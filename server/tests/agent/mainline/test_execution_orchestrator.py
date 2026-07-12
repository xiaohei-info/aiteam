"""AITEAM-689 (M1) 验收：统一执行编排 + snapshot_to_runspec 派生。

覆盖：
- snapshot_to_runspec 正确映射 persona/model/provider_ref/thinking_level/timeout；
- 不支持的快照字段（skills/knowledge/connector/memory）显式降级（记录在 degraded 列表），
  不能静默丢弃；
- prepare_private_run：在线冻结快照并派生 RunSpec，标记 snapshot_source=frozen；
- Manager 离线时 fallback 到最近冻结快照，标记 snapshot_source=fallback；
- 无 entry_employee_id 时 prepare_private_run 抛明确错误；
- prepare_group_run 按被 @ 专家逐个派生。
"""

import asyncio

import pytest

from agent_service.mainline.execution_orchestrator import (
    ExecutionOrchestrator,
    RunSpecDerivation,
    SnapshotSource,
    snapshot_to_runspec,
)
from shared.contracts.snapshot import EmployeeExecutionSnapshot, ModelPolicy, RuntimePolicy
from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.runspec import RunSpec


def _snapshot(
    employee_id="emp-1",
    version="v2",
    snapshot_version="snap-9",
    persona="严谨后端工程师",
    model="hermes-default",
    provider_ref="relay",
    thinking_level="deep",
    timeout=120,
    skills=("code-review",),
    knowledge=("kb-backend",),
    connectors=("slack",),
    memory=None,
) -> EmployeeExecutionSnapshot:
    return EmployeeExecutionSnapshot(
        employee_id=employee_id, version=version, snapshot_version=snapshot_version,
        display_name=f"专家-{employee_id}", persona=persona,
        model_policy=ModelPolicy(model=model, provider_ref=provider_ref, thinking_level=thinking_level),
        runtime_policy=RuntimePolicy(timeout_seconds=timeout),
        skills=list(skills), knowledge_refs=list(knowledge), connector_refs=list(connectors),
        memory_policy=memory or {"seed": "偏好"},
    )


def test_snapshot_to_runspec_maps_core_fields():
    snap = _snapshot()
    d = snapshot_to_runspec(snap)
    assert isinstance(d, RunSpecDerivation)
    spec = d.spec
    assert spec.system_prompt == "严谨后端工程师"
    assert spec.model == "hermes-default"
    assert spec.provider_ref == "relay"
    assert spec.thinking_level == "deep"
    assert spec.timeout_seconds == 120


def test_snapshot_to_runspec_explicitly_lists_unsupported_fields_rather_than_silently_dropping():
    """M1 架构边界：不支持的快照字段必须显式降级/记录，不能静默丢弃。"""
    snap = _snapshot()
    d = snapshot_to_runspec(snap)
    degraded = d.degraded
    assert "skills" in degraded
    assert "knowledge_refs" in degraded
    assert "connector_refs" in degraded
    assert "memory_policy" in degraded
    assert d.snapshot.employee_id == "emp-1"


def test_snapshot_to_runspec_minimal_snapshot():
    snap = EmployeeExecutionSnapshot(
        employee_id="emp-x", version="v1", snapshot_version="snap-1",
    )
    d = snapshot_to_runspec(snap)
    assert d.spec.system_prompt is None
    assert d.spec.model is None
    assert d.spec.provider_ref is None
    assert d.spec.thinking_level is None
    assert d.spec.timeout_seconds is None
    assert d.degraded == []


# ---- Orchestration ----

class FrozenGrantsClient:
    """可编排的 Manager pull 对端：按 employee_id 返回快照；可切换为不可达。"""

    def __init__(self) -> None:
        self.snapshots: dict[str, EmployeeExecutionSnapshot] = {}
        self.unreachable = False
        self.frozen_calls: list[str] = []

    def pull_authorized_config(self, request=None):
        from shared.contracts.crosstier import AuthorizedConfigPullRequest, AuthorizedConfigPullResponse
        return AuthorizedConfigPullResponse()

    def pull_snapshot(self, request):
        from shared.contracts.crosstier import SnapshotPullResponse
        self.frozen_calls.append(request.employee_id)
        if self.unreachable:
            raise RuntimeError("manager unreachable")
        return SnapshotPullResponse(snapshot=self.snapshots[request.employee_id])


class FakeGrantsService:
    """用 GrantsService 的投影/冻结仓储适配器：给 orchestrator 提供 projections/snapshots。"""

    def __init__(self) -> None:
        from agent_service.grants.store import (
            InMemoryProjectionRepository, InMemorySnapshotRepository,
        )
        from agent_service.grants.service import GrantsService
        self._client = FrozenGrantsClient()
        self._svc = GrantsService(
            client=self._client,  # type: ignore[arg-type]
            projections=InMemoryProjectionRepository(),
            snapshots=InMemorySnapshotRepository(),
        )

    @property
    def projections(self):
        return self._svc._projections

    @property
    def snapshots(self):
        return self._svc._snapshots

    @property
    def client(self):
        return self._client

    def freeze_snapshot(self, tenant_id, member_id, employee_id, version=None):
        return self._svc.freeze_snapshot(tenant_id, member_id, employee_id, version)

    def available_experts(self):
        return self._svc.available_experts()

    def load_snapshot(self, eid, sv):
        return self._svc.load_snapshot(eid, sv)

    def latest_snapshot(self, eid):
        return self._svc.latest_snapshot(eid)


def _make_projection(emp_id="emp-1", version="v2") -> LoadedExpertProjection:
    return LoadedExpertProjection(
        employee_id=emp_id, tenant_id="t1", version=version, display_name=f"专家{emp_id}",
    )


def _orchestrator(emp_id="emp-1", version="v2", provider_ref="relay"):
    grants = FrozenGrantsClient()
    snap = _snapshot(employee_id=emp_id, version=version, provider_ref=provider_ref)
    grants.snapshots[emp_id] = snap
    gs = FakeGrantsService()
    gs.client.snapshots[emp_id] = snap
    gs._svc._client.snapshots[emp_id] = snap  # sync onto inner grants service client
    proj = _make_projection(emp_id, version)
    gs.projections.upsert(proj)
    orch = ExecutionOrchestrator(
        grants=gs._svc,
        projections=gs.projections,
        tenant_id="t1", member_id="m1",
    )
    return orch, gs


class _Conv:
    def __init__(self, entry_employee_id=None):
        self.entry_employee_id = entry_employee_id


def test_prepare_private_run_online_freezes_and_marks_frozen():
    orch, gs = _orchestrator(provider_ref=None)
    prepared = orch.prepare_private_run(_Conv(entry_employee_id="emp-1"), tenant_id="t1")
    assert prepared.run_spec.system_prompt == "严谨后端工程师"
    assert prepared.run_spec.model == "hermes-default"
    assert prepared.binding.employee_id == "emp-1"
    assert prepared.binding.snapshot_version == "snap-9"
    assert prepared.binding.snapshot_source == SnapshotSource.FROZEN
    assert prepared.binding.skill_refs == ["code-review"]
    # 在本地仓储中确实冻结了该版本
    assert gs.snapshots.get("emp-1", "snap-9") is not None


def test_prepare_private_run_falls_back_when_manager_unreachable():
    orch, gs = _orchestrator(provider_ref=None)
    # 预先冻结一个旧快照作为 fallback
    old = _snapshot(employee_id="emp-1", version="v1", snapshot_version="snap-5", persona="旧版persona")
    gs.snapshots.freeze(old)
    # 切换为不可达
    gs.client.unreachable = True
    prepared = orch.prepare_private_run(_Conv(entry_employee_id="emp-1"), tenant_id="t1")
    assert prepared.binding.snapshot_source == SnapshotSource.FALLBACK
    assert prepared.binding.snapshot_version == "snap-5"
    assert prepared.run_spec.system_prompt == "旧版persona"


def test_prepare_private_run_raises_when_no_both_online_and_frozen():
    """在线不可达且无任何已冻结快照 → 明确报错（无配置错误才走 fallback）。"""
    from agent_service.mainline.execution_orchestrator import NoSnapshotAvailable
    orch, gs = _orchestrator(provider_ref=None)
    gs.client.unreachable = True
    # 不预冻结
    with pytest.raises(NoSnapshotAvailable):
        orch.prepare_private_run(_Conv(entry_employee_id="emp-1"), tenant_id="t1")


def test_prepare_private_run_requires_employee_binding():
    """无 entry_employee_id → 明确拒绝（M1：无绑定专家时报错或走默认助手；默认助手在 start_run 层处理）。"""
    from agent_service.mainline.execution_orchestrator import NoSnapshotAvailable
    orch, _ = _orchestrator()
    with pytest.raises(NoSnapshotAvailable):
        orch.prepare_private_run(_Conv(entry_employee_id=None), tenant_id="t1")


def test_prepare_group_run_derives_per_mentioned_expert():
    orch, gs = _orchestrator(provider_ref=None)
    # 第二个专家
    snap2 = _snapshot(employee_id="emp-2", version="v3", snapshot_version="snap-12", persona="前端专家", model="gpt-5")
    gs.client.snapshots["emp-2"] = snap2
    gs._svc._client.snapshots["emp-2"] = snap2
    gs.projections.upsert(_make_projection("emp-2", "v3"))
    results = orch.prepare_group_run(mentioned_employee_ids=["emp-1", "emp-2"], tenant_id="t1")
    assert [r.binding.employee_id for r in results] == ["emp-1", "emp-2"]
    assert results[1].run_spec.system_prompt == "前端专家"
    assert results[1].run_spec.model == "gpt-5"


def test_start_run_auto_derives_for_private_chat_when_orchestrator_present():
    """M1 #3：私聊 start_run 自动据 entry_employee_id 派生 RunSpec 并绑定 Run。"""
    from agent_service.mainline.factory import build_mainline_service
    from agent_service.mainline.models import RunStatus

    orch, gs = _orchestrator(provider_ref=None)
    svc = build_mainline_service(orchestrator=orch)
    conv = svc.create_conversation(entry_employee_id="emp-1", title="与专家对话")
    run = asyncio.run(svc.start_run(conv.id))
    assert run.employee_id == "emp-1"
    assert run.snapshot_version == "snap-9"
    assert run.snapshot_source == SnapshotSource.FROZEN
    assert run.skill_refs == ["code-review"]


def test_private_chat_auto_derive_end_to_end_with_fallback():
    """端到端：私聊主链在 Manager 不可达时 fallback 到最近冻结快照并标记 fallback。"""
    from agent_service.mainline.factory import build_mainline_service
    from agent_service.mainline.models import RunStatus

    orch, gs = _orchestrator(provider_ref=None)
    # 预冻结一个快照用作 fallback
    fb = _snapshot(employee_id="emp-1", version="v0", snapshot_version="snap-fb", persona="fallback persona", provider_ref=None)
    gs.snapshots.freeze(fb)
    gs.client.unreachable = True

    svc = build_mainline_service(orchestrator=orch)
    conv = svc.create_conversation(entry_employee_id="emp-1", title="私聊")
    run = asyncio.run(svc.start_run(conv.id))
    assert run.employee_id == "emp-1"
    assert run.snapshot_version == "snap-fb"
    assert run.snapshot_source == SnapshotSource.FALLBACK
    assert run.status in {RunStatus.SUCCEEDED, RunStatus.FAILED}

    # 元数据可追溯：通过 get_run 二次读取
    persisted = svc.get_run(run.id)
    assert persisted.snapshot_source == "fallback"
    assert persisted.snapshot_version == "snap-fb"
