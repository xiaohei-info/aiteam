"""Manager 多租户认证服务（03 9.3/9.4/9.5，D8/D23）。

收敛点（9.3）：登录方式多样性只在 Authenticator 一层；所有方式归一到同一 user，
再走同一 token 出口（RS256 按 tenant 签发，含 tenant_id）。M0 实现 password provider；MFA
（passkey/oauth/审计）叠加在本服务上（issue AITEAM-253）。

流程（9.4）：
- owner 首登：凭 bootstrap（must_reset=true）-> 强制重置 -> 新密码 hash 落本 tenant。
- member：负责人在租户内建账号 -> 手机号+密码登录。
- 校验通过 -> issue_token({tenant_id, user_id, roles}) 单一出口。

本扩展叠加：
- 密码强度 / 过期策略（密码策略）。
- 每次登录（成功/失败）记登录审计（login_attempt，脱敏）。
- passkey、OAuth 作为新 Authenticator 接入同一出口（9.3 零改 user/token 层）。
"""

from __future__ import annotations

import time
import uuid

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.auth import TokenClaims
from shared.contracts.enums import AuthProvider, EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound, Unauthorized, ValidationProblem

from .auth_password_policy import (
    assert_password_not_expired,
    validate_password_complexity,
)
from .keys import TenantKeyStore
from .login_audit import LoginAuditRepository
from .repository import TenantAuthRepository
from .security import hash_password, verify_password

_ACCESS_TTL_SECONDS = 3600  # 短期 access token；过期需重新联网登录（9.5）。


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

    def __init__(self, *, dsn, repo, keys, audit=None):
        # dsn：业务连接串（app_rw 身份，跑租户 RLS SQL）。管理连接（签名私钥读写）在 keys 内。
        self.dsn = dsn
        self._repo = repo
        self._keys = keys
        self._audit = audit

    # ---- 账号开通（控制面/负责人侧调用）----
    def provision_owner(self, tenant_id, *, phone, bootstrap_password):
        """落 owner bootstrap 凭据（must_reset=true，强制首登重置，9.4A）。密码需过策略校验。"""
        return self._create(
            tenant_id, phone=phone, password=bootstrap_password,
            roles=[EnterpriseRole.OWNER.value], display_name="owner", must_reset=True,
        )

    def create_member(
        self, tenant_id, *, phone, initial_password, display_name="", must_reset=True
    ):
        """负责人在租户内建成员账号（9.4B）。密码需过策略校验。"""
        return self._create(
            tenant_id, phone=phone, password=initial_password,
            roles=[EnterpriseRole.MEMBER.value], display_name=display_name, must_reset=must_reset,
        )

    def _create(self, tenant_id, *, phone, password, roles, display_name, must_reset):
        validate_password_complexity(password)
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
    def _validate_tenant_id(tenant_id):
        """拒绝非法 tenant_id（非 UUID 格式），避免其一路冲到写库后再在 _issue 按 tenant
        查签名密钥时炸出 500。前置校验把此类请求拒在业务链路之外，返回 422 而非 500。
        """
        try:
            uuid.UUID(tenant_id)
        except (ValueError, TypeError):
            raise ValidationProblem("invalid tenant_id format")

    def login(self, req):
        self._validate_tenant_id(req.tenant_id)
        ctx = TenantContext(tenant_id=req.tenant_id, user_id="anon", roles=[])
        identity = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=req.account)
        if identity is None or not identity.secret or not verify_password(req.password, identity.secret):
            record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                           actor="anon", success=False, detail="invalid credentials")
            raise Unauthorized("invalid credentials")
        if identity.must_reset:
            record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                           actor=identity.user_id, success=False, detail="reset required")
            raise Forbidden("password reset required before login")
        assert_password_not_expired(password_changed_at=identity.password_changed_at)
        record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                       actor=identity.user_id, success=True, detail=None)
        return self._issue(req.tenant_id, identity.user_id, identity.roles)

    def owner_reset(self, req):
        self._validate_tenant_id(req.tenant_id)
        validate_password_complexity(req.new_password)
        ctx = TenantContext(tenant_id=req.tenant_id, user_id="anon", roles=[])
        identity = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=req.account)
        if identity is None or not identity.secret or not verify_password(req.old_password, identity.secret):
            record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                           actor="anon", success=False, detail="invalid credentials")
            raise Unauthorized("invalid credentials")
        self._repo.update_secret(
            ctx, provider=AuthProvider.PHONE, external_id=req.account,
            secret=hash_password(req.new_password), must_reset=False,
        )
        record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                       actor=identity.user_id, success=True, detail="owner reset")
        return self._issue(req.tenant_id, identity.user_id, identity.roles)

    # ---- token 单一出口（9.3/9.5）----
    def _issue(self, tenant_id, user_id, roles):
        claims = TokenClaims(
            tenant_id=tenant_id, user_id=user_id, roles=roles,
            exp=int(time.time()) + _ACCESS_TTL_SECONDS,
        )
        token = self._keys.signer(tenant_id).sign(claims)
        return AuthResult(token=token, claims=claims)

    def issue(self, tenant_id, user_id, roles):
        """单一 token 出口（MFA Authenticator 共用）。"""
        return self._issue(tenant_id, user_id, roles)

    def jwks(self, tenant_id):
        """下发用户端的验签材料（公钥/JWKS，9.5）。"""
        return self._keys.jwks(tenant_id)

    def resolve_tenant(self, enterprise: str) -> str:
        """企业代码/名称 → tenant_id 解析（登录前调用，隐藏 UUID 细节）。

        按 tenant_registry.enterprise_code 或 enterprise_slug 匹配（优先 code，再 slug），
        404 未找到。返回 tenant_id UUID 字符串供 login/owner-reset 使用。
        """
        import psycopg

        with psycopg.connect(self.dsn, autocommit=True) as conn:
            row = conn.execute(
                "SELECT tenant_id FROM tenant_registry "
                "WHERE enterprise_code = %s OR enterprise_slug = %s LIMIT 1",
                (enterprise, enterprise),
            ).fetchone()
            if not row:
                raise NotFound(f"enterprise not found: {enterprise}")
            return str(row[0])  # psycopg 返回 UUID 对象,转 str


def record_attempt(audit, ctx, *, provider, external_id, actor, success, detail):
    """登录审计落点。audit 未配置 / 写入失败均不影响登录主路径（静默降级）。"""
    if audit is None:
        return
    try:
        audit.record(
            ctx, provider=provider, external_id=external_id,
            actor=actor, ip=None, success=success, detail=detail,
        )
    except Exception:
        return


def build_auth_service(dsn, admin_dsn=None, *, audit_dsn=None):
    """组装 AuthService（60：业务连接与管理连接分离）。

    - `dsn`：业务连接串（app_rw 身份）。租户 RLS 数据访问（auth_identity/app_user）走它。
    - `admin_dsn`：管理连接串（超管/DDL owner）。私钥库 tenant_signing_key 对 app_rw 零授权，
      故 TenantKeyStore 必须用管理连接直读直写。省略时回退到 `dsn`（兼容 admin 单 DSN 的老调用）。
    - `audit_dsn`：登录审计库连接（默认复用 dsn）。
    """
    router = PgTenantRouter(dsn)
    keys = TenantKeyStore(admin_dsn or dsn)
    audit = LoginAuditRepository(PgTenantRouter(audit_dsn or dsn)) if (audit_dsn or dsn) else None
    return AuthService(dsn=dsn, repo=TenantAuthRepository(router), keys=keys, audit=audit)
