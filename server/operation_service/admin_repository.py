"""运营端 admin 仓储（oper 库骨架，S01/S03/S04）。

持有运营端企业运营状态：封禁/解封、充值记录、配额调整、操作审计轨迹。
只持平台运营真相，不直写 Manager/Agent。

骨架期用进程内存实现；详设接 PostgreSQL（oper 库），接口形状不变。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal

from shared.errors import NotFound


@dataclass
class EnterpriseAdminState:
    """企业运营侧状态。区别于 EnterpriseAccount（开通/凭据），本记录只持运营面字段。"""

    enterprise_id: str
    enterprise_name: str
    owner_phone: str = ""
    status: str = "normal"  # normal | banned
    total_recharged: Decimal = field(default_factory=lambda: Decimal("0"))
    registered_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    quotas: dict = field(default_factory=dict)


@dataclass
class RechargeRecord:
    """单笔充值记录。"""

    recharge_id: str
    enterprise_id: str
    amount: Decimal
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class AuditEvent:
    """企业操作审计事件。"""

    event_id: str
    enterprise_id: str
    action: str
    detail: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class AdminRepository:
    """运营端管理仓储（进程内）。骨架期线程不安全；详设接 PG。"""

    def __init__(self) -> None:
        self._states: dict[str, EnterpriseAdminState] = {}
        self._recharges: list[RechargeRecord] = []
        self._audits: list[AuditEvent] = []

    # ---- 企业状态 ----

    def register_enterprise(
        self, enterprise_id: str, enterprise_name: str, owner_phone: str = ""
    ) -> EnterpriseAdminState:
        """幂等：企业首次出现时初始化 admin state。已存在则返回已有记录。"""
        if enterprise_id in self._states:
            return self._states[enterprise_id]
        state = EnterpriseAdminState(
            enterprise_id=enterprise_id,
            enterprise_name=enterprise_name,
            owner_phone=owner_phone,
        )
        self._states[enterprise_id] = state
        return state

    def get_state(self, enterprise_id: str) -> EnterpriseAdminState:
        s = self._states.get(enterprise_id)
        if s is None:
            raise NotFound(f"enterprise admin state not found: {enterprise_id}")
        return s

    def set_status(self, enterprise_id: str, status: str) -> EnterpriseAdminState:
        s = self.get_state(enterprise_id)
        s.status = status
        return s

    def add_recharge(self, enterprise_id: str, amount: Decimal) -> RechargeRecord:
        s = self.get_state(enterprise_id)
        s.total_recharged += amount
        rec = RechargeRecord(
            recharge_id=f"rchg:{enterprise_id}:{len(self._recharges)}",
            enterprise_id=enterprise_id,
            amount=amount,
        )
        self._recharges.append(rec)
        return rec

    def set_quota(self, enterprise_id: str, quotas: dict) -> EnterpriseAdminState:
        s = self.get_state(enterprise_id)
        s.quotas = quotas
        return s

    def record_audit(self, enterprise_id: str, action: str, detail: str) -> AuditEvent:
        evt = AuditEvent(
            event_id=f"audit:{enterprise_id}:{len(self._audits)}",
            enterprise_id=enterprise_id,
            action=action,
            detail=detail,
        )
        self._audits.append(evt)
        return evt

    # ---- 列表 ----

    def list_enterprises(
        self, *, keyword: str | None = None, status: str | None = None
    ) -> list[EnterpriseAdminState]:
        results = list(self._states.values())
        if keyword:
            kw = keyword.lower()
            results = [
                s
                for s in results
                if kw in s.enterprise_name.lower() or kw in s.enterprise_id.lower()
            ]
        if status:
            results = [s for s in results if s.status == status]
        return results

    def list_recharges(self, enterprise_id: str | None = None) -> list[RechargeRecord]:
        if enterprise_id is None:
            return list(self._recharges)
        return [r for r in self._recharges if r.enterprise_id == enterprise_id]

    def list_audits(self, enterprise_id: str | None = None) -> list[AuditEvent]:
        if enterprise_id is None:
            return list(self._audits)
        return [a for a in self._audits if a.enterprise_id == enterprise_id]

    # ---- 聚合统计 ----

    def total_recharged_all(self) -> Decimal:
        return sum((s.total_recharged for s in self._states.values()), Decimal("0"))

    def enterprise_count(self) -> int:
        return len(self._states)

    def new_this_month(self) -> int:
        now = datetime.now(timezone.utc)
        count = 0
        for s in self._states.values():
            delta = now - s.registered_at
            if delta.days < 30:
                count += 1
        return count

    def monthly_active(self) -> int:
        """已接入 rollup 数据的企业数（至少收到一条运行为 active）。"""
        active_ids: set[str] = set()
        for r in self._recharges:
            active_ids.add(r.enterprise_id)
        return len(active_ids)

    def top_consumers(self, n: int = 5) -> list[EnterpriseAdminState]:
        return sorted(
            self._states.values(), key=lambda s: s.total_recharged, reverse=True
        )[:n]

    def recharge_trend(self, _period: str) -> list[dict]:
        """按月份聚合充值趋势。骨架期一律返回按月分桶。"""
        buckets: dict[str, Decimal] = {}
        for r in self._recharges:
            month_key = r.created_at.strftime("%Y-%m")
            buckets[month_key] = buckets.get(month_key, Decimal("0")) + r.amount
        return [
            {"period": k, "amount": str(v)} for k, v in sorted(buckets.items())
        ]
