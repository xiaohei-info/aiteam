"""employee/expert 配置北向路由（M2，02 §10.1/§10.3 + 06 §7.6，D16）。

路径：/api/manager/employees/*。受保护端点（require_claims）；配置写操作需 owner/enterprise_admin。
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22）。

verifier 注入：本端 DevTokenService（骨架期）/ 生产 RS256 验签器由 app 持有，经 build_employee_router
闭包注入各端点依赖，避免依赖 app.state 时序。
"""

from __future__ import annotations

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.errors import AppError
from shared.db import PgTenantRouter

from .employee_config_service import EmployeeConfigService, build_employee_config_service
from .schemas import EmployeeConfigIn, EmployeeConfigOut


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


class _LifecycleValidationError(AppError):
    status, code, title = 422, "lifecycle_validation_error", "Lifecycle Validation Error"


class EmployeeTransitionIn(BaseModel):
    """请求体：archive 时提供 reason，其他 transition 留空即可。"""

    model_config = ConfigDict(extra="forbid")

    reason: str | None = None


class EmployeeLifecycleOptionsOut(BaseModel):
    """可用 transitions + 运行前检查出参。"""

    model_config = ConfigDict(extra="forbid")

    employee_id: str
    status: str
    allowed_transitions: list[str]
    is_runnable: bool
    is_provisionable: bool




def _service(request: Request) -> EmployeeConfigService:
    """从端配置构造 EmployeeConfigService；未配置业务 DB → 503（不静默，与 auth 路由一致）。"""
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_employee_config_service", None)
    if cache is None:
        # Minimal integration apps may mount this router without the full Manager
        # startup state; absence means no catalog validation for that isolated app.
        cache = build_employee_config_service(
            PgTenantRouter(dsn), getattr(request.app.state, "_operator_catalog", None)
        )
        request.app.state._employee_config_service = cache
    return cache


def build_employee_router(verifier) -> APIRouter:
    """构造 employee 配置路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager/employees", tags=["manager", "employee-config"])
    require = require_claims(verifier)

    @router.post(
        "", description="建 employee/expert 配置（runtime 中立）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="建 employee/expert 配置（runtime 中立）",
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
        "", description="列本租户全部 employee 配置。成功响应遵循统一 envelope，失败返回 problem+json。", summary="列本租户全部 employee 配置",
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
        "/{employee_id}", description="取单个 employee 配置。成功响应遵循统一 envelope，失败返回 problem+json。", summary="取单个 employee 配置",
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
        "/{employee_id}", description="改写 employee 配置（version 自增）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="改写 employee 配置（version 自增）",
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
        "/{employee_id}", description="删 employee 配置。成功响应遵循统一 envelope，失败返回 problem+json。", summary="删 employee 配置",
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

    @router.get(
        "/export/all",
        summary="导出员工列表 CSV",
        description="导出当前企业员工配置的 CSV 文件；不包含凭据。",
        operation_id="manager_employee_export",
        responses={200: {"content": {"text/csv": {"schema": {"type": "string", "format": "binary", "description": "员工配置 CSV 文件。"}}}}},
    )
    async def export_employees(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        items = svc.list_all(tenant_context_from(claims))
        import csv
        import io
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["employee_id", "employee_slug", "display_name", "model", "provider_ref", "thinking_level", "skills", "version"])
        for it in items:
            writer.writerow([
                it.employee_id, it.employee_slug, it.display_name,
                it.model or "", it.provider_ref or "", it.thinking_level or "",
                ",".join(it.skills), it.version,
            ])
        return Response(
            content=buf.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=employees.csv"},
        )
    @router.post(
        "/{employee_id}/transitions/{transition}",
        description="employee 生命周期流转（状态机校验 + 行锁 + 落库）。"
        "transition 取值：provision/activate/pause/resume/archive/retry_provision/mark_provisioning_failed。",
        summary="生命周期状态流转（issue #281）",
        operation_id="manager_employee_lifecycle_transition",
    )
    async def employee_lifecycle_transition(
        employee_id: str,
        transition: str,
        body: "EmployeeTransitionIn | None" = None,
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeConfigOut]:
        svc = _service(request)
        reason = body.reason if body is not None else None
        if transition == "archive" and not reason:
            raise _LifecycleValidationError("archive transition requires 'reason' in body")
        out = svc.transition(
            tenant_context_from(claims),
            employee_id=employee_id,
            transition=transition,
            archive_reason=reason,
        )
        return Envelope[EmployeeConfigOut](data=out)

    @router.get(
        "/{employee_id}/transitions",
        description="查询 employee 当前可执行的 transitions + 运行前检查（is_runnable / is_provisionable）。",
        summary="查询可用 lifecycle transitions（issue #281）",
        operation_id="manager_employee_lifecycle_options",
    )
    async def employee_lifecycle_options(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeLifecycleOptionsOut]:
        svc = _service(request)
        row = svc.get(tenant_context_from(claims), employee_id=employee_id)
        from shared.contracts.enums import EmployeeStatus
        from . import employee_lifecycle as _lc
        st = EmployeeStatus(row.status)
        allowed = [t for t in _lc.ALLOWED_TRANSITION_LABELS if _lc.can_transition(st, t)]
        opts = EmployeeLifecycleOptionsOut(
            employee_id=employee_id,
            status=row.status,
            allowed_transitions=allowed,
            is_runnable=_lc.is_runnable(st),
            is_provisionable=_lc.is_provisionable(st),
        )
        return Envelope[EmployeeLifecycleOptionsOut](data=opts)

    return router
