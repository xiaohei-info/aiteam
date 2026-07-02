"""成员/部门/角色 + member_grant 授权 CRUD 与跨租户隔离验收（integration，真 PG；issue #35）。

验收项（issue「验收」）：
- 成员/部门/角色 CRUD + member_grant 授权（端到端，经 service + TenantContext）。
- 授权按 tenant 裁剪的隔离测试：tenant A 的授权 tenant B 看不到（RLS 强制）；
  错 tenant 上下文写不了（WITH CHECK 拒）。

铁律：tenant_id 全程经 TenantContext（D22），repository 不接受手写 tenant 过滤。
"""

from __future__ import annotations

import uuid

import psycopg
import pytest

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

from manager_service.member_service import build_member_dept_service
from manager_service.schemas import (
    DepartmentCreate,
    MemberCreate,
    MemberGrantCreate,
    MemberUpdate,
)

pytestmark = pytest.mark.integration


def _ctx(tid: str, roles=None) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id=str(uuid.uuid4()), roles=roles or ["owner"])


def _build(dsn: str, admin_dsn: str):
    """用管理连接起 AuthService（签名私钥走 admin）；业务走 app_rw DSN。"""
    from manager_service.auth_service import build_auth_service

    auth = build_auth_service(dsn, admin_dsn=admin_dsn)
    return build_member_dept_service(dsn, auth=auth)


# ---- 部门 CRUD ----
def test_department_crud_within_tenant(two_tenants, migrated_db, admin_url):
    tid_a, _ = two_tenants
    member_svc, _ = _build(migrated_db, admin_url)
    ctx = _ctx(tid_a)

    created = member_svc.create_department(ctx, DepartmentCreate(department_slug="eng", display_name="工程"))
    assert created.department_slug == "eng"

    got = member_svc.get_department(ctx, created.id)
    assert got.display_name == "工程"

    rows = member_svc.list_departments(ctx)
    assert any(r.department_slug == "eng" for r in rows)

    updated = member_svc.update_department(ctx, created.id, __import__(
        "manager_service.schemas", fromlist=["DepartmentUpdate"]).DepartmentUpdate(display_name="工程部"))
    assert updated.display_name == "工程部"

    member_svc.delete_department(ctx, created.id)
    with pytest.raises(Exception):
        member_svc.get_department(ctx, created.id)


# ---- 成员 CRUD（角色经 EnterpriseRole 枚举）----
def test_member_crud_with_roles_and_departments(two_tenants, migrated_db, admin_url):
    tid_a, _ = two_tenants
    member_svc, _ = _build(migrated_db, admin_url)
    ctx = _ctx(tid_a)

    # 先建部门
    dept = member_svc.create_department(ctx, DepartmentCreate(department_slug="ops", display_name="运维"))

    # 建成员（角色 member，入 ops 部门）
    phone = f"138{uuid.uuid4().hex[:8]}"
    from shared.contracts.enums import EnterpriseRole

    member = member_svc.create_member(ctx, MemberCreate(
        account=phone, initial_password="Pw123456!", display_name="alice",
        roles=[EnterpriseRole.MEMBER], department_ids=[dept.id],
    ))
    assert "member" in member.roles
    assert dept.id in member.department_ids
    assert "secret" not in member.model_dump()

    # 改角色 → enterprise_admin
    from manager_service.schemas import MemberUpdate as MU

    updated = member_svc.update_member(
        ctx, member.id, MU(roles=[EnterpriseRole.ENTERPRISE_ADMIN])
    )
    assert "enterprise_admin" in updated.roles

    got = member_svc.get_member(ctx, member.id)
    assert got.id == member.id

    members = member_svc.list_members(ctx)
    assert any(m.id == member.id for m in members)

    member_svc.delete_member(ctx, member.id)
    with pytest.raises(Exception):
        member_svc.get_member(ctx, member.id)


# ---- member_grant 授权 CRUD + 撤销 ----
def test_grant_create_update_revoke(two_tenants, migrated_db, admin_url):
    tid_a, _ = two_tenants
    member_svc, grant_svc = _build(migrated_db, admin_url)
    ctx = _ctx(tid_a)

    dept = member_svc.create_department(ctx, DepartmentCreate(department_slug="g1"))
    phone = f"139{uuid.uuid4().hex[:8]}"
    from shared.contracts.enums import EnterpriseRole

    member = member_svc.create_member(ctx, MemberCreate(
        account=phone, initial_password="Pw123456!", roles=[EnterpriseRole.MEMBER],
    ))

    # 建授权：expert e1 → 部门 g1 + 成员
    grant = grant_svc.create_grant(ctx, MemberGrantCreate(
        resource_type="expert", resource_id=str(uuid.uuid4()),
        department_ids=[dept.id], member_ids=[member.id],
    ))
    assert grant.tenant_id == tid_a
    assert dept.id in grant.department_ids
    assert member.id in grant.member_ids

    # 改授权面（去掉成员，留部门）
    from manager_service.schemas import MemberGrantUpdate as GU

    updated = grant_svc.update_grant(
        ctx, grant.id, GU(department_ids=[dept.id], member_ids=[])
    )
    assert updated.member_ids == []
    assert dept.id in updated.department_ids

    # 列表能查到
    rows = grant_svc.list_grants(ctx)
    assert any(r.id == grant.id for r in rows)

    # upsert：同资源再 create → 替换不新增
    grant2 = grant_svc.create_grant(ctx, MemberGrantCreate(
        resource_type=grant.resource_type, resource_id=grant.resource_id,
        department_ids=[], member_ids=[member.id],
    ))
    assert grant2.id == grant.id

    # 撤销
    grant_svc.delete_grant(ctx, grant.id)
    rows = grant_svc.list_grants(ctx)
    assert all(r.id != grant.id for r in rows)


def test_grant_rejects_unknown_resource_type(two_tenants, migrated_db, admin_url):
    tid_a, _ = two_tenants
    _, grant_svc = _build(migrated_db, admin_url)
    ctx = _ctx(tid_a)
    with pytest.raises(ValueError):
        grant_svc.create_grant(ctx, MemberGrantCreate(
            resource_type="workspace", resource_id=str(uuid.uuid4()),
        ))


# ---- 隔离：授权按 tenant 裁剪（RLS 强制，D12/D22）----
def test_grant_cross_tenant_not_visible(two_tenants, migrated_db, admin_url):
    """tenant A 建的授权，tenant B 上下文看不到（RLS 按 tenant 裁剪）。"""
    tid_a, tid_b = two_tenants
    member_svc_a, grant_svc_a = _build(migrated_db, admin_url)
    _, grant_svc_b = _build(migrated_db, admin_url)
    ctx_a = _ctx(tid_a)
    ctx_b = _ctx(tid_b)

    dept = member_svc_a.create_department(ctx_a, DepartmentCreate(department_slug="iso"))
    grant = grant_svc_a.create_grant(ctx_a, MemberGrantCreate(
        resource_type="expert", resource_id=str(uuid.uuid4()),
        department_ids=[dept.id], member_ids=[],
    ))

    # tenant A 能看到
    rows_a = grant_svc_a.list_grants(ctx_a)
    assert any(r.id == grant.id for r in rows_a)

    # tenant B 完全看不到 tenant A 的授权（RLS 强制裁剪）
    rows_b = grant_svc_b.list_grants(ctx_b)
    assert all(r.id != grant.id for r in rows_b)
    assert all(r.tenant_id != tid_a for r in rows_b)


def test_grant_cross_tenant_write_rejected_by_rls(two_tenants, migrated_db, admin_url):
    """WITH CHECK：tenant B 上下文不能为 tenant A 的资源伪造授权（防跨租户写）。

    在 SET LOCAL app.tenant_id = tid_b 的 session 内，强行 INSERT tenant_id=tid_a 的授权行，
    RLS WITH CHECK 拒（tenant_id 不等于 session 绑定的租户）。
    """
    tid_a, tid_b = two_tenants
    router = PgTenantRouter(migrated_db)
    with pytest.raises(psycopg.errors.Error):
        with router.session(_ctx(tid_b)) as s:
            s.execute(
                "INSERT INTO member_grant (tenant_id, resource_type, resource_id) "
                "VALUES (%s, %s, %s)",
                (tid_a, "expert", str(uuid.uuid4())),
            )


def test_department_cross_tenant_isolation(two_tenants, migrated_db, admin_url):
    """部门表同样按 tenant 隔离：tenant A 部门 tenant B 看不到。"""
    tid_a, tid_b = two_tenants
    member_svc_a, _ = _build(migrated_db, admin_url)
    member_svc_b, _ = _build(migrated_db, admin_url)
    ctx_a = _ctx(tid_a)
    ctx_b = _ctx(tid_b)

    dept = member_svc_a.create_department(ctx_a, DepartmentCreate(department_slug="only_a"))

    # tenant A 看得到
    assert any(r.department_slug == "only_a" for r in member_svc_a.list_departments(ctx_a))
    # tenant B 看不到
    assert all(r.department_slug != "only_a" for r in member_svc_b.list_departments(ctx_b))


def test_member_cross_tenant_isolation(two_tenants, migrated_db, admin_url):
    """成员（app_user）按 tenant 隔离：tenant A 成员 tenant B 看不到。"""
    tid_a, tid_b = two_tenants
    member_svc_a, _ = _build(migrated_db, admin_url)
    member_svc_b, _ = _build(migrated_db, admin_url)
    ctx_a = _ctx(tid_a)
    ctx_b = _ctx(tid_b)

    from shared.contracts.enums import EnterpriseRole

    phone = f"137{uuid.uuid4().hex[:8]}"
    member = member_svc_a.create_member(ctx_a, MemberCreate(
        account=phone, initial_password="Pw123456!",
        roles=[EnterpriseRole.MEMBER], display_name="a-only",
    ))

    # tenant A 列表含本成员
    assert any(m.id == member.id for m in member_svc_a.list_members(ctx_a))
    # tenant B 列表不含 tenant A 成员（RLS 强制）
    assert all(m.id != member.id for m in member_svc_b.list_members(ctx_b))
    # tenant B 直接按 id 取也取不到（RLS 行级过滤）
    with pytest.raises(Exception):
        member_svc_b.get_member(ctx_b, member.id)
