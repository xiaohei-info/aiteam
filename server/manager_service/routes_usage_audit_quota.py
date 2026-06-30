"""企业级 usage/audit rollup + 软配额治理北向路由（M8，02 §10.1/§10.3 + 04 §6.5/§6.5.1，D13/D24）。

路径：
- /api/manager/usage/upload       接收 A5 上报的脱敏 UsageSummaryUpload（F13，本端消费落库聚合）
- /api/manager/usage/rollup       查本租户 usage 聚合 / 明细
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

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.tenancy import TenantContext
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError
from shared.service_token import verify_service_token

from .schemas import (
    AuditSummaryOut,
    QuotaEnforcementActionOut,
    QuotaPolicyIn,
    QuotaPolicyOut,
    RunEventIn,
    RunEventOut,
    UsageAggregateOut,
    UsageLedgerIn,
    UsageLedgerOut,
    UsageRollupOut,
)
from .usage_audit_quota_service import (
    UsageAuditQuotaService,
    build_usage_audit_quota_service,
)

# run-event 归档请求体（runtime 归一化器经 F13 上报，服务间调用凭据校验）。
class _RunEventIn(BaseModel):
    run_id: str
    cursor_no: int
    event_type: str
    source_type: str = "session"
    source_id: str
    team_task_id: str | None = None
    employee_id: str | None = None
    event_ts: datetime | None = None
    preview_text: str = ""
    payload_json: dict = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")


class _UsageLedgerIn(BaseModel):
    run_id: str
    employee_id: str
    conversation_id: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost_cents: int = 0
    source_type: str = "run_summary"
    occurred_at: datetime | None = None
    created_by: str | None = None

    model_config = ConfigDict(extra="forbid")


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


# F13 上报体（对齐 shared.contracts.crosstier.UsageSummaryUpload 形状；只 import 契约语义，
# 此处用一个**无会话内容字段**的薄 schema 作为 HTTP 入参边界，落库前由 service 层红线断言）。
class UsageSummaryUploadIn(BaseModel):
    """脱敏用量上报体（F13）。只承载脱敏聚合摘要，不含会话内容（D13）。"""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    usage: list[dict] = Field(default_factory=list, description="脱敏 UsageSummary 列表")
    audits: list[dict] = Field(default_factory=list, description="脱敏 AuditSummaryEvent 列表")


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


def build_usage_audit_quota_router(verifier) -> APIRouter:
    """构造 usage/audit/quota 路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager", tags=["manager", "usage-audit-quota"])
    require = require_claims(verifier)

    # ---- F13 用量上报（接收 A5 上报的脱敏摘要，落库聚合）----

    @router.post(
        "/usage/upload",
        description="请查看接口名称了解用途", summary="接收脱敏 usage/audit 摘要上报（F13，本端消费落库聚合）",
        operation_id="manager_usage_upload",
    )
    async def upload_usage(
        body: UsageSummaryUploadIn,
        request: Request,
        _service_token: None = Depends(verify_service_token),
    ) -> Envelope[dict]:
        svc = _service(request)
        ctx = TenantContext(tenant_id=body.tenant_id, user_id="agent-service", roles=["service"])
        result = svc.ingest_upload(ctx, body.model_dump())
        return Envelope[dict](data=result)

    # ---- usage 查询 ----

    @router.get(
        "/usage/rollup",
        description="请查看接口名称了解用途", summary="查本租户 usage 聚合（按窗口）/ 明细",
        operation_id="manager_usage_rollup",
    )
    async def get_usage_rollup(
        request: Request,
        window_start: datetime | None = Query(default=None, description="聚合窗口起（含）"),
        window_end: datetime | None = Query(default=None, description="聚合窗口止（含）"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        svc = _service(request)
        ctx = tenant_context_from(claims)
        if window_start is not None and window_end is not None:
            agg = svc.aggregate_usage(ctx, window_start=window_start, window_end=window_end)
            return Envelope[dict](data=agg.model_dump(mode="json"))
        items = svc.list_usage_ledger(ctx)
        return Envelope[dict](data={"items": [i.model_dump(mode="json") for i in items]})

    @router.get(
        "/usage/rollup/list",
        description="请查看接口名称了解用途", summary="列本租户全部 usage 明细",
        operation_id="manager_usage_rollup_list",
        response_model_exclude_none=True,
    )
    async def list_usage_rollup(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[UsageRollupOut]:
        svc = _service(request)
        return ListEnvelope[UsageRollupOut](data=svc.list_usage(tenant_context_from(claims)))

    # ---- 审计事件查询 ----

    @router.get(
        "/audits",
        description="请查看接口名称了解用途", summary="列本租户审计事件摘要（无会话内容）",
        operation_id="manager_audit_list",
        response_model_exclude_none=True,
    )
    async def list_audits(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[AuditSummaryOut]:
        svc = _service(request)
        return ListEnvelope[AuditSummaryOut](data=svc.list_audits(tenant_context_from(claims)))

    # ---- 软配额策略 CRUD（D24 默认 soft）----

    @router.post(
        "/quota-policies",
        description="请查看接口名称了解用途", summary="建软配额策略（owner/enterprise_admin/finance_admin）",
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
        description="请查看接口名称了解用途", summary="列本租户配额策略",
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
        description="请查看接口名称了解用途", summary="取单个配额策略",
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
        description="请查看接口名称了解用途", summary="改写配额策略（version 自增）",
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
        description="请查看接口名称了解用途", summary="删配额策略",
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
        description="请查看接口名称了解用途", summary="评估配额并产出软治理动作（不阻断 run，D24）",
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


# ---- run-event：运行事件明细归档（脱敏，issue #292）----
    # 运行时归一化器经服务间调用（verify_service_token）归档单条事件；重复归档由 repo 静默去重。

    @router.post(
        "/run-events",
        description="请查看接口名称了解用途", summary="归档单条 run-event（runtime 归一，脱敏）",
        operation_id="manager_run_event_append",
        response_model_exclude_none=True,
    )
    async def append_run_event(
        body: _RunEventIn,
        request: Request,
        _service_token: None = Depends(verify_service_token),
    ) -> Envelope:
        svc = _service(request)
        ctx = TenantContext(tenant_id=request.query_params.get("tenant_id", ""),
                            user_id="runtime-normalizer", roles=["service"])
        data = svc.append_run_event(ctx, body)
        return Envelope(data=data)

    @router.get(
        "/run-events/{run_id}",
        description="请查看接口名称了解用途", summary="按 run cursor 分页列事件明细（含 max_cursor）",
        operation_id="manager_run_event_list",
        response_model_exclude_none=True,
    )
    async def list_run_events(
        run_id: str,
        request: Request,
        after_cursor: int = Query(default=0, ge=0, description="返回 cursor > 该值的事件"),
        limit: int = Query(default=100, ge=1, le=500),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        svc = _service(request)
        return Envelope[dict](data=svc.list_run_events(
            tenant_context_from(claims), run_id=run_id,
            after_cursor=after_cursor, limit=limit,
        ))

    @router.get(
        "/run-events/{run_id}/max-cursor",
        description="请查看接口名称了解用途", summary="某 run 当前 max_cursor 水位",
        operation_id="manager_run_event_max_cursor",
        response_model_exclude_none=True,
    )
    async def get_run_max_cursor(
        run_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        svc = _service(request)
        return Envelope[dict](data=svc.get_max_cursor(tenant_context_from(claims), run_id=run_id))

    # ---- usage-ledger：逐 token 计费明细（issue #292）----

    @router.post(
        "/usage-ledger",
        description="请查看接口名称了解用途", summary="记录 usage_ledger（幂等回写，按 run+source）",
        operation_id="manager_usage_ledger_upsert",
        response_model_exclude_none=True,
    )
    async def upsert_usage_ledger(
        body: _UsageLedgerIn,
        request: Request,
        _service_token: None = Depends(verify_service_token),
    ) -> Envelope[UsageLedgerOut]:
        svc = _service(request)
        ctx = TenantContext(tenant_id=request.query_params.get("tenant_id", ""),
                            user_id="runtime-normalizer", roles=["service"])
        data = svc.record_usage(ctx, body, mode="upsert")
        return Envelope[UsageLedgerOut](data=UsageLedgerOut(**data))

    @router.get(
        "/usage-ledger/{run_id}",
        description="请查看接口名称了解用途", summary="按 run + source_type 取 usage_ledger",
        operation_id="manager_usage_ledger_get",
        response_model_exclude_none=True,
    )
    async def get_usage_ledger(
        run_id: str,
        request: Request,
        source_type: str = Query(default="run_summary"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[UsageLedgerOut]:
        svc = _service(request)
        data = svc.get_usage(tenant_context_from(claims), run_id=run_id, source_type=source_type)
        if data is None:
            from shared.errors import NotFound
            raise NotFound("usage_ledger not found")
        return Envelope[UsageLedgerOut](data=UsageLedgerOut(**data))

    @router.get(
        "/usage-ledger",
        description="请查看接口名称了解用途", summary="列 usage_ledger（按 run/employee/period 过滤）",
        operation_id="manager_usage_ledger_list",
        response_model_exclude_none=True,
    )
    async def list_usage_ledger(
        request: Request,
        run_id: str | None = Query(default=None),
        employee_id: str | None = Query(default=None),
        period_start: datetime | None = Query(default=None),
        period_end: datetime | None = Query(default=None),
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[UsageLedgerOut]:
        svc = _service(request)
        items = svc.list_usage_ledger(
            tenant_context_from(claims), run_id=run_id, employee_id=employee_id,
            period_start=period_start.isoformat() if period_start else None,
            period_end=period_end.isoformat() if period_end else None,
        )
        return ListEnvelope[UsageLedgerOut](data=[UsageLedgerOut(**i) for i in items])

    return router

    
