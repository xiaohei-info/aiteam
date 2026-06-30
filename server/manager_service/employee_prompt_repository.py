"""employee_prompt 版本管理 + 历史追踪租户作用域数据访问（issue #303，06 §7.6）。

铁律：与 TenantAuthRepository / EmployeeConfigRepository 一致——所有方法以 TenantContext
为隔离边界，tenant_id 只从 ctx 读取，SQL 不接受调用方手写 tenant 过滤字符串（D22）。
RLS 强制跨租户隔离（04 §6.1.1）。

版本模型：
  - employee_prompt        — 1:1 的 employee prompt 当前版本（head），version_no 单调递增。
  - employee_prompt_history — append-only 版本历史；update/rollback 前先归档 head 到历史，
                              保证可回滚、可溯源。每条历史记录带 change_reason + changed_by。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


@dataclass(frozen=True)
class EmployeePromptRow:
    """employee_prompt 当前版本行（head，中立字段）。"""

    employee_id: str
    tenant_id: str
    system_prompt: str
    behavior_rules: dict
    opening_message: str | None
    version_no: int
    source_template_version: str | None
    created_at: Any
    updated_at: Any


@dataclass(frozen=True)
class EmployeePromptHistoryRow:
    """employee_prompt_history 历史版本行（append-only）。"""

    history_id: str
    employee_id: str
    system_prompt: str
    behavior_rules: dict
    opening_message: str | None
    version_no: int
    source_template_version: str | None
    change_reason: str | None
    changed_by: str | None
    created_at: Any


_PROMPT_COLUMNS = (
    "id, tenant_id, system_prompt, behavior_rules_json, opening_message, "
    "version_no, source_template_version, created_at, updated_at"
)

_HISTORY_COLUMNS = (
    "id, employee_id, system_prompt, behavior_rules_json, opening_message, "
    "version_no, source_template_version, change_reason, changed_by, created_at"
)


def _json_field(value: Any) -> Any:
    """jsonb 列：psycopg2 已反序列化为 dict/list；若遇字符串则兜底 json.loads。"""
    if isinstance(value, str):
        import json as _json
        try:
            return _json.loads(value)
        except (ValueError, TypeError):
            return {}
    return value if value is not None else {}


def _row_to_prompt(row: Any) -> EmployeePromptRow:
    return EmployeePromptRow(
        employee_id=str(row[0]),
        tenant_id=str(row[1]),
        system_prompt=row[2] or "",
        behavior_rules=_json_field(row[3]),
        opening_message=row[4],
        version_no=int(row[5]),
        source_template_version=row[6],
        created_at=row[7],
        updated_at=row[8],
    )


def _row_to_history(row: Any) -> EmployeePromptHistoryRow:
    return EmployeePromptHistoryRow(
        history_id=str(row[0]),
        employee_id=str(row[1]),
        system_prompt=row[2] or "",
        behavior_rules=_json_field(row[3]),
        opening_message=row[4],
        version_no=int(row[5]),
        source_template_version=row[6],
        change_reason=row[7],
        changed_by=row[8],
        created_at=row[9],
    )


class EmployeePromptRepository:
    """employee_prompt + employee_prompt_history 租户内读写。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    # ---- head（当前版本）----

    def get(self, ctx: TenantContext, *, employee_id: str) -> EmployeePromptRow | None:
        """按 employee_id 取本 tenant 内的 prompt head；跨 tenant 因 RLS 看不到（04 §6.1.1）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _PROMPT_COLUMNS + " FROM employee_prompt WHERE id = %s",
                (employee_id,),
            ).fetchone()
        return _row_to_prompt(row) if row is not None else None

    def create(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        system_prompt: str,
        behavior_rules: dict,
        opening_message: str | None,
        source_template_version: str | None,
        change_reason: str | None,
        changed_by: str | None,
    ) -> EmployeePromptRow:
        """在本 tenant 建 employee_prompt head（version 落 1），并同步写 version=1 的历史行。

        tenant_id 取自 ctx（D22，RLS WITH CHECK 兜底）。
        """
        import json
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO employee_prompt "
                "(id, tenant_id, system_prompt, behavior_rules_json, opening_message, "
                "source_template_version) "
                "VALUES (%s, %s, %s, %s, %s, %s) "
                "RETURNING " + _PROMPT_COLUMNS,
                (
                    employee_id, ctx.tenant_id, system_prompt,
                    json.dumps(behavior_rules), opening_message,
                    source_template_version,
                ),
            ).fetchone()
            s.execute(
                "INSERT INTO employee_prompt_history "
                "(tenant_id, employee_id, system_prompt, behavior_rules_json, "
                "opening_message, version_no, source_template_version, change_reason, changed_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    ctx.tenant_id, employee_id, system_prompt,
                    json.dumps(behavior_rules), opening_message, 1,
                    source_template_version, change_reason, changed_by,
                ),
            )
        return _row_to_prompt(row)

    def update(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        system_prompt: str,
        behavior_rules: dict,
        opening_message: str | None,
        source_template_version: str | None,
        change_reason: str | None,
        changed_by: str | None,
    ) -> EmployeePromptRow | None:
        """改写 prompt head：先归档当前版本到历史，再推进 version_no + 1。

        返回 None 时 = employee 头不存在（未 create）。跨 tenant 行 RLS 不可见。
        """
        import json
        with self._router.session(ctx) as s:
            cur = s.execute(
                "SELECT system_prompt, behavior_rules_json, opening_message, "
                "version_no, source_template_version "
                "FROM employee_prompt WHERE id = %s",
                (employee_id,),
            ).fetchone()
            if cur is None:
                return None
            # 归档当前版本到历史（保留在历史中的 usage/version_no 不变）
            s.execute(
                "INSERT INTO employee_prompt_history "
                "(tenant_id, employee_id, system_prompt, behavior_rules_json, "
                "opening_message, version_no, source_template_version, change_reason, changed_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    ctx.tenant_id, employee_id, cur[0], cur[1], cur[2],
                    cur[3], cur[4], change_reason, changed_by,
                ),
            )
            new_version = int(cur[3]) + 1
            row = s.execute(
                "UPDATE employee_prompt SET "
                "system_prompt = %s, behavior_rules_json = %s, opening_message = %s, "
                "version_no = %s, source_template_version = %s "
                "WHERE id = %s "
                "RETURNING " + _PROMPT_COLUMNS,
                (
                    system_prompt, json.dumps(behavior_rules), opening_message,
                    new_version, source_template_version, employee_id,
                ),
            ).fetchone()
        return _row_to_prompt(row)

    def delete(self, ctx: TenantContext, *, employee_id: str) -> bool:
        """删本 tenant 内 employee_prompt head + history。返回是否命中（跨 tenant 行 RLS 不可见→False）。"""
        with self._router.session(ctx) as s:
            s.execute(
                "DELETE FROM employee_prompt_history WHERE employee_id = %s",
                (employee_id,),
            )
            row = s.execute(
                "DELETE FROM employee_prompt WHERE id = %s RETURNING id",
                (employee_id,),
            ).fetchone()
        return row is not None

    # ---- history（版本历史）----

    def list_history(
        self, ctx: TenantContext, *, employee_id: str
    ) -> list[EmployeePromptHistoryRow]:
        """列本 tenant 内 employee prompt 全部历史版本（version_no 降序）。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _HISTORY_COLUMNS +
                " FROM employee_prompt_history WHERE employee_id = %s ORDER BY version_no DESC",
                (employee_id,),
            ).fetchall()
        return [_row_to_history(r) for r in rows]

    def get_history(
        self, ctx: TenantContext, *, employee_id: str, version_no: int
    ) -> EmployeePromptHistoryRow | None:
        """取本 tenant 内 employee 的指定历史版本；不存在 → None。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _HISTORY_COLUMNS +
                " FROM employee_prompt_history "
                "WHERE employee_id = %s AND version_no = %s",
                (employee_id, version_no),
            ).fetchone()
        return _row_to_history(row) if row is not None else None

    def rollback(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        target_version_no: int,
        change_reason: str | None,
        changed_by: str | None,
    ) -> EmployeePromptRow | None:
        """回滚：取历史版本 `target_version_no` 的值，写为新的 head（version_no + 1）。

        返回 None 时 = employee 头不存在 或 目标历史版本不存在。
        注意：回滚本身会追加一条新历史（新 version_no），历史记录不回退——可再滚回。
        """
        import json
        with self._router.session(ctx) as s:
            cur = s.execute(
                "SELECT version_no FROM employee_prompt WHERE id = %s",
                (employee_id,),
            ).fetchone()
            if cur is None:
                return None
            hist = s.execute(
                "SELECT system_prompt, behavior_rules_json, opening_message, "
                "version_no, source_template_version "
                "FROM employee_prompt_history "
                "WHERE employee_id = %s AND version_no = %s",
                (employee_id, target_version_no),
            ).fetchone()
            if hist is None:
                return None
            new_version = int(cur[0]) + 1
            # 回滚本身作为新历史追加（保存回滚后的新 head，change_reason 描述溯源）
            reason = change_reason or f"rollback->v{target_version_no}"
            s.execute(
                "INSERT INTO employee_prompt_history "
                "(tenant_id, employee_id, system_prompt, behavior_rules_json, "
                "opening_message, version_no, source_template_version, change_reason, changed_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    ctx.tenant_id, employee_id, hist[0], hist[1], hist[2],
                    new_version, hist[4], reason, changed_by,
                ),
            )
            row = s.execute(
                "UPDATE employee_prompt SET "
                "system_prompt = %s, behavior_rules_json = %s, opening_message = %s, "
                "version_no = %s, source_template_version = %s "
                "WHERE id = %s "
                "RETURNING " + _PROMPT_COLUMNS,
                (hist[0], hist[1], hist[2], new_version, hist[4], employee_id),
            ).fetchone()
        return _row_to_prompt(row)
