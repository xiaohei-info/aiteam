"""P1-F3 数据生命周期 seed/cleanup fixture（最终执行 DAG §5.1 P1-F3）。

在隔离 tenant scope 内播种一套连贯的企业数据（owner/member、部门授权、知识空间绑定），
并提供按 scope 的清理。覆盖 closeout DAG 列出的 seed_enterprise / seed_member_grants /
seed_knowledge_space，落点为 manager_control_db 经 apply_migrations 落地的 RLS 租户表。

可重复 + 不污染其它 tenant 的实现要点：
- 每次 seed 用全新 UUID 业务键，重复调用不撞唯一约束（可重复运行）。
- 所有写入经 app_rw 业务会话 + SET LOCAL app.tenant_id，RLS WITH CHECK 强制 tenant_id 一致。
- cleanup 在 **tenant 会话内** DELETE：RLS 物理限定，删 A 租户够不到 B 租户——
  "不污染其它 tenant"是数据库强制，不靠应用层 WHERE 兜底。

注：用户端本地 SQLite 表不属于 manager_control_db；其 seed 不由本 Manager fixture 越界伪造。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import pytest

# apply_migrations(manager) 落地的租户 RLS 表。cleanup 逐表删（无 FK，顺序无关）。
TENANT_TABLES: tuple[str, ...] = (
    "knowledge_space_binding",
    "member_grant",
    "department",
    "auth_identity",
    "app_user",
    "rag_workspace",
    "employee",
)


@dataclass
class SeededEnterprise:
    """一次 seed 产出的业务键集合，供下游断言引用。"""

    tenant_id: str
    owner_user_id: str
    member_user_id: str
    department_id: str
    expert_resource_id: str
    knowledge_space_id: str


def seed_enterprise(scope, *, owner_slug: str | None = None) -> dict:
    """播种企业 owner + 一名 member（app_user + auth_identity）。返回 id 字典。"""
    owner_id = str(uuid.uuid4())
    member_id = str(uuid.uuid4())
    owner_login = owner_slug or f"owner_{uuid.uuid4().hex[:8]}"
    member_login = f"member_{uuid.uuid4().hex[:8]}"
    with scope.session(["owner"]) as s:
        s.execute(
            "INSERT INTO app_user (id, tenant_id, display_name, roles) VALUES (%s, %s, %s, %s)",
            (owner_id, scope.tenant_id, "Owner", ["owner"]),
        )
        s.execute(
            "INSERT INTO app_user (id, tenant_id, display_name, roles) VALUES (%s, %s, %s, %s)",
            (member_id, scope.tenant_id, "Member", ["member"]),
        )
        s.execute(
            "INSERT INTO auth_identity (tenant_id, user_id, provider, external_id) "
            "VALUES (%s, %s, %s, %s)",
            (scope.tenant_id, owner_id, "password", owner_login),
        )
        s.execute(
            "INSERT INTO auth_identity (tenant_id, user_id, provider, external_id) "
            "VALUES (%s, %s, %s, %s)",
            (scope.tenant_id, member_id, "password", member_login),
        )
    return {"owner_user_id": owner_id, "member_user_id": member_id}


def seed_member_grants(scope, *, member_user_id: str) -> dict:
    """播种部门 + 一条 expert grant（department + member_grant）。返回 id 字典。"""
    dept_id = str(uuid.uuid4())
    expert_resource_id = str(uuid.uuid4())
    with scope.session(["owner"]) as s:
        s.execute(
            "INSERT INTO department (id, tenant_id, department_slug, display_name) "
            "VALUES (%s, %s, %s, %s)",
            (dept_id, scope.tenant_id, f"dept_{uuid.uuid4().hex[:8]}", "Dept"),
        )
        s.execute(
            "INSERT INTO member_grant (tenant_id, resource_type, resource_id, department_ids, member_ids) "
            "VALUES (%s, %s, %s, %s, %s)",
            (scope.tenant_id, "expert", expert_resource_id, [dept_id], [member_user_id]),
        )
    return {"department_id": dept_id, "expert_resource_id": expert_resource_id}


def seed_knowledge_space(scope, *, department_id: str) -> dict:
    """播种知识空间绑定 + RAG workspace 映射（knowledge_space_binding + rag_workspace）。"""
    ks_id = f"ks_{uuid.uuid4().hex[:10]}"
    from shared.db import ManagerRagService

    workspace = ManagerRagService.derive_workspace(scope.tenant_id, ks_id)
    with scope.session(["owner"]) as s:
        s.execute(
            "INSERT INTO knowledge_space_binding (tenant_id, knowledge_space_id, resource_type, resource_id) "
            "VALUES (%s, %s, %s, %s)",
            (scope.tenant_id, ks_id, "department", department_id),
        )
        s.execute(
            "INSERT INTO rag_workspace (tenant_id, knowledge_space_id, workspace) VALUES (%s, %s, %s)",
            (scope.tenant_id, ks_id, workspace),
        )
    return {"knowledge_space_id": ks_id, "workspace": workspace}


def seed_full_enterprise(scope) -> SeededEnterprise:
    """一站式播种 enterprise -> grants -> knowledge_space，串好引用键。"""
    ent = seed_enterprise(scope)
    grants = seed_member_grants(scope, member_user_id=ent["member_user_id"])
    ks = seed_knowledge_space(scope, department_id=grants["department_id"])
    return SeededEnterprise(
        tenant_id=scope.tenant_id,
        owner_user_id=ent["owner_user_id"],
        member_user_id=ent["member_user_id"],
        department_id=grants["department_id"],
        expert_resource_id=grants["expert_resource_id"],
        knowledge_space_id=ks["knowledge_space_id"],
    )


def cleanup_test_scope(scope) -> int:
    """在 tenant 会话内删除本 scope 所有 RLS 行；返回删除总行数。

    RLS 物理限定：本调用够不到别的租户，故"不污染其它 tenant"由 DB 强制。
    幂等：可重复调用，第二次返回 0。
    """
    deleted = 0
    with scope.session(["owner"]) as s:
        for table in TENANT_TABLES:
            cur = s.execute(f"DELETE FROM {table}")  # noqa: S608 — 表名来自固定常量元组，非外部输入
            deleted += cur.rowcount
    return deleted


# ---- pytest fixtures ----


@pytest.fixture
def seeded_enterprise(tenant_scope) -> SeededEnterprise:
    """在隔离 scope 内播种完整企业数据，结束按 scope 清理（scope teardown 亦兜底）。"""
    seeded = seed_full_enterprise(tenant_scope)
    yield seeded
    cleanup_test_scope(tenant_scope)
