"""Manager 企业端组织架构路由（P07 配置态 / B01 部门分配）。

边界：Manager 管理组织树（配置态），Agent 端只做本地投影展示。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .org_service import OrgService
from .routes_org_schemas import OrgAssignmentPatch, OrgTreeNode


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> OrgService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_org_service", None)
    if cache is None:
        cache = OrgService(PgTenantRouter(dsn))
        request.app.state._org_service = cache
    return cache


def build_org_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/org", tags=["manager", "org"])
    require = require_claims(verifier)

    @router.get("/tree", summary="获取组织树", operation_id="manager_org_tree")
    async def get_org_tree(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[OrgTreeNode]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        tree = svc.build_tree(ctx)
        return Envelope(data=OrgTreeNode(**tree))

    @router.patch("/assignments/{employee_id}", summary="调整员工部门", operation_id="manager_org_assignment_patch")
    async def patch_assignment(
        employee_id: str,
        body: OrgAssignmentPatch,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        return Envelope(data=svc.update_assignment(ctx, employee_id, body.department_id))

    return router
