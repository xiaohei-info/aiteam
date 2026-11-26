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
import uuid
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.auth import TokenClaims
from shared.contracts.enums import AuthProvider, EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import AppError, Conflict, NotFound, ServiceUnavailable, TooManyRequests, Unauthorized, ValidationProblem
from shared.auth.constants import AUTH_SESSION_TTL_SECONDS

from .active_principal import require_active
from .auth_sessions import ManagerAuthSessionRepository
from .auth_password_policy import (
    PasswordExpired,
    PasswordResetRequired,
    assert_password_not_expired,
    validate_password_complexity,
)
from .keys import TenantKeyStore
from .login_audit import LoginAuditRepository
from .repository import TenantAuthRepository
from .security import hash_password, verify_password

_ACCESS_TTL_SECONDS = AUTH_SESSION_TTL_SECONDS


CHANGE_PW_MAX_FAILURES = 5
CHANGE_PW_WINDOW_MINUTES = 15
_CHANGE_PW_DETAIL = "change_password"


class OldPasswordIncorrect(ValidationProblem):
    code, title = "old_password_incorrect", "Old password incorrect"


class PasswordNotSet(Conflict):
    code, title = "password_not_set", "Password not set"


class TooManyAttempts(TooManyRequests):
    code, title = "too_many_attempts", "Too many attempts"


class TenantSelectionRequired(Conflict):
    """账号命中多个企业。`meta.candidates` 列出可选企业（tenant_id + 企业名），供登录页让用户选择。"""

    code, title = "tenant_selection_required", "Tenant Selection Required"

    def __init__(self, detail: str | None = None, *, candidates: list[dict[str, str]] | None = None):
        super().__init__(detail, meta={"candidates": candidates} if candidates else None)


class EnterpriseAmbiguous(Conflict):
    code, title = "enterprise_ambiguous", "Enterprise Ambiguous"


class ClientUpgradeRequired(AppError):
    """旧版「凭账号查企业」接口已停用：不论账号是否存在都固定返回 410，要求升级客户端。"""

    status, code, title = 410, "client_upgrade_required", "Client Upgrade Required"


CLIENT_UPGRADE_DETAIL = "客户端版本过旧，请升级后登录"
# 账号不存在与密码错误必须返回完全相同的 401（同 code / detail / 无 meta），不泄漏账号是否存在。
_INVALID_CREDENTIALS = "invalid credentials"
_dummy_secret: str | None = None


def _dummy_password_check(password: str) -> None:
    """账号不存在时也做一次同等代价的密码校验，避免按响应时间区分「无此账号」。"""
    global _dummy_secret
    if _dummy_secret is None:
        _dummy_secret = hash_password(uuid.uuid4().hex)
    verify_password(password, _dummy_secret)


class LoginInput(BaseModel):
    """企业成员/负责人登录。企业标识可省略：省略时按账号和密码匹配企业（多个则 409 候选）。"""

    model_config = ConfigDict(extra="forbid")

    enterprise: str | None = Field(default=None, description="企业代码或名称；省略时按账号和密码匹配企业")
    account: str = Field(description="手机号/用户名（external_id）")
    password: str = Field(description="登录密码；仅用于本次请求，不会回显。")
    tenant_id: str | None = Field(
        default=None, description="内部 tenant UUID：409 tenant_selection_required 候选中选定的企业（非用户必填）"
    )


class OwnerResetInput(BaseModel):
    """负责人重置密码。通常带登录 403 响应 meta.tenant_id；都不带时旧密码通过后再匹配企业。"""

    model_config = ConfigDict(extra="forbid")

    enterprise: str | None = Field(default=None, description="企业代码或名称")
    account: str = Field(description="手机号/用户名（external_id）")
    old_password: str = Field(description="bootstrap/旧密码")
    new_password: str = Field(description="要设置的新密码")
    tenant_id: str | None = Field(
        default=None, description="内部 tenant UUID：登录 403 password_reset_required 响应 meta.tenant_id（非用户必填）"
    )


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
        sessions=None,
    ):
        # dsn：业务连接串（app_rw 身份，跑租户 RLS SQL）。管理连接（签名私钥读写）在 keys 内。
        self.dsn = dsn
        self._repo = repo
        self._keys = keys
        self._audit = audit
        self._sessions = sessions
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
            user_id, replaced = self._repo.sync_owner_bootstrap_in_session(
                session,
                ctx,
                phone=phone,
                secret=hashed,
                must_reset=must_reset,
            )
            payload = {"tenant_id": str(tenant_id), "user_id": str(user_id)}
            if replaced:
                # 重置：旧会话、passkey、第三方登录都随旧密码一起失效，且与新密码同一事务提交。
                payload["cleared"] = self._repo.clear_user_credentials_in_session(session, ctx, user_id=str(user_id))
            return payload

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

    def _session_tenant_id(self, *, tenant_id: str | None, enterprise: str) -> str:
        """显式企业：tenant_id（登录弹窗选中的候选）和/或企业标识（用户填写），两者都给时必须一致。"""
        resolved = self.resolve_tenant(enterprise) if enterprise else None
        if tenant_id is not None:
            self._validate_tenant_id(tenant_id)
            if resolved is not None and tenant_id != resolved:
                raise ValidationProblem("enterprise does not match tenant_id")
            return tenant_id
        return resolved

    def _authenticate(self, *, tenant_id: str | None, enterprise: str | None, account: str, password: str):
        """校验账号密码并确定登录企业，返回 ``(tenant_id, ctx, identity)``。

        - 给了 tenant_id 或企业标识：只在该企业内校验。
        - 都没给：按账号找到所有未归档身份，**逐个企业校验密码**，只保留密码通过的企业；
          一个 → 直接用它；多个 → 优先 active，仍多个则 409 + meta.candidates（只含密码通过的企业）。
        - 账号不存在 / 密码在所有企业都不对：同一个 401（同 code、detail，无 meta）。
        """
        enterprise = (enterprise or "").strip()
        if tenant_id is not None or enterprise:
            tid = self._session_tenant_id(tenant_id=tenant_id, enterprise=enterprise)
            ctx = TenantContext(tenant_id=tid, user_id="anon", roles=[])
            identity = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=account)
            if identity is None or not identity.secret or not verify_password(password, identity.secret):
                record_attempt(self._audit, ctx, provider="password", external_id=account,
                               actor="anon", success=False, detail="invalid credentials")
                raise Unauthorized(_INVALID_CREDENTIALS)
            return tid, ctx, identity
        tenants = self._account_tenants(account)
        if not tenants:
            _dummy_password_check(password)
            raise Unauthorized(_INVALID_CREDENTIALS)
        matched: dict[str, tuple] = {}
        for tid in tenants:
            ctx = TenantContext(tenant_id=tid, user_id="anon", roles=[])
            identity = self._repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=account)
            if identity is not None and identity.secret and verify_password(password, identity.secret):
                matched[tid] = (ctx, identity)
            else:
                record_attempt(self._audit, ctx, provider="password", external_id=account,
                               actor="anon", success=False, detail="invalid credentials")
        if not matched:
            raise Unauthorized(_INVALID_CREDENTIALS)
        pool = _prefer_active({tid: tenants[tid][0] for tid in matched})
        if len(pool) == 1:
            ctx, identity = matched[pool[0]]
            return pool[0], ctx, identity
        candidates = sorted(
            ({"tenant_id": tid, "enterprise_name": tenants[tid][1]} for tid in pool),
            key=lambda c: (c["enterprise_name"], c["tenant_id"]),
        )
        raise TenantSelectionRequired(
            "account and password match multiple enterprises; select one by tenant_id",
            candidates=candidates,
        )

    def _account_tenants(self, account: str) -> dict[str, tuple[str, str]]:
        """账号 → {tenant_id: (企业状态, 企业名称)}。已归档身份（企业注销 / 删除）不参与。

        名称取 enterprise_settings.enterprise_name，为空时回落 tenant_registry.enterprise_slug。
        这里只给出「哪些企业有这个账号」，是否能登录由调用方逐个企业校验密码后决定，结果不直接返回给未认证者。
        """
        import psycopg

        query = (
            "SELECT DISTINCT ai.tenant_id, tr.status, "
            "COALESCE(NULLIF(es.enterprise_name, ''), tr.enterprise_slug) AS enterprise_name "
            "FROM auth_identity ai "
            "JOIN tenant_registry tr ON tr.tenant_id = ai.tenant_id "
            "LEFT JOIN enterprise_settings es ON es.tenant_id = ai.tenant_id "
            "WHERE ai.provider IN ('phone', 'password') AND ai.external_id = %s AND ai.archived_at IS NULL"
        )
        try:
            with psycopg.connect(self._admin_dsn, autocommit=True) as conn:
                rows = conn.execute(query, (account,)).fetchall()
        except psycopg.Error as exc:
            raise ServiceUnavailable("Manager account directory is unavailable") from exc
        return {str(r[0]): (r[1], r[2]) for r in rows}

    @staticmethod
    def _reset_meta(tenant_id: str) -> dict[str, str]:
        """「需要改密」响应回传 tenant_id：此时密码已校验通过，后续改密直接按该企业进行，无需再匹配企业。"""
        return {"tenant_id": tenant_id}

    def login(self, req):
        tenant_id, ctx, identity = self._authenticate(
            tenant_id=req.tenant_id, enterprise=req.enterprise, account=req.account, password=req.password,
        )
        require_active(identity)
        # 凭据核对通过后再看企业状态（不向未认证者泄露），且在任何“成功”审计之前。
        self._assert_tenant_active(tenant_id)
        if identity.must_reset:
            record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                           actor=identity.user_id, success=False, detail="reset required")
            raise PasswordResetRequired("password reset required before login", meta=self._reset_meta(tenant_id))
        try:
            assert_password_not_expired(password_changed_at=identity.password_changed_at)
        except PasswordExpired as exc:
            raise PasswordExpired(exc.detail, meta=self._reset_meta(tenant_id)) from None
        record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                       actor=identity.user_id, success=True, detail=None)
        return self._issue(tenant_id, identity.user_id, identity.roles)

    def owner_reset(self, req):
        """首次登录 / 过期改密。未给企业时与登录同口径：旧密码通过后才匹配企业（多个则 409 候选）。
        正常流程里客户端会带上「需要改密」响应 meta.tenant_id，直接定位到该企业。"""
        if req.tenant_id is not None:
            self._validate_tenant_id(req.tenant_id)
        validate_password_complexity(req.new_password)
        tenant_id, ctx, identity = self._authenticate(
            tenant_id=req.tenant_id, enterprise=req.enterprise, account=req.account, password=req.old_password,
        )
        require_active(identity)
        # 暂停 / 封禁等企业不可用时不能改密码（先拒绝，再写）。
        self._assert_tenant_active(tenant_id)
        self._repo.update_secret(
            ctx, provider=AuthProvider.PHONE, external_id=req.account,
            secret=hash_password(req.new_password), must_reset=False,
        )
        if self._sessions is not None:
            self._sessions.revoke_user(
                TenantContext(tenant_id=tenant_id, user_id=identity.user_id, roles=identity.roles),
                reason="password_reset",
            )
        record_attempt(self._audit, ctx, provider="password", external_id=req.account,
                       actor=identity.user_id, success=True, detail="owner reset")
        return self._issue(tenant_id, identity.user_id, identity.roles)

    def change_password(self, claims: TokenClaims, *, old_password: str, new_password: str) -> None:
        """已登录成员自助设置新密码：校验旧密码，成功后吊销该成员除当前会话外的其它会话。

        连续输错旧密码 5 次（15 分钟内）后锁定，期间连正确的旧密码也会被拒绝；
        审计库未配置时拒绝操作（无法计数就不能放开）。
        """
        if self._audit is None:
            raise ServiceUnavailable("login audit store is not configured")
        if not claims.tenant_id:
            raise Unauthorized("token has no tenant")
        ctx = TenantContext(tenant_id=claims.tenant_id, user_id=claims.user_id, roles=list(claims.roles))
        identity = require_active(self._repo.find_user(ctx, user_id=claims.user_id))
        if not identity.secret:
            raise PasswordNotSet("this account has no local password")
        detail = _CHANGE_PW_DETAIL
        if self._audit.count_recent_failures(
            ctx, actor=claims.user_id, detail=detail, within_minutes=CHANGE_PW_WINDOW_MINUTES,
        ) >= CHANGE_PW_MAX_FAILURES:
            raise TooManyAttempts("too many incorrect attempts, try again later")
        if not verify_password(old_password, identity.secret):
            record_attempt(self._audit, ctx, provider="password", external_id=None,
                           actor=claims.user_id, success=False, detail=detail)
            raise OldPasswordIncorrect("old password is incorrect")
        if new_password == old_password:
            raise ValidationProblem("new password must differ from the old one")
        validate_password_complexity(new_password)
        self._repo.update_secret_for_user(ctx, user_id=claims.user_id, secret=hash_password(new_password))
        if self._sessions is not None and claims.jti:
            self._sessions.revoke_user_except(ctx, keep_jti=claims.jti, reason="password_changed")
        record_attempt(self._audit, ctx, provider="password", external_id=None,
                       actor=claims.user_id, success=True, detail=detail)

    # ---- token 单一出口（9.3/9.5）----
    def _issue(self, tenant_id, user_id, roles):
        ctx = TenantContext(tenant_id=tenant_id, user_id=user_id, roles=[])
        principal = require_active(self._repo.find_user(ctx, user_id=user_id))
        roles = list(principal.roles)
        enterprise_id = self._enterprise_id_for_tenant(tenant_id)
        self._assert_tenant_active(tenant_id)
        issued_at = datetime.now(UTC)
        expires_at = issued_at + timedelta(seconds=_ACCESS_TTL_SECONDS)
        jti = (
            self._sessions.create(ctx, issued_at=issued_at, expires_at=expires_at)
            if self._sessions is not None
            else str(uuid.uuid4())
        )
        now = int(issued_at.timestamp())
        claims = TokenClaims(
            tenant_id=tenant_id,
            enterprise_id=enterprise_id,
            user_id=user_id,
            roles=roles,
            iss=os.getenv("AITEAM_JWT_ISSUER", "aiteam-manager"),
            aud=os.getenv("AITEAM_JWT_AUDIENCE", "aiteam-agent"),
            iat=now,
            exp=int(expires_at.timestamp()),
            jti=jti,
        )
        token = self._keys.signer(tenant_id).sign(claims)
        return AuthResult(token=token, claims=claims)

    def revoke(self, claims: TokenClaims, *, reason: str) -> None:
        if self._sessions is not None:
            self._sessions.revoke(claims, reason=reason)

    def _assert_tenant_active(self, tenant_id: str) -> None:
        """R5：暂停 / 封禁 / 注销 / 删除的企业不再签发 token（覆盖密码、passkey、第三方登录）。"""
        from .tenant_status import ACTIVE, TenantUnavailable, fetch_tenant_status

        status = fetch_tenant_status(self._admin_dsn, tenant_id)
        if status != ACTIVE:
            raise TenantUnavailable(status, at_login=True)

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
        """企业代码/名称 → tenant_id。代码精确匹配优先（重名时只看 active 企业）；slug 唯一。

        同一标识命中多家且全都不可用（暂停 / 封禁 / 注销 / 删除）时，报企业状态而不是「标识歧义」：
        改填企业代码也登录不了，真正原因是这些企业都不可用。
        """
        import psycopg

        from .tenant_status import TenantUnavailable

        value = (enterprise or "").strip()
        if not value:
            raise ValidationProblem("enterprise is required")
        with psycopg.connect(self._admin_dsn, autocommit=True) as conn:
            for column in ("enterprise_code", "enterprise_slug"):
                rows = conn.execute(
                    f"SELECT tenant_id, status FROM tenant_registry WHERE {column} = %s",  # noqa: S608 - 固定列名
                    (value,),
                ).fetchall()
                statuses = {str(r[0]): r[1] for r in rows}
                tenant_id = _single_preferring_active(statuses)
                if tenant_id is not None:
                    return tenant_id
                if rows and "active" not in statuses.values():
                    raise TenantUnavailable(_most_relevant_status(statuses.values()), at_login=True)
                if rows:
                    raise EnterpriseAmbiguous(f"enterprise identifier is ambiguous: {value}")
        raise NotFound(f"enterprise not found: {value}")


# 多家不可用企业共用一个标识时，按可恢复程度给出最相关的状态（暂停可恢复，最值得提示）。
_INACTIVE_STATUS_PRIORITY = ("suspended", "banned", "closed", "deleted")


def _most_relevant_status(statuses) -> str:
    present = set(statuses)
    return next((s for s in _INACTIVE_STATUS_PRIORITY if s in present), next(iter(present)))


def _prefer_active(statuses: dict[str, str]) -> list[str]:
    """有 active 企业时只留 active；否则原样保留（让登录给出“企业已暂停/封禁”等明确提示）。"""
    active = [tid for tid, status in statuses.items() if status == "active"]
    return active or list(statuses)


def _single_preferring_active(statuses: dict[str, str]) -> str | None:
    pool = _prefer_active(statuses)
    return pool[0] if len(pool) == 1 else None


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
        sessions=ManagerAuthSessionRepository(dsn),
    )
