"""Manager 多因素认证北向路由（issue AITEAM-253）。

公开端点（无需 token）：passkey 登录选项、passkey 登录、OAuth 提供商列表、OAuth 授权、OAuth 回调登录。
需 token 端点：passkey 注册选项/提交、passkey 删除、OAuth 连接列举、OAuth 绑定、OAuth 解绑。

统一经 shared/auth require_claims 解出身份；PasskeyService/OAuthService 以 tenant_id 经 TenantContext 隔离；
token 经 AuthService.issue 签发（与密码登录同一出口）。
"""

from __future__ import annotations

import os
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import RejectingTokenVerifier, require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import AppError, NotFound

from .active_principal import require_active, require_bound_tenant
from .auth_origin import AuthOrigin
from .auth_service import AuthResult, AuthService, build_auth_service
from .login_audit import LoginAuditRepository
from .openapi_schemas import (
    OAuthAuthorizeOut,
    OAuthConnectionOut,
    OAuthLinkOut,
    OAuthUnlinkOut,
    PasskeyCredentialOut,
    PasskeyCredentialResultOut,
    PasskeyDeleteOut,
    PasskeyOptionsOut,
)
from .oauth import OAuthConnectionStore, GitHubOAuth, GoogleOAuth
from .oauth_service import OAuthService
from .passkey_service import PasskeyService
from .passkey_store import PasskeyStore


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


class PasskeyRegistrationFinishIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str | None = Field(default=None, description="用户为该 passkey 设置的标签。")
    response: dict[str, Any] = Field(description="navigator.credentials.create返回的AuthenticatorAttestationResponse，clientDataJSON/attestationObject编码base64url。")


class PasskeyLoginIn(BaseModel):
    """WebAuthn 登录断言。"""

    model_config = ConfigDict(extra="allow", json_schema_extra={"x-dynamic-json": True})
    tenant_id: str = Field(description="企业租户 ID。")
    id: str | None = Field(default=None, description="credential ID。")
    rawId: str | None = Field(default=None, description="base64url credential ID。")
    type: str | None = Field(default=None, description="WebAuthn credential 类型。")
    response: dict[str, Any] | None = Field(default=None, description="浏览器返回的断言响应。")


class OAuthAuthorizeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(description="OAuth 提供方。")
    tenant_id: str = Field(description="企业租户 ID。")
    redirect_uri: str = Field(description="可信MANAGER_PUBLIC_ORIGIN的 /auth/oauth/callback。")
    intent: Literal["login", "link"] = Field(default="login", description="login登录；link绑定当前active JWT用户。")


class OAuthCallbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(description="OAuth 提供方。")
    code: str = Field(description="OAuth authorization code。")
    state: str = Field(description="CSRF state。")


class OAuthLinkIn(BaseModel):
    state: str = Field(description="authorize(intent=link)签发的当前用户一次性state；旧无state请求拒绝422。")
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(description="OAuth 提供方。")
    code: str = Field(description="OAuth authorization code。")
    redirect_uri: str = Field(description="OAuth 回调地址。")


def _require(request: Request):
    """Per-request dependency: resolve the verifier from app.state and return claims.
    Resolves lazily so tests/dev without a configured admin DB degrade to a rejecting verifier
    instead of crashing at import time."""
    verifier = getattr(request.app.state, "_token_verifier", None)
    if verifier is None:
        verifier = RejectingTokenVerifier("manager signing key store unconfigured")
    claims = require_claims(verifier)(request)
    require_active(_auth_service(request)._repo.find_user(tenant_context_from(claims), user_id=claims.user_id))
    return claims


def _settings(request: Request):
    return request.app.state.settings


def _auth_service(request: Request) -> AuthService:
    settings = _settings(request)
    dsn = settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    admin_dsn = settings.admin_db_url
    if not admin_dsn:
        raise _ManagerNotConfigured("Manager 管理 DB 未配置（设置 ADMIN_DB_URL）")
    cache = getattr(request.app.state, "_auth_service", None)
    if cache is None:
        cache = build_auth_service(
            dsn,
            admin_dsn=admin_dsn,
            audit_dsn=dsn,
            deployment_tenant_id=settings.manager_tenant_id,
            require_binding=True,
        )
        request.app.state._auth_service = cache
    return cache


def _build_oauth_providers() -> dict:
    providers = {}
    g_id = os.getenv("OAUTH_GOOGLE_CLIENT_ID")
    g_secret = os.getenv("OAUTH_GOOGLE_CLIENT_SECRET")
    if g_id and g_secret:
        providers["google"] = GoogleOAuth(client_id=g_id, client_secret=g_secret)
    gh_id = os.getenv("OAUTH_GITHUB_CLIENT_ID")
    gh_secret = os.getenv("OAUTH_GITHUB_CLIENT_SECRET")
    if gh_id and gh_secret:
        providers["github"] = GitHubOAuth(client_id=gh_id, client_secret=gh_secret)
    return providers


def _router_for(request: Request) -> PgTenantRouter:
    dsn = _settings(request).db_url
    return PgTenantRouter(dsn)


def _passkey_service(request: Request, auth: AuthService) -> PasskeyService:
    cache = getattr(request.app.state, "_passkey_service", None)
    if cache is None:
        r = _router_for(request)
        cache = PasskeyService(
            auth_repo=auth._repo,
            store=PasskeyStore(r),
            audit=LoginAuditRepository(r),
            issuer=auth.issue,
            origin=AuthOrigin.from_env(),
        )
        request.app.state._passkey_service = cache
    return cache


def _oauth_service(request: Request, auth: AuthService) -> OAuthService:
    cache = getattr(request.app.state, "_oauth_service", None)
    if cache is None:
        r = _router_for(request)
        cache = OAuthService(
            providers=_build_oauth_providers(),
            connections=OAuthConnectionStore(r),
            auth_repo=auth._repo,
            audit=LoginAuditRepository(r),
            issuer=auth.issue,
            deployment_tenant_id=_settings(request).manager_tenant_id,
            require_binding=True,
        )
        request.app.state._oauth_service = cache
    return cache


def _iso(v):
    return v.isoformat() if v is not None else None


# ---------------- passkey public ----------------
passkey_router = APIRouter(prefix="/api/auth/passkey", tags=["mfa", "passkey"])


@passkey_router.get(
    "/authentication-options",
    summary="生成 WebAuthn 登录选项（challenge）",
    description="按可信MANAGER_PUBLIC_ORIGIN的DNS RP生成挑战并绑定tenant；account限定active账号凭据，否则resident credential。缺合法origin/RP配置503，仅此能力不可用。",
    operation_id="manager_passkey_authentication_options",
    response_model_exclude_none=True,
)
async def passkey_authentication_options(
    tenant_id: str = Query(..., description="企业租户 ID。"),
    account: str | None = Query(default=None, description="可选员工账号；不传则使用 usernameless 模式。"),
    auth: AuthService = Depends(_auth_service),
    request: Request = None,
) -> Envelope[PasskeyOptionsOut]:
    require_bound_tenant(_settings(request).manager_tenant_id, tenant_id)
    svc = _passkey_service(request, auth)
    return Envelope[PasskeyOptionsOut](data=PasskeyOptionsOut.model_validate(svc.authentication_options(tenant_id, account)))


@passkey_router.post(
    "/login",
    summary="Passkey 登录（公开端点）",
    description="提交 WebAuthn 登录断言 + tenant_id；校验通过后 issue JWT access token。",
    operation_id="manager_passkey_login",
)
async def passkey_login(
    body: PasskeyLoginIn,
    auth: AuthService = Depends(_auth_service),
    request: Request = None,
) -> Envelope[AuthResult]:
    require_bound_tenant(_settings(request).manager_tenant_id, body.tenant_id)
    svc = _passkey_service(request, auth)
    payload = body.model_dump(exclude_none=True)
    return Envelope[AuthResult](data=svc.finish_login(tenant_id=body.tenant_id, payload=payload))


# ---------------- passkey protected (需 token) ----------------
passkey_mgmt_router = APIRouter(prefix="/api/manager/passkeys", tags=["mfa", "passkey"])


@passkey_mgmt_router.get(
    "",
    summary="列举当前用户已注册的 passkey 凭据",
    operation_id="manager_passkeys_list",
)
async def passkeys_list(
    request: Request,
    claims: TokenClaims = Depends(_require),  # noqa: ARG001
    auth: AuthService = Depends(_auth_service),
) -> Envelope[list[PasskeyCredentialOut]]:
    ctx = tenant_context_from(claims)
    store = PasskeyStore(_router_for(request))
    rows = store.list_for_user(ctx, claims.user_id)
    return Envelope[list[PasskeyCredentialOut]](data=[
        {"credential_id": r.credential_id, "label": r.label,
         "created_at": _iso(r.created_at), "last_used_at": _iso(r.last_used_at)}
        for r in rows
    ])


@passkey_mgmt_router.post(
    "/registration-options",
    summary="生成当前用户的 passkey 注册选项（challenge）",
    operation_id="manager_passkey_registration_options",
    response_model_exclude_none=True,
)
async def passkey_registration_options(
    request: Request,
    claims: TokenClaims = Depends(_require),  # noqa: ARG001
    auth: AuthService = Depends(_auth_service),
) -> Envelope[PasskeyOptionsOut]:
    ctx = tenant_context_from(claims)
    svc = _passkey_service(request, auth)
    return Envelope[PasskeyOptionsOut](data=PasskeyOptionsOut.model_validate(svc.registration_options(ctx, claims.user_id)))


@passkey_mgmt_router.post(
    "",
    summary="提交 passkey 注册响应，完成绑定",
    operation_id="manager_passkey_register",
    response_model_exclude_none=True,
)
async def passkey_register(
    body: PasskeyRegistrationFinishIn,
    request: Request,
    claims: TokenClaims = Depends(_require),  # noqa: ARG001
    auth: AuthService = Depends(_auth_service),
) -> Envelope[PasskeyCredentialResultOut]:
    label = (body.label or "").strip() or None
    ctx = tenant_context_from(claims)
    svc = _passkey_service(request, auth)
    result = svc.finish_registration(ctx, claims.user_id,
                                     {"label": label, "response": body.response})
    store = PasskeyStore(_router_for(request))
    cred = store.find_by_credential(tenant_context_from(claims), result["credential_id"])
    return Envelope[PasskeyCredentialResultOut](data=PasskeyCredentialResultOut(credential_id=result["credential_id"], label=cred.label if cred else result["label"]))


@passkey_mgmt_router.delete(
    "/{credential_id}",
    summary="删除当前用户某个 passkey 凭据",
    operation_id="manager_passkey_delete",
    response_model_exclude_none=True,
)
async def passkey_delete(
    credential_id: str,
    request: Request,
    claims: TokenClaims = Depends(_require),  # noqa: ARG001
    auth: AuthService = Depends(_auth_service),
) -> Envelope[PasskeyDeleteOut]:
    ctx = tenant_context_from(claims)
    store = PasskeyStore(_router_for(request))
    cred = store.find_by_credential(ctx, credential_id)
    if cred is None or cred.user_id != claims.user_id:
        raise NotFound("passkey not found")
    store.delete(ctx, credential_id=credential_id)
    return Envelope[PasskeyDeleteOut](data=PasskeyDeleteOut(deleted=True, credential_id=credential_id))


# ---------------- oauth public ----------------
oauth_router = APIRouter(prefix="/api/auth/oauth", tags=["mfa", "oauth"])


@oauth_router.get(
    "/providers",
    summary="列出当前已配置的 OAuth 提供方",
    operation_id="manager_oauth_providers",
)
async def oauth_providers(
    request: Request,
    auth: AuthService = Depends(_auth_service),
) -> Envelope[list[str]]:
    svc = _oauth_service(request, auth)
    return Envelope[list[str]](data=svc.provider_names())


@oauth_router.post(
    "/authorize",
    summary="生成 OAuth 授权跳转 URL（含 CSRF state）",
    operation_id="manager_oauth_authorize",
)
async def oauth_authorize(
    body: OAuthAuthorizeIn,
    request: Request,
    auth: AuthService = Depends(_auth_service),
) -> Envelope[OAuthAuthorizeOut]:
    require_bound_tenant(_settings(request).manager_tenant_id, body.tenant_id)
    svc = _oauth_service(request, auth)
    return Envelope[OAuthAuthorizeOut](data=OAuthAuthorizeOut(**svc.authorize(provider=body.provider, tenant_id=body.tenant_id,
                                                                                redirect_uri=body.redirect_uri, intent=body.intent,
                                                                                ctx=tenant_context_from(_require(request)) if body.intent == "link" else None)))


@oauth_router.post(
    "/callback",
    summary="OAuth 回调登录（公开端点）",
    description="仅消费一次有效login state（provider/tenant/可信redirect绑定），解析既有active Manager账号后签发JWT；不自动创建账号。浏览器须校验本地发起事务。",
    operation_id="manager_oauth_callback",
)
async def oauth_callback(
    body: OAuthCallbackIn,
    request: Request,
    auth: AuthService = Depends(_auth_service),
) -> Envelope[AuthResult]:
    svc = _oauth_service(request, auth)
    return Envelope[AuthResult](data=svc.callback(provider=body.provider, code=body.code, state=body.state))


# ---------------- oauth protected (需 token) ----------------
oauth_mgmt_router = APIRouter(prefix="/api/manager/oauth", tags=["mfa", "oauth"])


@oauth_mgmt_router.get(
    "/connections",
    summary="列举当前用户已绑定的第三方连接",
    operation_id="manager_oauth_connections",
)
async def oauth_connections(
    request: Request,
    claims: TokenClaims = Depends(_require),  # noqa: ARG001
    auth: AuthService = Depends(_auth_service),
) -> Envelope[list[OAuthConnectionOut]]:
    ctx = tenant_context_from(claims)
    svc = _oauth_service(request, auth)
    return Envelope[list[OAuthConnectionOut]](data=[OAuthConnectionOut(**item) for item in svc.list_connections(ctx, claims.user_id)])


@oauth_mgmt_router.post(
    "/link",
    summary="把第三方身份绑定到当前用户",
    description="必须active JWT与authorize(intent=link)的同用户/provider/tenant/redirect一次性state；旧无state请求422。",
    operation_id="manager_oauth_link",
)
async def oauth_link(
    body: OAuthLinkIn,
    request: Request,
    claims: TokenClaims = Depends(_require),  # noqa: ARG001
    auth: AuthService = Depends(_auth_service),
) -> Envelope[OAuthLinkOut]:
    ctx = tenant_context_from(claims)
    svc = _oauth_service(request, auth)
    return Envelope[OAuthLinkOut](data=OAuthLinkOut(**svc.link(ctx, provider=body.provider, code=body.code,
                                                               redirect_uri=body.redirect_uri, user_id=claims.user_id, state=body.state)))


@oauth_mgmt_router.delete(
    "/{provider}",
    summary="解绑当前用户的某第三方连接",
    operation_id="manager_oauth_unlink",
)
async def oauth_unlink(
    provider: str,
    request: Request,
    claims: TokenClaims = Depends(_require),  # noqa: ARG001
    auth: AuthService = Depends(_auth_service),
) -> Envelope[OAuthUnlinkOut]:
    ctx = tenant_context_from(claims)
    svc = _oauth_service(request, auth)
    ok = svc.unlink(ctx, provider=provider, user_id=claims.user_id)
    return Envelope[OAuthUnlinkOut](data=OAuthUnlinkOut(unlinked=ok, provider=provider))
