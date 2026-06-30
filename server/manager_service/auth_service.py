"""Manager 多租户认证服务（03 §9.3/§9.4/§9.5，D8/D23）。

收敛点（§9.3）：登录方式多样性只在 Authenticator 一层；所有方式归一到同一 user，
再走同一 token 出口（RS256 按 tenant 签发，含 tenant_id）。本 M0 实现 password provider。

流程（§9.4）：
- owner 首登：凭 bootstrap（must_reset=true）→ 强制重置 → 新密码 hash 落本 tenant。
- member：负责人在租户内建账号 → 手机号+密码登录。
- 校验通过 → issue_token({tenant_id, user_id, roles}) 单一出口。
"""

from __future__ import annotations

import time
import uuid

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.auth import TokenClaims
from shared.contracts.enums import AuthProvider, EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, Unauthorized, ValidationProblem

from .keys import TenantKeyStore
from .repository import TenantAuthRepository
from .security import hash_password, verify_password

_ACCESS_TTL_SECONDS = 3600  # 短期 access token；过期需重新联网登录（§9.5）。


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str = Field(description="租户 id（由企业定位解析得到，RLS 主键来源）")
    account: str = Field(description="手机号/用户名（external_id）")
    password: str


class OwnerResetInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    account: str
    old_password: str = Field(description="bootstrap/旧密码")
    new_password: str


class AuthResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str
    claims: TokenClaims


class AuthService:
    """编排凭据校验 + token 签发。tenant_id 全程经 TenantContext / 显式入参，不手写过滤。"""

    def __init__(self, *, dsn: str, repo: TenantAuthRepository, keys: TenantKeyStore):
        # dsn：业务连接串（app_rw 身份，跑租户 RLS SQL）。管理连接（签名私钥读写）在 keys 内。
        self.dsn = dsn
        self._repo = repo
        self._keys = keys

    # ---- 账号开通（控制面/负责人侧调用）----
    def provision_owner(self, tenant_id: str, *, phone: str, bootstrap_password: str) -> str:
        """落 owner bootstrap 凭据（must_reset=true，强制首登重置，§9.4A）。"""
        return self._create(
            tenant_id, phone=phone, password=bootstrap_password,
            roles=[EnterpriseRole.OWNER.value], display_name="owner", must_reset=True,
        )

    def create_member(
        self, tenant_id: str, *, phone: str, initial_password: str, display_name: str = "", must_reset: bool = True
    ) -> str:
        """负责人在租户内建成员账号（§9.4B）。

        must_reset 默认 True：成员首登时需强制重置密码（对齐 owner 行为，增强安全性）。
        负责人可选择 must_reset=False 允许成员直接使用初始密码登录（适用于信任场景）。
        """
        return self._create(
            tenant_id, phone=phone, password=initial_password,
            roles=[EnterpriseRole.MEMBER.value], display_name=display_name, must_reset=must_reset,
        )

    def _create(self, tenant_id: str, *, phone: str, password: str, roles, display_name, must_reset) -> str:
        ctx = TenantContext(tenant_id=tenant_id, user_id="system", roles=roles)
        existing = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=phone)
        if existing is not None:
            raise Conflict("account already exists in this tenant")
        return self._repo.create_user_with_identity(
            ctx, provider=AuthProvider.PHONE, external_id=phone, secret=hash_password(password),
            roles=roles, display_name=display_name, must_reset=must_reset,
        )

    # ---- 登录 / 重置 ----
    @staticmethod
    def _validate_tenant_id(tenant_id: str) -> None:
        """拒绝非法 tenant_id（非 UUID 格式），避免其一路冲到写库后再在 _issue 按 tenant
        查签名密钥时炸出 500。前置校验把此类请求拒在业务链路之外，返回 422 而非 500。
        """
        try:
            uuid.UUID(tenant_id)
        except (ValueError, TypeError):
            raise ValidationProblem("invalid tenant_id format")

    def login(self, req: LoginInput) -> AuthResult:
        self._validate_tenant_id(req.tenant_id)
        ctx = TenantContext(tenant_id=req.tenant_id, user_id="anon", roles=[])
        identity = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=req.account)
        if identity is None or not identity.secret or not verify_password(req.password, identity.secret):
            raise Unauthorized("invalid credentials")
        if identity.must_reset:
            raise Forbidden("password reset required before login")
        return self._issue(req.tenant_id, identity.user_id, identity.roles)

    def owner_reset(self, req: OwnerResetInput) -> AuthResult:
        self._validate_tenant_id(req.tenant_id)
        ctx = TenantContext(tenant_id=req.tenant_id, user_id="anon", roles=[])
        identity = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=req.account)
        if identity is None or not identity.secret or not verify_password(req.old_password, identity.secret):
            raise Unauthorized("invalid credentials")
        self._repo.update_secret(
            ctx, provider=AuthProvider.PHONE, external_id=req.account,
            secret=hash_password(req.new_password), must_reset=False,
        )
        return self._issue(req.tenant_id, identity.user_id, identity.roles)

    # ---- token 单一出口（§9.3/§9.5）----
    def _issue(self, tenant_id: str, user_id: str, roles: list[str]) -> AuthResult:
        claims = TokenClaims(
            tenant_id=tenant_id, user_id=user_id, roles=roles,
            exp=int(time.time()) + _ACCESS_TTL_SECONDS,
        )
        token = self._keys.signer(tenant_id).sign(claims)
        return AuthResult(token=token, claims=claims)

    def jwks(self, tenant_id: str) -> dict:
        """下发用户端的验签材料（公钥/JWKS，§9.5）。"""
        return self._keys.jwks(tenant_id)


def build_auth_service(dsn: str, admin_dsn: str | None = None) -> AuthService:
    """组装 AuthService（#60：业务连接与管理连接分离）。

    - `dsn`：业务连接串（app_rw 身份）。租户 RLS 数据访问（auth_identity/app_user）走它。
    - `admin_dsn`：管理连接串（超管/DDL owner）。**签名私钥库 tenant_signing_key 对 app_rw 零授权**，
      故 TenantKeyStore 必须用管理连接直读直写（误降为 app_rw 会读不到/破坏隔离边界）。
      省略时回退到 `dsn`（仅兼容 admin 单 DSN 的老调用；生产应显式传两个）。
    """
    router = PgTenantRouter(dsn)
    keys = TenantKeyStore(admin_dsn or dsn)
    return AuthService(dsn=dsn, repo=TenantAuthRepository(router), keys=keys)
