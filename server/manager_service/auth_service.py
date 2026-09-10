"""Manager current-enterprise authentication service (03 9.3/9.4/9.5, D8/D23).

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
- 自动关联：员工账号 → tenant_id 解析（去掉 Agent 端手工填 tenant_id/企业提示，#382）。
"""

from __future__ import annotations

import os
import time
import uuid

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.auth import TokenClaims
from shared.contracts.enums import AuthProvider, EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, NotFound, ServiceUnavailable, Unauthorized, ValidationProblem

from .active_principal import require_active
from .auth_password_policy import (
    PasswordResetRequired,
    assert_password_not_expired,
    validate_password_complexity,
)
from .keys import TenantKeyStore
from .login_audit import LoginAuditRepository
from .repository import TenantAuthRepository
from .security import hash_password, verify_password

_ACCESS_TTL_SECONDS = 3600  # 短期 access token；过期需重新联网登录（9.5）。


class TenantSelectionRequired(Conflict):
    code, title = "tenant_selection_required", "Tenant Selection Required"


class EnterpriseAmbiguous(Conflict):
    code, title = "enterprise_ambiguous", "Enterprise Ambiguous"


class LoginInput(BaseModel):
    """企业成员/负责人登录。用户填写企业标识与账号密码；tenant_id 仅为内部解析结果。"""

    model_config = ConfigDict(extra="forbid")

    enterprise: str | None = Field(default=None, description="企业代码或名称")
    account: str = Field(description="手机号/用户名（external_id）")
    password: str = Field(description="登录密码；仅用于本次请求，不会回显。")
    tenant_id: str | None = Field(default=None, description="内部 tenant UUID（解析结果，非用户必填）")


class OwnerResetInput(BaseModel):
    """负责人重置密码。用户填写企业标识与账号密码；tenant_id 仅为内部解析结果。"""

    model_config = ConfigDict(extra="forbid")

    enterprise: str | None = Field(default=None, description="企业代码或名称")
    account: str = Field(description="手机号/用户名（external_id）")
    old_password: str = Field(description="bootstrap/旧密码")
    new_password: str = Field(description="要设置的新密码")
    tenant_id: str | None = Field(default=None, description="内部 tenant UUID（解析结果，非用户必填）")


class AuthResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str
    claims: TokenClaims


class AuthService:
    """编排凭据校验 + token 签发。tenant_id 全程经 TenantContext / 显式入参，不手写过滤。"""

    def __init__(
        self,
        *,
        dsn,
        repo,
        keys,
        audit=None,
        admin_dsn=None,
    ):
        # dsn：业务连接串（app_rw 身份，跑租户 RLS SQL）。管理连接（签名私钥读写）在 keys 内。
        self.dsn = dsn
        self._repo = repo
        self._keys = keys
        self._audit = audit
        # admin_dsn：管理连接串（超管/BYPASSRLS）——仅在跨租户账号解析时需要；未给定时回落 dsn。
        self._admin_dsn = admin_dsn or dsn

    # ---- 账号开通（控制面/负责人侧调用）----
    def provision_owner(self, tenant_id, *, phone, bootstrap_password):
        """落 owner bootstrap 凭据（must_reset=true，强制首登重置，9.4A）。密码需过策略校验。"""
        return self._create(
            tenant_id, phone=phone, password=bootstrap_password,
            roles=[EnterpriseRole.OWNER.value], display_name="owner", must_reset=True,
        )

    def sync_owner_bootstrap(self, tenant_id, *, phone, bootstrap_password):
        """控制面同步负责人一次性凭据，兼容旧调用方仅返回 user_id。"""
        user_id, _idempotent = self.sync_owner_bootstrap_result(
            tenant_id, phone=phone, bootstrap_password=bootstrap_password
        )
        return user_id

    def sync_owner_bootstrap_result(self, tenant_id, *, phone, bootstrap_password):
        """同步负责人凭据并返回 ``(user_id, replaced_existing)``。

        初次开通创建 owner；重复同步明确是 replace（重新写入 bootstrap hash），
        但响应可以标记该次调用为可重复的 existing-account 操作。
        """
        validate_password_complexity(bootstrap_password)
        ctx = TenantContext(tenant_id=tenant_id, user_id="system", roles=[EnterpriseRole.OWNER.value])
        existing = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=phone)
        if existing is None:
            return self.provision_owner(tenant_id, phone=phone, bootstrap_password=bootstrap_password), False
        require_active(existing)
        self._repo.update_secret(
            ctx,
            provider=AuthProvider.PHONE,
            external_id=phone,
            secret=hash_password(bootstrap_password),
            must_reset=True,
        )
        return existing.user_id, True

    def sync_owner_bootstrap_idempotent(
        self,
        tenant_id,
        *,
        phone,
        bootstrap_password,
        must_reset: bool,
        idempotency_repository,
        idempotency_key: str,
        request_fingerprint: str,
    ):
        """Apply F02 and its durable receipt in one tenant/RLS transaction."""
        validate_password_complexity(bootstrap_password)
        ctx = TenantContext(tenant_id=tenant_id, user_id="system", roles=[EnterpriseRole.OWNER.value])
        hashed = hash_password(bootstrap_password)

        def effect(session):
            user_id, _replaced = self._repo.sync_owner_bootstrap_in_session(
                session,
                ctx,
                phone=phone,
                secret=hashed,
                must_reset=must_reset,
            )
            return {"tenant_id": str(tenant_id), "user_id": str(user_id)}

        return idempotency_repository.execute(
            ctx,
            operation="owner-bootstrap",
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
            effect=effect,
            status_code=201,
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

    def _session_tenant_id(self, *, tenant_id: str | None, enterprise: str | None) -> str:
        resolved = None
        if enterprise and enterprise.strip():
            resolved = self.resolve_tenant(enterprise.strip())
        if tenant_id is not None:
            self._validate_tenant_id(tenant_id)
            if resolved is not None and tenant_id != resolved:
                raise ValidationProblem("enterprise does not match tenant_id")
            return tenant_id
        if resolved is None:
            raise ValidationProblem("enterprise or tenant_id is required")
        return resolved

    def login(self, req):
        tenant_id = self._session_tenant_id(tenant_id=req.tenant_id, enterprise=req.enterprise)
        ctx = TenantContext(tenant_id=tenant_id, user_id="anon", roles=[])
        identity = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=req.account)
        if identity is None or not identity.secret or not verify_password(req.password, identity.secret):
            record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                           actor="anon", success=False, detail="invalid credentials")
            raise Unauthorized("invalid credentials")
        require_active(identity)
        if identity.must_reset:
            record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                           actor=identity.user_id, success=False, detail="reset required")
            raise PasswordResetRequired("password reset required before login")
        assert_password_not_expired(password_changed_at=identity.password_changed_at)
        record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                       actor=identity.user_id, success=True, detail=None)
        return self._issue(tenant_id, identity.user_id, identity.roles)

    def owner_reset(self, req):
        tenant_id = self._session_tenant_id(tenant_id=req.tenant_id, enterprise=req.enterprise)
        validate_password_complexity(req.new_password)
        ctx = TenantContext(tenant_id=tenant_id, user_id="anon", roles=[])
        identity = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=req.account)
        if identity is None or not identity.secret or not verify_password(req.old_password, identity.secret):
            record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                           actor="anon", success=False, detail="invalid credentials")
            raise Unauthorized("invalid credentials")
        require_active(identity)
        self._repo.update_secret(
            ctx, provider=AuthProvider.PHONE, external_id=req.account,
            secret=hash_password(req.new_password), must_reset=False,
        )
        record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                       actor=identity.user_id, success=True, detail="owner reset")
        return self._issue(tenant_id, identity.user_id, identity.roles)

    # ---- token 单一出口（9.3/9.5）----
    def _issue(self, tenant_id, user_id, roles):
        ctx = TenantContext(tenant_id=tenant_id, user_id=user_id, roles=[])
        principal = require_active(self._repo.find_user(ctx, user_id=user_id))
        roles = list(principal.roles)
        enterprise_id = self._enterprise_id_for_tenant(tenant_id)
        now = int(time.time())
        claims = TokenClaims(
            tenant_id=tenant_id,
            enterprise_id=enterprise_id,
            user_id=user_id,
            roles=roles,
            iss=os.getenv("AITEAM_JWT_ISSUER", "aiteam-manager"),
            aud=os.getenv("AITEAM_JWT_AUDIENCE", "aiteam-agent"),
            iat=now,
            exp=now + _ACCESS_TTL_SECONDS,
        )
        token = self._keys.signer(tenant_id).sign(claims)
        return AuthResult(token=token, claims=claims)

    def _enterprise_id_for_tenant(self, tenant_id: str) -> str | None:
        """Resolve the persisted Operator enterprise binding for token claims."""
        import psycopg

        try:
            with psycopg.connect(self._admin_dsn, autocommit=True) as conn:
                row = conn.execute(
                    "SELECT enterprise_id FROM tenant_registry WHERE tenant_id = %s",
                    (tenant_id,),
                ).fetchone()
        except psycopg.Error as exc:
            raise ServiceUnavailable("Manager enterprise mapping is unavailable") from exc
        return None if row is None or row[0] is None else str(row[0])

    def issue(self, tenant_id, user_id, roles):
        """单一 token 出口（MFA Authenticator 共用）。"""
        return self._issue(tenant_id, user_id, roles)

    def jwks(self, tenant_id):
        """下发用户端的验签材料（公钥/JWKS，9.5）。"""
        self._validate_tenant_id(tenant_id)
        return self._keys.jwks(tenant_id)

    def resolve_tenant(self, enterprise: str) -> str:
        """企业代码/名称 → tenant_id。代码精确匹配优先；slug 收集全部匹配，歧义 409。"""
        import psycopg

        value = (enterprise or "").strip()
        if not value:
            raise ValidationProblem("enterprise is required")
        with psycopg.connect(self._admin_dsn, autocommit=True) as conn:
            code_rows = conn.execute(
                "SELECT tenant_id FROM tenant_registry WHERE enterprise_code = %s",
                (value,),
            ).fetchall()
            code_ids = list({str(row[0]) for row in code_rows})
            if len(code_ids) == 1:
                return code_ids[0]
            if len(code_ids) > 1:
                raise EnterpriseAmbiguous(f"enterprise identifier is ambiguous: {value}")
            slug_rows = conn.execute(
                "SELECT tenant_id FROM tenant_registry WHERE enterprise_slug = %s",
                (value,),
            ).fetchall()
            slug_ids = list({str(row[0]) for row in slug_rows})
            if len(slug_ids) == 1:
                return slug_ids[0]
            if len(slug_ids) > 1:
                raise EnterpriseAmbiguous(f"enterprise identifier is ambiguous: {value}")
        raise NotFound(f"enterprise not found: {value}")

    def resolve_tenant_by_account(self, account: str, enterprise: str | None = None) -> str:
        """Resolve an account to one tenant; optional enterprise disambiguates duplicates."""
        import psycopg

        scoped = None
        if enterprise and enterprise.strip():
            scoped = self.resolve_tenant(enterprise.strip())
        with psycopg.connect(self._admin_dsn, autocommit=True) as conn:
            if scoped is None:
                rows = conn.execute(
                    "SELECT tenant_id FROM auth_identity "
                    "WHERE provider IN ('phone', 'password') AND external_id = %s "
                    "ORDER BY provider = 'phone' DESC, created_at DESC",
                    (account,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT tenant_id FROM auth_identity "
                    "WHERE tenant_id = %s AND provider IN ('phone', 'password') AND external_id = %s "
                    "ORDER BY provider = 'phone' DESC, created_at DESC",
                    (scoped, account),
                ).fetchall()
        if not rows:
            raise NotFound(f"account not bound to any tenant: {account}")
        tenant_ids = list({str(r[0]) for r in rows})
        if len(tenant_ids) > 1:
            raise TenantSelectionRequired(
                f"account belongs to multiple tenants, enterprise must be specified: {account}"
            )
        return tenant_ids[0]



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


def build_auth_service(
    dsn,
    admin_dsn=None,
    *,
    audit_dsn=None,
):
    """组装 AuthService（60：业务连接与管理连接分离）。

    - `dsn`：业务连接串（app_rw 身份）。租户 RLS 数据访问（auth_identity/app_user）走它。
    - `admin_dsn`：管理连接串（超管/DDL owner）。私钥库 tenant_signing_key 对 app_rw 零授权，
      故 TenantKeyStore 必须用管理连接直读直写。省略时回退到 `dsn`（兼容 admin 单 DSN 的老调用）。
    - `audit_dsn`：登录审计库连接（默认复用 dsn）。
    """
    router = PgTenantRouter(dsn)
    keys = TenantKeyStore(admin_dsn or dsn)
    audit = LoginAuditRepository(PgTenantRouter(audit_dsn or dsn)) if (audit_dsn or dsn) else None
    return AuthService(
        dsn=dsn,
        repo=TenantAuthRepository(router),
        keys=keys,
        audit=audit,
        admin_dsn=admin_dsn or dsn,
    )
