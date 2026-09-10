"""Operation-side admin service (issue #413): lifecycle / quota / audit.

Responsibilities: lifecycle transitions, quota changes, recharge/notify, finance,
solution aggregates, system health. No session, no execution, no Manager writes
(F17 notify goes through ManagerGateway narrow channel).
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from decimal import Decimal

from shared.contracts.enums import AuditResult, AuditSeverity, CatalogType
from shared.errors import NotFound, ValidationProblem

from .admin_repository import (
    AdminRepository,
    EnrichedAuditEvent,
    EnterpriseQuota,
)
from .catalog_repository import CatalogRepository
from .health_probes import ServiceHealthProbe
from .manager_gateway import ManagerGateway
from .repository import EnterpriseRepository
from .rollup_repository import CrossEnterpriseRollupRepository
from .solution_repository import SolutionRepository

logger = logging.getLogger(__name__)

# Map a legacy execute_action command (ban/unban/reactivate/suspend/close) onto an
# OperationStatus transition. Keeps the historical action surface intact.
_LEGACY_LIFECYCLE_ACTIONS = {"suspend", "ban", "unban", "reactivate", "close"}

# A best-effort approval of changes that tighten a constraint -> warning severity.
_WARN_QUOTA_DIMENSIONS = {"employee_limit", "token_quota_limit", "api_rate_limit", "storage_limit_mb"}


class AdminService:
    """Stateless orchestrator for the Operation admin surface."""

    def __init__(
        self,
        admin_repo: AdminRepository,
        enterprise_repo: EnterpriseRepository,
        catalog_repo: CatalogRepository,
        rollup_repo: CrossEnterpriseRollupRepository,
        solution_repo: SolutionRepository | None = None,
        manager_gateway: ManagerGateway | None = None,
        manager_health: ServiceHealthProbe | None = None,
        agent_health: ServiceHealthProbe | None = None,
    ):
        self._admin = admin_repo
        self._enterprise = enterprise_repo
        self._catalog = catalog_repo
        self._rollup = rollup_repo
        self._solution = solution_repo or SolutionRepository()
        self._manager = manager_gateway
        self._manager_health = manager_health
        self._agent_health = agent_health

    # ---- internal: ensure an enterprise has admin-side state ----

    def _ensure_state(self, enterprise_id: str):
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

    # ---- internal: F17 narrow-channel notification (Operator -> Manager) ----

    def _dispatch_notify(self, org_id: str, message: str | None, *, idempotency_key: str | None = None) -> str:
        text = message or ""
        if self._manager is None:
            return f"notification recorded (no manager channel): {text or '(no message)'}"

        acct = self._enterprise.get(org_id)
        from shared.contracts.crosstier import EnterpriseNotifyRequest
        req = EnterpriseNotifyRequest(
            tenant_id=acct.tenant_id,
            org_id=org_id,
            message=text,
        )
        manager_key = idempotency_key or (
            f"notify:{org_id}:"
            + hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
        )
        self._manager.notify_enterprise(req, idempotency_key=manager_key)
        return f"notification dispatched to tenant {acct.tenant_id}: {text or '(no message)'}"

    # ---- internal: audit helper with enriched metadata ----

    def _record(
        self,
        enterprise_id: str,
        action: str,
        detail: str,
        *,
        severity: str = AuditSeverity.INFO.value,
        result: str = AuditResult.SUCCESS.value,
        actor_id: str | None = None,
        actor_name: str | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> EnrichedAuditEvent:
        return self._admin.record_audit(
            enterprise_id,
            action,
            detail,
            severity=severity,
            result=result,
            actor_id=actor_id,
            actor_name=actor_name,
            ip_address=ip_address,
            user_agent=user_agent,
        )

    # ---- internal: lifecycle transition wrapper ----

    def _transition(
        self,
        enterprise_id: str,
        target: str,
        *,
        action: str = "lifecycle_change",
        reason: str | None = None,
        actor_id: str | None = None,
        actor_name: str | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> str:
        before = self._admin.get_state(enterprise_id).operation_status
        self._admin.set_operation_status(enterprise_id, target, reason=reason, normalized=False)
        after = self._admin.get_state(enterprise_id).operation_status
        detail = f"operation_status {before} -> {after}"
        if reason:
            detail += f" (reason: {reason})"
        severity = AuditSeverity.CRITICAL.value if target == "closed" else AuditSeverity.WARNING.value
        self._record(
            enterprise_id,
            action,
            detail,
            severity=severity,
            actor_id=actor_id,
            actor_name=actor_name,
            ip_address=ip_address,
            user_agent=user_agent,
        )
        return after

    # ---- lifecycle operations (issue #413) ----

    def suspend(
        self,
        enterprise_id: str,
        *,
        reason: str | None = None,
        actor_id: str | None = None,
        actor_name: str | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> str:
        return self._transition(
            enterprise_id,
            "suspended",
            action="suspend",
            reason=reason,
            actor_id=actor_id,
            actor_name=actor_name,
            ip_address=ip_address,
            user_agent=user_agent,
        )

    def ban(
        self,
        enterprise_id: str,
        *,
        reason: str | None = None,
        actor_id: str | None = None,
        actor_name: str | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> str:
        return self._transition(
            enterprise_id,
            "banned",
            action="ban",
            reason=reason,
            actor_id=actor_id,
            actor_name=actor_name,
            ip_address=ip_address,
            user_agent=user_agent,
        )

    def close(
        self,
        enterprise_id: str,
        *,
        reason: str | None = None,
        actor_id: str | None = None,
        actor_name: str | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> str:
        return self._transition(
            enterprise_id,
            "closed",
            action="close",
            reason=reason,
            actor_id=actor_id,
            actor_name=actor_name,
            ip_address=ip_address,
            user_agent=user_agent,
        )

    def reactivate(
        self,
        enterprise_id: str,
        *,
        actor_id: str | None = None,
        actor_name: str | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> str:
        return self._transition(
            enterprise_id,
            "active",
            action="reactivate",
            actor_id=actor_id,
            actor_name=actor_name,
            ip_address=ip_address,
            user_agent=user_agent,
        )

    # ---- quota operations (issue #413) ----

    def get_quota(self, enterprise_id: str) -> EnterpriseQuota:
        self._ensure_state(enterprise_id)
        return self._admin.ensure_quota(enterprise_id)

    def set_quota(self, enterprise_id: str, **dims: int) -> EnterpriseQuota:
        self._ensure_state(enterprise_id)
        before = self._admin.ensure_quota(enterprise_id)
        snapshot_before = {k: getattr(before, k) for k in dims}
        result = self._admin.update_quota(enterprise_id, **dims)
        changed = {f"{k}: {snapshot_before[k]} -> {getattr(result, k)}" for k in dims}
        severity = (
            AuditSeverity.WARNING.value
            if any(
                getattr(result, k, snapshot_before[k]) < snapshot_before[k]
                and getattr(result, k, snapshot_before[k]) != -1
                for k in dims
            )
            else AuditSeverity.INFO.value
        )
        self._record(
            enterprise_id,
            "quota_change",
            "quota updated: " + ", ".join(sorted(changed)),
            severity=severity,
        )
        return result

    # ---- charge / notify ----

    def recharge(self, enterprise_id: str, amount: Decimal) -> None:
        if amount is None or amount <= 0:
            raise ValidationProblem("recharge requires positive amount")
        self._ensure_state(enterprise_id)
        self._admin.add_recharge(enterprise_id, amount)
        self._record(enterprise_id, "recharge", f"recharged {amount}")

    def notify(self, enterprise_id: str, message: str | None, *, idempotency_key: str | None = None) -> str:
        self._ensure_state(enterprise_id)
        detail = self._dispatch_notify(enterprise_id, message, idempotency_key=idempotency_key)
        self._record(enterprise_id, "notify", detail)
        return detail

    # ---- legacy execute action (kept for compatibility with history + existing tests) ----

    def execute_action(
        self,
        org_id: str,
        action: str,
        amount: Decimal | None,
        message: str | None,
        *,
        idempotency_key: str | None = None,
    ) -> dict:
        """Execute a legacy admin action, re-routing to the new lifecycle/quota surface."""
        self._ensure_state(org_id)
        detail = message or ""

        if action == "recharge":
            if amount is None or amount <= 0:
                raise ValidationProblem("recharge requires positive amount")
            self.recharge(org_id, amount)
            detail = f"recharged {amount}"
        elif action == "ban":
            self.ban(org_id, reason=message)
            detail = message or "enterprise banned"
        elif action == "unban":
            self.reactivate(org_id)
            detail = "enterprise unbanned"
        elif action == "suspend":
            self.suspend(org_id, reason=message)
            detail = message or "enterprise suspended"
        elif action == "close":
            self.close(org_id, reason=message)
            detail = message or "enterprise closed"
        elif action == "reactivate":
            self.reactivate(org_id)
            detail = "enterprise reactivated"
        elif action == "notify":
            detail = self.notify(org_id, message, idempotency_key=idempotency_key)
        elif action == "adjust_quota":
            if amount is not None:
                self.set_quota(org_id, token_quota_limit=int(amount))
                detail = f"quota adjusted to {amount}"
            else:
                detail = "quota cleared"
        else:
            self._record(org_id, action, f"unknown action: {detail}", result=AuditResult.FAILURE.value)
            return {"org_id": org_id, "action": action, "executed": False, "detail": f"unknown action: {action}"}

        return {"org_id": org_id, "action": action, "executed": True, "detail": detail}

    # ---- listings ----

    def list_enterprises(
        self,
        *,
        keyword: str | None = None,
        status: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[dict], int]:
        states = self._admin.list_enterprises(keyword=keyword, status=status)
        states.sort(key=lambda s: s.registered_at, reverse=True)
        total = len(states)
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
                "status": s.operation_status,
                "operation_status": s.operation_status,
                "monthly_active": token_consumed > 0,
            })
        return results, total

    def count_enterprises(self, *, keyword: str | None = None, status: str | None = None) -> int:
        return len(self._admin.list_enterprises(keyword=keyword, status=status))

    def get_enterprise_detail(self, org_id: str) -> dict:
        state = self._ensure_state(org_id)
        recharges = self._admin.list_recharges(enterprise_id=org_id)
        audits = self._admin.list_audits(enterprise_id=org_id)
        enriched, enriched_total = self._admin.list_enriched_audits(enterprise_id=org_id, limit=100)

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

        quota = None
        try:
            q = self._admin.get_quota(org_id)
            quota = {
                "employee_limit": q.employee_limit,
                "employee_used": q.employee_used,
                "storage_limit_mb": q.storage_limit_mb,
                "storage_used_mb": q.storage_used_mb,
                "api_rate_limit": q.api_rate_limit,
                "api_rate_used": q.api_rate_used,
                "token_quota_limit": q.token_quota_limit,
                "token_quota_used": q.token_quota_used,
            }
        except NotFound:
            quota = {
                "employee_limit": -1,
                "employee_used": 0,
                "storage_limit_mb": -1,
                "storage_used_mb": 0,
                "api_rate_limit": -1,
                "api_rate_used": 0,
                "token_quota_limit": -1,
                "token_quota_used": 0,
            }

        return {
            "org_id": state.enterprise_id,
            "enterprise_name": state.enterprise_name,
            "contact_name": state.owner_phone,
            "contact_phone": state.owner_phone,
            "registered_at": state.registered_at,
            "total_recharged": state.total_recharged,
            "token_consumed": token_consumed,
            "status": state.operation_status,
            "operation_status": state.operation_status,
            "suspended_at": state.suspended_at,
            "suspended_reason": state.suspended_reason,
            "banned_at": state.banned_at,
            "banned_reason": state.banned_reason,
            "closed_at": state.closed_at,
            "monthly_active": token_consumed > 0,
            "recharge_records": [
                {"recharge_id": r.recharge_id, "amount": r.amount, "created_at": r.created_at}
                for r in recharges
            ],
            "employee_count": 0,
            "token_history": token_history,
            "quota": quota,
            "audit_events": [
                {
                    "event_id": a.event_id,
                    "action": a.action,
                    "detail": a.detail,
                    "severity": a.severity,
                    "result": a.result,
                    "ip_address": a.ip_address,
                    "user_agent": a.user_agent,
                    "created_at": a.created_at,
                }
                for a in enriched
            ],
            "audit_events_total": enriched_total,
        }

    # ---- platform-wide enriched audit query (issue #413) ----

    def query_audit_events(
        self,
        *,
        enterprise_id: str | None = None,
        severity: str | None = None,
        action: str | None = None,
        cursor: int = 0,
        limit: int = 50,
    ) -> tuple[list[EnrichedAuditEvent], int]:
        events, total = self._admin.list_enriched_audits(
            enterprise_id=enterprise_id,
            severity=severity,
            cursor=cursor,
            limit=limit,
        )
        if action:
            events = [e for e in events if e.action == action]
            total = len(events)
        return events, total

    def export_enterprises(self) -> dict:
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
                "status": s.operation_status,
                "total_recharged": str(s.total_recharged),
                "token_consumed": token_consumed,
                "registered_at": s.registered_at.isoformat(),
            })
        return {"total": len(rows), "rows": rows}

    def get_stats(self) -> dict:
        return {
            "total_enterprises": self._admin.enterprise_count(),
            "active_enterprises": len([
                s for s in self._admin.list_enterprises()
                if s.operation_status == "active"
            ]),
            "suspended_enterprises": len([
                s for s in self._admin.list_enterprises()
                if s.operation_status == "suspended"
            ]),
            "banned_enterprises": len([
                s for s in self._admin.list_enterprises()
                if s.operation_status == "banned"
            ]),
            "closed_enterprises": len([
                s for s in self._admin.list_enterprises()
                if s.operation_status == "closed"
            ]),
            "new_this_month": self._admin.new_this_month(),
            "monthly_active": self._admin.monthly_active(),
            "total_recharged": self._admin.total_recharged_all(),
        }

    # ---- S03 solution stats ----

    def get_solution_stats(self) -> list[dict]:
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

    # ---- S04 finance ----

    @staticmethod
    def _finance_window(period: str) -> tuple[datetime | None, datetime | None]:
        now = datetime.now(timezone.utc)
        if period == "all":
            return None, None
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if period == "quarter":
            start = start.replace(month=((start.month - 1) // 3) * 3 + 1)
        elif period == "year":
            start = start.replace(month=1)
        return start, None

    @classmethod
    def _in_finance_window(cls, value: datetime, period: str) -> bool:
        start, end = cls._finance_window(period)
        point = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return (start is None or point >= start) and (end is None or point < end)

    def _usage_for_finance(self, period: str) -> dict[str, dict]:
        usage: dict[str, dict] = {}
        for enterprise_id, summary in self._rollup.all_summaries():
            if not self._in_finance_window(summary.window_start, period):
                continue
            row = usage.setdefault(enterprise_id, {
                "enterprise_id": enterprise_id, "run_count": 0, "token_total": 0,
                "cost_total": Decimal("0"), "unknown_pricing_tokens": 0,
                "unknown_pricing_runs": 0,
            })
            row["run_count"] += summary.run_count
            row["token_total"] += summary.token_total
            row["cost_total"] += summary.cost_total
            if summary.pricing_status == "unknown":
                row["unknown_pricing_tokens"] += summary.token_total
                row["unknown_pricing_runs"] += summary.run_count
        return usage

    def _recharges_for_finance(self, period: str):
        return [r for r in self._admin.list_recharges() if self._in_finance_window(r.created_at, period)]

    def get_finance_overview(self, period: str) -> dict:
        usage = self._usage_for_finance(period)
        recharges = self._recharges_for_finance(period)
        total_recharged = sum((r.amount for r in recharges), Decimal("0"))
        total_tokens = sum(row["token_total"] for row in usage.values())
        total_cost = sum((row["cost_total"] for row in usage.values()), Decimal("0"))
        states = {s.enterprise_id: s for s in self._admin.list_enterprises()}
        top5 = []
        for row in sorted(usage.values(), key=lambda item: (item["cost_total"], item["token_total"]), reverse=True)[:5]:
            state = states.get(row["enterprise_id"])
            top5.append({
                "org_id": row["enterprise_id"],
                "enterprise_name": state.enterprise_name if state else row["enterprise_id"],
                "cost_total": str(row["cost_total"]),
                "token_total": row["token_total"],
                "pricing_status": "partial" if row["unknown_pricing_tokens"] else "known",
                "unknown_pricing_tokens": row["unknown_pricing_tokens"],
            })

        return {
            "period": period,
            "total_recharged": total_recharged,
            "total_tokens_billed": total_tokens,
            "total_api_cost": total_cost,
            "unknown_pricing_tokens": sum(row["unknown_pricing_tokens"] for row in usage.values()),
            "unknown_pricing_runs": sum(row["unknown_pricing_runs"] for row in usage.values()),
            # Recharge is currently CNY while model cost is USD; without an FX rate
            # subtraction would be numerically plausible but economically false.
            "gross_profit": None,
            "profit_margin": None,
            "profit_status": "unavailable_currency_mismatch",
            "revenue_currency": "CNY",
            "cost_currency": "USD",
            "active_orgs": sum(1 for row in usage.values() if row["run_count"] > 0),
            "monthly_trend": self._admin.recharge_trend(period),
            "top5_consumers": top5,
        }

    def get_finance_reports(self, period: str) -> dict:
        recharges = self._recharges_for_finance(period)
        recharge_details = [
            {"recharge_id": r.recharge_id, "enterprise_id": r.enterprise_id,
             "amount": str(r.amount), "created_at": r.created_at.isoformat(), "currency": "CNY"}
            for r in recharges
        ]

        usage = self._usage_for_finance(period)
        consumption_details = [
            {"enterprise_id": row["enterprise_id"], "token_total": row["token_total"],
             "cost_total": str(row["cost_total"]), "run_count": row["run_count"],
             "pricing_status": "partial" if row["unknown_pricing_tokens"] else "known",
             "unknown_pricing_tokens": row["unknown_pricing_tokens"], "currency": "USD"}
            for row in usage.values()
        ]
        total_recharged = sum((r.amount for r in recharges), Decimal("0"))
        total_cost = sum((row["cost_total"] for row in usage.values()), Decimal("0"))
        profit_details = [{
            "total_revenue": str(total_recharged), "revenue_currency": "CNY",
            "total_cost": str(total_cost), "cost_currency": "USD",
            "gross_profit": None, "profit_status": "unavailable_currency_mismatch", "period": period,
        }]
        return {
            "recharge_details": recharge_details,
            "consumption_details": consumption_details,
            "profit_details": profit_details,
        }

    # ---- system health ----

    def get_system_health(self) -> dict:
        now = datetime.now(timezone.utc)
        services: dict[str, str] = {"operation": "up"}
        degraded = False

        for name, probe in (("manager", self._manager_health), ("agent", self._agent_health)):
            if probe is None:
                continue
            try:
                status = probe.check()
            except Exception as exc:
                logger.warning("health probe failed: %s: %s", name, exc)
                status = "degraded"
            services[name] = status
            if status != "up":
                degraded = True

        overall = "degraded" if degraded else "healthy"

        return {
            "status": overall,
            "services": services,
            "timestamp": now,
        }
