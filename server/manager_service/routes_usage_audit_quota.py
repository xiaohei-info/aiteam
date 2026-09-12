"""企业级 usage/audit rollup + 软配额治理北向路由（M8，02 §10.1/§10.3 + 04 §6.5/§6.5.1，D13/D24）。

路径：
- /api/manager/usage/upload       接收 A5 上报的脱敏 UsageSummaryUpload（F13，本端消费落库聚合）
- /api/manager/usage/statistics  查保留小时摘要的成员/员工统计
- /api/manager/usage/work-history 查 Manager 持有的脱敏用量元数据历史
- /api/manager/usage/rollup       查本租户 usage 聚合 / 明细
- /api/manager/usage/operator-deliveries 查 Manager→Operator 持久投递收据
- /api/manager/audits             查本租户审计事件摘要
- /api/manager/quota-policies     软配额策略 CRUD + 评估（软治理动作）
- /api/manager/run-events         运行事件明细归档（脱敏，issue #292）
- /api/manager/usage-ledger       逐 token 计费明细（issue #292）

受保护端点（require_claims）；配额写操作限 owner/enterprise_admin/finance_admin。
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 全程经 TenantContext（D22）。

红线（D13/D24）：
- upload 只接收脱敏聚合摘要，消费端不存会话内容（service 层断言拒绝会话内容字段）。
- 配额治理默认软动作（告警/限流建议），不每 run 强领 quota lease（D14 离线可用性）。

verifier 注入：本端 DevTokenService（骨架期）/ 生产 RS256 验签器由 app 持有，经
build_usage_audit_quota_router 闭包注入各端点依赖（照 build_employee_router 模式）。
"""

from __future__ import annotations

from datetime import datetime
import logging
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import authorize, require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.tenancy import TenantContext
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError, Forbidden, ValidationProblem

from .usage_analytics_schemas import (
    UsageOperatorDeliveryOut,
    UsageStatisticsOut,
    UsageWorkHistoryOut,
)
from .usage_delivery_repository import UsageOperatorDeliveryRepository
from .usage_delivery_service import (
    UsageOperatorDeliveryService,
    build_usage_operator_delivery_service,
)

from .schemas import (
    AuditSummaryOut,
    QuotaEnforcementActionOut,
    QuotaPolicyIn,
    QuotaPolicyOut,
    UsageAggregateOut,
    UsageRollupOut,
)
from .openapi_schemas import UsageRollupItemsOut, UsageUploadDetailedOut, UsageUploadOut
from .usage_audit_quota_service import (
    UsageAuditQuotaService,
    build_usage_audit_quota_service,
)

logger = logging.getLogger(__name__)

_USAGE_ANALYTICS_ROLES = ["owner", "enterprise_admin", "finance_admin"]
_USAGE_ADMIN_ROLES = frozenset(_USAGE_ANALYTICS_ROLES)


def _usage_member_scope(claims: TokenClaims, requested: str | None) -> str | None:
    """Allow tenant-wide usage only to admins; members may read their own rows."""

    if set(claims.roles) & _USAGE_ADMIN_ROLES:
        return requested
    if requested is not None and requested != claims.user_id:
        raise Forbidden("usage reads may only target the authenticated member")
    return claims.user_id


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


# F13 上报体（对齐 shared.contracts.crosstier.UsageSummaryUpload 形状；只 import 契约语义，
# 此处用一个**无会话内容字段**的薄 schema 作为 HTTP 入参边界，落库前由 service 层红线断言）。
class UsageSummaryUploadIn(BaseModel):
    """脱敏用量上报体（F13）。只承载脱敏聚合摘要，不含会话内容（D13）。"""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str | None = Field(default=None, description="可选租户标识；省略时绑定当前 TenantContext，提供时必须匹配")
    usage: list[dict[str, Any]] = Field(default_factory=list, description="脱敏 UsageSummary 列表")
    audits: list[dict[str, Any]] = Field(default_factory=list, description="脱敏 AuditSummaryEvent 列表")


def _service(request: Request) -> UsageAuditQuotaService:
    """从端配置构造 UsageAuditQuotaService；未配置业务 DB → 503（不静默）。"""
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_usage_audit_quota_service", None)
    if cache is None:
        cache = build_usage_audit_quota_service(PgTenantRouter(dsn))
        request.app.state._usage_audit_quota_service = cache
    return cache


def _lookup_enterprise_id(request: Request, tenant_id: str) -> str | None:
    """Read the Manager tenant mapping from the control DB, best effort."""

    settings = request.app.state.settings
    admin_db_url = settings.admin_db_url
    if not admin_db_url or not settings.operator_url:
        return None
    try:
        import psycopg

        with psycopg.connect(admin_db_url, autocommit=True) as connection:
            row = connection.execute(
                "SELECT enterprise_id::text FROM tenant_registry WHERE tenant_id = %s::uuid",
                (tenant_id,),
            ).fetchone()
        return str(row[0]) if row and row[0] else None
    except Exception:  # noqa: BLE001 - a mapping outage must not reject Agent usage
        logger.warning("usage delivery enterprise mapping lookup deferred", extra={"tenant_id": tenant_id})
        return None


def _operator_delivery_service(request: Request) -> UsageOperatorDeliveryService | None:
    """Lazily share the signed Manager -> Operator delivery worker/service."""

    service = getattr(request.app.state, "_usage_operator_delivery_service", None)
    if service is not None:
        return service
    service = build_usage_operator_delivery_service(request.app.state.settings)
    if service is not None:
        request.app.state._usage_operator_delivery_service = service
    return service


def _report_to_operator(request: Request, service: UsageAuditQuotaService, ctx: TenantContext) -> None:
    """Best-effort immediate delivery hint; durable rows are retried by the worker."""

    del service  # usage rows/outbox were committed before this hint runs
    delivery = _operator_delivery_service(request)
    if delivery is None:
        return
    delivery.deliver_due(ctx)


def build_usage_audit_quota_router(verifier) -> APIRouter:
    """构造 usage/audit/quota 路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager", tags=["manager", "usage-audit-quota"])
    require = require_claims(verifier)

    # ---- F13 用量上报（接收 A5 上报的脱敏摘要，落库聚合）----

    @router.post(
        "/usage/upload",
        description="接收 Agent 上报的脱敏 usage/audit 聚合摘要并写入企业级汇总；不接收会话内容。", summary="接收脱敏 usage/audit 摘要上报（F13，本端消费落库聚合）",
        operation_id="manager_usage_upload",
    )
    async def upload_usage(
        body: UsageSummaryUploadIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[UsageUploadOut | UsageUploadDetailedOut]:
        svc = _service(request)
        ctx = tenant_context_from(claims)
        if body.tenant_id is not None and body.tenant_id != ctx.tenant_id:
            raise Forbidden("usage tenant_id must match the authenticated tenant")
        enterprise_id = _lookup_enterprise_id(request, ctx.tenant_id)
        upload = body.model_dump(exclude={"tenant_id"})
        if enterprise_id is None:
            result = svc.ingest_upload(ctx, upload)
        else:
            result = svc.ingest_upload(ctx, upload, enterprise_id=enterprise_id)
        try:
            _report_to_operator(request, svc, ctx)
        except Exception:  # best effort; Agent outbox already has durable retry semantics
            logger.warning("usage rollup upload to Operator deferred", extra={"tenant_id": ctx.tenant_id}, exc_info=True)
        if "usage_ingested" in result or "audits_ingested" in result:
            data = UsageUploadDetailedOut(**result)
        else:
            data = UsageUploadOut(**result)
        return Envelope[UsageUploadOut | UsageUploadDetailedOut](data=data)

    # ---- Manager enterprise usage/work statistics ----

    @router.get(
        "/usage/statistics",
        description=(
            "查询本租户保留的 Agent 小时用量摘要；可按 member_id/employee_id 和 UTC 整点 "
            "[window_start,window_end) 过滤。统计包含已接收的全部 Manager 聚合，不受 Operator delivery 状态影响；"
            "task_count 在没有可靠任务事件时为 null。"
        ),
        summary="查询租户小时用量统计",
        operation_id="manager_usage_statistics",
        response_model_exclude_none=False,
    )
    async def get_usage_statistics(
        request: Request,
        employee_id: str | None = Query(default=None, description="可选员工 ID；缺失历史归属保持 null。"),
        member_id: str | None = Query(default=None, description="可选成员 ID；旧摘要缺失归属保持 null。"),
        window_start: datetime | None = Query(default=None, description="UTC 整点包含起点；必须与 window_end 成对。"),
        window_end: datetime | None = Query(default=None, description="UTC 整点不包含终点；必须与 window_start 成对。"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[UsageStatisticsOut]:
        authorize(claims, _USAGE_ANALYTICS_ROLES)
        svc = _service(request)
        data = svc.statistics(
            tenant_context_from(claims),
            employee_id=employee_id,
            member_id=member_id,
            window_start=window_start,
            window_end=window_end,
        )
        return Envelope[UsageStatisticsOut](data=data)

    @router.get(
        "/usage/work-history",
        description=(
            "查询 Manager 实际持有的脱敏小时用量/工作元数据；不返回 Agent 会话 entries、工具事件或正文。"
            "范围使用 UTC 整点 [window_start,window_end)，不制造分钟级 totals；缺少可靠任务事件时 task_count 为 null。"
        ),
        summary="查询租户脱敏用量工作历史",
        operation_id="manager_usage_work_history",
        response_model_exclude_none=False,
    )
    async def get_usage_work_history(
        request: Request,
        employee_id: str | None = Query(default=None, description="可选员工 ID。"),
        member_id: str | None = Query(default=None, description="可选成员 ID。"),
        window_start: datetime | None = Query(default=None, description="UTC 整点包含起点；必须与 window_end 成对。"),
        window_end: datetime | None = Query(default=None, description="UTC 整点不包含终点；必须与 window_start 成对。"),
        limit: int = Query(default=200, ge=1, le=500, description="最多返回 500 条小时摘要。"),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[UsageWorkHistoryOut]:
        authorize(claims, _USAGE_ANALYTICS_ROLES)
        svc = _service(request)
        data = svc.work_history(
            tenant_context_from(claims),
            employee_id=employee_id,
            member_id=member_id,
            window_start=window_start,
            window_end=window_end,
            limit=limit,
        )
        return ListEnvelope[UsageWorkHistoryOut](data=data)

    @router.get(
        "/usage/operator-deliveries",
        description="查询 Manager→Operator usage 摘要的持久 delivery receipt；已 sent 记录不删除。",
        summary="查询用量 Operator delivery 收据",
        operation_id="manager_usage_operator_delivery_list",
        response_model_exclude_none=False,
    )
    async def list_usage_operator_deliveries(
        request: Request,
        delivery_status: str | None = Query(default=None, alias="status", description="可选：pending/sending/sent/failed。"),
        limit: int = Query(default=200, ge=1, le=500),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[UsageOperatorDeliveryOut]:
        authorize(claims, _USAGE_ANALYTICS_ROLES)
        settings = request.app.state.settings
        if not settings.db_url:
            raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
        repo = UsageOperatorDeliveryRepository(PgTenantRouter(settings.db_url))
        statuses = (delivery_status,) if delivery_status else None
        if statuses and delivery_status not in {"pending", "sending", "sent", "failed"}:
            from shared.errors import ValidationProblem
            raise ValidationProblem("status must be pending, sending, sent, or failed")
        rows = repo.list(tenant_context_from(claims), statuses=statuses, limit=limit)
        return ListEnvelope[UsageOperatorDeliveryOut](data=[UsageOperatorDeliveryOut(
            delivery_id=row.delivery_id,
            summary_id=row.summary_id,
            enterprise_id=row.enterprise_id,
            member_id=row.member_id,
            employee_id=row.employee_id,
            idempotency_key=row.idempotency_key,
            status=row.status,
            attempts=row.attempts,
            next_attempt_at=row.next_attempt_at,
            last_error=row.last_error,
            claimed_at=row.claimed_at,
            created_at=row.created_at,
            updated_at=row.updated_at,
            sent_at=row.sent_at,
        ) for row in rows])

    # ---- usage 查询 ----

    @router.get(
        "/usage/rollup",
        description="查本租户 usage 聚合（按窗口）/ 明细。成功响应遵循统一 envelope，失败返回 problem+json。", summary="查本租户 usage 聚合（按窗口）/ 明细",
        operation_id="manager_usage_rollup",
    )
    async def get_usage_rollup(
        request: Request,
        window_start: datetime | None = Query(default=None, description="聚合窗口起（含）"),
        window_end: datetime | None = Query(default=None, description="聚合窗口止（不含）"),
        member_id: str | None = Query(default=None, description="管理员可选成员过滤；普通成员仅可读取自己。"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[UsageAggregateOut | UsageRollupItemsOut]:
        ctx = tenant_context_from(claims)
        member_scope = _usage_member_scope(claims, member_id)
        svc = _service(request)
        if (window_start is None) != (window_end is None):
            raise ValidationProblem("window_start and window_end must be provided together")
        if window_start is not None and window_end is not None:
            if member_scope is None:
                agg = svc.aggregate_usage(ctx, window_start=window_start, window_end=window_end)
            else:
                agg = svc.aggregate_usage(
                    ctx, window_start=window_start, window_end=window_end,
                    member_id=member_scope,
                )
            return Envelope[UsageAggregateOut | UsageRollupItemsOut](data=agg)
        items = svc.list_usage(ctx, member_id=member_scope)
        return Envelope[UsageAggregateOut | UsageRollupItemsOut](data=UsageRollupItemsOut(items=items))

    @router.get(
        "/usage/rollup/list",
        description="列本租户全部 usage 明细。成功响应遵循统一 envelope，失败返回 problem+json。", summary="列本租户全部 usage 明细",
        operation_id="manager_usage_rollup_list",
        response_model_exclude_none=True,
    )
    async def list_usage_rollup(
        request: Request,
        member_id: str | None = Query(default=None, description="管理员可选成员过滤；普通成员仅可读取自己。"),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[UsageRollupOut]:
        member_scope = _usage_member_scope(claims, member_id)
        svc = _service(request)
        return ListEnvelope[UsageRollupOut](
            data=svc.list_usage(tenant_context_from(claims), member_id=member_scope)
        )

    # ---- 审计事件查询 ----

    @router.get(
        "/audits",
        description="列本租户审计事件摘要（无会话内容）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="列本租户审计事件摘要（无会话内容）",
        operation_id="manager_audit_list",
        response_model_exclude_none=True,
    )
    async def list_audits(
        request: Request,
        member_id: str | None = Query(default=None, description="管理员可选成员过滤；普通成员仅可读取自己产生的摘要。"),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[AuditSummaryOut]:
        member_scope = _usage_member_scope(claims, member_id)
        svc = _service(request)
        return ListEnvelope[AuditSummaryOut](
            data=svc.list_audits(tenant_context_from(claims), actor=member_scope)
        )

    # ---- 软配额策略 CRUD（D24 默认 soft）----

    @router.post(
        "/quota-policies",
        description="建软配额策略（owner/enterprise_admin/finance_admin）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="建软配额策略（owner/enterprise_admin/finance_admin）",
        operation_id="manager_quota_policy_create",
        status_code=status.HTTP_201_CREATED,
        response_model_exclude_none=True,
    )
    async def create_quota_policy(
        body: QuotaPolicyIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[QuotaPolicyOut]:
        svc = _service(request)
        return Envelope[QuotaPolicyOut](
            data=svc.create_quota(tenant_context_from(claims), body)
        )

    @router.get(
        "/quota-policies",
        description="列本租户配额策略。成功响应遵循统一 envelope，失败返回 problem+json。", summary="列本租户配额策略",
        operation_id="manager_quota_policy_list",
        response_model_exclude_none=True,
    )
    async def list_quota_policies(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[QuotaPolicyOut]:
        svc = _service(request)
        return ListEnvelope[QuotaPolicyOut](data=svc.list_quotas(tenant_context_from(claims)))

    @router.get(
        "/quota-policies/{policy_id}",
        description="取单个配额策略。成功响应遵循统一 envelope，失败返回 problem+json。", summary="取单个配额策略",
        operation_id="manager_quota_policy_get",
        response_model_exclude_none=True,
    )
    async def get_quota_policy(
        policy_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[QuotaPolicyOut]:
        svc = _service(request)
        return Envelope[QuotaPolicyOut](
            data=svc.get_quota(tenant_context_from(claims), policy_id=policy_id)
        )

    @router.put(
        "/quota-policies/{policy_id}",
        description="改写配额策略（version 自增）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="改写配额策略（version 自增）",
        operation_id="manager_quota_policy_update",
        response_model_exclude_none=True,
    )
    async def update_quota_policy(
        policy_id: str,
        body: QuotaPolicyIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[QuotaPolicyOut]:
        svc = _service(request)
        return Envelope[QuotaPolicyOut](
            data=svc.update_quota(tenant_context_from(claims), body, policy_id=policy_id)
        )

    @router.delete(
        "/quota-policies/{policy_id}",
        description="删配额策略。成功响应遵循统一 envelope，失败返回 problem+json。", summary="删配额策略",
        operation_id="manager_quota_policy_delete",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_quota_policy(
        policy_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete_quota(tenant_context_from(claims), policy_id=policy_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/quota-policies/{policy_id}/evaluate",
        description="评估配额并产出软治理动作（不阻断 run，D24）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="评估配额并产出软治理动作（不阻断 run，D24）",
        operation_id="manager_quota_policy_evaluate",
        response_model_exclude_none=True,
    )
    async def evaluate_quota_policy(
        policy_id: str,
        request: Request,
        window_start: datetime = Query(..., description="评估窗口起"),
        window_end: datetime = Query(..., description="评估窗口止"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[QuotaEnforcementActionOut]:
        svc = _service(request)
        return Envelope[QuotaEnforcementActionOut](
            data=svc.evaluate_quota(
                tenant_context_from(claims), policy_id=policy_id,
                window_start=window_start, window_end=window_end,
            )
        )


    return router

    
