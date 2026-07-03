"""运营端行业方案应用统计仓储（oper 库骨架）。

统计口径：按 ``solution_id`` 聚合方案应用数据。
- ``apply_count``：该方案被应用的总次数（同一租户重复应用累计）。
- ``active_enterprises``：当前仍持有 ``applied`` 状态实例的去重租户数。

骨架期用进程内存实现；详设接 PostgreSQL（oper 库，``GROUP BY solution_id``），
接入数据库后本接口形状不变。
"""

from __future__ import annotations

from collections import defaultdict
from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class _SolutionAgg:
    """单方案的聚合计数器。"""

    apply_count: int = 0
    applied_enterprises: set[str] = field(default_factory=set)


class SolutionRepositoryBase(ABC):
    """Common shape for the solution-statistics repository."""
    @abstractmethod
    def record_apply(self, *, solution_id, enterprise_id, applied=True): ...
    @abstractmethod
    def get_stats(self, solution_id): ...
    @abstractmethod
    def list_stats(self): ...


class SolutionRepository(SolutionRepositoryBase):
    """行业方案应用统计仓储（骨架进程内）。线程不安全；详设接 PG。"""

    def __init__(self) -> None:
        self._by_solution: dict[str, _SolutionAgg] = defaultdict(_SolutionAgg)

    def record_apply(self, *, solution_id: str, enterprise_id: str, applied: bool = True) -> None:
        """登记一次方案应用（同一 enterprise 重复调用累计 apply_count）。"""
        agg = self._by_solution[solution_id]
        agg.apply_count += 1
        if applied:
            agg.applied_enterprises.add(enterprise_id)

    def get_stats(self, solution_id: str) -> dict:
        """返回单个方案的聚合统计。未登记过则返回零值。"""
        agg = self._by_solution.get(solution_id)
        if agg is None:
            return {"apply_count": 0, "active_enterprises": 0}
        return {
            "apply_count": agg.apply_count,
            "active_enterprises": len(agg.applied_enterprises),
        }

    def list_stats(self) -> dict[str, dict]:
        """返回全部方案的聚合统计，按 solution_id 索引。"""
        return {
            sid: {
                "apply_count": agg.apply_count,
                "active_enterprises": len(agg.applied_enterprises),
            }
            for sid, agg in self._by_solution.items()
        }


class PgSolutionRepository(SolutionRepositoryBase):
    """Postgres-backed solution apply-statistics repository (oper library)."""

    def __init__(self, dsn):
        self._dsn = dsn

    def record_apply(self, *, solution_id, enterprise_id, applied=True):
        if not applied:
            return
        import psycopg
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO solution_stat (solution_id, enterprise_id) VALUES (%s, %s) "
                    "ON CONFLICT (solution_id, enterprise_id) DO NOTHING",
                    (solution_id, enterprise_id),
                )
            conn.commit()

    def get_stats(self, solution_id):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*), COUNT(DISTINCT enterprise_id) FROM solution_stat WHERE solution_id = %s",
                    (solution_id,),
                )
                row = cur.fetchone()
        return {"apply_count": int(row[0]), "active_enterprises": int(row[1])}

    def list_stats(self):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT solution_id, COUNT(*), COUNT(DISTINCT enterprise_id) FROM solution_stat "
                    "GROUP BY solution_id",
                )
                rows = cur.fetchall()
        return {r[0]: {"apply_count": int(r[1]), "active_enterprises": int(r[2])} for r in rows}
