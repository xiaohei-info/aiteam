"""OAuth 编排服务（issue AITEAM-253）。

把 OAuthProvider（上游协议） + OAuthConnectionStore（绑定持久化） + TenantAuthRepository（auth_identity 映射）
拼成端到端 OAuth 登录/绑定流程。tenant_id 只经 TenantContext 出入（D22）。

流程：
- authorize：生成 state（含 tenant_id + redirect_uri + nonce），返回 provider 授权跳转 URL。
- callback：校验 state，provider 换 token + 取 profile，反查/建 auth_identity(provider=oauth, external_id=provider:sub)，
  落 oauth_connection 绑定，issue_token。
- link（已登录用户）：把 provider 身份绑到当前 user（用于「设置」页绑定第三方账号）。
"""

from __future__ import annotations

from shared.contracts.enums import AuthProvider
from shared.contracts.tenancy import TenantContext
from shared.errors import Unauthorized, ValidationProblem

from .auth_service import AuthResult
from .login_audit import LoginAuditRepository
from .oauth import (
    OAuthConnectionStore, OAuthError, OAuthProfile, OAuthProvider,
    _consume_state, _make_state,
)
from .repository import TenantAuthRepository


class OAuthService:
    def __init__(
        self,
        *,
        providers: dict[str, OAuthProvider],
        connections: OAuthConnectionStore,
        auth_repo: TenantAuthRepository,
        audit: LoginAuditRepository,
        issuer,
    ):
        self._providers = providers
        self._connections = connections
        self._auth_repo = auth_repo
        self._audit = audit
        self._issuer = issuer

    def provider_names(self) -> list[str]:
        return sorted(self._providers.keys())

    def authorize(self, *, provider: str, tenant_id: str, redirect_uri: str) -> dict:
        prov = self._providers.get(provider)
        if prov is None:
            raise ValidationProblem("unsupported oauth provider: %s" % provider)
        state = _make_state(tenant_id, redirect_uri)
        url = prov.authorization_url(state, redirect_uri, nonce=state)
        return {"provider": provider, "state": state, "authorization_url": url}

    def callback(self, *, provider: str, code: str, state: str, ip: str | None = None) -> AuthResult:
        prov = self._providers.get(provider)
        if prov is None:
            raise ValidationProblem("unsupported oauth provider: %s" % provider)
        try:
            payload = _consume_state(state)
        except OAuthError as exc:
            raise ValidationProblem("invalid oauth state: %s" % exc) from exc
        tenant_id = payload.get("t")
        redirect_uri = payload.get("r")
        if not tenant_id or not redirect_uri:
            raise ValidationProblem("invalid oauth state payload")
        try:
            token_resp = prov.exchange(code, redirect_uri)
            profile = prov.fetch_profile(token_resp)
        except (OAuthError, Exception) as exc:
            ctx = TenantContext(tenant_id=tenant_id, user_id="anon", roles=[])
            self._audit.record(
                ctx, provider="oauth:" + provider, external_id=None,
                actor="anon", ip=ip, success=False, detail="exchange failed",
            )
            raise Unauthorized("oauth provider exchange failed") from exc
        return self._resolve(tenant_id=tenant_id, profile=profile, ip=ip)

    def _resolve(self, *, tenant_id: str, profile: OAuthProfile, ip: str | None) -> AuthResult:
        ctx = TenantContext(tenant_id=tenant_id, user_id="anon", roles=[])
        # 1) 先按连接表反查（已绑定用户）
        conn = self._connections.find(ctx, external_id=profile.external_id)
        if conn is not None:
            self._connections.upsert(ctx, profile=profile, user_id=conn.user_id)
            identity = self._auth_repo.find_user(ctx, user_id=conn.user_id)
            if identity is None:
                raise Unauthorized("oauth bound account missing")
            self._audit.record(
                ctx, provider="oauth:" + profile.provider,
                external_id=profile.external_id, actor=identity.user_id, ip=ip,
                success=True, detail="connected",
            )
            return self._issuer(ctx.tenant_id, identity.user_id, identity.roles)
        # 2) 再按 auth_identity 反查（兼容直接建过映射的）
        identity = self._auth_repo.find_oauth_identity(ctx, external_id=profile.external_id)
        if identity is not None:
            self._connections.upsert(ctx, profile=profile, user_id=identity.user_id)
            self._audit.record(
                ctx, provider="oauth:" + profile.provider,
                external_id=profile.external_id, actor=identity.user_id, ip=ip,
                success=True, detail="identity",
            )
            return self._issuer(ctx.tenant_id, identity.user_id, identity.roles)
        self._audit.record(
            ctx, provider="oauth:" + profile.provider,
            external_id=profile.external_id, actor="anon", ip=ip,
            success=False, detail="no account linked",
        )
        raise Unauthorized("no manager account linked to this %s identity" % profile.provider)

    def link(self, ctx: TenantContext, *, provider: str, code: str, redirect_uri: str, user_id: str) -> dict:
        """已登录用户绑定第三方账号。"""
        prov = self._providers.get(provider)
        if prov is None:
            raise ValidationProblem("unsupported oauth provider: %s" % provider)
        try:
            token_resp = prov.exchange(code, redirect_uri)
            profile = prov.fetch_profile(token_resp)
        except (OAuthError, Exception) as exc:
            raise Unauthorized("oauth provider exchange failed") from exc
        # 该三方身份若已绑到别人，拒绝。
        existing = self._connections.find(ctx, external_id=profile.external_id)
        if existing is not None and existing.user_id != user_id:
            raise ValidationProblem("this %s account is already linked to another user" % provider)
        identity = self._auth_repo.find_oauth_identity(ctx, external_id=profile.external_id)
        if identity is not None and identity.user_id != user_id:
            raise ValidationProblem("this %s account is already linked to another user" % provider)
        self._connections.upsert(ctx, profile=profile, user_id=user_id)
        self._auth_repo.upsert_oauth_identity(ctx, user_id=user_id, external_id=profile.external_id)
        return {"provider": provider, "linked": True}

    def list_connections(self, ctx: TenantContext, user_id: str) -> list[dict]:
        rows = self._connections.list_for_user(ctx, user_id)
        return [
            {
                "provider": r.provider,
                "profile_email": r.profile_email,
                "connected_at": r.connected_at.isoformat() if r.connected_at else None,
                "last_login_at": r.last_login_at.isoformat() if r.last_login_at else None,
            }
            for r in rows
        ]

    def unlink(self, ctx: TenantContext, *, provider: str, user_id: str) -> bool:
        return self._connections.delete(ctx, provider=provider, user_id=user_id)
