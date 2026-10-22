"""成员/部门/角色 + member_grant 授权租户作用域数据访问（issue #35；04 §6.1，D12/D22）。

铁律同 repository.py：所有方法以 TenantContext 为隔离边界，只从 ctx 读 tenant_id，
绝不接受调用方手写 tenant 过滤字符串（D22）；进 session 即 SET LOCAL app.tenant_id + RLS 强制。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import ValidationProblem

from .department_tree import check_parent, check_promote
from .schemas import RESOURCE_TYPES


def _s(value) -> str:
    """把 PG 返回的标量（uuid/str）统一转字符串。"""
    return str(value)


def _sa(values) -> list[str]:
    """把 PG 返回的数组元素（uuid/str）统一转字符串列表。"""
    return [str(v) for v in (values or [])]


@dataclass(frozen=True)
class DepartmentRow:
    id: str
    department_slug: str
    display_name: str
    created_at: datetime | None = None
    parent_id: str | None = None


@dataclass(frozen=True)
class MemberRow:
    id: str
    display_name: str
    status: str
    roles: list[str]
    department_ids: list[str]


@dataclass(frozen=True)
class GrantRow:
    id: str
    resource_type: str
    resource_id: str
    department_ids: list[str]
    member_ids: list[str]
    updated_at: datetime | None = None


class MemberDeptRepository:
    """部门与成员（app_user principal）的租户内访问。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    # ---- 部门 ----
    _DEPT_COLUMNS = "id, department_slug, display_name, created_at, parent_id"

    @staticmethod
    def _dept(row) -> DepartmentRow:
        return DepartmentRow(_s(row[0]), row[1], row[2], row[3], None if row[4] is None else _s(row[4]))

    @staticmethod
    def _lock_hierarchy(s, ctx: TenantContext) -> None:
        """同一租户的层级写入串行化，避免两个并发移动合起来形成环。事务结束自动释放。"""
        s.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"department-hierarchy:{ctx.tenant_id}",))

    @staticmethod
    def _parents(s) -> dict[str, str | None]:
        rows = s.execute("SELECT id, parent_id FROM department").fetchall()
        return {_s(r[0]): (None if r[1] is None else _s(r[1])) for r in rows}

    def create_department(
        self, ctx: TenantContext, *, department_slug: str, display_name: str, parent_id: str | None = None
    ) -> DepartmentRow:
        with self._router.session(ctx) as s:
            if parent_id is not None:
                self._lock_hierarchy(s, ctx)
                check_parent(self._parents(s), parent_id)
            row = s.execute(
                "INSERT INTO department (tenant_id, department_slug, display_name, parent_id) "
                "VALUES (%s, %s, %s, %s) "
                f"RETURNING {self._DEPT_COLUMNS}",
                (ctx.tenant_id, department_slug, display_name, parent_id),
            ).fetchone()
        return self._dept(row)

    def get_department(self, ctx: TenantContext, *, department_id: str) -> DepartmentRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                f"SELECT {self._DEPT_COLUMNS} FROM department WHERE id = %s",
                (department_id,),
            ).fetchone()
        return None if row is None else self._dept(row)

    def list_departments(self, ctx: TenantContext) -> list[DepartmentRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                f"SELECT {self._DEPT_COLUMNS} FROM department ORDER BY created_at"
            ).fetchall()
        return [self._dept(r) for r in rows]

    def update_department(
        self, ctx: TenantContext, *, department_id: str, display_name: str
    ) -> DepartmentRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE department SET display_name = %s WHERE id = %s "
                f"RETURNING {self._DEPT_COLUMNS}",
                (display_name, department_id),
            ).fetchone()
        return None if row is None else self._dept(row)

    def move_department(
        self,
        ctx: TenantContext,
        *,
        department_id: str,
        parent_id: str | None,
        display_name: str | None = None,
    ) -> DepartmentRow | None:
        """把部门移到另一个部门下（parent_id=None 为顶级）。校验与写入在同一事务内完成。

        同时传 display_name 时改名与移动同事务，要么都生效要么都不生效。
        """
        with self._router.session(ctx) as s:
            self._lock_hierarchy(s, ctx)
            parents = self._parents(s)
            if department_id not in parents:
                return None
            check_parent(parents, parent_id, moving=department_id)
            row = s.execute(
                "UPDATE department SET parent_id = %s, display_name = COALESCE(%s, display_name) "
                f"WHERE id = %s RETURNING {self._DEPT_COLUMNS}",
                (parent_id, display_name, department_id),
            ).fetchone()
        return None if row is None else self._dept(row)

    def promote_department(
        self, ctx: TenantContext, *, department_id: str, child_id: str
    ) -> DepartmentRow | None:
        """下级部门升级：在同一事务内完成两次改动，要么都生效要么都不生效。返回升级后的 child。"""
        with self._router.session(ctx) as s:
            self._lock_hierarchy(s, ctx)
            parents = self._parents(s)
            if department_id not in parents or child_id not in parents:
                return None
            updated = check_promote(parents, department_id, child_id)
            top = updated[child_id]
            # 先把 child 放到原部门的位置，再把原部门挂到 child 下，过程中不会出现环。
            s.execute("UPDATE department SET parent_id = %s WHERE id = %s", (top, child_id))
            s.execute("UPDATE department SET parent_id = %s WHERE id = %s", (child_id, department_id))
            row = s.execute(f"SELECT {self._DEPT_COLUMNS} FROM department WHERE id = %s", (child_id,)).fetchone()
        return None if row is None else self._dept(row)

    def delete_department(self, ctx: TenantContext, *, department_id: str) -> bool:
        """Delete a department and remove every tenant-local assignment first.

        Department ids are denormalized text arrays on users, employees, and grants;
        clearing them in the same transaction prevents dangling org/authorization
        references after a successful delete. Child departments move up to the
        deleted department's parent instead of being deleted or orphaned.
        """
        with self._router.session(ctx) as s:
            # 与移动 / 升级串行：否则别人刚把部门移到被删部门下，外键会让删除失败。
            self._lock_hierarchy(s, ctx)
            s.execute(
                "UPDATE department SET parent_id = (SELECT parent_id FROM department WHERE id = %s) "
                "WHERE parent_id = %s",
                (department_id, department_id),
            )
            s.execute(
                "UPDATE app_user SET department_ids = array_remove(department_ids, %s) "
                "WHERE %s = ANY(department_ids)",
                (department_id, department_id),
            )
            s.execute(
                "UPDATE employee SET department_ids = array_remove(department_ids, %s) "
                "WHERE %s = ANY(department_ids)",
                (department_id, department_id),
            )
            s.execute(
                "UPDATE member_grant SET department_ids = array_remove(department_ids, %s) "
                "WHERE %s = ANY(department_ids)",
                (department_id, department_id),
            )
            s.execute(
                "DELETE FROM knowledge_space_binding "
                "WHERE resource_type = 'department' AND resource_id = %s",
                (department_id,),
            )
            cur = s.execute("DELETE FROM department WHERE id = %s", (department_id,))
            return cur.rowcount > 0

    def department_exists(self, ctx: TenantContext, *, department_id: str) -> bool:
        return self.get_department(ctx, department_id=department_id) is not None

    # ---- 成员（app_user principal；凭据/secret 经 auth_identity，不在此暴露）----
    def list_members(self, ctx: TenantContext) -> list[MemberRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, display_name, status, roles, department_ids "
                "FROM app_user ORDER BY created_at"
            ).fetchall()
        return [MemberRow(_s(r[0]), r[1], r[2], _sa(r[3]), _sa(r[4])) for r in rows]

    def get_member(self, ctx: TenantContext, *, member_id: str) -> MemberRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT id, display_name, status, roles, department_ids FROM app_user WHERE id = %s",
                (member_id,),
            ).fetchone()
        return None if row is None else MemberRow(
            _s(row[0]), row[1], row[2], _sa(row[3]), _sa(row[4])
        )

    def update_member(
        self,
        ctx: TenantContext,
        *,
        member_id: str,
        display_name: str | None,
        roles: list[str] | None,
        department_ids: list[str] | None,
        status: str | None,
    ) -> MemberRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE app_user SET "
                "  display_name = COALESCE(%s, display_name), "
                "  roles = COALESCE(%s, roles), "
                "  department_ids = COALESCE(%s, department_ids), "
                "  status = COALESCE(%s, status) "
                "WHERE id = %s "
                "RETURNING id, display_name, status, roles, department_ids",
                (display_name, roles, department_ids, status, member_id),
            ).fetchone()
        return None if row is None else MemberRow(
            _s(row[0]), row[1], row[2], _sa(row[3]), _sa(row[4])
        )

    def delete_member(self, ctx: TenantContext, *, member_id: str) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute("DELETE FROM app_user WHERE id = %s", (member_id,))
            return cur.rowcount > 0


class GrantRepository:
    """member_grant 成员级授权的租户内访问（D12）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def upsert(
        self,
        ctx: TenantContext,
        *,
        resource_type: str,
        resource_id: str,
        department_ids: list[str],
        member_ids: list[str],
    ) -> GrantRow:
        """创建或替换某资源的授权面（聚合，一资源一条）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO member_grant "
                "  (tenant_id, resource_type, resource_id, department_ids, member_ids, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, now()) "
                "ON CONFLICT (tenant_id, resource_type, resource_id) DO UPDATE "
                "  SET department_ids = EXCLUDED.department_ids, "
                "      member_ids = EXCLUDED.member_ids, updated_at = now() "
                "RETURNING id, resource_type, resource_id, department_ids, member_ids, updated_at",
                (ctx.tenant_id, resource_type, resource_id, department_ids, member_ids),
            ).fetchone()
        return GrantRow(_s(row[0]), row[1], _s(row[2]), _sa(row[3]), _sa(row[4]), row[5])

    def extend(self, ctx: TenantContext, *, resource_type: str, resource_id: str,
               department_ids: list[str], member_ids: list[str]) -> GrantRow:
        """Implicit solution reuse only adds audience; explicit upsert still replaces it."""
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO member_grant (tenant_id, resource_type, resource_id, department_ids, member_ids) "
                "VALUES (%s, %s, %s, %s, %s) "
                "ON CONFLICT (tenant_id, resource_type, resource_id) DO UPDATE SET "
                "department_ids = ARRAY(SELECT DISTINCT value FROM unnest(member_grant.department_ids || EXCLUDED.department_ids) AS value ORDER BY value), "
                "member_ids = ARRAY(SELECT DISTINCT value FROM unnest(member_grant.member_ids || EXCLUDED.member_ids) AS value ORDER BY value), updated_at = now() "
                "RETURNING id, resource_type, resource_id, department_ids, member_ids, updated_at",
                (ctx.tenant_id, resource_type, resource_id, department_ids, member_ids),
            ).fetchone()
        return GrantRow(_s(row[0]), row[1], _s(row[2]), _sa(row[3]), _sa(row[4]), row[5])

    def list_all(self, ctx: TenantContext) -> list[GrantRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, resource_type, resource_id, department_ids, member_ids, updated_at "
                "FROM member_grant ORDER BY updated_at"
            ).fetchall()
        return [GrantRow(_s(r[0]), r[1], _s(r[2]), _sa(r[3]), _sa(r[4]), r[5]) for r in rows]

    def list_by_resource(
        self, ctx: TenantContext, *, resource_type: str, resource_id: str
    ) -> list[GrantRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, resource_type, resource_id, department_ids, member_ids, updated_at "
                "FROM member_grant WHERE resource_type = %s AND resource_id = %s",
                (resource_type, resource_id),
            ).fetchall()
        return [GrantRow(_s(r[0]), r[1], _s(r[2]), _sa(r[3]), _sa(r[4]), r[5]) for r in rows]

    def get(self, ctx: TenantContext, *, grant_id: str) -> GrantRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT id, resource_type, resource_id, department_ids, member_ids, updated_at "
                "FROM member_grant WHERE id = %s",
                (grant_id,),
            ).fetchone()
        return None if row is None else GrantRow(
            _s(row[0]), row[1], _s(row[2]), _sa(row[3]), _sa(row[4]), row[5]
        )

    def update(
        self,
        ctx: TenantContext,
        *,
        grant_id: str,
        department_ids: list[str],
        member_ids: list[str],
    ) -> GrantRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE member_grant SET department_ids = %s, member_ids = %s, updated_at = now() "
                "WHERE id = %s "
                "RETURNING id, resource_type, resource_id, department_ids, member_ids, updated_at",
                (department_ids, member_ids, grant_id),
            ).fetchone()
        return None if row is None else GrantRow(
            _s(row[0]), row[1], _s(row[2]), _sa(row[3]), _sa(row[4]), row[5]
        )

    def delete(self, ctx: TenantContext, *, grant_id: str) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute("DELETE FROM member_grant WHERE id = %s", (grant_id,))
            return cur.rowcount > 0


def validate_resource_type(resource_type: str) -> None:
    """resource_type 白名单（对齐 MemberGrant 契约）。

    抛 ValidationProblem（422）而非裸 ValueError，使 HTTP 路径被统一异常处理转成
    application/problem+json，避免落到 500（02 §11.2）。schema 层另有 Literal 双保险。
    """
    if resource_type not in RESOURCE_TYPES:
        raise ValidationProblem(
            detail=f"resource_type must be one of {RESOURCE_TYPES}, got: {resource_type!r}",
            errors=None,
        )
