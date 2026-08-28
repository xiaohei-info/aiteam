"""employee_prompt 版本管理北向路由（issue #303，06 §7.6 / 04 §6.1，D16/D22）。

路径：
  - POST   /api/manager/employees/{employee_id}/prompts                建 prompt（version=1）
  - GET    /api/manager/employees/{employee_id}/prompts                取当前 prompt head
  - PUT    /api/manager/employees/{employee_id}/prompts                更新 prompt（version+1）
  - DELETE /api/manager/employees/{employee_id}/prompts                删 prompt + 历史
  - GET    /api/manager/employees/{employee_id}/prompts/history        列版本历史
  - POST   /api/manager/employees/{employee_id}/prompts/rollback       回滚到某历史版本

统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22）。
verifier 注入：由 app 持有，经 build_employee_prompt_router 闭包注入各受保护端点。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .employee_prompt_service import EmployeePromptService, build_employee_prompt_service
from .schemas import (
    EmployeePromptHistoryOut,
    EmployeePromptIn,
    EmployeePromptOut,
    EmployeePromptRollbackIn,
)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> EmployeePromptService:
    """从端配置构造 EmployeePromptService；未配置业务 DB → 503（不静默，与 auth 路由一致）。"""
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_employee_prompt_service", None)
    if cache is None:
        cache = build_employee_prompt_service(PgTenantRouter(dsn))
        request.app.state._employee_prompt_service = cache
    return cache


def build_employee_prompt_router(verifier) -> APIRouter:
    """构造 employee_prompt 版本管理路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager/employees", tags=["manager", "employee-prompt"])
    require = require_claims(verifier)

    @router.post(
        "/{employee_id}/prompts",
        description="建 employee prompt（version=1，同时落 history v1）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="建 employee prompt（version=1，同时落 history v1）",
        operation_id="manager_employee_prompt_create",
        status_code=status.HTTP_201_CREATED,
    )
    async def create_prompt(
        employee_id: str,
        body: EmployeePromptIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeePromptOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        out = svc.create(ctx, body, employee_id=employee_id)
        return Envelope[EmployeePromptOut](data=out)

    @router.get(
        "/{employee_id}/prompts",
        description="取 employee prompt 当前 head。成功响应遵循统一 envelope，失败返回 problem+json。", summary="取 employee prompt 当前 head",
        operation_id="manager_employee_prompt_get",
    )
    async def get_prompt(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeePromptOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        out = svc.get(ctx, employee_id=employee_id)
        return Envelope[EmployeePromptOut](data=out)

    @router.put(
        "/{employee_id}/prompts",
        description="改写 employee prompt（version+1，旧版归档到 history）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="改写 employee prompt（version+1，旧版归档到 history）",
        operation_id="manager_employee_prompt_update",
    )
    async def update_prompt(
        employee_id: str,
        body: EmployeePromptIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeePromptOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        out = svc.update(ctx, body, employee_id=employee_id)
        return Envelope[EmployeePromptOut](data=out)

    @router.delete(
        "/{employee_id}/prompts",
        description="删 employee prompt head + history。成功响应遵循统一 envelope，失败返回 problem+json。", summary="删 employee prompt head + history",
        operation_id="manager_employee_prompt_delete",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_prompt(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        svc.delete(ctx, employee_id=employee_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.get(
        "/{employee_id}/prompts/history",
        description="列 employee prompt 全部历史版本（version_no 降序）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="列 employee prompt 全部历史版本（version_no 降序）",
        operation_id="manager_employee_prompt_history",
    )
    async def list_history(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[EmployeePromptHistoryOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_history(ctx, employee_id=employee_id)
        return ListEnvelope[EmployeePromptHistoryOut](data=items)

    @router.post(
        "/{employee_id}/prompts/rollback",
        description="回滚到某历史版本（产生新 version_no，不回退历史）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="回滚到某历史版本（产生新 version_no，不回退历史）",
        operation_id="manager_employee_prompt_rollback",
    )
    async def rollback_prompt(
        employee_id: str,
        body: EmployeePromptRollbackIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeePromptOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        out = svc.rollback(ctx, body, employee_id=employee_id)
        return Envelope[EmployeePromptOut](data=out)

    return router
