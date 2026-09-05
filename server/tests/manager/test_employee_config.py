"""employee/expert 配置 CRUD + Pi 会话策略验收（M2，04 §6.1，D16/D22）。

非 integration（默认门必跑，不依赖 PG）：
- HTTP 受保护端点：无 token → 401；未配置 DB → 503（problem+json）。
- schema Pi 执行策略：仅允许会话限制，不接受底层执行器字段。
- 业务编排：跨租户不可见、冲突/缺失判定（用内存伪 repository 验，不依赖 PG）。

integration（真 PG）：CRUD 端到端 + 跨租户 RLS 隔离 + version 自增。
"""

import pytest

from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, Forbidden, NotFound

from manager_service.employee_config_repository import EmployeeConfigRow
from manager_service.employee_config_service import EmployeeConfigService
from manager_service.schemas import EmployeeConfigIn, EmployeeConfigOut


# ---- Pi 会话策略（D16：不配置底层执行器）----


def test_execution_policy_is_neutral_session_limit():
    from shared.contracts.snapshot import ExecutionPolicy

    config = EmployeeConfigIn(display_name="x", execution_policy=ExecutionPolicy(timeout_seconds=120))
    assert config.execution_policy.timeout_seconds == 120
    assert not hasattr(config.execution_policy, "binding")


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
            timeout_seconds=kw["timeout_seconds"],
            tools=kw["tools"], skills=kw["skills"], knowledge_refs=kw["knowledge_refs"],
            connector_refs=kw["connector_refs"], memory_policy=kw["memory_policy"], version=1,
            status="draft",
            role_title=kw.get("role_title"),
            department_ids=list(kw.get("department_ids") or []),
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
            timeout_seconds=kw["timeout_seconds"],
            tools=kw["tools"], skills=kw["skills"], knowledge_refs=kw["knowledge_refs"],
            connector_refs=kw["connector_refs"], memory_policy=kw["memory_policy"],
            version=old.version + 1, status=old.status,
            archive_reason=old.archive_reason, archived_at=old.archived_at,
            role_title=kw.get("role_title"),
            department_ids=list(kw["department_ids"]) if kw.get("department_ids") is not None else old.department_ids,
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


def test_department_ids_roundtrip_and_update():
    svc = EmployeeConfigService(_FakeRepo())
    ctx = _ctx("t-a")
    created = svc.create(_ctx("t-a"), _body(department_ids=["d-1", "d-2"]), employee_slug="exp-1")
    assert created.department_ids == ["d-1", "d-2"]

    updated = svc.update(ctx, _body(department_ids=["d-3"]), employee_id=created.employee_id)
    assert updated.department_ids == ["d-3"]


def test_role_title_roundtrip_clear_and_no_permission_alias():
    from pydantic import ValidationError

    svc = EmployeeConfigService(_FakeRepo())
    ctx = _ctx("t-a")
    created = svc.create(ctx, _body(role_title="研究分析师"), employee_slug="researcher")
    assert svc.get(ctx, employee_id=created.employee_id).role_title == "研究分析师"
    assert svc.list_all(ctx)[0].role_title == "研究分析师"
    for body in [_body(role_title=None), _body(role_title="新岗位"), _body()]:
        updated = svc.update(ctx, body, employee_id=created.employee_id)
        assert updated.role_title == body.role_title
    assert EmployeeConfigIn(display_name="x", role_title="岗" * 100).role_title == "岗" * 100
    for value in ["", "岗" * 101, 123]:
        with pytest.raises(ValidationError):
            _body(role_title=value)
    for alias in ["role_name", "position_title"]:
        with pytest.raises(ValidationError):
            _body(**{alias: "不接受别名"})
    for role in ["member", "finance_admin"]:
        with pytest.raises(Forbidden):
            svc.update(_ctx("t-a", [role]), _body(role_title="owner"), employee_id=created.employee_id)
    with pytest.raises(NotFound):
        svc.update(_ctx("t-b"), _body(role_title="其他企业"), employee_id=created.employee_id)


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


def test_model_thinking_level_must_match_operator_capabilities():
    class Operator:
        def list_platform_catalog(self):
            return {
                "models": [{
                    "model": {
                        "provider_id": "p1", "model_id": "minimax-m3", "version": 1,
                        "status": "published",
                        "capabilities": {"reasoning": True, "thinking_levels": ["off", "high"]},
                    },
                    "rate": {"pricing_status": "known"},
                }],
            }

    svc = EmployeeConfigService(_FakeRepo(), Operator())
    body = _body(model_policy={
        "model": "minimax-m3", "provider_ref": "p1",
        "provider_version": 1, "model_version": 1, "thinking_level": "low",
    })
    with pytest.raises(Conflict, match="selected model"):
        svc.create(_ctx("t-a"), body, employee_slug="minimax")

    accepted = svc.create(
        _ctx("t-a"), body.model_copy(update={"model_policy": body.model_policy.model_copy(update={"thinking_level": "high"})}),
        employee_slug="minimax-high",
    )
    assert accepted.model_policy.thinking_level == "high"


def test_thinking_validation_accepts_off_and_maps_capabilities():
    from manager_service.employee_config_service import _validate_thinking_level

    _validate_thinking_level("off", {})
    _validate_thinking_level("high", {"thinking_level_map": {"high": "high", "low": None}})
    with pytest.raises(Conflict, match="does not support thinking"):
        _validate_thinking_level("high", {"reasoning": False})


def test_unopened_model_is_reported_as_not_found():
    class Operator:
        def list_platform_catalog(self, *, tenant_id):
            assert tenant_id == "t-a"
            return {
                "model_access_configured": True,
                "models": [{
                    "model": {
                        "provider_id": "p1", "model_id": "allowed", "version": 1,
                        "status": "published", "capabilities": {"thinking_levels": ["off"]},
                    },
                    "rate": {"pricing_status": "known"},
                }],
            }

    svc = EmployeeConfigService(_FakeRepo(), Operator())
    body = _body(model_policy={
        "model": "blocked", "provider_ref": "p1",
        "provider_version": 1, "model_version": 1,
    })
    with pytest.raises(NotFound, match="platform model not found"):
        svc.create(_ctx("t-a"), body, employee_slug="blocked")


def test_model_access_resolver_rejects_unopened_model():
    class Operator:
        def list_platform_catalog(self, *, tenant_id):
            assert tenant_id == "t-a"
            return {
                "models": [{
                    "model": {
                        "provider_id": "p1", "model_id": "allowed", "version": 1,
                        "status": "published", "capabilities": {"thinking_levels": ["off"]},
                    },
                    "rate": {"pricing_status": "known"},
                }],
            }

        def resolve_tenant_access(self, **kwargs):
            assert kwargs == {"tenant_id": "t-a", "provider_id": "p1", "model_ids": ["allowed"]}
            return {"access": {"allowed_model_ids": []}}

    svc = EmployeeConfigService(_FakeRepo(), Operator())
    body = _body(model_policy={
        "model": "allowed", "provider_ref": "p1",
        "provider_version": 1, "model_version": 1,
    })
    with pytest.raises(NotFound, match="platform model not found"):
        svc.create(_ctx("t-a"), body, employee_slug="blocked")


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
