"""GET /api/manager/me：当前登录者的企业与账号概览（顶栏、自助改密入口用）。任何角色可访问。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .me_service import MeService
from .openapi_schemas import MeOut
from .repository import TenantAuthRepository
from .settings_repository import SettingsRepository


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _registry_code_reader(admin_dsn: str | None):
    def read(tenant_id: str) -> str | None:
        if not admin_dsn:
            return None
        import psycopg

        try:
            with psycopg.connect(admin_dsn, autocommit=True) as conn:
                row = conn.execute(
                    "SELECT enterprise_code FROM tenant_registry WHERE tenant_id = %s", (tenant_id,),
                ).fetchone()
        except psycopg.Error:
            return None  # 企业代码只是顶栏的回退展示，读不到不应让整个页面失败
        return row[0] if row and row[0] else None

    return read


def _service(request: Request) -> MeService:
    cached = getattr(request.app.state, "_me_service", None)
    if cached is not None:
        return cached
    settings = request.app.state.settings
    if not settings.db_url:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    router = PgTenantRouter(settings.db_url)
    service = MeService(
        settings=SettingsRepository(router),
        auth=TenantAuthRepository(router),
        registry_code=_registry_code_reader(settings.admin_db_url),
    )
    request.app.state._me_service = service
    return service


def build_me_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager", tags=["manager", "me"])
    require = require_claims(verifier)

    @router.get(
        "/me",
        summary="当前登录者的企业与账号概览",
        description="返回企业名称/代码、脱敏账号、角色、是否有本地密码和密码策略。任何角色可读，只读。",
        operation_id="manager_me",
    )
    async def me(request: Request, claims: TokenClaims = Depends(require)) -> Envelope[MeOut]:
        return Envelope[MeOut](data=MeOut(**_service(request).get(tenant_context_from(claims))))

    return router
