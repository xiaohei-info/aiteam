"""employee/expert 配置租户作用域数据访问（M2，06 §7.6 / 04 §6.1，D16/D22）。

铁律：与 TenantAuthRepository 一致——所有方法以 TenantContext 为隔离边界，tenant_id 只从 ctx
读取，SQL 不接受调用方手写 tenant 过滤字符串（D22）。RLS 强制跨租户隔离（04 §6.1.1）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from psycopg import errors as pg_errors
from datetime import datetime
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict


@dataclass(frozen=True)
class EmployeeConfigRow:
    """employee 配置行（Pi 会话中立字段）+ 生命周期状态。"""

    employee_id: str
    employee_slug: str
    display_name: str
    persona: str | None
    model: str | None
    provider_ref: str | None
    thinking_level: str | None
    timeout_seconds: int | None
    tools: list[str]
    skills: list[str]
    knowledge_refs: list[str]
    connector_refs: list[str]
    memory_policy: dict | None
    version: int
    status: str
    archive_reason: str | None = None
    archived_at: datetime | None = None


_CONFIG_COLUMNS = (
    "id, employee_slug, display_name, persona, model, provider_ref, thinking_level, "
    "timeout_seconds, tools, skills, knowledge_refs, connector_refs, "
    "memory_policy, version, status, archive_reason, archived_at"
)


def _row_to_config(row: Any) -> EmployeeConfigRow:
    return EmployeeConfigRow(
        employee_id=str(row[0]),
        employee_slug=row[1],
        display_name=row[2],
        persona=row[3],
        model=row[4],
        provider_ref=row[5],
        thinking_level=row[6],
        timeout_seconds=row[7],
        tools=list(row[8] or []),
        skills=list(row[9] or []),
        knowledge_refs=list(row[10] or []),
        connector_refs=list(row[11] or []),
        memory_policy=row[12],
        version=row[13],
        status=row[14],
        archive_reason=row[15],
        archived_at=row[16],
    )


class EmployeeConfigRepository:
    """employee 配置的租户内读写。Pi 会话中立（D16）；tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(
        self,
        ctx: TenantContext,
        *,
        employee_slug: str,
        display_name: str,
        persona: str | None,
        model: str | None,
        provider_ref: str | None,
        thinking_level: str | None,
        timeout_seconds: int | None,
        tools: list[str],
        skills: list[str],
        knowledge_refs: list[str],
        connector_refs: list[str],
        memory_policy: dict | None,
        source_template_id: str | None = None,
        source_template_version: str | None = None,
    ) -> EmployeeConfigRow:
        """在本 tenant 建 employee 配置行。tenant_id 取自 ctx（D22，RLS WITH CHECK 兜底）。"""
        try:
            with self._router.session(ctx) as s:
                row = s.execute(
                    """
                    INSERT INTO employee (
                        tenant_id, employee_slug, display_name, persona, model, provider_ref,
                        thinking_level, timeout_seconds, tools, skills,
                        knowledge_refs, connector_refs, memory_policy,
                        source_template_id, source_template_version
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                    )
                    RETURNING """ + _CONFIG_COLUMNS,
                    (
                        ctx.tenant_id, employee_slug, display_name, persona, model, provider_ref,
                        thinking_level, timeout_seconds,
                        json.dumps(tools), json.dumps(skills), json.dumps(knowledge_refs),
                        json.dumps(connector_refs), json.dumps(memory_policy) if memory_policy else None,
                        source_template_id, source_template_version,
                    ),
                ).fetchone()
        except pg_errors.UniqueViolation as exc:
            if "uq_employee_live_direct_template" in str(exc):
                raise Conflict("expert template already recruited in this tenant") from exc
            raise
        return _row_to_config(row)

    def get(self, ctx: TenantContext, *, employee_id: str) -> EmployeeConfigRow | None:
        """按 employee_id 取本 tenant 内的配置；跨 tenant 因 RLS 看不到（04 §6.1.1）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _CONFIG_COLUMNS + " FROM employee WHERE id = %s",
                (employee_id,),
            ).fetchone()
        return _row_to_config(row) if row is not None else None

    def get_by_slug(self, ctx: TenantContext, *, employee_slug: str) -> EmployeeConfigRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _CONFIG_COLUMNS + " FROM employee WHERE employee_slug = %s",
                (employee_slug,),
            ).fetchone()
        return _row_to_config(row) if row is not None else None

    def get_by_source_template(
        self, ctx: TenantContext, *, source_template_id: str
    ) -> EmployeeConfigRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _CONFIG_COLUMNS
                + " FROM employee WHERE source_template_id = %s AND status <> 'archived'",
                (source_template_id,),
            ).fetchone()
        return _row_to_config(row) if row is not None else None

    def list_live_source_template_ids(self, ctx: TenantContext) -> set[str]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT source_template_id FROM employee "
                "WHERE source_template_id IS NOT NULL AND status <> 'archived'"
            ).fetchall()
        return {str(row[0]) for row in rows}

    def update(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        display_name: str,
        persona: str | None,
        model: str | None,
        provider_ref: str | None,
        thinking_level: str | None,
        timeout_seconds: int | None,
        tools: list[str],
        skills: list[str],
        knowledge_refs: list[str],
        connector_refs: list[str],
        memory_policy: dict | None,
    ) -> EmployeeConfigRow | None:
        """改写本 tenant 内 employee 的配置（version 由触发器自增）。跨 tenant 行 RLS 不可见。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                UPDATE employee SET
                    display_name = %s, persona = %s, model = %s, provider_ref = %s,
                    thinking_level = %s, timeout_seconds = %s,
                    tools = %s, skills = %s, knowledge_refs = %s, connector_refs = %s,
                    memory_policy = %s
                WHERE id = %s
                RETURNING """ + _CONFIG_COLUMNS,
                (
                    display_name, persona, model, provider_ref, thinking_level,
                    timeout_seconds, json.dumps(tools), json.dumps(skills),
                    json.dumps(knowledge_refs), json.dumps(connector_refs),
                    json.dumps(memory_policy) if memory_policy else None,
                    employee_id,
                ),
            ).fetchone()
        return _row_to_config(row) if row is not None else None

    def delete(self, ctx: TenantContext, *, employee_id: str) -> bool:
        """删本 tenant 内 employee 配置行。返回是否命中（跨 tenant 行 RLS 不可见→False）。"""
        with self._router.session(ctx) as s:
            row = s.execute("DELETE FROM employee WHERE id = %s RETURNING id", (employee_id,)).fetchone()
        return row is not None

    def list_all(self, ctx: TenantContext) -> list[EmployeeConfigRow]:
        """列本 tenant 内全部 employee 配置（RLS 自动限定本 tenant）。"""
        with self._router.session(ctx) as s:
            rows = s.execute("SELECT " + _CONFIG_COLUMNS + " FROM employee ORDER BY created_at").fetchall()
        return [_row_to_config(r) for r in rows]

    def transition_status(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        from_status: str,
        to_status: str,
        archive_reason: str | None = None,
    ) -> EmployeeConfigRow | None:
        """行级锁 + 状态机校验，更新 employee 主状态。

        跨 tenant 行 RLS 不可见 → None；from_status 冲突时抛 Conflict 由 service 抛出。
        """
        with self._router.session(ctx) as s:
            # 先锁行取当前状态（FOR UPDATE 防并发竞态）
            cur = s.execute(
                "SELECT status FROM employee WHERE id = %s FOR UPDATE",
                (employee_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            if row[0] != from_status:
                raise Conflict(
                    f"employee status conflict: expected={from_status}, actual={row[0]}"
                )
            set_parts = ["status = %s"]
            params: list = [to_status]
            if to_status == "archived":
                if archive_reason:
                    set_parts.append("archive_reason = %s")
                    params.append(archive_reason)
                set_parts.append("archived_at = now()")
            elif row[0] == "archived":
                # 任何从 archived 出发的落库本不应发生（状态机已拦）；清零归档元数据兜底
                set_parts.append("archive_reason = NULL")
                set_parts.append("archived_at = NULL")
            params.append(employee_id)
            cur = s.execute(
                "UPDATE employee SET " + ", ".join(set_parts) + " WHERE id = %s RETURNING " + _CONFIG_COLUMNS,
                tuple(params),
            )
            new_row = cur.fetchone()
        return _row_to_config(new_row)
