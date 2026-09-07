"""知识空间/RAG 管理面 CRUD + 绑定 + 租户隔离验收（M3，04 §6.1.2/§6.6；05 F08；D21）。

非 integration（默认门必跑，不依赖 PG）：
- 红线 D21：workspace 不在 schema 入参；KnowledgeSpaceOut 不接受 workspace 直传。
- 业务编排：知识空间 CRUD、绑定（专家走 employee.knowledge_refs；部门/成员走 binding 表）、
  跨租户不可见、写操作角色门（member 403）、冲突/缺失判定（用内存伪 repository 验）。
- 删除知识空间时清残绑定 + 专家引用。

integration（真 PG）见 test_knowledge_space_e2e.py。
"""

from __future__ import annotations

import pytest

from shared.contracts.tenancy import TenantContext
from shared.db import ManagerRagService
from shared.errors import Conflict, Forbidden, NotFound

from manager_service.knowledge_space_repository import (
    KnowledgeSpaceBindingRow,
    KnowledgeSpaceRow,
)
from manager_service.knowledge_space_service import KnowledgeSpaceService
from manager_service.schemas import (
    KnowledgeSpaceBindingCreate,
    KnowledgeSpaceCreate,
    KnowledgeSpaceUpdate,
)


# ---- D21 红线：workspace 不在入参 ----


def test_create_schema_has_no_workspace_input():
    """KnowledgeSpaceCreate 不含 workspace 字段（D21：workspace 只由 ManagerRagService 推导）。"""
    fields = set(KnowledgeSpaceCreate.model_fields.keys())
    assert "workspace" not in fields


def test_binding_create_resource_type_is_limited():
    """绑定 resource_type 白名单：expert|department|member。"""
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        KnowledgeSpaceBindingCreate(
            knowledge_space_id="ks", resource_type="workspace", resource_id="x"
        )


# ---- 内存伪 repository（模拟 RLS 跨租户不可见；tenant_id 只从 ctx 读）----


class _FakeSpaceRepo:
    def __init__(self):
        self._store: dict[str, dict[str, KnowledgeSpaceRow]] = {}

    def _bucket(self, ctx):
        return self._store.setdefault(ctx.tenant_id, {})

    def create(self, ctx, *, knowledge_space_id, display_name):
        workspace = ManagerRagService.derive_workspace(ctx.tenant_id, knowledge_space_id)
        row = KnowledgeSpaceRow(
            knowledge_space_id=knowledge_space_id,
            workspace=workspace,
            display_name=display_name,
            created_at=None,
        )
        self._bucket(ctx)[knowledge_space_id] = row
        return row

    def get(self, ctx, *, knowledge_space_id):
        return self._bucket(ctx).get(knowledge_space_id)

    def list_all(self, ctx):
        return list(self._bucket(ctx).values())

    def update(self, ctx, *, knowledge_space_id, display_name):
        b = self._bucket(ctx)
        if knowledge_space_id not in b:
            return None
        old = b[knowledge_space_id]
        row = KnowledgeSpaceRow(
            knowledge_space_id=old.knowledge_space_id,
            workspace=old.workspace,
            display_name=display_name,
            created_at=old.created_at,
        )
        b[knowledge_space_id] = row
        return row

    def delete(self, ctx, *, knowledge_space_id):
        return self._bucket(ctx).pop(knowledge_space_id, None) is not None


class _FakeBindingRepo:
    def __init__(self):
        self._store: dict[str, dict[tuple, KnowledgeSpaceBindingRow]] = {}

    def _bucket(self, ctx):
        return self._store.setdefault(ctx.tenant_id, {})

    def upsert(self, ctx, *, knowledge_space_id, resource_type, resource_id):
        key = (knowledge_space_id, resource_type, resource_id)
        b = self._bucket(ctx)
        if key not in b:
            b[key] = KnowledgeSpaceBindingRow(
                id=f"b-{len(b)}",
                knowledge_space_id=knowledge_space_id,
                resource_type=resource_type,
                resource_id=resource_id,
                created_at=None,
            )
        return b[key]

    def list_by_space(self, ctx, *, knowledge_space_id):
        return [
            v for (ks, _t, _i), v in self._bucket(ctx).items() if ks == knowledge_space_id
        ]

    def delete_one(self, ctx, *, knowledge_space_id, resource_type, resource_id):
        key = (knowledge_space_id, resource_type, resource_id)
        return self._bucket(ctx).pop(key, None) is not None

    def delete_by_space(self, ctx, *, knowledge_space_id):
        b = self._bucket(ctx)
        keys = [k for k in b if k[0] == knowledge_space_id]
        for k in keys:
            b.pop(k, None)
        return len(keys)


class _FakeExpertBinding:
    """专家绑定真相态：内存按 tenant 分桶的 employee_id → knowledge_refs 集合。"""

    def __init__(self, employees: dict[str, dict[str, set[str]]] | None = None):
        # {tenant_id: {employee_id: set(ks_ids)}}
        self._store: dict[str, dict[str, set[str]]] = employees or {}

    def _bucket(self, ctx):
        return self._store.setdefault(ctx.tenant_id, {})

    def seed(self, ctx, employee_id, refs=None):
        self._bucket(ctx)[employee_id] = set(refs or [])

    def bind(self, ctx, *, employee_id, knowledge_space_id):
        b = self._bucket(ctx)
        if employee_id not in b:
            return False
        b[employee_id].add(knowledge_space_id)
        return True

    def unbind(self, ctx, *, employee_id, knowledge_space_id):
        b = self._bucket(ctx)
        if employee_id not in b:
            return False
        b[employee_id].discard(knowledge_space_id)
        return True

    def list_experts_by_space(self, ctx, *, knowledge_space_id):
        b = self._bucket(ctx)
        return [eid for eid, refs in b.items() if knowledge_space_id in refs]


def _ctx(tid: str, roles=None) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id="u", roles=roles or ["owner"])


def _svc(space=None, binding=None, expert=None, *, enterprise_only=False) -> KnowledgeSpaceService:
    return KnowledgeSpaceService(
        repo=space or _FakeSpaceRepo(),
        binding_repo=binding or _FakeBindingRepo(),
        expert_binding=expert or _FakeExpertBinding(),
        enterprise_only=enterprise_only,
    )


# ---- 知识空间 CRUD ----


def test_knowledge_space_crud_roundtrip():
    svc = _svc()
    ctx = _ctx("t-a")
    created = svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="ks_default", display_name="默认"))
    assert created.knowledge_space_id == "ks_default"
    # workspace 由 ManagerRagService 推导（D21）
    assert created.workspace == ManagerRagService.derive_workspace("t-a", "ks_default")

    got = svc.get(ctx, knowledge_space_id="ks_default")
    assert got.display_name == "默认"

    rows = svc.list_all(ctx)
    assert any(r.knowledge_space_id == "ks_default" for r in rows)

    updated = svc.update(ctx, "ks_default", KnowledgeSpaceUpdate(display_name="默认改名"))
    assert updated.display_name == "默认改名"

    svc.delete(ctx, knowledge_space_id="ks_default")
    with pytest.raises(NotFound):
        svc.get(ctx, knowledge_space_id="ks_default")


def test_manager_exposes_only_the_enterprise_knowledge_key():
    svc = _svc(enterprise_only=True)
    created = svc.create(_ctx("t-a"), KnowledgeSpaceCreate(knowledge_space_id="enterprise_shared"))
    assert created.knowledge_space_id == "enterprise_shared"
    with pytest.raises(Conflict, match="one enterprise knowledge base"):
        svc.create(_ctx("t-a"), KnowledgeSpaceCreate(knowledge_space_id="ks-other"))


def test_knowledge_space_conflict_within_tenant():
    svc = _svc()
    ctx = _ctx("t-a")
    svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="dup"))
    with pytest.raises(Conflict):
        svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="dup"))


def test_same_knowledge_space_id_across_tenants_allowed():
    """同 knowledge_space_id 在不同 tenant 是不同空间（unique(tenant_id, knowledge_space_id)）。"""
    svc = _svc()
    a = svc.create(_ctx("t-a"), KnowledgeSpaceCreate(knowledge_space_id="shared"))
    b = svc.create(_ctx("t-b"), KnowledgeSpaceCreate(knowledge_space_id="shared"))
    assert a.workspace != b.workspace  # workspace 含 tenant_id，隔离（D21）


def test_cross_tenant_isolation_not_visible():
    """t-a 建的知识空间 t-b 看不到/改不到/删不掉（D22 + RLS 语义）。"""
    svc = _svc()
    ctx_a = _ctx("t-a")
    ctx_b = _ctx("t-b")
    svc.create(ctx_a, KnowledgeSpaceCreate(knowledge_space_id="ks_a"))

    with pytest.raises(NotFound):
        svc.get(ctx_b, knowledge_space_id="ks_a")
    with pytest.raises(NotFound):
        svc.update(ctx_b, "ks_a", KnowledgeSpaceUpdate(display_name="hack"))
    with pytest.raises(NotFound):
        svc.delete(ctx_b, knowledge_space_id="ks_a")
    # t-a 仍在
    assert svc.get(ctx_a, knowledge_space_id="ks_a") is not None


def test_member_cannot_write_knowledge_space():
    """知识空间写操作需 owner/enterprise_admin；member → 403（03 §9.7）。member 读允许。"""
    svc = _svc()
    ctx_owner = _ctx("t-a", roles=["owner"])
    svc.create(ctx_owner, KnowledgeSpaceCreate(knowledge_space_id="ks"))
    ctx_member = _ctx("t-a", roles=["member"])
    with pytest.raises(Forbidden):
        svc.create(ctx_member, KnowledgeSpaceCreate(knowledge_space_id="ks2"))
    with pytest.raises(Forbidden):
        svc.update(ctx_member, "ks", KnowledgeSpaceUpdate(display_name="x"))
    with pytest.raises(Forbidden):
        svc.delete(ctx_member, knowledge_space_id="ks")
    # member 读可
    assert svc.get(ctx_member, knowledge_space_id="ks").knowledge_space_id == "ks"
    assert svc.list_all(ctx_member)


# ---- 绑定：部门/成员 ----


def test_bind_department_and_member():
    svc = _svc()
    ctx = _ctx("t-a")
    svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="ks"))

    import uuid
    dept_id, member_id = str(uuid.uuid4()), str(uuid.uuid4())

    b1 = svc.bind(ctx, KnowledgeSpaceBindingCreate(
        knowledge_space_id="ks", resource_type="department", resource_id=dept_id
    ))
    assert b1.resource_type == "department" and b1.resource_id == dept_id

    b2 = svc.bind(ctx, KnowledgeSpaceBindingCreate(
        knowledge_space_id="ks", resource_type="member", resource_id=member_id
    ))
    assert b2.resource_type == "member" and b2.resource_id == member_id

    bindings = svc.list_bindings(ctx, knowledge_space_id="ks")
    types = {b.resource_type for b in bindings}
    assert types == {"department", "member"}


def test_bind_requires_existing_knowledge_space():
    svc = _svc()
    ctx = _ctx("t-a")
    import uuid
    with pytest.raises(NotFound):
        svc.bind(ctx, KnowledgeSpaceBindingCreate(
            knowledge_space_id="nope", resource_type="department", resource_id=str(uuid.uuid4())
        ))


def test_unbind_department():
    svc = _svc()
    ctx = _ctx("t-a")
    svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="ks"))
    import uuid
    dept_id = str(uuid.uuid4())
    svc.bind(ctx, KnowledgeSpaceBindingCreate(
        knowledge_space_id="ks", resource_type="department", resource_id=dept_id
    ))
    svc.unbind(ctx, knowledge_space_id="ks", resource_type="department", resource_id=dept_id)
    assert all(b.resource_id != dept_id for b in svc.list_bindings(ctx, knowledge_space_id="ks"))


# ---- 绑定：专家（真相态 = employee.knowledge_refs）----


def test_bind_expert_updates_knowledge_refs():
    expert = _FakeExpertBinding()
    svc = _svc(expert=expert)
    ctx = _ctx("t-a")
    svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="ks"))
    expert.seed(ctx, "emp-1", refs=[])

    b = svc.bind(ctx, KnowledgeSpaceBindingCreate(
        knowledge_space_id="ks", resource_type="expert", resource_id="emp-1"
    ))
    assert b.resource_type == "expert" and b.resource_id == "emp-1"
    # 真相态：employee.knowledge_refs 含 ks
    assert "ks" in expert._bucket(ctx)["emp-1"]

    # list_bindings 从 knowledge_refs 派生专家绑定
    bindings = svc.list_bindings(ctx, knowledge_space_id="ks")
    assert any(b.resource_type == "expert" and b.resource_id == "emp-1" for b in bindings)


def test_bind_expert_unknown_employee_not_found():
    expert = _FakeExpertBinding()  # 无 emp-9
    svc = _svc(expert=expert)
    ctx = _ctx("t-a")
    svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="ks"))
    with pytest.raises(NotFound):
        svc.bind(ctx, KnowledgeSpaceBindingCreate(
            knowledge_space_id="ks", resource_type="expert", resource_id="emp-9"
        ))


def test_unbind_unknown_expert_is_not_silent():
    expert = _FakeExpertBinding()
    svc = _svc(expert=expert)
    ctx = _ctx("t-a")
    svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="ks"))
    with pytest.raises(NotFound):
        svc.unbind(ctx, knowledge_space_id="ks", resource_type="expert", resource_id="missing")


def test_unbind_expert_removes_from_knowledge_refs():
    expert = _FakeExpertBinding()
    svc = _svc(expert=expert)
    ctx = _ctx("t-a")
    svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="ks"))
    expert.seed(ctx, "emp-1", refs=["ks"])
    svc.unbind(ctx, knowledge_space_id="ks", resource_type="expert", resource_id="emp-1")
    assert "ks" not in expert._bucket(ctx)["emp-1"]


# ---- 删除知识空间清残绑定 ----


def test_delete_clears_bindings_and_expert_refs():
    expert = _FakeExpertBinding()
    space = _FakeSpaceRepo()
    binding = _FakeBindingRepo()
    svc = _svc(space=space, binding=binding, expert=expert)
    ctx = _ctx("t-a")
    svc.create(ctx, KnowledgeSpaceCreate(knowledge_space_id="ks"))
    expert.seed(ctx, "emp-1", refs=[])

    import uuid
    svc.bind(ctx, KnowledgeSpaceBindingCreate(
        knowledge_space_id="ks", resource_type="department", resource_id=str(uuid.uuid4())
    ))
    svc.bind(ctx, KnowledgeSpaceBindingCreate(
        knowledge_space_id="ks", resource_type="expert", resource_id="emp-1"
    ))

    svc.delete(ctx, knowledge_space_id="ks")
    # 部门绑定清空
    assert binding.list_by_space(ctx, knowledge_space_id="ks") == []
    # 专家引用清空
    assert expert.list_experts_by_space(ctx, knowledge_space_id="ks") == []


# ---- 绑定租户隔离 ----


def test_binding_cross_tenant_not_visible():
    """t-a 建的绑定 t-b 看不到（knowledge_space 本身 t-b 不可见 → list_bindings NotFound）。"""
    svc = _svc()
    ctx_a = _ctx("t-a")
    ctx_b = _ctx("t-b")
    svc.create(ctx_a, KnowledgeSpaceCreate(knowledge_space_id="ks"))
    import uuid
    svc.bind(ctx_a, KnowledgeSpaceBindingCreate(
        knowledge_space_id="ks", resource_type="department", resource_id=str(uuid.uuid4())
    ))
    with pytest.raises(NotFound):
        svc.list_bindings(ctx_b, knowledge_space_id="ks")
