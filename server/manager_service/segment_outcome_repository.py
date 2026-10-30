"""段落结果评估小时汇总的数据访问（议题 1 / 议题 7：解决率）。

Agent 经 F13 上报「成员 + 员工 + UTC 小时」的已评估/已解决段数（绝对值）；本仓储按
summary_id 覆盖写入，并按员工、按来源模板聚合。只存计数，不含会话文本、评估备注或原因标签。

铁律（D22）：tenant_id 只从 TenantContext 读，跨租户隔离由 RLS 保证；SQL 不接受调用方手写
tenant 过滤，过滤条件来自固定白名单。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict

# 与 Agent 本地 RESOLUTION_RATE_MIN_SAMPLE 一致：已评估少于该段数时不发布解决率。
RESOLUTION_RATE_MIN_SAMPLE = 10


def resolution_rate(evaluated: int, resolved: int) -> float | None:
    """已解决 ÷ 已评估；样本不足 RESOLUTION_RATE_MIN_SAMPLE 时为 None。"""
    return resolved / evaluated if evaluated >= RESOLUTION_RATE_MIN_SAMPLE else None


@dataclass(frozen=True)
class SegmentOutcomeCounts:
    """一个分组（员工或模板）的已评估/已解决段数。"""

    group_id: str | None
    display_name: str | None
    evaluated_count: int
    resolved_count: int


def _uuid(value: str | None) -> UUID | None:
    return None if value is None else UUID(str(value))


class SegmentOutcomeRepository:
    """segment_outcome_rollup 的租户内读写。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def upsert(self, ctx: TenantContext, *, payload: dict) -> None:
        """按 (tenant_id, summary_id) 覆盖为最新绝对计数；同一 summary 的成员/员工归属不可改。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO segment_outcome_rollup (
                    tenant_id, summary_id, member_id, employee_id, window_start, window_end,
                    evaluated_count, resolved_count
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (tenant_id, summary_id) DO UPDATE SET
                    evaluated_count = EXCLUDED.evaluated_count,
                    resolved_count = EXCLUDED.resolved_count,
                    received_at = now()
                WHERE segment_outcome_rollup.member_id = EXCLUDED.member_id
                  AND segment_outcome_rollup.employee_id = EXCLUDED.employee_id
                  AND segment_outcome_rollup.window_start = EXCLUDED.window_start
                RETURNING summary_id
                """,
                (
                    _uuid(ctx.tenant_id), payload["summary_id"], _uuid(payload["member_id"]),
                    _uuid(payload["employee_id"]), payload["window_start"], payload["window_end"],
                    payload["evaluated_count"], payload["resolved_count"],
                ),
            ).fetchone()
        if row is None:
            raise Conflict("segment outcome summary attribution is immutable once assigned")

    def counts_by_employee(
        self,
        ctx: TenantContext,
        *,
        employee_id: str | None = None,
        member_id: str | None = None,
        window_start: datetime | None = None,
        window_end: datetime | None = None,
    ) -> list[SegmentOutcomeCounts]:
        """按员工聚合；时间窗按段落结束所在小时 [window_start, window_end) 过滤，null 参数表示不过滤。"""
        employee = _uuid(employee_id)
        member = _uuid(member_id)
        with self._router.session(ctx) as s:
            rows = s.execute(
                """
                SELECT o.employee_id, MAX(e.display_name),
                       COALESCE(SUM(o.evaluated_count), 0), COALESCE(SUM(o.resolved_count), 0)
                FROM segment_outcome_rollup AS o LEFT JOIN employee AS e ON e.id = o.employee_id
                WHERE (%s::timestamptz IS NULL OR o.window_start >= %s::timestamptz)
                  AND (%s::timestamptz IS NULL OR o.window_end <= %s::timestamptz)
                  AND (%s::uuid IS NULL OR o.employee_id = %s::uuid)
                  AND (%s::uuid IS NULL OR o.member_id = %s::uuid)
                GROUP BY o.employee_id
                ORDER BY SUM(o.evaluated_count) DESC, o.employee_id
                """,
                (window_start, window_start, window_end, window_end, employee, employee, member, member),
            ).fetchall()
        return [
            SegmentOutcomeCounts(
                group_id=str(row[0]), display_name=row[1],
                evaluated_count=int(row[2] or 0), resolved_count=int(row[3] or 0),
            )
            for row in rows
        ]

    def counts_by_source_template(self, ctx: TenantContext) -> dict[str, SegmentOutcomeCounts]:
        """按员工的 Operator 来源模板聚合全企业计数；只覆盖直接招募（带 source_template_id）的员工。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT e.source_template_id, COALESCE(SUM(o.evaluated_count), 0), "
                "COALESCE(SUM(o.resolved_count), 0) "
                "FROM segment_outcome_rollup AS o JOIN employee AS e ON e.id = o.employee_id "
                "WHERE e.source_template_id IS NOT NULL GROUP BY e.source_template_id",
            ).fetchall()
        return {
            str(row[0]): SegmentOutcomeCounts(
                group_id=str(row[0]), display_name=None,
                evaluated_count=int(row[1] or 0), resolved_count=int(row[2] or 0),
            )
            for row in rows
        }
