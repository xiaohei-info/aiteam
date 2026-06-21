"""EmployeeExecutionSnapshot 生成验收（M7，04 §6.2/§6.3 / 05 F11/F16，D5/D22）。

非 integration（默认门必跑，不依赖 PG）：
- 成员级授权（04 §6.2 / 05 F16）：未 grant 的 member → 403；已 grant（直接成员/经部门）→ 200；
  owner/enterprise_admin 豁免 → 200。
- 正常派生：employee 配置 → 正确映射为 EmployeeExecutionSnapshot 各字段。
- 不存在的 employee → NotFound（404）；版本不符 → NotFound（404）。
- 幂等：同 (employee_id, version) 多次生成得同一 snapshot_version 与内容。
- 租户隔离：A 租户不能生成 B 租户 employee 的快照（经 TenantContext，非手写过滤）。
- 只读红线：SnapshotService 不暴露任何写 employee 主数据的能力（D5）。

业务编排经内存伪 repository/service（与 test_employee_config / test_member_grant 风格一致），
从 service 层验证 D22 隔离语义 + 成员级授权。HTTP 端到端见 test_snapshot_e2e。
"""

import pytest

from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, NotFound

from manager_service.employee_config_service import EmployeeConfigService
from manager_service.repository_member import GrantRow, MemberRow
from manager_service.schemas import EmployeeConfigIn
from manager_service.snapshot_service import SnapshotService

from .test_employee_config import _FakeRepo


# ---- 内存伪 grant / member service（按 tenant 分桶，模拟 RLS 跨租户不可见）----


class _FakeGrantService:
    """伪 GrantService：暴露 list_grants_by_resource，按 tenant_id 分桶。"""

    def __init__(self):
        # tenant_id -> resource_id -> GrantRow
        self._store: dict[str, dict[str, GrantRow]] = {}

    def set_grant(self, tenant_id: str, resource_id: str, *, member_ids=None, department_ids=None):
        self._store.setdefault(tenant_id, {})[resource_id] = GrantRow(
            id="g-" + resource_id, resource_type="expert", resource_id=resource_id,
            department_ids=list(department_ids or []), member_ids=list(member_ids or []),
        )

    def list_grants_by_resource(self, ctx: TenantContext, resource_type: str, resource_id: str):
        assert resource_type == "expert"
        row = self._store.get(ctx.tenant_id, {}).get(resource_id)
        return [row] if row is not None else []

    def list_grants(self, ctx: TenantContext):
        return list(self._store.get(ctx.tenant_id, {}).values())


class _FakeMemberService:
    """伪 MemberDeptService：暴露 get_member，按 tenant_id 分桶。"""

    def __init__(self):
        self._store: dict[str, dict[str, MemberRow]] = {}

    def set_member(self, tenant_id: str, member_id: str, *, department_ids=None):
        self._store.setdefault(tenant_id, {})[member_id] = MemberRow(
            id=member_id, display_name="m", status="active",
            roles=["member"], department_ids=list(department_ids or []),
        )

    def get_member(self, ctx: TenantContext, member_id: str):
        row = self._store.get(ctx.tenant_id, {}).get(member_id)
        if row is None:
            raise NotFound("member not found")
        return row


class _FakeAuditRecorder:
    """伪 enterprise_audit 写入口：记录 record() 调用入参，供越权审计断言。"""

    def __init__(self):
        self.records: list[dict] = []

    def record(self, ctx, *, actor, action, resource_type=None, resource_id=None, detail=None):
        self.records.append({
            "tenant_id": ctx.tenant_id, "actor": actor, "action": action,
            "resource_type": resource_type, "resource_id": resource_id, "detail": detail,
        })


def _ctx(tid: str, roles=None, user_id="u-1") -> TenantContext:
    return TenantContext(tenant_id=tid, user_id=user_id, roles=roles or ["member"])


def _full_body() -> EmployeeConfigIn:
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy

    return EmployeeConfigIn(
        display_name="专家A",
        persona="你是一名资深测试专家",
        model_policy=ModelPolicy(model="claude-opus-4-8", provider_ref="relay-default", thinking_level="high"),
        runtime_policy=RuntimePolicy(runtime_binding="hermes_acp", timeout_seconds=120),
        tools=["search"],
        skills=["code-review"],
        knowledge_refs=["ks_default"],
        connector_refs=["slack"],
        memory_policy={"seed": "记住用户偏好"},
    )


def _services() -> tuple[EmployeeConfigService, _FakeGrantService, _FakeMemberService, SnapshotService]:
    config_svc = EmployeeConfigService(_FakeRepo())
    grant_svc = _FakeGrantService()
    member_svc = _FakeMemberService()
    snap_svc = SnapshotService(
        config_service=config_svc, grant_service=grant_svc, member_service=member_svc
    )
    return config_svc, grant_svc, member_svc, snap_svc


# ---- 成员级授权（04 §6.2 / 05 F16）----


def test_unauthorized_member_is_forbidden():
    """未被 grant 该专家的 member → 403（不可拉取执行配置）。"""
    config_svc, _grant, member_svc, snap_svc = _services()
    ctx = _ctx("t-a", roles=["member"], user_id="m-1")
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    member_svc.set_member("t-a", "m-1")  # 成员存在但无 grant

    with pytest.raises(Forbidden):
        snap_svc.generate(ctx, member_id="m-1", employee_id=created.employee_id)


# ---- 越权审计（05 F16）：越权 403 时记 enterprise_audit ----


def test_unauthorized_pull_records_audit():
    """越权拉取被 403 拦截时记一条 enterprise_audit（actor/resource/拒因，不含配置内容）。"""
    config_svc = EmployeeConfigService(_FakeRepo())
    grant_svc = _FakeGrantService()
    member_svc = _FakeMemberService()
    audit = _FakeAuditRecorder()
    snap_svc = SnapshotService(
        config_service=config_svc, grant_service=grant_svc,
        member_service=member_svc, audit_recorder=audit,
    )
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    member_svc.set_member("t-a", "m-1")  # 成员存在但无 grant

    with pytest.raises(Forbidden):
        snap_svc.generate(_ctx("t-a", roles=["member"], user_id="m-1"),
                          member_id="m-1", employee_id=created.employee_id)

    assert len(audit.records) == 1
    rec = audit.records[0]
    assert rec["tenant_id"] == "t-a"
    assert rec["actor"] == "m-1"
    assert rec["action"] == "snapshot_pull_denied"
    assert rec["resource_type"] == "expert"
    assert rec["resource_id"] == created.employee_id
    # 红线：审计记录不得含任何执行配置内容（persona/model/skills 等，D13）。
    blob = repr(rec).lower()
    for leak in ("资深测试专家", "claude-opus", "code-review", "relay-default", "记住用户偏好"):
        assert leak.lower() not in blob


def test_audit_failure_does_not_mask_forbidden():
    """审计写失败（best-effort）不得淹没原始 403：record 抛异常时仍 raises(Forbidden)。"""
    config_svc = EmployeeConfigService(_FakeRepo())
    grant_svc = _FakeGrantService()
    member_svc = _FakeMemberService()

    class _BoomRecorder:
        def record(self, *a, **k):
            raise RuntimeError("audit DB down")

    snap_svc = SnapshotService(
        config_service=config_svc, grant_service=grant_svc,
        member_service=member_svc, audit_recorder=_BoomRecorder(),
    )
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    member_svc.set_member("t-a", "m-1")  # 成员存在但无 grant

    with pytest.raises(Forbidden):
        snap_svc.generate(_ctx("t-a", roles=["member"], user_id="m-1"),
                          member_id="m-1", employee_id=created.employee_id)


def test_missing_member_404_records_no_audit():
    """member 不存在 → 404（NotFound，非越权）且不写审计（审计只记真正的 403 越权）。"""
    config_svc = EmployeeConfigService(_FakeRepo())
    grant_svc = _FakeGrantService()
    member_svc = _FakeMemberService()
    audit = _FakeAuditRecorder()
    snap_svc = SnapshotService(
        config_service=config_svc, grant_service=grant_svc,
        member_service=member_svc, audit_recorder=audit,
    )
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    # 该专家有 grant（指向别的 member），但请求的 member 在 member 表不存在 → get_member 抛 404
    grant_svc.set_grant("t-a", created.employee_id, member_ids=["someone"])

    with pytest.raises(NotFound):
        snap_svc.generate(_ctx("t-a", roles=["member"], user_id="ghost"),
                          member_id="ghost", employee_id=created.employee_id)
    assert audit.records == []


def test_authorized_pull_records_no_audit():
    """正常授权拉取（200）不产生越权审计。"""
    config_svc = EmployeeConfigService(_FakeRepo())
    grant_svc = _FakeGrantService()
    member_svc = _FakeMemberService()
    audit = _FakeAuditRecorder()
    snap_svc = SnapshotService(
        config_service=config_svc, grant_service=grant_svc,
        member_service=member_svc, audit_recorder=audit,
    )
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    member_svc.set_member("t-a", "m-1")
    grant_svc.set_grant("t-a", created.employee_id, member_ids=["m-1"])

    snap_svc.generate(_ctx("t-a", roles=["member"], user_id="m-1"),
                      member_id="m-1", employee_id=created.employee_id)
    assert audit.records == []


def test_admin_exempt_pull_records_no_audit():
    """owner/enterprise_admin 豁免授权（200），不产生越权审计。"""
    config_svc = EmployeeConfigService(_FakeRepo())
    audit = _FakeAuditRecorder()
    snap_svc = SnapshotService(
        config_service=config_svc, grant_service=_FakeGrantService(),
        member_service=_FakeMemberService(), audit_recorder=audit,
    )
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    snap_svc.generate(_ctx("t-a", roles=["owner"], user_id="admin-1"),
                      member_id="admin-1", employee_id=created.employee_id)
    assert audit.records == []


def test_directly_granted_member_can_generate():
    """member 直接在 grant.member_ids → 200 拿到快照。"""
    config_svc, grant_svc, member_svc, snap_svc = _services()
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    member_svc.set_member("t-a", "m-1")
    grant_svc.set_grant("t-a", created.employee_id, member_ids=["m-1"])

    snap = snap_svc.generate(_ctx("t-a", roles=["member"], user_id="m-1"),
                             member_id="m-1", employee_id=created.employee_id)
    assert snap.employee_id == created.employee_id


def test_department_granted_member_can_generate():
    """member 所属部门 ∈ grant.department_ids → 200。"""
    config_svc, grant_svc, member_svc, snap_svc = _services()
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    member_svc.set_member("t-a", "m-1", department_ids=["d-eng"])
    grant_svc.set_grant("t-a", created.employee_id, department_ids=["d-eng"])

    snap = snap_svc.generate(_ctx("t-a", roles=["member"], user_id="m-1"),
                             member_id="m-1", employee_id=created.employee_id)
    assert snap.employee_id == created.employee_id


@pytest.mark.parametrize("role", ["owner", "enterprise_admin"])
def test_admin_roles_exempt_from_grant(role):
    """owner/enterprise_admin 豁免成员级 grant（03 §9.7），无 grant 也能拉。"""
    config_svc, _grant, _member, snap_svc = _services()
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    # 不设 member、不设 grant，管理角色应直接放行
    snap = snap_svc.generate(_ctx("t-a", roles=[role], user_id="admin-1"),
                             member_id="admin-1", employee_id=created.employee_id)
    assert snap.employee_id == created.employee_id


# ---- 正常派生：employee 配置 → EmployeeExecutionSnapshot 全字段映射 ----


def test_generate_maps_all_fields():
    config_svc, grant_svc, member_svc, snap_svc = _services()
    created = config_svc.create(_ctx("t-a", roles=["owner"]), _full_body(), employee_slug="exp-a")
    member_svc.set_member("t-a", "m-1")
    grant_svc.set_grant("t-a", created.employee_id, member_ids=["m-1"])

    snap = snap_svc.generate(_ctx("t-a", roles=["member"], user_id="m-1"),
                             member_id="m-1", employee_id=created.employee_id)

    assert isinstance(snap, EmployeeExecutionSnapshot)
    assert snap.employee_id == created.employee_id
    assert snap.version == str(created.version)  # "1"
    assert snap.display_name == "专家A"
    assert snap.persona == "你是一名资深测试专家"
    assert snap.model_policy.model == "claude-opus-4-8"
    assert snap.model_policy.provider_ref == "relay-default"
    assert snap.model_policy.thinking_level == "high"
    assert snap.runtime_policy.runtime_binding == "hermes_acp"
    assert snap.runtime_policy.timeout_seconds == 120
    assert snap.tools == ["search"]
    assert snap.skills == ["code-review"]
    assert snap.knowledge_refs == ["ks_default"]
    assert snap.connector_refs == ["slack"]
    assert snap.memory_policy == {"seed": "记住用户偏好"}
    assert snap.snapshot_version  # 非空


def test_generate_with_explicit_matching_version():
    config_svc, _grant, _member, snap_svc = _services()
    ctx = _ctx("t-a", roles=["owner"], user_id="admin-1")
    created = config_svc.create(ctx, _full_body(), employee_slug="exp-a")

    snap = snap_svc.generate(ctx, member_id="admin-1", employee_id=created.employee_id, employee_version="1")
    assert snap.version == "1"


# ---- 缺失/版本不符 → 404（管理角色绕过授权门，验配置缺失语义）----


def test_generate_missing_employee_raises_404():
    _config, _grant, _member, snap_svc = _services()
    with pytest.raises(NotFound):
        snap_svc.generate(_ctx("t-a", roles=["owner"], user_id="admin-1"),
                          member_id="admin-1", employee_id="does-not-exist")


def test_generate_mismatched_version_raises_404():
    """请求版本与当前配置版本不符 → 404（旧版本不保留，无法重建快照）。"""
    config_svc, _grant, _member, snap_svc = _services()
    ctx = _ctx("t-a", roles=["owner"], user_id="admin-1")
    created = config_svc.create(ctx, _full_body(), employee_slug="exp-a")
    with pytest.raises(NotFound):
        snap_svc.generate(ctx, member_id="admin-1", employee_id=created.employee_id, employee_version="99")


# ---- 幂等：同 (employee_id, version) 多次生成同 snapshot_version 与内容 ----


def test_generate_is_idempotent():
    config_svc, _grant, _member, snap_svc = _services()
    ctx = _ctx("t-a", roles=["owner"], user_id="admin-1")
    created = config_svc.create(ctx, _full_body(), employee_slug="exp-a")

    s1 = snap_svc.generate(ctx, member_id="admin-1", employee_id=created.employee_id)
    s2 = snap_svc.generate(ctx, member_id="admin-1", employee_id=created.employee_id)
    assert s1.snapshot_version == s2.snapshot_version
    assert s1.model_dump() == s2.model_dump()


def test_snapshot_version_changes_with_config_content():
    """配置内容变更（version 自增）→ snapshot_version 变更（对账可追溯）。"""
    config_svc, _grant, _member, snap_svc = _services()
    ctx = _ctx("t-a", roles=["owner"], user_id="admin-1")
    created = config_svc.create(ctx, _full_body(), employee_slug="exp-a")
    v1 = snap_svc.generate(ctx, member_id="admin-1", employee_id=created.employee_id).snapshot_version

    config_svc.update(ctx, _full_body().model_copy(update={"display_name": "改名"}), employee_id=created.employee_id)
    v2 = snap_svc.generate(ctx, member_id="admin-1", employee_id=created.employee_id).snapshot_version
    assert v1 != v2


# ---- 租户隔离：A 不能生成 B 的快照（经 TenantContext / RLS 语义）----


def test_cross_tenant_snapshot_isolated():
    config_svc, _grant, _member, snap_svc = _services()
    ctx_a = _ctx("t-a", roles=["owner"], user_id="admin-a")
    ctx_b = _ctx("t-b", roles=["owner"], user_id="admin-b")
    created = config_svc.create(ctx_a, _full_body(), employee_slug="exp-a")

    # B 租户用 A 的 employee_id 生成快照 → 经 TenantContext 隔离，看不到 → 404
    with pytest.raises(NotFound):
        snap_svc.generate(ctx_b, member_id="admin-b", employee_id=created.employee_id)

    # A 仍能正常生成
    assert snap_svc.generate(ctx_a, member_id="admin-a",
                             employee_id=created.employee_id).employee_id == created.employee_id


# ---- 只读红线（D5）：SnapshotService 无任何修改 employee 主数据的能力 ----


def test_snapshot_service_has_no_write_methods():
    write_like = {"create", "update", "delete", "save", "set", "write"}
    methods = {m for m in dir(SnapshotService) if not m.startswith("_")}
    assert not (methods & write_like), f"SnapshotService 暴露了写能力: {methods & write_like}"
    assert methods == {"generate"}, f"SnapshotService 应只暴露 generate，实际: {methods}"
