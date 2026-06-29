"""employee/expert 配置北向路由（M2，02 §10.1/§10.3 + 06 §7.6，D16）。

路径：/api/manager/employees/*。受保护端点（require_claims）；配置写操作需 owner/enterprise_admin。
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22）。

verifier 注入：本端 DevTokenService（骨架期）/ 生产 RS256 验签器由 app 持有，经 build_employee_router
闭包注入各端点依赖，避免依赖 app.state 时序。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.errors import AppError
from shared.db import PgTenantRouter

from .employee_config_service import EmployeeConfigService, build_employee_config_service
from .schemas import EmployeeConfigIn, EmployeeConfigOut


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> EmployeeConfigService:
    """从端配置构造 EmployeeConfigService；未配置业务 DB → 503（不静默，与 auth 路由一致）。"""
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_employee_config_service", None)
    if cache is None:
        cache = build_employee_config_service(PgTenantRouter(dsn))
        request.app.state._employee_config_service = cache
    return cache


def build_employee_router(verifier) -> APIRouter:
    """构造 employee 配置路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager/employees", tags=["manager", "employee-config"])
    require = require_claims(verifier)

    @router.post(
        "", description="请查看接口名称了解用途", summary="建 employee/expert 配置（runtime 中立）",
        operation_id="manager_employee_config_create", status_code=status.HTTP_201_CREATED,
    )
    async def create_employee_config(
        body: EmployeeConfigIn,
        employee_slug: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeConfigOut]:
        svc = _service(request)
        out = svc.create(tenant_context_from(claims), body, employee_slug=employee_slug)
        return Envelope[EmployeeConfigOut](data=out)

    @router.get(
        "", description="请查看接口名称了解用途", summary="列本租户全部 employee 配置",
        operation_id="manager_employee_config_list",
    )
    async def list_employee_config(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[EmployeeConfigOut]:
        svc = _service(request)
        items = svc.list_all(tenant_context_from(claims))
        return ListEnvelope[EmployeeConfigOut](data=items)

    @router.get(
        "/{employee_id}", description="请查看接口名称了解用途", summary="取单个 employee 配置",
        operation_id="manager_employee_config_get",
    )
    async def get_employee_config(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeConfigOut]:
        svc = _service(request)
        return Envelope[EmployeeConfigOut](data=svc.get(tenant_context_from(claims), employee_id=employee_id))

    @router.put(
        "/{employee_id}", description="请查看接口名称了解用途", summary="改写 employee 配置（version 自增）",
        operation_id="manager_employee_config_update",
    )
    async def update_employee_config(
        employee_id: str,
        body: EmployeeConfigIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeConfigOut]:
        svc = _service(request)
        return Envelope[EmployeeConfigOut](
            data=svc.update(tenant_context_from(claims), body, employee_id=employee_id)
        )

    @router.delete(
        "/{employee_id}", description="请查看接口名称了解用途", summary="删 employee 配置",
        operation_id="manager_employee_config_delete",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_employee_config(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete(tenant_context_from(claims), employee_id=employee_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
