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
    planner_prompt: str = ""
    subtask_prompt: str = ""
    aggregate_prompt: str = ""
    default_grants_meta: dict | None = None
    template_meta: dict | None = None
    config_version: int = 1
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
    "knowledge_refs, skill_refs, planner_prompt, subtask_prompt, aggregate_prompt, "
    "default_grants_meta, template_meta, config_version, created_at, updated_at"
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
        planner_prompt=row[8] or "",
        subtask_prompt=row[9] or "",
        aggregate_prompt=row[10] or "",
        default_grants_meta=row[11],
        template_meta=row[12],
        config_version=int(row[13] or 1),
        created_at=row[14],
        updated_at=row[15],
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


@dataclass(frozen=True)
class SolutionApplyRecordRow:
    """方案应用记录（AITEAM-242）。记录 who/when 将哪一版本方案落到本 tenant。"""

    id: str
    tenant_id: str
    solution_id: str
    solution_version: str
    applied_by: str | None
    status: str                          # applied | revoked
    expert_instance_ids: list[str]
    detail: dict | None
    created_at: datetime | None
    updated_at: datetime | None


def _row_to_apply_record(row: Any) -> SolutionApplyRecordRow:
    return SolutionApplyRecordRow(
        id=str(row[0]),
        tenant_id=str(row[1]),
        solution_id=row[2],
        solution_version=row[3],
        applied_by=str(row[4]) if row[4] is not None else None,
        status=row[5],
        expert_instance_ids=[str(v) for v in (row[6] or [])],
        detail=row[7],
        created_at=row[8],
        updated_at=row[9],
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
        planner_prompt: str = "",
        subtask_prompt: str = "",
        aggregate_prompt: str = "",
        default_grants_meta: dict | None = None,
        template_meta: dict | None = None,
        status: str = "applied",
    ) -> SolutionInstanceRow:
        """在本 tenant 建方案实例（展开后的真相）。tenant_id 取自 ctx（D22）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO solution_instance (
                    tenant_id, solution_id, solution_version, display_name, status,
                    expert_employee_ids, knowledge_refs, skill_refs,
                    planner_prompt, subtask_prompt, aggregate_prompt,
                    default_grants_meta, template_meta, config_version
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                RETURNING """ + _SOLUTION_COLUMNS,
                (
                    ctx.tenant_id, solution_id, solution_version, display_name, status,
                    [eid for eid in expert_employee_ids],
                    json.dumps(knowledge_refs), json.dumps(skill_refs),
                    planner_prompt, subtask_prompt, aggregate_prompt,
                    json.dumps(default_grants_meta) if default_grants_meta is not None else None,
                    json.dumps(template_meta) if template_meta is not None else None,
                    1,
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

    def update_solution_instance(
        self,
        ctx: TenantContext,
        *,
        instance_id: str,
        display_name: str | None = None,
        expert_employee_ids: list[str] | None = None,
        knowledge_refs: list[str] | None = None,
        skill_refs: list[str] | None = None,
        planner_prompt: str | None = None,
        subtask_prompt: str | None = None,
        aggregate_prompt: str | None = None,
        status: str | None = None,
    ) -> SolutionInstanceRow | None:
        """局部更新方案实例（仅传字段被写入；tenant_id 取自 ctx，D22）。

        None 字段不写入（保持原值）。返回更新后的行；行不存在 → None（跨 tenant RLS 不可见）。
        """
        sets: list[str] = []
        params: list[Any] = []
        if display_name is not None:
            sets.append("display_name = %s")
            params.append(display_name)
        if expert_employee_ids is not None:
            sets.append("expert_employee_ids = %s")
            params.append([str(e) for e in expert_employee_ids])
        if knowledge_refs is not None:
            sets.append("knowledge_refs = %s")
            params.append(json.dumps(knowledge_refs))
        if skill_refs is not None:
            sets.append("skill_refs = %s")
            params.append(json.dumps(skill_refs))
        if planner_prompt is not None:
            sets.append("planner_prompt = %s")
            params.append(planner_prompt)
        if subtask_prompt is not None:
            sets.append("subtask_prompt = %s")
            params.append(subtask_prompt)
        if aggregate_prompt is not None:
            sets.append("aggregate_prompt = %s")
            params.append(aggregate_prompt)
        if status is not None:
            sets.append("status = %s")
            params.append(status)
        if not sets:
            return self.get_solution_instance(ctx, instance_id=instance_id)
        sets.append("updated_at = now()")
        sets.append("config_version = config_version + 1")
        params.append(instance_id)
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE solution_instance SET " + ", ".join(sets)
                + " WHERE id = %s RETURNING " + _SOLUTION_COLUMNS,
                tuple(params),
            ).fetchone()
        return _row_to_solution(row) if row is not None else None

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


    # ---- solution_apply_record（方案应用记录，AITEAM-242，issue #286）----
    def create_solution_apply_record(
        self,
        ctx: TenantContext,
        *,
        solution_id: str,
        solution_version: str,
        applied_by: str | None,
        expert_instance_ids: list[str],
        detail: dict | None = None,
        status: str = "applied",
    ) -> SolutionApplyRecordRow:
        """写一条方案应用记录（apply 成功后追加）。幂等：同 (tenant, solution, version) 唯一。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO solution_apply_record (
                    tenant_id, solution_id, solution_version, applied_by, status,
                    expert_instance_ids, detail
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (tenant_id, solution_id, solution_version) DO UPDATE
                    SET applied_by = EXCLUDED.applied_by,
                        status = EXCLUDED.status,
                        expert_instance_ids = EXCLUDED.expert_instance_ids,
                        detail = EXCLUDED.detail,
                        updated_at = now()
                RETURNING id, tenant_id, solution_id, solution_version, applied_by, status,
                          expert_instance_ids, detail, created_at, updated_at
                """,
                (
                    ctx.tenant_id, solution_id, solution_version, applied_by,
                    status, [eid for eid in expert_instance_ids],
                    json.dumps(detail) if detail is not None else None,
                ),
            ).fetchone()
        return _row_to_apply_record(row)

    def list_solution_apply_records(
        self,
        ctx: TenantContext,
        *,
        solution_id: str | None = None,
        status: str | None = None,
    ) -> list[SolutionApplyRecordRow]:
        """列本 tenant 方案应用记录（audited history），可按 solution_id / status 过滤。"""
        clauses: list[str] = []
        params: list[Any] = []
        if solution_id:
            clauses.append("solution_id = %s")
            params.append(solution_id)
        if status:
            clauses.append("status = %s")
            params.append(status)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, tenant_id, solution_id, solution_version, applied_by, status, "
                "expert_instance_ids, detail, created_at, updated_at "
                "FROM solution_apply_record "
                f"{where} ORDER BY created_at DESC",
                tuple(params),
            ).fetchall()
        return [_row_to_apply(r) for r in rows]

    def get_latest_solution_apply_record(
        self, ctx: TenantContext, *, solution_id: str
    ) -> SolutionApplyRecordRow | None:
        """查某方案最新的非 revoked 应用记录（用于反查企业当前专家配置来源）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT id, tenant_id, solution_id, solution_version, applied_by, status, "
                "expert_instance_ids, detail, created_at, updated_at "
                "FROM solution_apply_record "
                "WHERE solution_id = %s AND status = 'applied' "
                "ORDER BY created_at DESC LIMIT 1",
                (solution_id,),
            ).fetchone()
        return _row_to_apply_record(row) if row is not None else None

