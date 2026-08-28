"""运营端跨企业 rollup 仓储（cross_enterprise_usage_rollup，oper 库骨架）。

单写者：cross_enterprise_usage_rollup 唯一写端是 Operator（CLAUDE/AGENTS §3.2）。
只持**企业级脱敏聚合数字** + 已见 summary_id（幂等去重），绝不持成员/会话/token 明细（D13）。

骨架期用进程内存实现；详设接 PostgreSQL（oper 库），接口形状不变。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from shared.contracts.summary import UsageSummary
from abc import ABC, abstractmethod
from shared.errors import NotFound


@dataclass
class EnterpriseRollupRow:
    """单企业累加器。只存聚合标量；seen_ids 仅用于幂等，不含任何明细内容。"""

    enterprise_id: str
    tenant_id: str
    run_count: int = 0
    token_total: int = 0
    cost_total: Decimal = field(default_factory=lambda: Decimal("0"))
    unknown_pricing_tokens: int = 0
    unknown_pricing_runs: int = 0
    error_count: int = 0
    duration_seconds_total: int = 0
    summary_count: int = 0
    window_start: datetime | None = None
    window_end: datetime | None = None
    _seen_ids: set[str] = field(default_factory=set)
    _summaries: list["UsageSummary"] = field(default_factory=list)

    def apply(self, s: UsageSummary) -> bool:
        """累加一条脱敏摘要；已见 summary_id 直接跳过。返回是否真正计入。"""
        if s.summary_id in self._seen_ids:
            return False
        self._seen_ids.add(s.summary_id)
        self.run_count += s.run_count
        self.token_total += s.token_total
        self.cost_total += s.cost_total
        if s.pricing_status == "unknown":
            self.unknown_pricing_tokens += s.token_total
            self.unknown_pricing_runs += s.run_count
        self.error_count += s.error_count
        self.duration_seconds_total += s.duration_seconds_total
        self.summary_count += 1
        if self.window_start is None or s.window_start < self.window_start:
            self.window_start = s.window_start
        if self.window_end is None or s.window_end > self.window_end:
            self.window_end = s.window_end
        self._summaries.append(s)
        return True


class CrossEnterpriseRollupRepositoryBase(ABC):
    """Common shape for the cross-enterprise usage-rollup repository."""

    @abstractmethod
    def apply_summary(self, enterprise_id, tenant_id, summary): ...
    @abstractmethod
    def get(self, enterprise_id): ...
    @abstractmethod
    def list_all(self): ...
    @abstractmethod
    def summaries_for(self, enterprise_id): ...
    @abstractmethod
    def all_summaries(self): ...


class CrossEnterpriseRollupRepository(CrossEnterpriseRollupRepositoryBase):
    """跨企业 rollup 的进程内仓储。每企业一行累加器，幂等去重在行内完成。"""

    def __init__(self) -> None:
        self._rows: dict[str, EnterpriseRollupRow] = {}

    def apply_summary(self, enterprise_id: str, tenant_id: str, summary: UsageSummary) -> None:
        row = self._rows.get(enterprise_id)
        if row is None:
            row = EnterpriseRollupRow(enterprise_id=enterprise_id, tenant_id=tenant_id)
            self._rows[enterprise_id] = row
        row.apply(summary)

    def get(self, enterprise_id: str) -> EnterpriseRollupRow:
        row = self._rows.get(enterprise_id)
        if row is None:
            raise NotFound(f"enterprise rollup not found: {enterprise_id}")
        return row

    def list_all(self) -> list[EnterpriseRollupRow]:
        return list(self._rows.values())


    def summaries_for(self, enterprise_id: str) -> list[UsageSummary]:
        """某企业全部已入库脱敏摘要（按入库顺序）。未知企业 → []。"""
        row = self._rows.get(enterprise_id)
        if row is None:
            return []
        return list(row._summaries)

    def all_summaries(self) -> list[tuple[str, UsageSummary]]:
        """全平台已入库脱敏摘要，附带 enterprise_id。"""
        out: list[tuple[str, UsageSummary]] = []
        for eid, row in self._rows.items():
            for s in row._summaries:
                out.append((eid, s))
        return out


class PgRollupRepository(CrossEnterpriseRollupRepositoryBase):
    """Postgres-backed cross-enterprise usage-rollup repository (oper library).

    Idempotent by ``summary_id`` (via UNIQUE). Selected by the DI factory when
    ``admin_db_url`` is configured.
    """

    def __init__(self, dsn):
        self._dsn = dsn

    @staticmethod
    def _to_summary(tenant_id, row):
        return UsageSummary(
            summary_id=row[0], tenant_id=tenant_id,
            window_start=row[1], window_end=row[2],
            run_count=row[3] or 0, token_total=row[4] or 0,
            cost_total=row[5] or Decimal("0"), error_count=row[6] or 0,
            duration_seconds_total=row[7] or 0,
            pricing_version=row[8], pricing_status=row[9] or "unknown", currency=row[10] or "USD",
        )

    def apply_summary(self, enterprise_id, tenant_id, summary):
        import psycopg
        upsert_seen = (
            "INSERT INTO operation_rollup_seen "
            "(enterprise_id, summary_id, tenant_id, employee_id, run_count, token_total, "
            "cost_total, error_count, duration_seconds_total, pricing_version, pricing_status, currency, window_start, window_end) "
            "VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (summary_id) DO UPDATE SET "
            "enterprise_id=EXCLUDED.enterprise_id, tenant_id=EXCLUDED.tenant_id, employee_id=EXCLUDED.employee_id, "
            "run_count=EXCLUDED.run_count, token_total=EXCLUDED.token_total, cost_total=EXCLUDED.cost_total, "
            "error_count=EXCLUDED.error_count, duration_seconds_total=EXCLUDED.duration_seconds_total, "
            "pricing_version=EXCLUDED.pricing_version, pricing_status=EXCLUDED.pricing_status, currency=EXCLUDED.currency, "
            "window_start=EXCLUDED.window_start, window_end=EXCLUDED.window_end"
        )
        recompute = (
            "INSERT INTO cross_enterprise_usage_rollup "
            "(enterprise_id, tenant_id, run_count, token_total, cost_total, error_count, "
            "duration_seconds_total, summary_count, window_start, window_end, updated_at) "
            "VALUES (%s::uuid, %s, "
            "(SELECT COALESCE(SUM(run_count), 0) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid), "
            "(SELECT COALESCE(SUM(token_total), 0) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid), "
            "(SELECT COALESCE(SUM(cost_total), 0) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid), "
            "(SELECT COALESCE(SUM(error_count), 0) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid), "
            "(SELECT COALESCE(SUM(duration_seconds_total), 0) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid), "
            "(SELECT COUNT(*) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid), "
            "(SELECT MIN(window_start) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid), "
            "(SELECT MAX(window_end) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid), "
            "now()) "
            "ON CONFLICT (enterprise_id) DO UPDATE SET "
            "run_count = (SELECT COALESCE(SUM(run_count), 0) FROM operation_rollup_seen WHERE enterprise_id = cross_enterprise_usage_rollup.enterprise_id), "
            "token_total = (SELECT COALESCE(SUM(token_total), 0) FROM operation_rollup_seen WHERE enterprise_id = cross_enterprise_usage_rollup.enterprise_id), "
            "cost_total = (SELECT COALESCE(SUM(cost_total), 0) FROM operation_rollup_seen WHERE enterprise_id = cross_enterprise_usage_rollup.enterprise_id), "
            "error_count = (SELECT COALESCE(SUM(error_count), 0) FROM operation_rollup_seen WHERE enterprise_id = cross_enterprise_usage_rollup.enterprise_id), "
            "duration_seconds_total = (SELECT COALESCE(SUM(duration_seconds_total), 0) FROM operation_rollup_seen WHERE enterprise_id = cross_enterprise_usage_rollup.enterprise_id), "
            "summary_count = (SELECT COUNT(*) FROM operation_rollup_seen WHERE enterprise_id = cross_enterprise_usage_rollup.enterprise_id), "
            "window_start = (SELECT MIN(window_start) FROM operation_rollup_seen WHERE enterprise_id = cross_enterprise_usage_rollup.enterprise_id), "
            "window_end = (SELECT MAX(window_end) FROM operation_rollup_seen WHERE enterprise_id = cross_enterprise_usage_rollup.enterprise_id), "
            "updated_at = now()"
        )
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(upsert_seen, (
                    enterprise_id, summary.summary_id, tenant_id,
                    summary.employee_id, summary.run_count, summary.token_total,
                    summary.cost_total, summary.error_count, summary.duration_seconds_total,
                    summary.pricing_version, summary.pricing_status, summary.currency, summary.window_start, summary.window_end,
                ))
                cur.execute(recompute, tuple([enterprise_id, tenant_id] + [enterprise_id] * 8))
            conn.commit()

    def get(self, enterprise_id):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT run_count, token_total, cost_total, "
                    "(SELECT COALESCE(SUM(token_total), 0) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid AND pricing_status = 'unknown'), "
                    "(SELECT COALESCE(SUM(run_count), 0) FROM operation_rollup_seen WHERE enterprise_id = %s::uuid AND pricing_status = 'unknown'), "
                    "error_count, duration_seconds_total, summary_count, window_start, window_end, tenant_id "
                    "FROM cross_enterprise_usage_rollup WHERE enterprise_id = %s::uuid",
                    (enterprise_id, enterprise_id, enterprise_id),
                )
                row = cur.fetchone()
                if row is None:
                    raise NotFound(f"enterprise rollup not found: {enterprise_id}")
                return EnterpriseRollupRow(
                    enterprise_id=enterprise_id, tenant_id=row[10],
                    run_count=row[0] or 0, token_total=row[1] or 0,
                    cost_total=row[2] or Decimal("0"), unknown_pricing_tokens=row[3] or 0,
                    unknown_pricing_runs=row[4] or 0, error_count=row[5] or 0,
                    duration_seconds_total=row[6] or 0, summary_count=row[7] or 0,
                    window_start=row[8], window_end=row[9],
                )

    def list_all(self):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT r.enterprise_id, r.tenant_id, r.run_count, r.token_total, r.cost_total, "
                    "(SELECT COALESCE(SUM(s.token_total), 0) FROM operation_rollup_seen s WHERE s.enterprise_id = r.enterprise_id AND s.pricing_status = 'unknown'), "
                    "(SELECT COALESCE(SUM(s.run_count), 0) FROM operation_rollup_seen s WHERE s.enterprise_id = r.enterprise_id AND s.pricing_status = 'unknown'), "
                    "r.error_count, r.duration_seconds_total, r.summary_count, r.window_start, r.window_end "
                    "FROM cross_enterprise_usage_rollup r"
                )
                rows = cur.fetchall()
        return [
            EnterpriseRollupRow(
                enterprise_id=str(r[0]), tenant_id=r[1], run_count=r[2] or 0, token_total=r[3] or 0,
                cost_total=r[4] or Decimal("0"), unknown_pricing_tokens=r[5] or 0,
                unknown_pricing_runs=r[6] or 0, error_count=r[7] or 0,
                duration_seconds_total=r[8] or 0, summary_count=r[9] or 0,
                window_start=r[10], window_end=r[11],
            )
            for r in rows
        ]

    def summaries_for(self, enterprise_id):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT tenant_id FROM cross_enterprise_usage_rollup WHERE enterprise_id = %s::uuid LIMIT 1",
                    (enterprise_id,),
                )
                head = cur.fetchone()
                tenant_id = head[0] if head else ""
                cur.execute(
                    "SELECT summary_id, window_start, window_end, run_count, token_total, "
                    "cost_total, error_count, duration_seconds_total, pricing_version, pricing_status, currency FROM operation_rollup_seen "
                    "WHERE enterprise_id = %s::uuid ORDER BY created_at",
                    (enterprise_id,),
                )
                rows = cur.fetchall()
        return [self._to_summary(tenant_id, r) for r in rows]

    def all_summaries(self):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT s.enterprise_id, s.summary_id, s.window_start, s.window_end, "
                    "s.run_count, s.token_total, s.cost_total, s.error_count, "
                    "s.duration_seconds_total, s.pricing_version, s.pricing_status, s.currency, a.tenant_id "
                    "FROM operation_rollup_seen s "
                    "LEFT JOIN cross_enterprise_usage_rollup a ON a.enterprise_id = s.enterprise_id "
                    "ORDER BY s.enterprise_id, s.created_at"
                )
                rows = cur.fetchall()
        return [(str(r[0]), self._to_summary(r[12] or "", r[1:12])) for r in rows]
