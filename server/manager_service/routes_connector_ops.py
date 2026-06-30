"""Manager 企业端连接器操作路由（B05 连接器测试/状态/grants/预设）。

边界：Manager 管理连接器实例操作；连接器目录已在 capability catalog 管理。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .connector_ops_repository import ConnectorOpsRepository
from .connector_ops_service import ConnectorOpsService
from .routes_connector_schemas import (
    ConnectorGrantsPatch,
    ConnectorPreset,
    ConnectorStatusOut,
    ConnectorTestResult,
    PRESETS,
)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> ConnectorOpsService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_connector_ops_service", None)
    if cache is None:
        cache = ConnectorOpsService(ConnectorOpsRepository(PgTenantRouter(dsn)))
        request.app.state._connector_ops_service = cache
    return cache


def build_connector_ops_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/connectors", tags=["manager", "connector-ops"])
    require = require_claims(verifier)

    @router.get("/presets", summary="列出连接器预设", operation_id="manager_connector_presets")
    async def list_presets(claims: TokenClaims = Depends(require)) -> list[ConnectorPreset]:
        tenant_context_from(claims)
        return PRESETS

    @router.get("/{connector_id}/status", summary="连接器健康状态", operation_id="manager_connector_status")
    async def get_status(
        connector_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorStatusOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.get_status(ctx, connector_id)
        return Envelope(data=ConnectorStatusOut(**data))

    @router.post("/{connector_id}/test", summary="测试连接器", operation_id="manager_connector_test")
    async def test_connector(
        connector_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorTestResult]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.test_connector(ctx, connector_id)
        return Envelope(data=ConnectorTestResult(**data))

    @router.patch("/{connector_id}/grants", summary="设置连接器对员工可见性", operation_id="manager_connector_grants")
    async def patch_grants(
        connector_id: str,
        body: ConnectorGrantsPatch,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        return svc.set_grants(ctx, connector_id, body.employee_ids, body.action)

    return router
