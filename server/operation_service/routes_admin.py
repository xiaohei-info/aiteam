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
from shared.contracts.envelope import Envelope

from .admin_dependencies import get_admin_service
from .admin_service import AdminService


# ---- S01 账号管理 ----

class EnterpriseAccountOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    org_id: str
    enterprise_name: str
    contact_name: str = ""
    contact_phone: str = ""
    registered_at: datetime
    total_recharged: Decimal = Decimal("0")
    token_consumed: int = 0
    status: str = "normal"
    monthly_active: bool = False


class EnterpriseAccountDetail(EnterpriseAccountOut):
    recharge_records: list[dict] = Field(default_factory=list)
    audit_events: list[dict] = Field(default_factory=list)
    employee_count: int = 0
    token_history: list[dict] = Field(default_factory=list)


class EnterpriseActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["recharge", "ban", "unban", "notify", "adjust_quota"]
    amount: Decimal | None = None
    message: str | None = None


class EnterpriseActionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    org_id: str
    action: str
    executed: bool = True
    detail: str = ""


class EnterpriseStatsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total_enterprises: int = 0
    new_this_month: int = 0
    monthly_active: int = 0
    total_recharged: Decimal = Decimal("0")


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


_PLATFORM_ROLES = [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]


def build_admin_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/operation/admin", tags=["operation", "admin"])
    require_any = require_claims(verifier)

    def require_op(request: Request) -> TokenClaims:
        claims = require_any(request)
        authorize(claims, _PLATFORM_ROLES)
        return claims

    # ---- S01 企业账号管理 ----

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
    ) -> dict:
        rows = service.list_enterprises(keyword=keyword, status=status, page=page, page_size=page_size)
        total = service.count_enterprises(keyword=keyword, status=status)
        return {
            "data": rows,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.get(
        "/enterprises/{org_id}",
        summary="企业详情",
        operation_id="operation_admin_enterprise_detail",
    )
    async def get_enterprise(
        org_id: str,
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[dict]:
        return Envelope(data=service.get_enterprise_detail(org_id))

    @router.get(
        "/enterprises/export/all",
        summary="导出企业列表",
        operation_id="operation_admin_enterprise_export",
    )
    async def export_enterprises(
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> dict:
        return service.export_enterprises()

    @router.post(
        "/enterprises/{org_id}/actions",
        summary="企业操作(充值/封禁/解封/通知/配额)",
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
        summary="企业统计卡片",
        operation_id="operation_admin_stats",
    )
    async def get_stats(
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[EnterpriseStatsOut]:
        return Envelope(data=EnterpriseStatsOut(**service.get_stats()))

    # ---- S03 行业方案统计 ----

    @router.get(
        "/solutions/stats",
        summary="行业方案应用统计",
        operation_id="operation_admin_solution_stats",
    )
    async def solution_stats(
        _claims: TokenClaims = Depends(require_op),
        service: AdminService = Depends(get_admin_service),
    ) -> Envelope[list[SolutionStatsOut]]:
        rows = [SolutionStatsOut(**r) for r in service.get_solution_stats()]
        return Envelope(data=rows)

    # ---- S04 财务管理 ----

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

    # ---- 系统健康 ----

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
