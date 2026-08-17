"""知识空间/绑定租户作用域数据访问（M3，04 §6.1.2/§6.6；05 F08；D21）。

铁律（同 EmployeeConfigRepository）：所有方法以 TenantContext 为隔离边界，tenant_id 只从
ctx 读，SQL 不接受调用方手写 tenant 过滤字符串（D22）；RLS 强制跨租户隔离（04 §6.1.1）。

设计口径（D21）：
- workspace 只由 ManagerRagService.derive_workspace(ctx.tenant_id, knowledge_space_id) 派生，
  禁前端/Agent 直传；本 repository 不暴露 workspace 写入接口。
- 专家授权真相态走 employee_knowledge_binding，本表的 knowledge_space_binding 只落
  部门/成员绑定元数据（不做检索执行）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import ManagerRagService, PgTenantRouter

# 绑定目标类型（本表承载的部门/成员；专家授权走 employee_knowledge_binding）。
BINDING_RESOURCE_TYPES = ("department", "member")


def _s(value) -> str:
    return str(value)


@dataclass(frozen=True)
class KnowledgeSpaceRow:
    """知识空间行（复用 rag_workspace 表：tenant/knowledge_space_id 映射 + 展示名）。"""

    knowledge_space_id: str
    workspace: str
    display_name: str
    created_at: datetime | None = None


@dataclass(frozen=True)
class KnowledgeSpaceBindingRow:
    """知识空间 → 部门/成员 绑定行（仅元数据，D21）。"""

    id: str
    knowledge_space_id: str
    resource_type: str
    resource_id: str
    created_at: datetime | None = None


_SPACE_COLUMNS = "knowledge_space_id, workspace, display_name, created_at"
_BINDING_COLUMNS = "id, knowledge_space_id, resource_type, resource_id, created_at"


def _row_to_space(row: Any) -> KnowledgeSpaceRow:
    return KnowledgeSpaceRow(
        knowledge_space_id=row[0],
        workspace=row[1],
        display_name=row[2],
        created_at=row[3],
    )


def _row_to_binding(row: Any) -> KnowledgeSpaceBindingRow:
    return KnowledgeSpaceBindingRow(
        id=_s(row[0]),
        knowledge_space_id=row[1],
        resource_type=row[2],
        resource_id=_s(row[3]),
        created_at=row[4],
    )


class KnowledgeSpaceRepository:
    """知识空间管理面 CRUD（复用 rag_workspace 表）。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        display_name: str,
    ) -> KnowledgeSpaceRow:
        """建知识空间：workspace 由 ManagerRagService 派生（D21，禁止外部直传）。"""
        workspace = ManagerRagService.derive_workspace(ctx.tenant_id, knowledge_space_id)
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO rag_workspace (tenant_id, knowledge_space_id, workspace, display_name) "
                "VALUES (%s, %s, %s, %s) "
                "RETURNING " + _SPACE_COLUMNS,
                (ctx.tenant_id, knowledge_space_id, workspace, display_name),
            ).fetchone()
        assert row is not None  # INSERT RETURNING 必有行
        return _row_to_space(row)

    def get(self, ctx: TenantContext, *, knowledge_space_id: str) -> KnowledgeSpaceRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _SPACE_COLUMNS + " FROM rag_workspace WHERE knowledge_space_id = %s",
                (knowledge_space_id,),
            ).fetchone()
        return _row_to_space(row) if row is not None else None

    def list_all(self, ctx: TenantContext) -> list[KnowledgeSpaceRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _SPACE_COLUMNS + " FROM rag_workspace ORDER BY created_at"
            ).fetchall()
        return [_row_to_space(r) for r in rows]

    def update(
        self, ctx: TenantContext, *, knowledge_space_id: str, display_name: str
    ) -> KnowledgeSpaceRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE rag_workspace SET display_name = %s WHERE knowledge_space_id = %s "
                "RETURNING " + _SPACE_COLUMNS,
                (display_name, knowledge_space_id),
            ).fetchone()
        return _row_to_space(row) if row is not None else None

    def delete(self, ctx: TenantContext, *, knowledge_space_id: str) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute(
                "DELETE FROM rag_workspace WHERE knowledge_space_id = %s", (knowledge_space_id,)
            )
            return cur.rowcount > 0


class KnowledgeSpaceBindingRepository:
    """知识空间 → 部门/成员 绑定（knowledge_space_binding 表）。tenant_id 取自 ctx（D22）。

    专家绑定（resource_type=expert）的真相态走 employee_knowledge_binding（见 ExpertKnowledgeBinding），
    本表不承载。
    """

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def upsert(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        resource_type: str,
        resource_id: str,
    ) -> KnowledgeSpaceBindingRow:
        """创建或幂等返回某绑定（同 (tenant, ks, type, id) 已存在则不重复）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO knowledge_space_binding "
                "  (tenant_id, knowledge_space_id, resource_type, resource_id) "
                "VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (tenant_id, knowledge_space_id, resource_type, resource_id) DO NOTHING "
                "RETURNING " + _BINDING_COLUMNS,
                (ctx.tenant_id, knowledge_space_id, resource_type, resource_id),
            ).fetchone()
            if row is None:
                # 已存在：取现有行
                row = s.execute(
                    "SELECT " + _BINDING_COLUMNS
                    + " FROM knowledge_space_binding "
                    "WHERE knowledge_space_id = %s AND resource_type = %s AND resource_id = %s",
                    (knowledge_space_id, resource_type, resource_id),
                ).fetchone()
        assert row is not None
        return _row_to_binding(row)

    def list_by_space(self, ctx: TenantContext, *, knowledge_space_id: str) -> list[KnowledgeSpaceBindingRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _BINDING_COLUMNS
                + " FROM knowledge_space_binding WHERE knowledge_space_id = %s ORDER BY created_at",
                (knowledge_space_id,),
            ).fetchall()
        return [_row_to_binding(r) for r in rows]

    def list_all(self, ctx: TenantContext) -> list[KnowledgeSpaceBindingRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _BINDING_COLUMNS + " FROM knowledge_space_binding ORDER BY created_at"
            ).fetchall()
        return [_row_to_binding(r) for r in rows]

    def delete_one(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        resource_type: str,
        resource_id: str,
    ) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute(
                "DELETE FROM knowledge_space_binding "
                "WHERE knowledge_space_id = %s AND resource_type = %s AND resource_id = %s",
                (knowledge_space_id, resource_type, resource_id),
            )
            return cur.rowcount > 0

    def delete_by_space(self, ctx: TenantContext, *, knowledge_space_id: str) -> int:
        """删某知识空间下的全部部门/成员绑定（知识空间删除时清残绑定）。返回删除条数。"""
        with self._router.session(ctx) as s:
            cur = s.execute(
                "DELETE FROM knowledge_space_binding WHERE knowledge_space_id = %s",
                (knowledge_space_id,),
            )
            return cur.rowcount


class ExpertKnowledgeBinding:
    """Expert knowledge authorization backed solely by employee_knowledge_binding.

    Kept as a narrow compatibility port for existing services; it never reads or
    writes only employee_knowledge_binding.
    """

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def bind(self, ctx: TenantContext, *, employee_id: str, knowledge_space_id: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO employee_knowledge_binding "
                "(tenant_id, employee_id, knowledge_space_id, enabled, config) "
                "VALUES (%s, %s, %s, true, '{}'::jsonb) "
                "ON CONFLICT (tenant_id, employee_id, knowledge_space_id) DO UPDATE "
                "SET enabled = true, updated_at = now() RETURNING id",
                (ctx.tenant_id, employee_id, knowledge_space_id),
            ).fetchone()
        return row is not None

    def unbind(self, ctx: TenantContext, *, employee_id: str, knowledge_space_id: str) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute(
                "UPDATE employee_knowledge_binding SET enabled = false, updated_at = now() "
                "WHERE employee_id = %s AND knowledge_space_id = %s",
                (employee_id, knowledge_space_id),
            )
        return cur.rowcount > 0

    def list_experts_by_space(
        self, ctx: TenantContext, *, knowledge_space_id: str
    ) -> list[str]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT employee_id FROM employee_knowledge_binding "
                "WHERE knowledge_space_id = %s AND enabled = true",
                (knowledge_space_id,),
            ).fetchall()
        return [_s(r[0]) for r in rows]
