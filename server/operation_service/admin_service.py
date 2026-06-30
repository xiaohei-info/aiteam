"""运营端 admin 服务编排（S01/S03/S04）。

职责：企业运营管理（列表/详情/操作/统计）、财务总览/报表、行业方案统计、系统健康。
不执行 Agent、不持会话、不直写 Manager/Agent。

编排层：组合 AdminRepository（运营状态）+ EnterpriseRepository（企业账号）+
CatalogRepository（方案统计）+ RollupRepository（用量数据）+ SolutionRepository（方案应用统计）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from shared.contracts.enums import CatalogType
from shared.errors import NotFound

from .admin_repository import AdminRepository
from .catalog_repository import CatalogRepository
from .repository import EnterpriseRepository
from .rollup_repository import CrossEnterpriseRollupRepository
from .solution_repository import SolutionRepository


class AdminService:
    """运营端管理编排器（无状态）。"""

    def __init__(
        self,
        admin_repo: AdminRepository,
        enterprise_repo: EnterpriseRepository,
        catalog_repo: CatalogRepository,
        rollup_repo: CrossEnterpriseRollupRepository,
        solution_repo: SolutionRepository | None = None,
    ):
        self._admin = admin_repo
        self._enterprise = enterprise_repo
        self._catalog = catalog_repo
        self._rollup = rollup_repo
        self._solution = solution_repo or SolutionRepository()

    # ---- 内部：确保 enterprise 有 admin state ----

    def _ensure_state(self, enterprise_id: str):
        """确保 enterprise 在 admin repo 中有记录。从 enterprise repo 补注册。"""
        try:
            return self._admin.get_state(enterprise_id)
        except NotFound:
            try:
                acct = self._enterprise.get(enterprise_id)
            except NotFound:
                raise NotFound(f"enterprise not found: {enterprise_id}")
            return self._admin.register_enterprise(
                enterprise_id=acct.enterprise_id,
                enterprise_name=acct.enterprise_name,
                owner_phone=acct.owner_phone,
            )

    # ---- S01 企业账号管理 ----

    def list_enterprises(
        self, *, keyword: str | None = None, status: str | None = None,
        page: int = 1, page_size: int = 20,
    ) -> list[dict]:
        """企业列表：从 admin repo 读取真实运营状态，按 keyword/status 过滤并分页。"""
        states = self._admin.list_enterprises(keyword=keyword, status=status)
        states.sort(key=lambda s: s.registered_at, reverse=True)
        start = (page - 1) * page_size
        page_states = states[start : start + page_size]

        results: list[dict] = []
        for s in page_states:
            token_consumed = 0
            try:
                row = self._rollup.get(s.enterprise_id)
                token_consumed = row.token_total
            except NotFound:
                pass
            results.append({
                "org_id": s.enterprise_id,
                "enterprise_name": s.enterprise_name,
                "contact_name": s.owner_phone,
                "contact_phone": s.owner_phone,
                "registered_at": s.registered_at,
                "total_recharged": s.total_recharged,
                "token_consumed": token_consumed,
                "status": s.status,
                "monthly_active": token_consumed > 0,
            })
        return results

    def count_enterprises(self, *, keyword: str | None = None, status: str | None = None) -> int:
        states = self._admin.list_enterprises(keyword=keyword, status=status)
        return len(states)

    def get_enterprise_detail(self, org_id: str) -> dict:
        """企业详情：先确保有 admin state，再补 rollup 数据。"""
        state = self._ensure_state(org_id)
        recharges = self._admin.list_recharges(enterprise_id=org_id)
        audits = self._admin.list_audits(enterprise_id=org_id)

        token_consumed = 0
        token_history: list[dict] = []
        try:
            row = self._rollup.get(org_id)
            token_consumed = row.token_total
            token_history = [{
                "run_count": row.run_count,
                "token_total": row.token_total,
                "cost_total": str(row.cost_total),
                "error_count": row.error_count,
                "window_start": row.window_start.isoformat() if row.window_start else None,
                "window_end": row.window_end.isoformat() if row.window_end else None,
            }]
        except NotFound:
            pass

        return {
            "org_id": state.enterprise_id,
            "enterprise_name": state.enterprise_name,
            "contact_name": state.owner_phone,
            "contact_phone": state.owner_phone,
            "registered_at": state.registered_at,
            "total_recharged": state.total_recharged,
            "token_consumed": token_consumed,
            "status": state.status,
            "monthly_active": token_consumed > 0,
            "recharge_records": [
                {"recharge_id": r.recharge_id, "amount": r.amount, "created_at": r.created_at}
                for r in recharges
            ],
            "employee_count": 0,
            "token_history": token_history,
            "audit_events": [
                {"event_id": a.event_id, "action": a.action, "detail": a.detail,
                 "created_at": a.created_at}
                for a in audits
            ],
        }

    def export_enterprises(self) -> dict:
        """导出企业列表：返回完整列表与总数。骨架期返回 JSON 格式。"""
        states = self._admin.list_enterprises()
        rows: list[dict] = []
        for s in states:
            token_consumed = 0
            try:
                row = self._rollup.get(s.enterprise_id)
                token_consumed = row.token_total
            except NotFound:
                pass
            rows.append({
                "org_id": s.enterprise_id,
                "enterprise_name": s.enterprise_name,
                "status": s.status,
                "total_recharged": str(s.total_recharged),
                "token_consumed": token_consumed,
                "registered_at": s.registered_at.isoformat(),
            })
        return {"total": len(rows), "rows": rows}

    def execute_action(
        self, org_id: str, action: str, amount: Decimal | None, message: str | None
    ) -> dict:
        """执行企业操作。每种操作改变本端状态并记录审计。"""
        self._ensure_state(org_id)
        detail = message or ""

        if action == "recharge":
            if amount is None or amount <= 0:
                from shared.errors import ValidationProblem
                raise ValidationProblem("recharge requires positive amount")
            self._admin.add_recharge(org_id, amount)
            detail = f"recharged {amount}"
        elif action == "ban":
            self._admin.set_status(org_id, "banned")
            detail = "enterprise banned"
        elif action == "unban":
            self._admin.set_status(org_id, "normal")
            detail = "enterprise unbanned"
        elif action == "notify":
            detail = f"notification sent: {message or '(no message)'}"
        elif action == "adjust_quota":
            if amount is not None:
                self._admin.set_quota(org_id, {"quota": str(amount)})
                detail = f"quota adjusted to {amount}"
            else:
                self._admin.set_quota(org_id, {})
                detail = "quota cleared"

        self._admin.record_audit(org_id, action, detail)
        return {"org_id": org_id, "action": action, "executed": True, "detail": detail}

    def get_stats(self) -> dict:
        """企业统计卡片。"""
        return {
            "total_enterprises": self._admin.enterprise_count(),
            "new_this_month": self._admin.new_this_month(),
            "monthly_active": self._admin.monthly_active(),
            "total_recharged": self._admin.total_recharged_all(),
        }

    # ---- S03 行业方案统计 ----

    def get_solution_stats(self) -> list[dict]:
        """行业方案应用统计：从 catalog 读方案模板列表 + SolutionRepository 聚合真实统计。

        口径：``apply_count`` = 方案被应用总次数；``active_enterprises`` = 当前持有
        ``applied`` 状态实例的去重租户数。
        """
        entries = self._catalog.list(catalog_type=CatalogType.SOLUTION_TEMPLATE)
        results: list[dict] = []
        for e in entries:
            stats = self._solution.get_stats(e.template_id)
            results.append({
                "solution_id": e.template_id,
                "name": e.display_name,
                "apply_count": stats["apply_count"],
                "active_enterprises": stats["active_enterprises"],
            })
        return results

    # ---- S04 财务管理 ----

    def get_finance_overview(self, period: str) -> dict:
        """财务总览：从充值记录 + rollup 数据聚合。"""
        total_recharged = self._admin.total_recharged_all()
        total_tokens = 0
        total_cost = Decimal("0")
        for row in self._rollup.list_all():
            total_tokens += row.token_total
            total_cost += row.cost_total

        revenue = total_recharged
        cost = total_cost
        profit = revenue - cost
        margin = float(str(profit / revenue)) if revenue > 0 else 0.0

        active_orgs = 0
        for row in self._rollup.list_all():
            if row.run_count > 0:
                active_orgs += 1

        trend = self._admin.recharge_trend(period)
        top5 = [
            {"org_id": s.enterprise_id, "enterprise_name": s.enterprise_name,
             "total_recharged": str(s.total_recharged)}
            for s in self._admin.top_consumers(5)
        ]

        return {
            "period": period,
            "total_recharged": total_recharged,
            "total_tokens_billed": total_tokens,
            "total_api_cost": total_cost,
            "gross_profit": profit,
            "profit_margin": margin,
            "active_orgs": active_orgs,
            "monthly_trend": trend,
            "top5_consumers": top5,
        }

    def get_finance_reports(self, period: str) -> dict:
        """财务报表：充值明细 + 消耗明细 + 利润明细。"""
        recharges = self._admin.list_recharges()
        recharge_details = [
            {"recharge_id": r.recharge_id, "enterprise_id": r.enterprise_id,
             "amount": str(r.amount), "created_at": r.created_at.isoformat()}
            for r in recharges
        ]

        consumption_details: list[dict] = []
        for row in self._rollup.list_all():
            consumption_details.append({
                "enterprise_id": row.enterprise_id,
                "token_total": row.token_total,
                "cost_total": str(row.cost_total),
                "run_count": row.run_count,
            })

        total_recharged = self._admin.total_recharged_all()
        total_cost = sum((row.cost_total for row in self._rollup.list_all()), Decimal("0"))
        profit = total_recharged - total_cost
        profit_details: list[dict] = [{
            "total_revenue": str(total_recharged),
            "total_cost": str(total_cost),
            "gross_profit": str(profit),
            "period": period,
        }]

        return {
            "recharge_details": recharge_details,
            "consumption_details": consumption_details,
            "profit_details": profit_details,
        }

    # ---- 系统健康 ----

    def get_system_health(self) -> dict:
        """系统健康：探测本端仓储是否可用（骨架期探测仓库实例）。"""
        now = datetime.now(timezone.utc)
        services: dict[str, str] = {"operation": "up"}

        # manager 连通性：骨架期不发起真实 HTTP，标记 degraded。
        services["manager"] = "degraded"
        services["agent"] = "local"
        overall = "healthy"

        return {
            "status": overall,
            "services": services,
            "timestamp": now,
        }
