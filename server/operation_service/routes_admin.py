"""运营端企业管理 + 财务管理 + 系统健康路由（S01/S03/S04）。

边界：Operator 持平台运营真相；不执行 Agent、不持会话。
鉴权：system_admin | system_operator（对齐 catalog）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import PlatformRole
from shared.contracts.envelope import Envelope, ListEnvelope

from .admin_dependencies import get_admin_service
from .admin_service import AdminService


# ---- S01 账号管理 ----

class EnterpriseAccountOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    org_id: str
    enterprise_name: str
    contact_name: str = ""
    contact_phone: str = ""
    registered_at: datetime | str
    total_recharged: Decimal | float | str = Decimal("0")
    token_consumed: int = 0
    status: str = "active"
    operation_status: str = "active"
    monthly_active: bool = False


class EnterpriseAccountDetail(EnterpriseAccountOut):
    recharge_records: list[dict] = Field(default_factory=list)
    audit_events: list[dict] = Field(default_factory=list)
    audit_events_total: int = 0
    employee_count: int = 0
    token_history: list[dict] = Field(default_factory=list)
    quota: dict | None = None
    suspended_at: datetime | None = None
    suspended_reason: str | None = None
    banned_at: datetime | None = None
    banned_reason: str | None = None
    closed_at: datetime | None = None


class EnterpriseActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["recharge", "ban", "unban", "notify", "adjust_quota", "suspend", "close", "reactivate"]
    amount: Decimal | None = None
    message: str | None = None


class EnterpriseActionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    org_id: str
    action: str
    executed: bool
    detail: str = ""


class EnterpriseExportResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total: int = 0
    rows: list[dict] = Field(default_factory=list)


class EnterpriseStatsOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    total_enterprises: int = 0
    active_enterprises: int = 0
    suspended_enterprises: int = 0
    banned_enterprises: int = 0
    closed_enterprises: int = 0
    new_this_month: int = 0
    monthly_active: int = 0
    total_recharged: Decimal | float | str = Decimal("0")


# ---- S03 行业方案统计 ----

class SolutionStatsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    solution_id: str
    name: str
    apply_count: int = 0
    active_enterprises: int = 0


# ---- S04 财务管理 ----

class FinanceOverviewOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    period: str
    total_recharged: Decimal = Decimal("0")
    total_tokens_billed: int = 0
    total_api_cost: Decimal = Decimal("0")
    gross_profit: Decimal = Decimal("0")
    profit_margin: float = 0.0
    active_orgs: int = 0
    monthly_trend: list[dict] = Field(default_factory=list)
    top5_consumers: list[dict] = Field(default_factory=list)


class FinanceReportOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recharge_details: list[dict] = Field(default_factory=list)
    consumption_details: list[dict] = Field(default_factory=list)
    profit_details: list[dict] = Field(default_factory=list)


# ---- 系统健康 ----

class SystemHealthOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str = "healthy"
    services: dict = Field(default_factory=dict)
    timestamp: datetime


# ---- S01 新增：企业生命周期（issue #413）----

_ALLOWED_LIFECYCLE_ACTIONS = ["activate", "suspend", "ban", "close"]


class LifecycleStatusOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    org_id: str
    operation_status: str
    suspended_at: datetime | None = None
    suspended_reason: str | None = None
    banned_at: datetime | None = None
    banned_reason: str | None = None
    closed_at: datetime | None = None


class LifecycleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["activate", "suspend", "ban", "close"]
    reason: str | None = Field(default=None, description="操作原因(封禁/暂停必填)")


class LifecycleResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    org_id: str
    action: str
    operation_status: str
    detail: str = ""


# ---- S01 新增：企业配额（issue #413）----


class QuotaOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    org_id: str
    employee_limit: int
    employee_used: int
    storage_limit_mb: int
    storage_used_mb: int
    api_rate_limit: int
    api_rate_used: int
    token_quota_limit: int
    token_quota_used: int


class QuotaChange(BaseModel):
    """Any subset of quota dimensions; leave a field null to leave it unchanged."""

    model_config = ConfigDict(extra="forbid")

    employee_limit: int | None = Field(default=None, ge=-1, description="员工上限(-1=不限制)")
    storage_limit_mb: int | None = Field(default=None, ge=-1, description="存储上限MB")
    api_rate_limit: int | None = Field(default=None, ge=-1, description="API 调用率(次/分钟)")
    token_quota_limit: int | None = Field(default=None, ge=-1, description="token 月度配额(元/月)")


class QuotaResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    org_id: str
    limit: int
    used: int
    # Map of dimension -> {limit, used} for full snapshots.
    dimensions: dict = Field(default_factory=dict)


# ---- S01 新增：审计事件 enriched（issue #413）----


class EnrichedAuditOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: str
    enterprise_id: str
    action: str
    detail: str = ""
    actor_id: str | None = None
    actor_name: str | None = None
    severity: str = "info"
    result: str = "success"
    ip_address: str | None = None
    user_agent: str | None = None
    created_at: datetime


class EnrichedAuditListOut(BaseModel):
    """Paginated enriched audit response (platform-wide or per-enterprise)."""

    model_config = ConfigDict(extra="forbid")

    total: int
    items: list[EnrichedAuditOut] = Field(default_factory=list)
    next_cursor: int | None = None



_PLATFORM_ROLES = [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]


def build_admin_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/operation/admin", tags=["operation", "lifecycle", "quota", "audit"])
    require_any = require_claims(verifier)

    def require_op(request: Request) -> TokenClaims:
        claims = require_any(request)
        authorize(claims, _PLATFORM_ROLES)
        return claims

    # ---------------------------------------------------------------------------------
    # S01 lifecycle (issue #413)
    # ---------------------------------------------------------------------------------

    @router.get(
        "/enterprises/{org_id}/lifecycle",
        summary="企业当前生命周期状态",
        operation_id="operation_admin_lifecycle_status",
    )
    async def get_lifecycle_status(
        org_id: str,
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[LifecycleStatusOut]:
        state = service.get_enterprise_detail(org_id)
        return Envelope(data=LifecycleStatusOut(
            org_id=state["org_id"],
            operation_status=state["operation_status"],
            suspended_at=state.get("suspended_at"),
            suspended_reason=state.get("suspended_reason"),
            banned_at=state.get("banned_at"),
            banned_reason=state.get("banned_reason"),
            closed_at=state.get("closed_at"),
        ))

    @router.post(
        "/enterprises/{org_id}/lifecycle",
        summary="驱动企业生命周期(activate|suspend|ban|close)",
        operation_id="operation_admin_lifecycle_change",
    )
    async def change_lifecycle(
        org_id: str,
        body: LifecycleRequest,
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[LifecycleResponse]:
        # Pre-validate so a closed enterprise returns 409 instead of 200-with-noop.
        detail_before = service.get_enterprise_detail(org_id)
        current = detail_before["operation_status"]

        if current == "closed" and body.action != "close":
            from shared.errors import InvalidTransition
            raise InvalidTransition(f"closed enterprise can only remain closed; got {body.action}")

        dispatch = {
            "activate": lambda: service.reactivate(org_id, actor_name="system_admin", actor_id=str(_claims.user_id) if _claims.user_id else None),
            "suspend": lambda: service.suspend(org_id, reason=body.reason, actor_name="system_admin", actor_id=str(_claims.user_id) if _claims.user_id else None),
            "close": lambda: service.close(org_id, reason=body.reason, actor_name="system_admin", actor_id=str(_claims.user_id) if _claims.user_id else None),
            "ban": lambda: service.ban(org_id, reason=body.reason, actor_name="system_admin", actor_id=str(_claims.user_id) if _claims.user_id else None),
        }
        new_status = dispatch[body.action]()
        detail_after = service.get_enterprise_detail(org_id)
        return Envelope(data=LifecycleResponse(
            org_id=org_id,
            action=body.action,
            operation_status=new_status,
            detail=f"operation_status changed to {new_status}" + (f" (reason: {body.reason})" if body.reason else ""),
        ))

    # ---------------------------------------------------------------------------------
    # S01 quota (issue #413)
    # ---------------------------------------------------------------------------------

    @router.get(
        "/enterprises/{org_id}/quota",
        summary="企业配额",
        operation_id="operation_admin_quota_get",
    )
    async def get_quota(
        org_id: str,
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[QuotaOut]:
        detail = service.get_enterprise_detail(org_id)
        q = detail.get("quota") or {}
        return Envelope(data=QuotaOut(
            org_id=org_id,
            employee_limit=q.get("employee_limit", -1),
            employee_used=q.get("employee_used", 0),
            storage_limit_mb=q.get("storage_limit_mb", -1),
            storage_used_mb=q.get("storage_used_mb", 0),
            api_rate_limit=q.get("api_rate_limit", -1),
            api_rate_used=q.get("api_rate_used", 0),
            token_quota_limit=q.get("token_quota_limit", -1),
            token_quota_used=q.get("token_quota_used", 0),
        ))

    @router.patch(
        "/enterprises/{org_id}/quota",
        summary="修改企业配额(employee/storage/api_rate/token)",
        operation_id="operation_admin_quota_change",
    )
    async def change_quota(
        org_id: str,
        body: QuotaChange,
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[QuotaOut]:
        dims = {k: v for k, v in body.model_dump(exclude_none=True).items() if v is not None}
        if not dims:
            from shared.errors import ValidationProblem
            raise ValidationProblem("no quota fields provided")
        service.set_quota(org_id, **dims)
        detail = service.get_enterprise_detail(org_id)
        q = detail.get("quota") or {}
        return Envelope(data=QuotaOut(
            org_id=org_id,
            employee_limit=q.get("employee_limit", -1),
            employee_used=q.get("employee_used", 0),
            storage_limit_mb=q.get("storage_limit_mb", -1),
            storage_used_mb=q.get("storage_used_mb", 0),
            api_rate_limit=q.get("api_rate_limit", -1),
            api_rate_used=q.get("api_rate_used", 0),
            token_quota_limit=q.get("token_quota_limit", -1),
            token_quota_used=q.get("token_quota_used", 0),
        ))

    # ---------------------------------------------------------------------------------
    # S01 legacy enterprise account列表 / 详情 / 操作（兼容现在 issue #413 字段）----
    # ---------------------------------------------------------------------------------

    @router.get(
        "/enterprises",
        summary="企业列表(搜索/筛选/分页)",
        operation_id="operation_admin_enterprise_list",
    )
    async def list_enterprises(
        keyword: str | None = Query(default=None),
        status: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=20, ge=1, le=100),
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> ListEnvelope[EnterpriseAccountOut]:
        rows, total = service.list_enterprises(keyword=keyword, status=status, page=page, page_size=page_size)
        items = [EnterpriseAccountOut(**r) for r in rows]
        next_cursor = page * page_size if (page * page_size) < total else None
        return ListEnvelope[EnterpriseAccountOut](
            data=items,
            page={"next_cursor": str(next_cursor) if next_cursor else None, "has_more": bool(next_cursor)},
            meta={"total": total},
        )

    @router.get(
        "/enterprises/{org_id}",
        summary="企业详情(含生命周期/配额/审计)",
        operation_id="operation_admin_enterprise_detail",
    )
    async def get_enterprise(
        org_id: str,
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[EnterpriseAccountDetail]:
        detail = service.get_enterprise_detail(org_id)
        return Envelope(data=EnterpriseAccountDetail(**detail))

    @router.get(
        "/enterprises/export/all",
        summary="导出企业列表",
        operation_id="operation_admin_enterprise_export",
    )
    async def export_enterprises(
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[EnterpriseExportResponse]:
        result = service.export_enterprises()
        return Envelope(data=EnterpriseExportResponse(**result))

    @router.post(
        "/enterprises/{org_id}/actions",
        summary="企业操作(充值/封禁/解封/通知/配额/suspend|close|reactivate)",
        operation_id="operation_admin_enterprise_action",
    )
    async def enterprise_action(
        org_id: str,
        body: EnterpriseActionRequest,
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[EnterpriseActionResponse]:
        result = service.execute_action(org_id, body.action, body.amount, body.message)
        return Envelope(data=EnterpriseActionResponse(**result))

    @router.get(
        "/stats",
        summary="企业统计卡片(含生命周期分布)",
        operation_id="operation_admin_stats",
    )
    async def get_stats(
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[EnterpriseStatsOut]:
        return Envelope(data=EnterpriseStatsOut(**service.get_stats()))

    # ---------------------------------------------------------------------------------
    # S03 行业方案统计
    # ---------------------------------------------------------------------------------

    @router.get(
        "/solutions/stats",
        summary="行业方案应用统计",
        operation_id="operation_admin_solution_stats",
    )
    async def solution_stats(
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> ListEnvelope[SolutionStatsOut]:
        rows = [SolutionStatsOut(**r) for r in service.get_solution_stats()]
        return ListEnvelope[SolutionStatsOut](data=rows)

    # ---------------------------------------------------------------------------------
    # S04 财务管理
    # ---------------------------------------------------------------------------------

    @router.get(
        "/finance/overview",
        summary="财务总览",
        operation_id="operation_admin_finance_overview",
    )
    async def finance_overview(
        period: Literal["month", "quarter", "year", "all"] = Query(default="month"),
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[FinanceOverviewOut]:
        return Envelope(data=FinanceOverviewOut(**service.get_finance_overview(period)))

    @router.get(
        "/finance/reports",
        summary="财务报表",
        operation_id="operation_admin_finance_reports",
    )
    async def finance_reports(
        period: Literal["month", "quarter", "year", "all"] = Query(default="month"),
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[FinanceReportOut]:
        return Envelope(data=FinanceReportOut(**service.get_finance_reports(period)))

    # ---------------------------------------------------------------------------------
    # Audit query (platform-wide enriched events, issue #413)
    # ---------------------------------------------------------------------------------

    @router.get(
        "/audit-events",
        summary="运营审计事件(支持按企业/severity/action过滤+分页)",
        operation_id="operation_admin_audit_events",
    )
    async def query_audit_events(
        enterprise_id: str | None = Query(default=None),
        severity: str | None = Query(default=None),
        action: str | None = Query(default=None),
        cursor: int = Query(default=0, ge=0),
        limit: int = Query(default=50, ge=1, le=200),
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[EnrichedAuditListOut]:
        if severity and severity not in {s.value for s in AuditSeverity}:
            from shared.errors import ValidationProblem
            raise ValidationProblem(f"invalid severity: {severity}")
        events, total = service.query_audit_events(
            enterprise_id=enterprise_id,
            severity=severity,
            action=action,
            cursor=cursor,
            limit=limit,
        )
        items = [
            EnrichedAuditOut(
                event_id=e.event_id,
                enterprise_id=e.enterprise_id,
                action=e.action,
                detail=e.detail,
                actor_id=e.actor_id,
                actor_name=e.actor_name,
                severity=e.severity,
                result=e.result,
                ip_address=e.ip_address,
                user_agent=e.user_agent,
                created_at=e.created_at,
            )
            for e in events
        ]
        next_cursor = cursor + limit if (cursor + limit) < total else None
        return Envelope(data=EnrichedAuditListOut(
            total=total,
            items=items,
            next_cursor=next_cursor,
        ))

    # ---------------------------------------------------------------------------------
    # 系统健康
    # ---------------------------------------------------------------------------------

    @router.get(
        "/health",
        summary="系统健康状态",
        operation_id="operation_admin_health",
    )
    async def system_health(
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[SystemHealthOut]:
        return Envelope(data=SystemHealthOut(**service.get_system_health()))

    return router
