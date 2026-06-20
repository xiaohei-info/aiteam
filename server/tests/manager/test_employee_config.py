"""employee/expert 配置 CRUD + runtime 中立性验收（M2，06 §7.6 / 04 §6.1，D16/D22）。

非 integration（默认门必跑，不依赖 PG）：
- HTTP 受保护端点：无 token → 401；未配置 DB → 503（problem+json）。
- schema runtime 中立性：runtime_binding 仅接受中立标识符；拒绝 runtime 参数/profile 片段。
- 业务编排：跨租户不可见、冲突/缺失判定（用内存伪 repository 验，不依赖 PG）。

integration（真 PG）：CRUD 端到端 + 跨租户 RLS 隔离 + version 自增。
"""

import pytest

from shared.contracts.auth import TokenClaims
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, Forbidden, NotFound

from manager_service.employee_config_repository import EmployeeConfigRow
from manager_service.employee_config_service import EmployeeConfigService
from manager_service.schemas import EmployeeConfigIn, EmployeeConfigOut


# ---- runtime 中立性（D16 红线：不配置 runtime 非中立）----


def test_runtime_binding_neutral_identifier_accepted():
    """默认 runtime_policy.runtime_binding=None 合法；显式中立标识符也合法。"""
    assert EmployeeConfigIn(display_name="x").runtime_policy.runtime_binding is None
    from shared.contracts.snapshot import RuntimePolicy
    ok = EmployeeConfigIn(
        display_name="x", runtime_policy=RuntimePolicy(runtime_binding="claude_code_json_stream"),
    )
    assert ok.runtime_policy.runtime_binding == "claude_code_json_stream"


@pytest.mark.parametrize("bad", [
    "hermes_acp --flag x",      # 含启动参数
    "SOUL.md",                  # 原生 profile 文件名
    "config.yaml",              # 原生配置文件
    "/usr/local/bin/hermes",    # 路径
    "runtime=val",              # 含等号
    "Hermes_ACP",               # 非全小写
    "hermes acp",               # 含空格
    "hermes-acp",               # 含连字符
])
def test_runtime_binding_rejects_non_neutral(bad):
    """runtime_binding 必须是中立标识符；runtime 参数/profile/路径一律拒绝（D16 红线）。"""
    from pydantic import ValidationError
    from shared.contracts.snapshot import RuntimePolicy
    with pytest.raises(ValidationError):
        EmployeeConfigIn(display_name="x", runtime_policy=RuntimePolicy(runtime_binding=bad))


def test_config_carries_no_native_runtime_format():
    """EmployeeConfigOut 不含 SOUL.md/MEMORY.md/config.yaml 等 runtime 原生字段（D16）。"""
    fields = set(EmployeeConfigOut.model_fields.keys())
    forbidden = {"soul", "memory_md", "config_yaml", "profile_path", "cli_args", "executable"}
    assert not (fields & forbidden), f"EmployeeConfigOut 含 runtime 原生字段: {fields & forbidden}"


# ---- 业务编排（内存伪 repository，不依赖 PG；验证 D22 tenant 隔离语义 + 冲突/缺失）----


class _FakeRepo:
    """内存伪 repository：按 tenant_id 分桶，模拟 RLS 跨租户不可见。tenant_id 只从 ctx 读。"""

    def __init__(self):
        self._store: dict[str, dict[str, "EmployeeConfigRow"]] = {}

    def _bucket(self, ctx: TenantContext) -> dict[str, EmployeeConfigRow]:
        return self._store.setdefault(ctx.tenant_id, {})

    def create(self, ctx, **kw):
        import uuid
        row = EmployeeConfigRow(
            employee_id=str(uuid.uuid4()), employee_slug=kw["employee_slug"],
            display_name=kw["display_name"], persona=kw["persona"], model=kw["model"],
            provider_ref=kw["provider_ref"], thinking_level=kw["thinking_level"],
            runtime_binding=kw["runtime_binding"], timeout_seconds=kw["timeout_seconds"],
            tools=kw["tools"], skills=kw["skills"], knowledge_refs=kw["knowledge_refs"],
            connector_refs=kw["connector_refs"], memory_policy=kw["memory_policy"], version=1,
        )
        self._bucket(ctx)[row.employee_id] = row
        return row

    def get(self, ctx, *, employee_id):
        return self._bucket(ctx).get(employee_id)

    def get_by_slug(self, ctx, *, employee_slug):
        for r in self._bucket(ctx).values():
            if r.employee_slug == employee_slug:
                return r
        return None

    def update(self, ctx, *, employee_id, **kw):
        b = self._bucket(ctx)
        if employee_id not in b:
            return None
        old = b[employee_id]
        row = EmployeeConfigRow(
            employee_id=old.employee_id, employee_slug=old.employee_slug,
            display_name=kw["display_name"], persona=kw["persona"], model=kw["model"],
            provider_ref=kw["provider_ref"], thinking_level=kw["thinking_level"],
            runtime_binding=kw["runtime_binding"], timeout_seconds=kw["timeout_seconds"],
            tools=kw["tools"], skills=kw["skills"], knowledge_refs=kw["knowledge_refs"],
            connector_refs=kw["connector_refs"], memory_policy=kw["memory_policy"],
            version=old.version + 1,
        )
        b[employee_id] = row
        return row

    def delete(self, ctx, *, employee_id):
        return self._bucket(ctx).pop(employee_id, None) is not None

    def list_all(self, ctx):
        return list(self._bucket(ctx).values())


def _ctx(tid: str, roles=None) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id="u", roles=roles or ["owner"])


def _body(**overrides) -> EmployeeConfigIn:
    base = {"display_name": "专家A", "persona": "你是测试专家"}
    base.update(overrides)
    return EmployeeConfigIn(**base)


def test_crud_roundtrip_and_version_increment():
    svc = EmployeeConfigService(_FakeRepo())
    ctx = _ctx("t-a")
    created = svc.create(ctx, _body(), employee_slug="exp-1")
    assert created.employee_slug == "exp-1"
    assert created.version == 1
    assert created.persona == "你是测试专家"

    got = svc.get(ctx, employee_id=created.employee_id)
    assert got.employee_id == created.employee_id

    updated = svc.update(ctx, _body(display_name="专家A改名"), employee_id=created.employee_id)
    assert updated.display_name == "专家A改名"
    assert updated.version == 2

    svc.delete(ctx, employee_id=created.employee_id)
    with pytest.raises(NotFound):
        svc.get(ctx, employee_id=created.employee_id)


def test_cross_tenant_isolation_not_visible():
    """跨租户：t-a 建的配置，t-b 看不到/改不到/删不掉（D22 + RLS 语义）。"""
    svc = EmployeeConfigService(_FakeRepo())
    ctx_a = _ctx("t-a")
    ctx_b = _ctx("t-b")
    created = svc.create(ctx_a, _body(), employee_slug="exp-1")

    # t-b 看不到
    with pytest.raises(NotFound):
        svc.get(ctx_b, employee_id=created.employee_id)
    # t-b 改不到
    with pytest.raises(NotFound):
        svc.update(ctx_b, _body(display_name="hack"), employee_id=created.employee_id)
    # t-b 删不掉
    with pytest.raises(NotFound):
        svc.delete(ctx_b, employee_id=created.employee_id)
    # t-a 仍在
    assert svc.get(ctx_a, employee_id=created.employee_id) is not None


def test_slug_conflict_within_tenant():
    svc = EmployeeConfigService(_FakeRepo())
    ctx = _ctx("t-a")
    svc.create(ctx, _body(), employee_slug="dup")
    with pytest.raises(Conflict):
        svc.create(ctx, _body(), employee_slug="dup")


def test_same_slug_across_tenants_allowed():
    """同 slug 属不同 tenant 是不同 employee（unique(tenant_id, employee_slug)，04 §6.1.1）。"""
    svc = EmployeeConfigService(_FakeRepo())
    svc.create(_ctx("t-a"), _body(), employee_slug="shared")
    # 不同 tenant 同 slug 不冲突
    created_b = svc.create(_ctx("t-b"), _body(), employee_slug="shared")
    assert created_b.employee_slug == "shared"


def test_member_cannot_write_config():
    """配置写操作需 owner/enterprise_admin；member → 403（03 §9.7）。"""
    svc = EmployeeConfigService(_FakeRepo())
    ctx_member = _ctx("t-a", roles=["member"])
    with pytest.raises(Forbidden):
        svc.create(ctx_member, _body(), employee_slug="x")
    # member 读允许（get/list 无角色门）
    ctx_owner = _ctx("t-a", roles=["owner"])
    created = svc.create(ctx_owner, _body(), employee_slug="x")
    assert svc.get(ctx_member, employee_id=created.employee_id).employee_slug == "x"
