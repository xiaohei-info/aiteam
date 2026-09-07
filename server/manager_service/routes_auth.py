"""Manager 认证北向路由（/api/auth/*，02 §10.1 路径前缀 + §10.3 envelope；03 §9.4/§9.6）。

公开端点（无需 token，§9.6）：login / owner-reset / resolve-tenant / resolve-tenant-by-account / jwks。
凭据校验失败 → 401；首登需重置 → 403；账号已存在 → 409；皆经统一 problem+json。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from shared.contracts.envelope import Envelope
from shared.errors import AppError

from .auth_service import AuthResult, AuthService, LoginInput, OwnerResetInput, build_auth_service
from .openapi_schemas import JwksOut


class ResolveTenantInput(BaseModel):
    """企业标识 → tenant_id 解析请求（登录前调用，隐藏 UUID 细节）。"""

    enterprise: str = Field(
        description="企业代码或企业名称（匹配 tenant_registry.enterprise_code 或 enterprise_slug）"
    )


class ResolveTenantOutput(BaseModel):
    """解析结果：tenant_id（登录时传给 login/owner-reset）。"""

    tenant_id: str



class ResolveTenantByAccountInput(BaseModel):
    """员工账号 → tenant_id 解析请求（登录前调用，隐藏 UUID 细节）。"""

    account: str = Field(
        description="员工账号（手机号或用户名，匹配 auth_identity.external_id）"
    )
    enterprise: str | None = Field(
        default=None,
        description="可选企业代码或名称；账号跨企业时必须提供以消除歧义",
    )


class ResolveTenantByAccountOutput(BaseModel):
    """解析结果：tenant_id（供 login / owner-reset 使用）。"""

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
    description="员工账号 → tenant_id 解析（登录前调用，隐藏 UUID 细节；#382）。"
              "账号跨企业时返回 tenant_selection_required 409，带 enterprise 后继续。",
    summary="解析员工账号到 tenant_id（公开端点，#382）",
    operation_id="manager_resolve_tenant_by_account",
)
async def resolve_tenant_by_account(
    body: ResolveTenantByAccountInput, svc: AuthService = Depends(_auth_service)
) -> Envelope[ResolveTenantByAccountOutput]:
    tenant_id = svc.resolve_tenant_by_account(body.account, body.enterprise)
    return Envelope[ResolveTenantByAccountOutput](data=ResolveTenantByAccountOutput(tenant_id=tenant_id))


@router.post("/login", description="成员或负责人使用企业标识或已解析 tenant 与账号密码登录。登录成功后返回带 tenant_id 的 JWT。", summary="成员/负责人登录（公开端点）", operation_id="manager_login")
async def login(body: LoginInput, svc: AuthService = Depends(_auth_service)) -> Envelope[AuthResult]:
    return Envelope[AuthResult](data=svc.login(body))


@router.post("/owner-reset", description="active账号以旧密码重置。请求携带企业标识或已解析 tenant。password_reset_required/password_expired提示重置；principal_inactive拒绝重置和签发。已签发离线JWT的expiry不变。", summary="负责人首登强制重置（公开端点）", operation_id="manager_owner_reset")
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
