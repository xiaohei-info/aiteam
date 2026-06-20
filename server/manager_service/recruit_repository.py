"""招募/应用方案租户作用域数据访问（M6，05 F06/F07 / 04 §6.1，D12/D22）。

铁律同 EmployeeConfigRepository / MemberDeptRepository：所有方法以 TenantContext 为隔离边界，
tenant_id 只从 ctx 读，SQL 不接受调用方手写 tenant 过滤字符串（D22）。RLS 强制跨租户隔离
（04 §6.1.1，solution_instance / recruit_event 均 ENABLE + FORCE RLS，见迁移 0006）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


def _s(value: Any) -> str:
    return str(value)


def _sa(values: Any) -> list[str]:
    return [str(v) for v in (values or [])]


@dataclass(frozen=True)
class SolutionInstanceRow:
    """本 tenant 的方案实例真相（从 Operator 方案包展开）。"""

    id: str
    solution_id: str
    solution_version: str
    display_name: str
    status: str
    expert_employee_ids: list[str]
    knowledge_refs: list[str]
    skill_refs: list[str]
    default_grants_meta: dict | None
    template_meta: dict | None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True)
class RecruitEventRow:
    """招募/应用方案审计事件（F06/F07 审计）。"""

    id: str
    action: str
    actor_user_id: str | None
    source_template_id: str | None
    source_template_version: str | None
    source_solution_id: str | None
    source_solution_version: str | None
    target_employee_ids: list[str]
    target_solution_instance_id: str | None
    detail: dict | None
    created_at: datetime | None = None


_SOLUTION_COLUMNS = (
    "id, solution_id, solution_version, display_name, status, expert_employee_ids, "
    "knowledge_refs, skill_refs, default_grants_meta, template_meta, created_at, updated_at"
)


def _row_to_solution(row: Any) -> SolutionInstanceRow:
    return SolutionInstanceRow(
        id=_s(row[0]),
        solution_id=row[1],
        solution_version=row[2],
        display_name=row[3],
        status=row[4],
        expert_employee_ids=_sa(row[5]),
        knowledge_refs=list(row[6] or []),
        skill_refs=list(row[7] or []),
        default_grants_meta=row[8],
        template_meta=row[9],
        created_at=row[10],
        updated_at=row[11],
    )


_EVENT_COLUMNS = (
    "id, action, actor_user_id, source_template_id, source_template_version, "
    "source_solution_id, source_solution_version, target_employee_ids, "
    "target_solution_instance_id, detail, created_at"
)


def _row_to_event(row: Any) -> RecruitEventRow:
    return RecruitEventRow(
        id=_s(row[0]),
        action=row[1],
        actor_user_id=_s(row[2]) if row[2] is not None else None,
        source_template_id=row[3],
        source_template_version=row[4],
        source_solution_id=row[5],
        source_solution_version=row[6],
        target_employee_ids=_sa(row[7]),
        target_solution_instance_id=_s(row[8]) if row[8] is not None else None,
        detail=row[9],
        created_at=row[10],
    )


class RecruitRepository:
    """solution_instance + recruit_event 的租户内读写。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    # ---- solution_instance ----
    def create_solution_instance(
        self,
        ctx: TenantContext,
        *,
        solution_id: str,
        solution_version: str,
        display_name: str,
        expert_employee_ids: list[str],
        knowledge_refs: list[str],
        skill_refs: list[str],
        default_grants_meta: dict | None,
        template_meta: dict | None,
        status: str = "applied",
    ) -> SolutionInstanceRow:
        """在本 tenant 建方案实例（展开后的真相）。tenant_id 取自 ctx（D22）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO solution_instance (
                    tenant_id, solution_id, solution_version, display_name, status,
                    expert_employee_ids, knowledge_refs, skill_refs,
                    default_grants_meta, template_meta
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                RETURNING """ + _SOLUTION_COLUMNS,
                (
                    ctx.tenant_id, solution_id, solution_version, display_name, status,
                    [eid for eid in expert_employee_ids],
                    json.dumps(knowledge_refs), json.dumps(skill_refs),
                    json.dumps(default_grants_meta) if default_grants_meta is not None else None,
                    json.dumps(template_meta) if template_meta is not None else None,
                ),
            ).fetchone()
        return _row_to_solution(row)

    def get_solution_instance(self, ctx: TenantContext, *, instance_id: str) -> SolutionInstanceRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _SOLUTION_COLUMNS + " FROM solution_instance WHERE id = %s",
                (instance_id,),
            ).fetchone()
        return _row_to_solution(row) if row is not None else None

    def find_solution_instance(
        self, ctx: TenantContext, *, solution_id: str, solution_version: str
    ) -> SolutionInstanceRow | None:
        """按 (solution_id, version) 查本 tenant 内实例（跨 tenant RLS 不可见）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _SOLUTION_COLUMNS
                + " FROM solution_instance WHERE solution_id = %s AND solution_version = %s",
                (solution_id, solution_version),
            ).fetchone()
        return _row_to_solution(row) if row is not None else None

    def list_solution_instances(self, ctx: TenantContext) -> list[SolutionInstanceRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _SOLUTION_COLUMNS + " FROM solution_instance ORDER BY created_at"
            ).fetchall()
        return [_row_to_solution(r) for r in rows]

    # ---- recruit_event（审计，只追加）----
    def append_recruit_event(
        self,
        ctx: TenantContext,
        *,
        action: str,
        actor_user_id: str | None = None,
        source_template_id: str | None = None,
        source_template_version: str | None = None,
        source_solution_id: str | None = None,
        source_solution_version: str | None = None,
        target_employee_ids: list[str] | None = None,
        target_solution_instance_id: str | None = None,
        detail: dict | None = None,
    ) -> RecruitEventRow:
        """追加招募/应用方案审计事件（F06/F07，04 §6.1.3 审计口径）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO recruit_event (
                    tenant_id, action, actor_user_id, source_template_id, source_template_version,
                    source_solution_id, source_solution_version, target_employee_ids,
                    target_solution_instance_id, detail
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                RETURNING """ + _EVENT_COLUMNS,
                (
                    ctx.tenant_id, action, actor_user_id,
                    source_template_id, source_template_version,
                    source_solution_id, source_solution_version,
                    [eid for eid in (target_employee_ids or [])],
                    target_solution_instance_id,
                    json.dumps(detail) if detail is not None else None,
                ),
            ).fetchone()
        return _row_to_event(row)

    def list_recruit_events(self, ctx: TenantContext) -> list[RecruitEventRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _EVENT_COLUMNS + " FROM recruit_event ORDER BY created_at"
            ).fetchall()
        return [_row_to_event(r) for r in rows]
