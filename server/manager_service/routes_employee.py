"""employee/expert 配置北向路由（M2，02 §10.1/§10.3 + 06 §7.6，D16）。

路径：/api/manager/employees/*。受保护端点（require_claims）；配置写操作需 owner/enterprise_admin。
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22）。

verifier 注入：本端 DevTokenService（骨架期）/ 生产 RS256 验签器由 app 持有，经 build_employee_router
闭包注入各端点依赖，避免依赖 app.state 时序。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.errors import AppError
from shared.db import PgTenantRouter

from .active_principal import require_admin
from .catalog_scope_wiring import reconcile_for_admin
from .employee_config_service import EmployeeConfigService, build_employee_config_service
from .employee_copy_service import EmployeeCopyService, build_employee_copy_service
from .schemas import EmployeeConfigIn, EmployeeConfigOut, EmployeeCopyIn
from .avatar_schemas import EmployeeAvatarIn, EmployeeAvatarOut
from .employee_avatar_repository import EmployeeAvatarRepository
from .employee_avatar_service import EmployeeAvatarService, avatar_content_path
from .knowledge_intake_service import ensure_storage_root, manager_storage_root


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


def _avatar_service(request: Request) -> EmployeeAvatarService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_employee_avatar_service", None)
    if cache is None:
        root = ensure_storage_root(manager_storage_root(request.app.state.settings))
        cache = EmployeeAvatarService(EmployeeAvatarRepository(PgTenantRouter(dsn)), root)
        request.app.state._employee_avatar_service = cache
    return cache


logger = logging.getLogger(__name__)


def _with_avatars(request: Request, ctx, items: list[EmployeeConfigOut]) -> list[EmployeeConfigOut]:
    """给列表/详情补上头像路径。头像不是主链：读失败时照常返回，前端显示占位。"""
    try:
        urls = _avatar_service(request).avatar_urls(ctx)
    except Exception:
        logger.warning("employee avatar lookup failed; list returned without avatars", exc_info=True)
        return items
    return [item.model_copy(update={"avatar_url": urls.get(item.employee_id)}) for item in items]


def _copy_service(request: Request) -> EmployeeCopyService:
    cache = getattr(request.app.state, "_employee_copy_service", None)
    if cache is None:
        cache = build_employee_copy_service(
            PgTenantRouter(request.app.state.settings.db_url),
            getattr(request.app.state, "_operator_catalog", None),
            _avatar_service(request), _service(request),
        )
        request.app.state._employee_copy_service = cache
    return cache


def build_employee_router(verifier) -> APIRouter:
    """构造 employee 配置路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager/employees", tags=["manager", "employee-config"])
    require = require_claims(verifier)

    @router.post(
        "", description="建 employee/expert 配置（runtime 中立）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="建 employee/expert 配置（runtime 中立）",
        operation_id="manager_employee_config_create", status_code=status.HTTP_201_CREATED,
    )
    def create_employee_config(
        body: EmployeeConfigIn,
        employee_slug: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeConfigOut]:
        require_admin(tenant_context_from(claims))
        svc = _service(request)
        out = svc.create(tenant_context_from(claims), body, employee_slug=employee_slug, with_status=True)
        return Envelope[EmployeeConfigOut](data=out)

    @router.get(
        "", description="仅owner/enterprise_admin列本租户全部 employee 配置。成功响应遵循统一 envelope，失败返回 problem+json。", summary="列本租户全部 employee 配置",
        operation_id="manager_employee_config_list",
    )
    def list_employee_config(
        request: Request,
        background: BackgroundTasks,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[EmployeeConfigOut]:
        ctx = tenant_context_from(claims)
        require_admin(ctx)
        items = _with_avatars(request, ctx, _service(request).list_all(ctx, with_status=True))
        # 发布范围对账要调运营端：放到响应之后，运营端慢或不可用时列表照常返回；结果在下次打开时可见。
        background.add_task(reconcile_for_admin, request, ctx)
        return ListEnvelope[EmployeeConfigOut](data=items)

    @router.post(
        "/{employee_id}/copy",
        description="复制专家为企业自建专家（草稿）：带走配置、prompt、技能/知识/连接器绑定与头像，不带成员授权与个人记忆。必须带 Idempotency-Key。",
        summary="复制专家", operation_id="manager_employee_copy", status_code=status.HTTP_201_CREATED,
    )
    def copy_employee(  # 同步读库、调运营端目录、复制头像：普通函数由框架放到线程池
        employee_id: str,
        body: EmployeeCopyIn,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeConfigOut]:
        ctx = tenant_context_from(claims)
        require_admin(ctx)
        out = _copy_service(request).copy(
            ctx, source_id=employee_id, display_name=body.display_name,
            model_policy=body.model_policy, idempotency_key=idempotency_key or "",
        )
        return Envelope[EmployeeConfigOut](data=_with_avatars(request, ctx, [out])[0])

    @router.get(
        "/{employee_id}", description="仅owner/enterprise_admin取单个 employee 配置。成功响应遵循统一 envelope，失败返回 problem+json。", summary="取单个 employee 配置",
        operation_id="manager_employee_config_get",
    )
    def get_employee_config(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeConfigOut]:
        ctx = tenant_context_from(claims)
        require_admin(ctx)
        out = _service(request).get(ctx, employee_id=employee_id, with_status=True)
        return Envelope[EmployeeConfigOut](data=_with_avatars(request, ctx, [out])[0])

    @router.post(
        "/{employee_id}/avatar",
        description=(
            "上传员工头像（仅企业自建员工，origin=custom；来自专家模板的员工固定使用模板头像，返回 409）。"
            "仅 owner/enterprise_admin 可操作。服务端转静态 WebP，存为该员工唯一的头像文件；"
            "内容变化时 version +1。"
        ),
        summary="更新员工头像",
        operation_id="manager_employee_avatar_update",
        status_code=status.HTTP_200_OK,
        response_model=Envelope[EmployeeAvatarOut],
    )
    def update_employee_avatar(
        employee_id: str,
        body: EmployeeAvatarIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeAvatarOut]:
        ctx = tenant_context_from(claims)
        require_admin(ctx)
        row = _avatar_service(request).update(ctx, employee_id=employee_id, mime_type=body.mime_type, data=body.data)
        # Audit metadata only; raw image data never enters the audit log.
        try:
            from .audit_repository import AuditRepository
            AuditRepository(PgTenantRouter(request.app.state.settings.db_url)).create_event(
                ctx,
                event_type="employee_avatar_updated",
                actor_id=ctx.user_id,
                target_type="employee",
                target_id=employee_id,
                detail={"version": row.version, "mime_type": body.mime_type, "byte_size": row.byte_size},
            )
        except Exception:
            # The avatar write is already durable; audit failures are surfaced by
            # the service logs in deployments that install an audit sink.
            pass
        return Envelope[EmployeeAvatarOut](data=EmployeeAvatarOut(
            employee_id=row.employee_id, avatar_url=avatar_content_path(row.employee_id, row.version),
            version=row.version, updated_at=row.updated_at,
        ))

    @router.get(
        "/{employee_id}/avatar/content",
        description="读取当前租户员工头像文件（静态 WebP）。响应头 X-Avatar-Version 为当前头像版本，调用方按版本缓存。",
        summary="读取员工头像对象",
        operation_id="manager_employee_avatar_content",
        response_class=Response,
        responses={
            200: {
                "content": {"image/webp": {"schema": {"type": "string", "format": "binary"}}},
            },
        },
    )
    def get_employee_avatar_content(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        ctx = tenant_context_from(claims)
        result = _avatar_service(request).content(ctx, employee_id)
        if result is None:
            from shared.errors import NotFound
            raise NotFound("employee avatar not found")
        return Response(content=result.data, media_type=result.mime_type, headers={
            "Cache-Control": "private, max-age=86400",
            "ETag": f'"{result.sha256}"',
            "X-Avatar-Version": str(result.version),
            "X-Content-Type-Options": "nosniff",
        })

    @router.put(
        "/{employee_id}", description="完整替换 employee 配置；role_title 省略或 null 清空岗位，department_ids 省略或 [] 清空全部部门。实际配置变化时 version 自增，授权增量 pull 可感知；需 owner/enterprise_admin。成功响应遵循统一 envelope，失败返回 problem+json。", summary="改写 employee 配置（version 自增）",
        operation_id="manager_employee_config_update",
    )
    def update_employee_config(
        employee_id: str,
        body: EmployeeConfigIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeConfigOut]:
        ctx = tenant_context_from(claims)
        require_admin(ctx)
        out = _service(request).update(ctx, body, employee_id=employee_id, with_status=True)
        return Envelope[EmployeeConfigOut](data=_with_avatars(request, ctx, [out])[0])

    @router.delete(
        "/{employee_id}", description="删 employee 配置。成功响应遵循统一 envelope，失败返回 problem+json。", summary="删 employee 配置",
        operation_id="manager_employee_config_delete",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_employee_config(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        require_admin(tenant_context_from(claims))
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
    def export_employees(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        require_admin(tenant_context_from(claims))
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
    def employee_lifecycle_transition(
        employee_id: str,
        transition: str,
        body: "EmployeeTransitionIn | None" = None,
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeConfigOut]:
        require_admin(tenant_context_from(claims))
        svc = _service(request)
        reason = body.reason if body is not None else None
        if transition == "archive" and not reason:
            raise _LifecycleValidationError("archive transition requires 'reason' in body")
        ctx = tenant_context_from(claims)
        out = svc.transition(
            ctx,
            employee_id=employee_id,
            transition=transition,
            archive_reason=reason,
        )
        return Envelope[EmployeeConfigOut](data=_with_avatars(request, ctx, [out])[0])

    @router.get(
        "/{employee_id}/transitions",
        description="查询 employee 当前可执行的 transitions + 运行前检查（is_runnable / is_provisionable）。",
        summary="查询可用 lifecycle transitions（issue #281）",
        operation_id="manager_employee_lifecycle_options",
    )
    def employee_lifecycle_options(
        employee_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EmployeeLifecycleOptionsOut]:
        require_admin(tenant_context_from(claims))
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
