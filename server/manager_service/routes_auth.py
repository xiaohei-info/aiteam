"""Manager 认证北向路由（/api/auth/*，02 §10.1 路径前缀 + §10.3 envelope；03 §9.4/§9.6）。

公开端点（无需 token，§9.6）：login / owner-reset / jwks。
凭据校验失败 → 401；首登需重置 → 403；账号已存在 → 409；皆经统一 problem+json。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.contracts.envelope import Envelope
from shared.errors import AppError

from .auth_service import AuthResult, AuthService, LoginInput, OwnerResetInput, build_auth_service


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _auth_service(request: Request) -> AuthService:
    """从端配置取 DB 连接串构造 AuthService；未配置则 503（不静默）。"""
    settings = request.app.state.settings
    dsn = settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_auth_service", None)
    if cache is None:
        cache = build_auth_service(dsn)
        request.app.state._auth_service = cache
    return cache


router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", summary="成员/负责人登录（公开端点）", operation_id="manager_login")
async def login(body: LoginInput, svc: AuthService = Depends(_auth_service)) -> Envelope[AuthResult]:
    return Envelope[AuthResult](data=svc.login(body))


@router.post("/owner-reset", summary="负责人首登强制重置（公开端点）", operation_id="manager_owner_reset")
async def owner_reset(body: OwnerResetInput, svc: AuthService = Depends(_auth_service)) -> Envelope[AuthResult]:
    return Envelope[AuthResult](data=svc.owner_reset(body))


@router.get("/{tenant_id}/jwks.json", summary="下发 tenant 验签公钥（JWKS）", operation_id="manager_jwks")
async def jwks(tenant_id: str, svc: AuthService = Depends(_auth_service)) -> dict:
    # JWKS 是公开验签材料（公钥），可下发用户端本地验签（D23）。
    return svc.jwks(tenant_id)
