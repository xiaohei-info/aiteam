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
    def create_department(
        self, ctx: TenantContext, *, department_slug: str, display_name: str
    ) -> DepartmentRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO department (tenant_id, department_slug, display_name) "
                "VALUES (%s, %s, %s) "
                "RETURNING id, department_slug, display_name, created_at",
                (ctx.tenant_id, department_slug, display_name),
            ).fetchone()
        return DepartmentRow(_s(row[0]), row[1], row[2], row[3])

    def get_department(self, ctx: TenantContext, *, department_id: str) -> DepartmentRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT id, department_slug, display_name, created_at "
                "FROM department WHERE id = %s",
                (department_id,),
            ).fetchone()
        return None if row is None else DepartmentRow(_s(row[0]), row[1], row[2], row[3])

    def list_departments(self, ctx: TenantContext) -> list[DepartmentRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, department_slug, display_name, created_at "
                "FROM department ORDER BY created_at"
            ).fetchall()
        return [DepartmentRow(_s(r[0]), r[1], r[2], r[3]) for r in rows]

    def update_department(
        self, ctx: TenantContext, *, department_id: str, display_name: str
    ) -> DepartmentRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE department SET display_name = %s WHERE id = %s "
                "RETURNING id, department_slug, display_name, created_at",
                (display_name, department_id),
            ).fetchone()
        return None if row is None else DepartmentRow(_s(row[0]), row[1], row[2], row[3])

    def delete_department(self, ctx: TenantContext, *, department_id: str) -> bool:
        with self._router.session(ctx) as s:
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
