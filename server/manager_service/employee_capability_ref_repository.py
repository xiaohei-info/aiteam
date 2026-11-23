"""员工技能 / 连接器引用的反查与联动清理（设计 2026-11-22 §3.2、§3.4）。

员工身上的清单（employee.skills / employee.connector_refs）由 Manager 单写；目录项被删除或停用时，
受影响员工的清单在**同一个事务**里处理。租户隔离全程经 TenantContext / RLS，不手写 tenant 过滤。
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Literal

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

RefKind = Literal["skill", "connector"]

# kind → (员工表里的清单列, 目录表, 目录里的业务键列)；列名与表名只来自这里的常量，不拼接外部输入。
_KIND = {
    "skill": ("skills", "skill_catalog", "skill_id"),
    "connector": ("connector_refs", "connector_catalog", "connector_id"),
}


def ref_key(kind: RefKind, ref: str) -> str:
    """技能引用可以是 skill_id@version，目录身份只认 skill_id；连接器引用就是 connector_id。"""
    return ref.partition("@")[0] if kind == "skill" else ref


@dataclass(frozen=True)
class EmployeeUse:
    employee_id: str
    display_name: str


@dataclass(frozen=True)
class DeleteOutcome:
    """deleted=False 表示有员工在用且调用方没有表态，什么都没动。"""

    deleted: bool
    uses: list[EmployeeUse]


class EmployeeCapabilityRefRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    @contextmanager
    def transaction(self, ctx: TenantContext):
        """同一个事务里同时改目录项和员工清单：中途失败两边一起回滚，不会留下「目录项已停用、员工清单还留着引用」。"""
        from .capability_catalog_repository import CapabilityCatalogRepository
        from .recruit_transaction import _TransactionRouter

        with self._router.session(ctx) as session:
            bound = _TransactionRouter(session)
            yield CapabilityCatalogRepository(bound), EmployeeCapabilityRefRepository(bound)

    def employees_using(self, ctx: TenantContext, kind: RefKind, key: str) -> list[EmployeeUse]:
        with self._router.session(ctx) as s:
            return _uses(s, kind, key)

    def delete_catalog_entry(
        self, ctx: TenantContext, kind: RefKind, catalog_id: str, *, unlink: bool | None,
    ) -> DeleteOutcome | None:
        """删目录项。有员工在用时：unlink 为 None 不动并返回 uses；True 同事务从这些员工身上去掉；False 只删目录项。"""
        _column, table, key_column = _KIND[kind]
        with self._router.session(ctx) as s:
            row = s.execute(f"SELECT {key_column} FROM {table} WHERE id = %s FOR UPDATE", (catalog_id,)).fetchone()
            if row is None:
                return None
            uses = _uses(s, kind, row[0])
            if uses and unlink is None:
                return DeleteOutcome(deleted=False, uses=uses)
            if uses and unlink:
                _unlink(s, kind, row[0], uses)
            s.execute(f"DELETE FROM {table} WHERE id = %s", (catalog_id,))
            return DeleteOutcome(deleted=True, uses=uses)

    def unlink(self, ctx: TenantContext, kind: RefKind, key: str) -> list[EmployeeUse]:
        """把某项从所有员工的清单里去掉（停用时「去掉」的选择）；返回受影响的员工。"""
        with self._router.session(ctx) as s:
            uses = _uses(s, kind, key)
            if uses:
                _unlink(s, kind, key, uses)
            return uses


def _uses(session, kind: RefKind, key: str) -> list[EmployeeUse]:
    column = _KIND[kind][0]
    rows = session.execute(f"SELECT id, display_name, {column} FROM employee ORDER BY created_at").fetchall()
    return [
        EmployeeUse(str(row[0]), row[1] or "")
        for row in rows
        if any(isinstance(ref, str) and ref_key(kind, ref) == key for ref in (row[2] or []))
    ]


def _unlink(session, kind: RefKind, key: str, uses: list[EmployeeUse]) -> None:
    column = _KIND[kind][0]
    for use in uses:
        current = session.execute(f"SELECT {column} FROM employee WHERE id = %s FOR UPDATE", (use.employee_id,)).fetchone()
        remaining = [ref for ref in (current[0] or []) if not (isinstance(ref, str) and ref_key(kind, ref) == key)]
        # employee 表的触发器在配置列被改写时推进 version，下一次同步员工就拿到新清单。
        session.execute(f"UPDATE employee SET {column} = %s WHERE id = %s", (json.dumps(remaining), use.employee_id))
