"""employee 独立绑定实体 租户作用域数据访问（issue AITEAM-234 / GitHub AITEAM-280，04 §6.1/§6.6，D22）。

铁律（与 EmployeeConfigRepository / memory_items_repository 一致）：所有方法以 TenantContext
为隔离边界，tenant_id 只从 ctx 读取，SQL 不接受调用方手写 tenant 过滤字符串（D22）。
RLS 强制跨租户隔离 + 外键 ON DELETE CASCADE（employee 删除时同步清除绑定，04 §6.1.1）。

五类独立绑定实体（0014_employee_bindings.sql）：
  PromptVersion  — employee prompt 版本化（多版本 + 当前生效版）
  SkillBinding   — employee ↔ skill_catalog
  KnowledgeBinding — employee ↔ knowledge_space
  MemorySetting  — employee 记忆策略单例 (1:1)
  ConnectorBinding — employee ↔ connector_catalog
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


# ============================= Row dataclasses =============================


@dataclass(frozen=True)
class PromptVersionRow:
    binding_id: str
    employee_id: str
    version: int
    display_name: str
    persona: str | None
    model: str | None
    provider_ref: str | None
    thinking_level: str | None
    tools: list[str]
    is_current: bool
    change_note: str | None
    created_at: datetime


@dataclass(frozen=True)
class SkillBindingRow:
    binding_id: str
    employee_id: str
    skill_id: str
    enabled: bool
    config: dict
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class KnowledgeBindingRow:
    binding_id: str
    employee_id: str
    knowledge_space_id: str
    enabled: bool
    config: dict
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class MemorySettingRow:
    binding_id: str
    employee_id: str
    policy: dict
    seed_memories: list[Any]
    retention_days: int | None
    scope: str
    updated_at: datetime


@dataclass(frozen=True)
class ConnectorBindingRow:
    binding_id: str
    employee_id: str
    connector_id: str
    grant_ref: str | None
    enabled: bool
    config: dict
    created_at: datetime
    updated_at: datetime


# ============================= PromptVersion =============================

_PROMPT_COLS = (
    "id, employee_id, version, display_name, persona, model, provider_ref, thinking_level, "
    "tools, is_current, change_note, created_at"
)


def _row_to_prompt(row: Any) -> PromptVersionRow:
    return PromptVersionRow(
        binding_id=str(row[0]), employee_id=str(row[1]), version=int(row[2]),
        display_name=row[3], persona=row[4], model=row[5], provider_ref=row[6],
        thinking_level=row[7], tools=list(row[8] or []), is_current=bool(row[9]),
        change_note=row[10], created_at=row[11],
    )


class EmployeePromptVersionRepository:
    """employee prompt 版本化的租户内读写。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(self, ctx: TenantContext, *, employee_id: str, display_name: str,
               persona: str | None, model: str | None, provider_ref: str | None,
               thinking_level: str | None, tools: list[str], is_current: bool,
               change_note: str | None) -> PromptVersionRow:
        """新建下一个 prompt 版本；version = 当前本 employee 最大版 + 1。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO employee_prompt_version "
                "(tenant_id, employee_id, version, display_name, persona, model, provider_ref, "
                "thinking_level, tools, is_current, change_note) "
                "VALUES (%s, %s, COALESCE((SELECT MAX(version) FROM employee_prompt_version "
                "  WHERE employee_id = %s), 0) + 1, %s, %s, %s, %s, %s, %s, %s, %s) "
                "RETURNING " + _PROMPT_COLS,
                (ctx.tenant_id, employee_id, employee_id,
                 display_name, persona, model, provider_ref, thinking_level,
                 json.dumps(tools), is_current, change_note),
            ).fetchone()
        return _row_to_prompt(row)

    def get(self, ctx: TenantContext, *, binding_id: str) -> PromptVersionRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _PROMPT_COLS + " FROM employee_prompt_version WHERE id = %s",
                (binding_id,),
            ).fetchone()
        return _row_to_prompt(row) if row is not None else None

    def get_current(self, ctx: TenantContext, *, employee_id: str) -> PromptVersionRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _PROMPT_COLS + " FROM employee_prompt_version "
                "WHERE employee_id = %s AND is_current = true",
                (employee_id,),
            ).fetchone()
        return _row_to_prompt(row) if row is not None else None

    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[PromptVersionRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _PROMPT_COLS + " FROM employee_prompt_version "
                "WHERE employee_id = %s ORDER BY version DESC",
                (employee_id,),
            ).fetchall()
        return [_row_to_prompt(r) for r in rows]

    def set_current(self, ctx: TenantContext, *, binding_id: str) -> PromptVersionRow | None:
        """把指定版本标记为当前生效，并把该 employee 其它版本 is_current 置 false。"""
        with self._router.session(ctx) as s:
            target = s.execute(
                "SELECT employee_id FROM employee_prompt_version WHERE id = %s",
                (binding_id,),
            ).fetchone()
            if target is None:
                return None
            s.execute(
                "UPDATE employee_prompt_version SET is_current = false WHERE employee_id = %s",
                (target[0],),
            )
            row = s.execute(
                "UPDATE employee_prompt_version SET is_current = true WHERE id = %s "
                "RETURNING " + _PROMPT_COLS,
                (binding_id,),
            ).fetchone()
        return _row_to_prompt(row) if row is not None else None

    def delete(self, ctx: TenantContext, *, binding_id: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "DELETE FROM employee_prompt_version WHERE id = %s RETURNING id",
                (binding_id,),
            ).fetchone()
        return row is not None


# ============================= SkillBinding =============================

_SKILL_COLS = "id, employee_id, skill_id, enabled, config, created_at, updated_at"


def _row_to_skill(row: Any) -> SkillBindingRow:
    return SkillBindingRow(
        binding_id=str(row[0]), employee_id=str(row[1]), skill_id=row[2],
        enabled=bool(row[3]), config=row[4] or {}, created_at=row[5], updated_at=row[6],
    )


class EmployeeSkillBindingRepository:
    """employee ↔ skill 绑定的租户内读写。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(self, ctx: TenantContext, *, employee_id: str, skill_id: str,
               enabled: bool, config: dict) -> SkillBindingRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO employee_skill_binding "
                "(tenant_id, employee_id, skill_id, enabled, config) "
                "VALUES (%s, %s, %s, %s, %s) RETURNING " + _SKILL_COLS,
                (ctx.tenant_id, employee_id, skill_id, enabled, json.dumps(config)),
            ).fetchone()
        return _row_to_skill(row)

    def get(self, ctx: TenantContext, *, binding_id: str) -> SkillBindingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _SKILL_COLS + " FROM employee_skill_binding WHERE id = %s",
                (binding_id,),
            ).fetchone()
        return _row_to_skill(row) if row is not None else None

    def get_by_ref(self, ctx: TenantContext, *, employee_id: str,
                   skill_id: str) -> SkillBindingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _SKILL_COLS + " FROM employee_skill_binding "
                "WHERE employee_id = %s AND skill_id = %s",
                (employee_id, skill_id),
            ).fetchone()
        return _row_to_skill(row) if row is not None else None

    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[SkillBindingRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _SKILL_COLS + " FROM employee_skill_binding "
                "WHERE employee_id = %s ORDER BY created_at",
                (employee_id,),
            ).fetchall()
        return [_row_to_skill(r) for r in rows]

    def update(self, ctx: TenantContext, *, binding_id: str, enabled: bool,
               config: dict) -> SkillBindingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE employee_skill_binding SET enabled = %s, config = %s, updated_at = now() "
                "WHERE id = %s RETURNING " + _SKILL_COLS,
                (enabled, json.dumps(config), binding_id),
            ).fetchone()
        return _row_to_skill(row) if row is not None else None

    def delete(self, ctx: TenantContext, *, binding_id: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "DELETE FROM employee_skill_binding WHERE id = %s RETURNING id",
                (binding_id,),
            ).fetchone()
        return row is not None

    def delete_all(self, ctx: TenantContext, *, employee_id: str) -> int:
        with self._router.session(ctx) as s:
            cur = s.execute(
                "DELETE FROM employee_skill_binding WHERE employee_id = %s",
                (employee_id,),
            )
            return cur.rowcount


# ============================= KnowledgeBinding =============================

_KNOW_COLS = "id, employee_id, knowledge_space_id, enabled, config, created_at, updated_at"


def _row_to_know(row: Any) -> KnowledgeBindingRow:
    return KnowledgeBindingRow(
        binding_id=str(row[0]), employee_id=str(row[1]), knowledge_space_id=row[2],
        enabled=bool(row[3]), config=row[4] or {}, created_at=row[5], updated_at=row[6],
    )


class EmployeeKnowledgeBindingRepository:
    """employee ↔ knowledge_space 绑定的租户内读写。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(self, ctx: TenantContext, *, employee_id: str, knowledge_space_id: str,
               enabled: bool, config: dict) -> KnowledgeBindingRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO employee_knowledge_binding "
                "(tenant_id, employee_id, knowledge_space_id, enabled, config) "
                "VALUES (%s, %s, %s, %s, %s) RETURNING " + _KNOW_COLS,
                (ctx.tenant_id, employee_id, knowledge_space_id, enabled, json.dumps(config)),
            ).fetchone()
        return _row_to_know(row)

    def get(self, ctx: TenantContext, *, binding_id: str) -> KnowledgeBindingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _KNOW_COLS + " FROM employee_knowledge_binding WHERE id = %s",
                (binding_id,),
            ).fetchone()
        return _row_to_know(row) if row is not None else None

    def get_by_ref(self, ctx: TenantContext, *, employee_id: str,
                   knowledge_space_id: str) -> KnowledgeBindingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _KNOW_COLS + " FROM employee_knowledge_binding "
                "WHERE employee_id = %s AND knowledge_space_id = %s",
                (employee_id, knowledge_space_id),
            ).fetchone()
        return _row_to_know(row) if row is not None else None

    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[KnowledgeBindingRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _KNOW_COLS + " FROM employee_knowledge_binding "
                "WHERE employee_id = %s ORDER BY created_at",
                (employee_id,),
            ).fetchall()
        return [_row_to_know(r) for r in rows]

    def update(self, ctx: TenantContext, *, binding_id: str, enabled: bool,
               config: dict) -> KnowledgeBindingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE employee_knowledge_binding "
                "SET enabled = %s, config = %s, updated_at = now() "
                "WHERE id = %s RETURNING " + _KNOW_COLS,
                (enabled, json.dumps(config), binding_id),
            ).fetchone()
        return _row_to_know(row) if row is not None else None

    def delete(self, ctx: TenantContext, *, binding_id: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "DELETE FROM employee_knowledge_binding WHERE id = %s RETURNING id",
                (binding_id,),
            ).fetchone()
        return row is not None


# ============================= MemorySetting =============================

_MEMORY_COLS = "id, employee_id, policy, seed_memories, retention_days, scope, updated_at"


def _row_to_memory(row: Any) -> MemorySettingRow:
    return MemorySettingRow(
        binding_id=str(row[0]), employee_id=str(row[1]), policy=row[2] or {},
        seed_memories=list(row[3] or []), retention_days=row[4], scope=row[5],
        updated_at=row[6],
    )


class EmployeeMemorySettingRepository:
    """employee 记忆策略单例的租户内读写（与 employee 1:1）。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def get(self, ctx: TenantContext, *, employee_id: str) -> MemorySettingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _MEMORY_COLS + " FROM employee_memory_setting "
                "WHERE employee_id = %s",
                (employee_id,),
            ).fetchone()
        return _row_to_memory(row) if row is not None else None

    def upsert(self, ctx: TenantContext, *, employee_id: str, policy: dict,
               seed_memories: list[Any], retention_days: int | None,
               scope: str) -> MemorySettingRow:
        """1:1 单例；存在则更新，不存在则新增。tenant_id 来自 ctx（D22）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO employee_memory_setting "
                "(tenant_id, employee_id, policy, seed_memories, retention_days, scope) "
                "VALUES (%s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (tenant_id, employee_id) DO UPDATE SET "
                "policy = EXCLUDED.policy, seed_memories = EXCLUDED.seed_memories, "
                "retention_days = EXCLUDED.retention_days, scope = EXCLUDED.scope, "
                "updated_at = now() "
                "RETURNING " + _MEMORY_COLS,
                (ctx.tenant_id, employee_id, json.dumps(policy), json.dumps(seed_memories),
                 retention_days, scope),
            ).fetchone()
        return _row_to_memory(row)

    def update(self, ctx: TenantContext, *, employee_id: str, policy: dict,
               seed_memories: list[Any], retention_days: int | None,
               scope: str) -> MemorySettingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE employee_memory_setting "
                "SET policy = %s, seed_memories = %s, retention_days = %s, scope = %s, "
                "updated_at = now() "
                "WHERE employee_id = %s RETURNING " + _MEMORY_COLS,
                (json.dumps(policy), json.dumps(seed_memories), retention_days,
                 scope, employee_id),
            ).fetchone()
        return _row_to_memory(row) if row is not None else None

    def delete(self, ctx: TenantContext, *, employee_id: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "DELETE FROM employee_memory_setting WHERE employee_id = %s RETURNING id",
                (employee_id,),
            ).fetchone()
        return row is not None


# ============================= ConnectorBinding =============================

_CONN_COLS = "id, employee_id, connector_id, grant_ref, enabled, config, created_at, updated_at"


def _row_to_conn(row: Any) -> ConnectorBindingRow:
    return ConnectorBindingRow(
        binding_id=str(row[0]), employee_id=str(row[1]), connector_id=row[2],
        grant_ref=row[3], enabled=bool(row[4]), config=row[5] or {},
        created_at=row[6], updated_at=row[7],
    )


class EmployeeConnectorBindingRepository:
    """employee ↔ connector 绑定的租户内读写。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(self, ctx: TenantContext, *, employee_id: str, connector_id: str,
               grant_ref: str | None, enabled: bool, config: dict) -> ConnectorBindingRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO employee_connector_binding "
                "(tenant_id, employee_id, connector_id, grant_ref, enabled, config) "
                "VALUES (%s, %s, %s, %s, %s, %s) RETURNING " + _CONN_COLS,
                (ctx.tenant_id, employee_id, connector_id, grant_ref, enabled,
                 json.dumps(config)),
            ).fetchone()
        return _row_to_conn(row)

    def get(self, ctx: TenantContext, *, binding_id: str) -> ConnectorBindingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _CONN_COLS + " FROM employee_connector_binding WHERE id = %s",
                (binding_id,),
            ).fetchone()
        return _row_to_conn(row) if row is not None else None

    def get_by_ref(self, ctx: TenantContext, *, employee_id: str,
                   connector_id: str) -> ConnectorBindingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _CONN_COLS + " FROM employee_connector_binding "
                "WHERE employee_id = %s AND connector_id = %s",
                (employee_id, connector_id),
            ).fetchone()
        return _row_to_conn(row) if row is not None else None

    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[ConnectorBindingRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _CONN_COLS + " FROM employee_connector_binding "
                "WHERE employee_id = %s ORDER BY created_at",
                (employee_id,),
            ).fetchall()
        return [_row_to_conn(r) for r in rows]

    def update(self, ctx: TenantContext, *, binding_id: str, grant_ref: str | None,
               enabled: bool, config: dict) -> ConnectorBindingRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE employee_connector_binding "
                "SET grant_ref = %s, enabled = %s, config = %s, updated_at = now() "
                "WHERE id = %s RETURNING " + _CONN_COLS,
                (grant_ref, enabled, json.dumps(config), binding_id),
            ).fetchone()
        return _row_to_conn(row) if row is not None else None

    def delete(self, ctx: TenantContext, *, binding_id: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "DELETE FROM employee_connector_binding WHERE id = %s RETURNING id",
                (binding_id,),
            ).fetchone()
        return row is not None
