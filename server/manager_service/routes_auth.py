"""Manager 认证北向路由（/api/auth/*，02 §10.1 路径前缀 + §10.3 envelope；03 §9.4/§9.6）。

公开端点（无需 token，§9.6）：login / owner-reset / resolve-tenant / jwks；resolve-tenant-by-account 已停用（固定 410）。
凭据校验失败 → 401；首登需重置 → 403；账号已存在 → 409；皆经统一 problem+json。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.errors import AppError

from .auth_service import (
    CLIENT_UPGRADE_DETAIL,
    AuthResult,
    AuthService,
    ClientUpgradeRequired,
    LoginInput,
    OwnerResetInput,
    build_auth_service,
)
from .openapi_schemas import JwksOut


class ResolveTenantInput(BaseModel):
    """企业标识 → tenant_id 解析请求（登录前调用，隐藏 UUID 细节）。"""

    enterprise: str = Field(
        description="企业代码或企业名称（匹配 tenant_registry.enterprise_code 或 enterprise_slug）"
    )


class ChangePasswordInput(BaseModel):
    """自助设置新密码。"""

    model_config = ConfigDict(extra="forbid")

    old_password: str = Field(description="当前密码")
    new_password: str = Field(description="新密码，需满足企业密码策略")


class ResolveTenantOutput(BaseModel):
    """解析结果：tenant_id（登录时传给 login/owner-reset）。"""

    tenant_id: str



class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _auth_service(request: Request) -> AuthService:
    """从端配置取 DB 连接串构造 AuthService；未配置则 503（不静默）。

    业务连接走 db_url（app_rw 身份）；签名私钥库走 admin_db_url（管理连接，#60）。
    """
    settings = request.app.state.settings
    dsn = settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    admin_dsn = settings.admin_db_url
    if not admin_dsn:
        raise _ManagerNotConfigured("Manager 管理 DB 未配置（设置 ADMIN_DB_URL）")
    cache = getattr(request.app.state, "_auth_service", None)
    if cache is None:
        cache = build_auth_service(dsn, admin_dsn=admin_dsn)
        request.app.state._auth_service = cache
    return cache


router = APIRouter(prefix="/api/auth", tags=["auth"])



@router.post(
    "/resolve-tenant-by-account",
    description="已停用：旧版客户端「凭账号查企业」入口。不再查询账号，不论账号是否存在都固定返回 410 "
              "client_upgrade_required（客户端版本过旧，请升级后登录）。新版客户端直接调用 login，"
              "未填企业标识时由登录接口按账号和密码匹配企业。",
    summary="已停用：解析员工账号到 tenant_id（固定 410）",
    operation_id="manager_resolve_tenant_by_account",
    deprecated=True,
    status_code=410,
)
async def resolve_tenant_by_account() -> None:
    # 不读请求体、不连库：响应与账号是否存在、是否配置数据库都无关。
    raise ClientUpgradeRequired(CLIENT_UPGRADE_DETAIL)


@router.post("/login", description="成员或负责人登录。可带企业标识或 tenant_id；都不带时按账号和密码匹配企业：只有一个企业密码通过则直接登录，多个则 409 tenant_selection_required 并在 meta.candidates 列出密码通过的企业（tenant_id + enterprise_name），再带 tenant_id 重试。账号不存在与密码错误返回相同的 401。需要改密时 403 的 meta.tenant_id 指明企业。", summary="成员/负责人登录（公开端点）", operation_id="manager_login")
async def login(body: LoginInput, svc: AuthService = Depends(_auth_service)) -> Envelope[AuthResult]:
    return Envelope[AuthResult](data=svc.login(body))


@router.get("/session", description="验证当前 JWT 对应的服务端认证会话仍处于 active。", summary="验证认证会话", operation_id="manager_auth_session")
async def session(request: Request) -> Envelope[TokenClaims]:
    claims = require_claims(request.app.state._token_verifier)(request)
    return Envelope[TokenClaims](data=claims)


@router.post("/logout", description="撤销当前 JWT 对应的服务端认证会话。", summary="注销当前认证会话", operation_id="manager_logout")
async def logout(request: Request, svc: AuthService = Depends(_auth_service)) -> Envelope[dict[str, bool]]:
    claims = require_claims(request.app.state._token_verifier)(request)
    svc.revoke(claims, reason="user_logout")
    return Envelope[dict[str, bool]](data={"signed_out": True})


@router.post("/password", description="已登录成员自助设置新密码：校验旧密码，成功后吊销该成员其它会话（当前会话保留）。连续输错旧密码 5 次（15 分钟内）返回 429。仅第三方登录的账号返回 409。", summary="自助设置新密码", operation_id="manager_change_password")
async def change_password(
    body: ChangePasswordInput, request: Request, svc: AuthService = Depends(_auth_service)
) -> Envelope[dict[str, bool]]:
    claims = require_claims(request.app.state._token_verifier)(request)
    svc.change_password(claims, old_password=body.old_password, new_password=body.new_password)
    return Envelope[dict[str, bool]](data={"changed": True})


@router.post("/owner-reset", description="active账号以旧密码重置。请求携带企业标识或已解析 tenant。password_reset_required/password_expired提示重置；principal_inactive拒绝重置和签发。已签发 JWT 会话会撤销。", summary="负责人首登强制重置（公开端点）", operation_id="manager_owner_reset")
async def owner_reset(body: OwnerResetInput, svc: AuthService = Depends(_auth_service)) -> Envelope[AuthResult]:
    return Envelope[AuthResult](data=svc.owner_reset(body))


@router.get("/{tenant_id}/jwks.json", description="下发指定 tenant 的验签公钥（JWKS 格式）。用户端凭此本地验签。", summary="下发 tenant 验签公钥（JWKS）", operation_id="manager_jwks", response_model=JwksOut, response_model_exclude_none=True)
async def jwks(tenant_id: str, svc: AuthService = Depends(_auth_service)) -> JwksOut:
    # JWKS 是公开验签材料（公钥），可下发用户端本地验签（D23）。
    return JwksOut.model_validate(svc.jwks(tenant_id))


@router.post("/resolve-tenant", description="企业代码/名称 → tenant_id 解析（登录前调用，隐藏 UUID 细节）。代码精确匹配优先；slug 歧义返回 enterprise_ambiguous 409。不使用 Host 或第一行 registry。", summary="解析企业标识到 tenant（公开端点）", operation_id="manager_resolve_tenant")
async def resolve_tenant(
    body: ResolveTenantInput, svc: AuthService = Depends(_auth_service)
) -> Envelope[ResolveTenantOutput]:
    tenant_id = svc.resolve_tenant(body.enterprise)
    return Envelope[ResolveTenantOutput](data=ResolveTenantOutput(tenant_id=tenant_id))
