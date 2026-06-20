"""employee/expert 配置租户作用域数据访问（M2，06 §7.6 / 04 §6.1，D16/D22）。

铁律：与 TenantAuthRepository 一致——所有方法以 TenantContext 为隔离边界，tenant_id 只从 ctx
读取，SQL 不接受调用方手写 tenant 过滤字符串（D22）。RLS 强制跨租户隔离（04 §6.1.1）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


@dataclass(frozen=True)
class EmployeeConfigRow:
    """employee 配置行（中立字段，runtime 无关）。"""

    employee_id: str
    employee_slug: str
    display_name: str
    persona: str | None
    model: str | None
    provider_ref: str | None
    thinking_level: str | None
    runtime_binding: str | None
    timeout_seconds: int | None
    tools: list[str]
    skills: list[str]
    knowledge_refs: list[str]
    connector_refs: list[str]
    memory_policy: dict | None
    version: int


_CONFIG_COLUMNS = (
    "id, employee_slug, display_name, persona, model, provider_ref, thinking_level, "
    "runtime_binding, timeout_seconds, tools, skills, knowledge_refs, connector_refs, "
    "memory_policy, version"
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
        runtime_binding=row[7],
        timeout_seconds=row[8],
        tools=list(row[9] or []),
        skills=list(row[10] or []),
        knowledge_refs=list(row[11] or []),
        connector_refs=list(row[12] or []),
        memory_policy=row[13],
        version=row[14],
    )


class EmployeeConfigRepository:
    """employee 配置的租户内读写。runtime 中立（D16）；tenant_id 取自 ctx（D22）。"""

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
        runtime_binding: str | None,
        timeout_seconds: int | None,
        tools: list[str],
        skills: list[str],
        knowledge_refs: list[str],
        connector_refs: list[str],
        memory_policy: dict | None,
    ) -> EmployeeConfigRow:
        """在本 tenant 建 employee 配置行。tenant_id 取自 ctx（D22，RLS WITH CHECK 兜底）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO employee (
                    tenant_id, employee_slug, display_name, persona, model, provider_ref,
                    thinking_level, runtime_binding, timeout_seconds, tools, skills,
                    knowledge_refs, connector_refs, memory_policy
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                RETURNING """ + _CONFIG_COLUMNS,
                (
                    ctx.tenant_id, employee_slug, display_name, persona, model, provider_ref,
                    thinking_level, runtime_binding, timeout_seconds,
                    json.dumps(tools), json.dumps(skills), json.dumps(knowledge_refs),
                    json.dumps(connector_refs), json.dumps(memory_policy) if memory_policy else None,
                ),
            ).fetchone()
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
        runtime_binding: str | None,
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
                    thinking_level = %s, runtime_binding = %s, timeout_seconds = %s,
                    tools = %s, skills = %s, knowledge_refs = %s, connector_refs = %s,
                    memory_policy = %s
                WHERE id = %s
                RETURNING """ + _CONFIG_COLUMNS,
                (
                    display_name, persona, model, provider_ref, thinking_level, runtime_binding,
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
