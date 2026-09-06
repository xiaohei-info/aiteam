"""employee 独立绑定实体 租户作用域数据访问（issue AITEAM-234 / GitHub AITEAM-280，04 §6.1/§6.6，D22）。

铁律（与 EmployeeConfigRepository 一致）：所有方法以 TenantContext
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

    policy_revision: int = 0
    policy_source: str = "legacy_observed"
    policy_actor: str | None = None
    policy_updated_at: datetime | None = None
    revoked_at: datetime | None = None


@dataclass(frozen=True)
class MemorySettingRow:
    binding_id: str
    employee_id: str
    policy: dict
    seed_memories: list[Any]
    retention_days: int | None
    scope: str
    updated_at: datetime
    revision: int = 0
    source: str = "legacy_pending"
    explicit_auto_retain: bool = False
    provenance: dict | None = None
    retention_guarded: bool = False


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

_KNOW_COLS = ("id, employee_id, knowledge_space_id, enabled, config, created_at, updated_at, "
              "policy_revision, policy_source, policy_actor, policy_updated_at, revoked_at")


def _row_to_know(row: Any) -> KnowledgeBindingRow:
    return KnowledgeBindingRow(
        binding_id=str(row[0]), employee_id=str(row[1]), knowledge_space_id=row[2],
        enabled=bool(row[3]), config=row[4] or {}, created_at=row[5], updated_at=row[6],
        policy_revision=row[7], policy_source=row[8],
        policy_actor=str(row[9]) if row[9] is not None else None,
        policy_updated_at=row[10], revoked_at=row[11],
    )


class EmployeeKnowledgeBindingRepository:
    """employee ↔ knowledge_space 绑定的租户内读写。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def employee_exists(self, ctx: TenantContext, *, employee_id: str) -> bool:
        with self._router.session(ctx) as s:
            return s.execute("SELECT 1 FROM employee WHERE id=%s", (employee_id,)).fetchone() is not None

    def atomic_enable(self, ctx: TenantContext, *, employee_id: str, knowledge_space_id: str,
                      config: dict | None = None) -> tuple[KnowledgeBindingRow | None, bool]:
        """Validate and enable a binding with a serialized tombstone transition.

        The insert uses the tenant/employee/space unique key as the
        concurrency boundary.  A concurrent disable/enable therefore waits for
        the winner and then takes the same row lock; it cannot surface a raw
        unique-violation or lose a policy revision.
        """
        with self._router.session(ctx) as s:
            employee = s.execute(
                "SELECT id FROM employee WHERE id=%s FOR KEY SHARE",
                (employee_id,),
            ).fetchone()
            if employee is None:
                return None, False
            s.execute(
                "INSERT INTO employee_knowledge_binding "
                "(tenant_id, employee_id, knowledge_space_id, enabled, config, policy_revision, "
                "policy_source, policy_actor, policy_updated_at, revoked_at) "
                "VALUES (%s,%s,%s,true,%s,1,'admin',%s,now(),NULL) "
                "ON CONFLICT (tenant_id, employee_id, knowledge_space_id) DO NOTHING",
                (ctx.tenant_id, employee_id, knowledge_space_id, json.dumps(config or {}), ctx.user_id),
            )
            current = s.execute(
                "SELECT " + _KNOW_COLS + " FROM employee_knowledge_binding "
                "WHERE employee_id=%s AND knowledge_space_id=%s FOR UPDATE",
                (employee_id, knowledge_space_id),
            ).fetchone()
            if current is None:
                return None, False
            previous = _row_to_know(current)
            next_config = previous.config if config is None else config
            if previous.enabled and previous.revoked_at is None and previous.config == next_config:
                return previous, False
            row = s.execute(
                "UPDATE employee_knowledge_binding SET enabled=true, config=%s, revoked_at=NULL, "
                "policy_revision=policy_revision+1, policy_source='admin', policy_actor=%s, "
                "policy_updated_at=now(), updated_at=now() WHERE id=%s RETURNING " + _KNOW_COLS,
                (json.dumps(next_config), ctx.user_id, previous.binding_id),
            ).fetchone()
            return _row_to_know(row), True

    def create(self, ctx: TenantContext, *, employee_id: str, knowledge_space_id: str,
               enabled: bool, config: dict) -> KnowledgeBindingRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO employee_knowledge_binding "
                "(tenant_id, employee_id, knowledge_space_id, enabled, config, "
                "policy_revision, policy_source, policy_actor, policy_updated_at) "
                "VALUES (%s, %s, %s, %s, %s, 1, 'admin', %s, now()) RETURNING " + _KNOW_COLS,
                (ctx.tenant_id, employee_id, knowledge_space_id, enabled, json.dumps(config), ctx.user_id),
            ).fetchone()
        return _row_to_know(row)

    def atomic_disable(self, ctx: TenantContext, *, employee_id: str, knowledge_space_id: str,
                       config: dict | None = None) -> tuple[KnowledgeBindingRow | None, bool]:
        """Create or update an explicit deny tombstone under the row lock."""
        with self._router.session(ctx) as s:
            employee = s.execute(
                "SELECT id FROM employee WHERE id=%s FOR KEY SHARE",
                (employee_id,),
            ).fetchone()
            if employee is None:
                return None, False
            s.execute(
                "INSERT INTO employee_knowledge_binding "
                "(tenant_id, employee_id, knowledge_space_id, enabled, config, policy_revision, "
                "policy_source, policy_actor, policy_updated_at, revoked_at) "
                "VALUES (%s,%s,%s,false,%s,1,'admin',%s,now(),now()) "
                "ON CONFLICT (tenant_id, employee_id, knowledge_space_id) DO NOTHING",
                (ctx.tenant_id, employee_id, knowledge_space_id, json.dumps(config or {}), ctx.user_id),
            )
            current = s.execute(
                "SELECT " + _KNOW_COLS + " FROM employee_knowledge_binding "
                "WHERE employee_id=%s AND knowledge_space_id=%s FOR UPDATE",
                (employee_id, knowledge_space_id),
            ).fetchone()
            if current is None:
                return None, False
            previous = _row_to_know(current)
            next_config = previous.config if config is None else config
            if not previous.enabled and previous.revoked_at is not None and previous.config == next_config:
                return previous, False
            row = s.execute(
                "UPDATE employee_knowledge_binding SET enabled=false, config=%s, revoked_at=COALESCE(revoked_at,now()), "
                "policy_revision=policy_revision+1, policy_source='admin', policy_actor=%s, "
                "policy_updated_at=now(), updated_at=now() WHERE id=%s RETURNING " + _KNOW_COLS,
                (json.dumps(next_config), ctx.user_id, previous.binding_id),
            ).fetchone()
            return _row_to_know(row), True

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

    def update(self, ctx: TenantContext, *, binding_id: str, enabled: bool | None,
               config: dict | None) -> KnowledgeBindingRow | None:
        with self._router.session(ctx) as s:
            current = s.execute("SELECT " + _KNOW_COLS + " FROM employee_knowledge_binding "
                                "WHERE id = %s FOR UPDATE", (binding_id,)).fetchone()
            if current is None:
                return None
            previous = _row_to_know(current)
            next_enabled = previous.enabled if enabled is None else enabled
            next_config = previous.config if config is None else config
            if (next_enabled == previous.enabled and next_config == previous.config
                    and not (enabled is True and previous.revoked_at is not None)):
                return previous
            row = s.execute(
                "UPDATE employee_knowledge_binding SET enabled = %s, config = %s, "
                "revoked_at = CASE WHEN %s THEN NULL ELSE COALESCE(revoked_at, now()) END, "
                "policy_revision = policy_revision + 1, policy_source = 'admin', "
                "policy_actor = %s, policy_updated_at = now(), updated_at = now() "
                "WHERE id = %s RETURNING " + _KNOW_COLS,
                (next_enabled, json.dumps(next_config), enabled is True, ctx.user_id, binding_id),
            ).fetchone()
        return _row_to_know(row)

    def delete(self, ctx: TenantContext, *, binding_id: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE employee_knowledge_binding SET enabled = false, revoked_at = now(), "
                "policy_revision = policy_revision + 1, policy_source = 'admin', "
                "policy_actor = %s, policy_updated_at = now(), updated_at = now() "
                "WHERE id = %s AND revoked_at IS NULL RETURNING id",
                (ctx.user_id, binding_id),
            ).fetchone()
            if row is None:
                row = s.execute("SELECT id FROM employee_knowledge_binding WHERE id = %s",
                                (binding_id,)).fetchone()
        return row is not None


# ============================= MemorySetting =============================

_MEMORY_COLS = ("id, employee_id, policy, seed_memories, retention_days, scope, updated_at, revision, source, explicit_auto_retain, provenance, "
                "EXISTS(SELECT 1 FROM memory_bank_guard g WHERE g.tenant_id=employee_memory_setting.tenant_id AND g.employee_id=employee_memory_setting.employee_id)")


def _row_to_memory(row: Any) -> MemorySettingRow:
    return MemorySettingRow(
        binding_id=str(row[0]), employee_id=str(row[1]), policy=row[2] or {},
        seed_memories=list(row[3] or []), retention_days=row[4], scope=row[5],
        updated_at=row[6], revision=int(row[7]), source=row[8],
        explicit_auto_retain=row[9], provenance=row[10], retention_guarded=bool(row[11]),
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

    def _write(self, ctx: TenantContext, *, employee_id: str, fields: dict,
               source: str = "memory_setting", require_existing: bool = False) -> MemorySettingRow:
        from .memory_policy_service import write_policy_in_session
        with self._router.session(ctx) as s:
            write_policy_in_session(s, ctx, employee_id=employee_id, fields=fields,
                                    source=source, require_existing=require_existing)
            row = s.execute("SELECT " + _MEMORY_COLS + " FROM employee_memory_setting WHERE employee_id=%s",
                            (employee_id,)).fetchone()
        return _row_to_memory(row)

    def upsert(self, ctx: TenantContext, *, employee_id: str, **fields) -> MemorySettingRow:
        return self._write(ctx, employee_id=employee_id, fields=fields)

    def update(self, ctx: TenantContext, *, employee_id: str, **fields) -> MemorySettingRow:
        return self._write(ctx, employee_id=employee_id, fields=fields, require_existing=True)

    def delete(self, ctx: TenantContext, *, employee_id: str) -> bool:
        self._write(ctx, employee_id=employee_id,
                    fields={"policy": {"enabled": False, "allowed_operations": [], "explicit_auto_retain": False}},
                    source="deleted_deny")
        return True


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
