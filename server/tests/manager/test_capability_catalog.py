"""技能/连接器/记忆策略 目录 CRUD + 租户隔离 + runtime 中立性（M4，04 §6.6，D17/D16/D22）。

非 integration（默认门必跑，不依赖 PG）：
- schema runtime 中立性：三类目录均不含 runtime 原生格式字段；config 是中立 dict。
- 业务编排：主路径 CRUD + 跨租户不可见（D22）+ 冲突/缺失判定 + member 写 403（03 §9.7）。
- 红线断言：连接器不发起对外调用（无对外调用方法）；凭据本体不入库（ConnectorCatalog 无 secret 字段）。

用内存伪 repository 验（不依赖 PG）。
"""

import uuid

import pytest

from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, Forbidden, NotFound

from manager_service.capability_catalog_repository import (
    ConnectorCatalogRow,
    MemoryPolicyCatalogRow,
    SkillCatalogRow,
)
from manager_service.capability_catalog_service import CapabilityCatalogService
from manager_service.schemas import (
    ConnectorCatalogIn,
    ConnectorCatalogOut,
    MemoryPolicyCatalogIn,
    MemoryPolicyCatalogOut,
    SkillCatalogIn,
    SkillCatalogOut,
)


# ---- runtime 中立性（D16 红线：不配置 runtime 非中立）+ 红线相关断言 ----


@pytest.mark.parametrize(
    "out_cls",
    [SkillCatalogOut, ConnectorCatalogOut, MemoryPolicyCatalogOut],
)
def test_catalog_schema_carries_no_runtime_native_format(out_cls):
    """三类目录 Out 均不含 runtime 原生字段（SOUL.md/MEMORY.md/config.yaml/启动参数），D16。"""
    fields = set(out_cls.model_fields.keys())
    forbidden = {
        "soul", "memory_md", "config_yaml", "profile_path", "cli_args", "executable",
        "api_key", "secret", "token", "provider_key",  # 凭据本体归 M5，D18
        "script_path", "entrypoint",
    }
    assert not (fields & forbidden), f"{out_cls.__name__} 含禁止字段: {fields & forbidden}"


def test_connector_catalog_has_no_secret_field():
    """红线③：连接器凭据本体不入 connector_catalog（凭据本体归 M5，D18）。"""
    fields = set(ConnectorCatalogOut.model_fields.keys())
    forbidden_secret = {"secret", "api_key", "token", "provider_key", "credential"}
    assert not (fields & forbidden_secret), f"ConnectorCatalogOut 含凭据本体字段: {fields & forbidden_secret}"


def test_connector_service_has_no_outbound_call_methods():
    """红线③：service 不发起连接器对外调用（只 CRUD 管理面真相）。"""
    svc_methods = {m for m in dir(CapabilityCatalogService) if not m.startswith("_")}
    forbidden = {"invoke", "call", "test_connection", "fetch", "request"}
    assert not (svc_methods & forbidden), f"service 含对外调用方法: {svc_methods & forbidden}"


def test_memory_policy_carries_no_runtime_memory_data():
    """红线①：记忆策略只落策略真相，不持运行时记忆数据本体（mem0 数据在用户端，04 §6.6）。"""
    fields = set(MemoryPolicyCatalogOut.model_fields.keys())
    forbidden_runtime_memory = {"messages", "memories", "runs", "conversation", "session_data"}
    assert not (fields & forbidden_runtime_memory)


# ---- 内存伪 repository（按 tenant_id 分桶，模拟 RLS 跨租户不可见；tenant_id 只从 ctx 读）----


class _FakeRepo:
    """内存伪 repository：三表按 tenant_id 分桶。tenant_id 只从 ctx 读（D22）。"""

    def __init__(self):
        self._skills: dict[str, dict[str, SkillCatalogRow]] = {}
        self._connectors: dict[str, dict[str, ConnectorCatalogRow]] = {}
        self._memories: dict[str, dict[str, MemoryPolicyCatalogRow]] = {}

    @staticmethod
    def _bucket(store, ctx):
        return store.setdefault(ctx.tenant_id, {})

    # ---- skill ----
    def create_skill(self, ctx, **kw):
        row = SkillCatalogRow(
            catalog_id=str(uuid.uuid4()), skill_id=kw["skill_id"], display_name=kw["display_name"],
            version=kw["version"], install_policy=kw["install_policy"], binding_policy=kw["binding_policy"],
            visibility=kw["visibility"], config=kw["config"], files=list(kw.get("files") or []),
            content_hash=kw.get("content_hash", ""), catalog_version=1,
        )
        self._bucket(self._skills, ctx)[row.catalog_id] = row
        return row

    def update_skill(self, ctx, *, catalog_id, **kw):
        b = self._bucket(self._skills, ctx)
        if catalog_id not in b:
            return None
        old = b[catalog_id]
        row = SkillCatalogRow(
            catalog_id=old.catalog_id, skill_id=old.skill_id, display_name=kw["display_name"],
            version=kw["version"], install_policy=kw["install_policy"], binding_policy=kw["binding_policy"],
            visibility=kw["visibility"], config=kw["config"], files=old.files, content_hash=old.content_hash,
            catalog_version=old.catalog_version + 1,
        )
        b[catalog_id] = row
        return row

    def get_skill(self, ctx, *, catalog_id):
        return self._bucket(self._skills, ctx).get(catalog_id)

    def get_skill_by_id(self, ctx, *, skill_id):
        for r in self._bucket(self._skills, ctx).values():
            if r.skill_id == skill_id:
                return r
        return None

    def list_skills(self, ctx):
        return list(self._bucket(self._skills, ctx).values())

    # ---- connector ----
    def create_connector(self, ctx, **kw):
        row = ConnectorCatalogRow(
            catalog_id=str(uuid.uuid4()), connector_id=kw["connector_id"], display_name=kw["display_name"],
            visibility=kw["visibility"], grant_scope=kw["grant_scope"], config=kw["config"],
            catalog_version=1,
        )
        self._bucket(self._connectors, ctx)[row.catalog_id] = row
        return row

    def update_connector(self, ctx, *, catalog_id, **kw):
        b = self._bucket(self._connectors, ctx)
        if catalog_id not in b:
            return None
        old = b[catalog_id]
        row = ConnectorCatalogRow(
            catalog_id=old.catalog_id, connector_id=old.connector_id, display_name=kw["display_name"],
            visibility=kw["visibility"], grant_scope=kw["grant_scope"], config=kw["config"],
            catalog_version=old.catalog_version + 1,
        )
        b[catalog_id] = row
        return row

    def get_connector(self, ctx, *, catalog_id):
        return self._bucket(self._connectors, ctx).get(catalog_id)

    def get_connector_by_id(self, ctx, *, connector_id):
        for r in self._bucket(self._connectors, ctx).values():
            if r.connector_id == connector_id:
                return r
        return None

    def list_connectors(self, ctx):
        return list(self._bucket(self._connectors, ctx).values())

    # ---- memory_policy ----
    def create_memory_policy(self, ctx, **kw):
        row = MemoryPolicyCatalogRow(
            catalog_id=str(uuid.uuid4()), policy_id=kw["policy_id"], display_name=kw["display_name"],
            policy=kw["policy"], seed_memories=kw["seed_memories"], retention_days=kw["retention_days"],
            visibility=kw["visibility"], config=kw["config"], catalog_version=1,
        )
        self._bucket(self._memories, ctx)[row.catalog_id] = row
        return row

    def update_memory_policy(self, ctx, *, catalog_id, **kw):
        b = self._bucket(self._memories, ctx)
        if catalog_id not in b:
            return None
        old = b[catalog_id]
        row = MemoryPolicyCatalogRow(
            catalog_id=old.catalog_id, policy_id=old.policy_id, display_name=kw["display_name"],
            policy=kw["policy"], seed_memories=kw["seed_memories"], retention_days=kw["retention_days"],
            visibility=kw["visibility"], config=kw["config"], catalog_version=old.catalog_version + 1,
        )
        b[catalog_id] = row
        return row

    def get_memory_policy(self, ctx, *, catalog_id):
        return self._bucket(self._memories, ctx).get(catalog_id)

    def get_memory_policy_by_id(self, ctx, *, policy_id):
        for r in self._bucket(self._memories, ctx).values():
            if r.policy_id == policy_id:
                return r
        return None

    def list_memory_policies(self, ctx):
        return list(self._bucket(self._memories, ctx).values())

    # ---- 通用 delete ----
    def delete(self, ctx, *, resource_kind, catalog_id):
        store = {"skill": self._skills, "connector": self._connectors, "memory_policy": self._memories}[resource_kind]
        return self._bucket(store, ctx).pop(catalog_id, None) is not None


def _ctx(tid: str, roles=None) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id="u", roles=roles or ["owner"])


# ---- skill 主路径 CRUD + version 自增 ----


def test_skill_crud_roundtrip_and_version_increment():
    svc = CapabilityCatalogService(_FakeRepo())
    ctx = _ctx("t-a")
    body = SkillCatalogIn(skill_id="code-review", display_name="代码评审", version="1.2.0",
                          config={"lang": "py"})
    created = svc.create_skill(ctx, body)
    assert created.skill_id == "code-review"
    assert created.catalog_version == 1
    assert created.config == {"lang": "py"}

    got = svc.get_skill(ctx, catalog_id=created.catalog_id)
    assert got.skill_id == "code-review"

    updated = svc.update_skill(
        ctx, SkillCatalogIn(skill_id="code-review", display_name="评审改名",
                            version="1.3.0", install_policy="pinned", config={}),
        catalog_id=created.catalog_id,
    )
    assert updated.display_name == "评审改名"
    assert updated.version == "1.3.0"
    assert updated.catalog_version == 2
    assert updated.install_policy == "pinned"

    svc.delete_skill(ctx, catalog_id=created.catalog_id)
    with pytest.raises(NotFound):
        svc.get_skill(ctx, catalog_id=created.catalog_id)


def test_skill_id_conflict_within_tenant():
    svc = CapabilityCatalogService(_FakeRepo())
    ctx = _ctx("t-a")
    svc.create_skill(ctx, SkillCatalogIn(skill_id="dup"))
    with pytest.raises(Conflict):
        svc.create_skill(ctx, SkillCatalogIn(skill_id="dup"))


def test_skill_cross_tenant_isolation():
    """跨租户：t-a 建的技能，t-b 看不到/改不到/删不掉（D22 + RLS 语义）。"""
    svc = CapabilityCatalogService(_FakeRepo())
    ctx_a = _ctx("t-a")
    ctx_b = _ctx("t-b")
    created = svc.create_skill(ctx_a, SkillCatalogIn(skill_id="s1"))

    with pytest.raises(NotFound):
        svc.get_skill(ctx_b, catalog_id=created.catalog_id)
    with pytest.raises(NotFound):
        svc.update_skill(ctx_b, SkillCatalogIn(skill_id="s1", display_name="hack"), catalog_id=created.catalog_id)
    with pytest.raises(NotFound):
        svc.delete_skill(ctx_b, catalog_id=created.catalog_id)
    # t-a 仍在
    assert svc.get_skill(ctx_a, catalog_id=created.catalog_id) is not None
    # t-b list 为空
    assert svc.list_skills(ctx_b) == []


def test_same_skill_id_across_tenants_allowed():
    """同 skill_id 属不同 tenant 是不同条目（unique(tenant_id, skill_id)，04 §6.1.1）。"""
    svc = CapabilityCatalogService(_FakeRepo())
    svc.create_skill(_ctx("t-a"), SkillCatalogIn(skill_id="shared"))
    created_b = svc.create_skill(_ctx("t-b"), SkillCatalogIn(skill_id="shared"))
    assert created_b.skill_id == "shared"


# ---- connector 主路径 CRUD + 红线断言 ----


def test_connector_crud_roundtrip():
    svc = CapabilityCatalogService(_FakeRepo())
    ctx = _ctx("t-a")
    body = ConnectorCatalogIn(connector_id="slack", display_name="Slack",
                              grant_scope="department_scoped", config={"base_url": "https://slack.com"})
    created = svc.create_connector(ctx, body)
    assert created.connector_id == "slack"
    assert created.grant_scope == "department_scoped"
    assert created.catalog_version == 1

    updated = svc.update_connector(
        ctx, ConnectorCatalogIn(connector_id="slack", display_name="Slack 改名",
                                grant_scope="member_scoped", config={}),
        catalog_id=created.catalog_id,
    )
    assert updated.display_name == "Slack 改名"
    assert updated.grant_scope == "member_scoped"
    assert updated.catalog_version == 2

    svc.delete_connector(ctx, catalog_id=created.catalog_id)
    with pytest.raises(NotFound):
        svc.get_connector(ctx, catalog_id=created.catalog_id)


def test_connector_conflict_and_cross_tenant():
    svc = CapabilityCatalogService(_FakeRepo())
    created = svc.create_connector(_ctx("t-a"), ConnectorCatalogIn(connector_id="c1"))
    # 冲突
    with pytest.raises(Conflict):
        svc.create_connector(_ctx("t-a"), ConnectorCatalogIn(connector_id="c1"))
    # 跨租户同 connector_id 允许
    created_b = svc.create_connector(_ctx("t-b"), ConnectorCatalogIn(connector_id="c1"))
    assert created_b.connector_id == "c1"
    # 跨租户不可见
    with pytest.raises(NotFound):
        svc.get_connector(_ctx("t-b"), catalog_id=created.catalog_id)


# ---- memory_policy 主路径 CRUD + D17 ----


def test_memory_policy_crud_roundtrip():
    svc = CapabilityCatalogService(_FakeRepo())
    ctx = _ctx("t-a")
    body = MemoryPolicyCatalogIn(
        policy_id="default", display_name="默认记忆策略",
        policy={"scope": "user"}, seed_memories=[{"role": "system", "content": "记住偏好"}],
        retention_days=30, visibility="tenant",
    )
    created = svc.create_memory_policy(ctx, body)
    assert created.policy_id == "default"
    assert created.retention_days == 30
    assert created.seed_memories == [{"role": "system", "content": "记住偏好"}]
    assert created.catalog_version == 1

    updated = svc.update_memory_policy(
        ctx, MemoryPolicyCatalogIn(
            policy_id="default", display_name="改名", policy={"scope": "agent"},
            seed_memories=[], retention_days=90, visibility="private",
        ),
        catalog_id=created.catalog_id,
    )
    assert updated.retention_days == 90
    assert updated.catalog_version == 2

    svc.delete_memory_policy(ctx, catalog_id=created.catalog_id)
    with pytest.raises(NotFound):
        svc.get_memory_policy(ctx, catalog_id=created.catalog_id)


def test_memory_policy_conflict_and_cross_tenant():
    svc = CapabilityCatalogService(_FakeRepo())
    svc.create_memory_policy(_ctx("t-a"), MemoryPolicyCatalogIn(policy_id="p1"))
    with pytest.raises(Conflict):
        svc.create_memory_policy(_ctx("t-a"), MemoryPolicyCatalogIn(policy_id="p1"))
    created = svc.create_memory_policy(_ctx("t-a"), MemoryPolicyCatalogIn(policy_id="p2"))
    with pytest.raises(NotFound):
        svc.get_memory_policy(_ctx("t-b"), catalog_id=created.catalog_id)
    assert svc.list_memory_policies(_ctx("t-b")) == []


# ---- 角色门：member 只读，写需 owner/enterprise_admin（03 §9.7）----


@pytest.mark.parametrize("method", ["create_skill", "create_connector", "create_memory_policy"])
def test_member_cannot_write_catalog(method):
    """目录写操作需 owner/enterprise_admin；member → 403（03 §9.7）。"""
    svc = CapabilityCatalogService(_FakeRepo())
    ctx_member = _ctx("t-a", roles=["member"])
    bodies = {
        "create_skill": SkillCatalogIn(skill_id="x"),
        "create_connector": ConnectorCatalogIn(connector_id="x"),
        "create_memory_policy": MemoryPolicyCatalogIn(policy_id="x"),
    }
    with pytest.raises(Forbidden):
        getattr(svc, method)(ctx_member, bodies[method])


def test_member_can_read_catalog():
    """member 读允许（get/list 无角色门）。"""
    svc = CapabilityCatalogService(_FakeRepo())
    ctx_owner = _ctx("t-a", roles=["owner"])
    created = svc.create_skill(ctx_owner, SkillCatalogIn(skill_id="s1"))
    ctx_member = _ctx("t-a", roles=["member"])
    assert svc.get_skill(ctx_member, catalog_id=created.catalog_id).skill_id == "s1"
    assert len(svc.list_skills(ctx_member)) == 1


def test_enterprise_admin_can_write_catalog():
    """enterprise_admin 亦可写目录（03 §9.7）。"""
    svc = CapabilityCatalogService(_FakeRepo())
    ctx_admin = _ctx("t-a", roles=["enterprise_admin"])
    created = svc.create_skill(ctx_admin, SkillCatalogIn(skill_id="s1"))
    assert created.catalog_version == 1
