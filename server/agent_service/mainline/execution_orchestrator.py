"""专家快照驱动的统一执行编排（AITEAM-689 / M1）。

职责（M1 #1/#2）：
- 私聊：据会话 entry_employee_id 冻结/复用专家快照，派生 RunSpec + 绑定元数据；
- 群聊：按被 @ 专家逐个冻结/复用快照，派生各自的 RunSpec + 绑定元数据；
- Manager 在线时经 GrantsService.freeze_snapshot 冻结；不可达时 fallback 到最近已冻结快照，
  并标记 snapshot_source=fallback（D14 离线降级）；
- 无快照可用时明确报错（NoSnapshotAvailable），不回退到未知配置。

架构边界（M1）：
- Manager 是配置真相源；Agent 只读投影 + 本地冻结快照。
- 不支持的快照字段（skills/knowledge_refs/connector_refs/memory_policy）**显式降级**：
  记录在 RunSpecDerivation.degraded 列表，不静默丢弃；M2/M3 装配时再消费。
- 前端传入的 model/system_prompt/runtime 不作为权威配置（由 start_run 层保证）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from shared.contracts.runspec import RunSpec
from shared.contracts.snapshot import EmployeeExecutionSnapshot

if TYPE_CHECKING:
    from agent_service.grants.service import GrantsService
    from agent_service.grants.store import ProjectionRepository


class SnapshotSource:
    """快照来源标记（M1 #5：run 记录可追溯快照来源）。"""

    FROZEN = "frozen"      # 在线冻结（Manager 可达，按 employee_id+version 拉取并冻结）
    FALLBACK = "fallback"  # Manager 不可达，回退到最近已冻结快照（D14）
    NONE = "none"          # 未绑定快照


# 快照中 M1 不装配到 RunSpec 的字段（M2/M3 装配）。显式列出，避免静默丢弃。
_UNSUPPORTED_SNAPSHOT_FIELDS = ("skills", "knowledge_refs", "connector_refs", "memory_policy")


class NoSnapshotAvailable(Exception):
    """无可用专家快照：在线不可达且无已冻结快照，或会话未绑定专家。"""


@dataclass
class RunSpecDerivation:
    """snapshot_to_runspec 的产出：派生出的中立 RunSpec + 显式降级字段记录。"""

    spec: RunSpec
    degraded: list[str] = field(default_factory=list)
    snapshot: EmployeeExecutionSnapshot | None = None


def snapshot_to_runspec(snapshot: EmployeeExecutionSnapshot) -> RunSpecDerivation:
    """把 EmployeeExecutionSnapshot 派生为中立 RunSpec（M1 #2）。

    映射：
      persona -> RunSpec.system_prompt
      model_policy.model -> RunSpec.model
      model_policy.provider_ref -> RunSpec.provider_ref
      model_policy.thinking_level -> RunSpec.thinking_level
      runtime_policy.timeout_seconds -> RunSpec.timeout_seconds

    不支持字段（skills/knowledge_refs/connector_refs/memory_policy）不静默丢弃，
    记录在 degraded 列表由调用方/后续 M2/M3 处理。
    """
    degraded: list[str] = []
    for fname in _UNSUPPORTED_SNAPSHOT_FIELDS:
        value = getattr(snapshot, fname, None)
        if fname == "memory_policy":
            if value not in (None, {}):
                degraded.append(fname)
        else:
            if value:
                degraded.append(fname)

    spec = RunSpec(
        system_prompt=snapshot.persona,
        model=snapshot.model_policy.model,
        provider_ref=snapshot.model_policy.provider_ref,
        thinking_level=snapshot.model_policy.thinking_level,
        timeout_seconds=snapshot.runtime_policy.timeout_seconds,
    )
    return RunSpecDerivation(spec=spec, degraded=degraded, snapshot=snapshot)


@dataclass
class PreparedRun:
    """一次 run 的准备结果：中立 RunSpec + 落到 Run 记录的绑定元数据。"""

    run_spec: RunSpec
    binding: "RunBindingView"


@dataclass
class RunBindingView:
    """Run 记录绑定的快照元数据（与 service.RunBinding 同形，避免反向依赖）。"""

    employee_id: str | None = None
    snapshot_version: str | None = None
    snapshot_source: str = SnapshotSource.NONE
    runtime: str | None = None
    provider_ref: str | None = None
    skill_refs: list[str] = field(default_factory=list)


class _ConversationLike(Protocol):
    entry_employee_id: str | None


class ExecutionOrchestrator:
    """统一执行编排（M1 #1）。"""

    def __init__(
        self,
        *,
        grants: "GrantsService",
        projections: "ProjectionRepository",
        tenant_id: str = "local",
        member_id: str = "local",
    ) -> None:
        self._grants = grants
        self._projections = projections
        self._tenant_id = tenant_id
        self._member_id = member_id

    def prepare_private_run(
        self,
        conversation: _ConversationLike,
        *,
        tenant_id: str | None = None,
    ) -> PreparedRun:
        """私聊主链收口（M1 #3）：据会话 entry_employee_id 派生 RunSpec + 绑定。"""
        employee_id = (conversation.entry_employee_id or "").strip()
        if not employee_id:
            raise NoSnapshotAvailable(
                "private run requires a bound expert (conversation.entry_employee_id)"
            )
        return self._prepare_one(employee_id, tenant_id=tenant_id or self._tenant_id)

    def prepare_group_run(
        self,
        mentioned_employee_ids: list[str],
        *,
        tenant_id: str | None = None,
    ) -> list[PreparedRun]:
        """群聊主链收口（M1 #4）：按被 @ 专家逐个派生 RunSpec + 绑定。"""
        effective_tenant = tenant_id or self._tenant_id
        return [self._prepare_one(eid.strip(), tenant_id=effective_tenant)
                for eid in mentioned_employee_ids if eid and eid.strip()]

    def _prepare_one(self, employee_id: str, *, tenant_id: str) -> PreparedRun:
        projection = self._projections.get(employee_id)
        version = projection.version if projection else None

        snapshot, source = self._resolve_snapshot(employee_id, version=version)
        derivation = snapshot_to_runspec(snapshot)
        binding = RunBindingView(
            employee_id=snapshot.employee_id,
            snapshot_version=snapshot.snapshot_version,
            snapshot_source=source,
            runtime=snapshot.runtime_policy.runtime_binding,
            provider_ref=snapshot.model_policy.provider_ref,
            skill_refs=list(snapshot.skills),
        )
        return PreparedRun(run_spec=derivation.spec, binding=binding)

    def _resolve_snapshot(
        self, employee_id: str, version: str | None
    ) -> tuple[EmployeeExecutionSnapshot, str]:
        """在线冻结优先；不可达则 fallback 到最近已冻结快照（D14）。"""
        try:
            snapshot = self._grants.freeze_snapshot(
                tenant_id=self._tenant_id,
                member_id=self._member_id,
                employee_id=employee_id,
                employee_version=version,
            )
            return snapshot, SnapshotSource.FROZEN
        except Exception:
            # Manager 不可达 → 回退到最近已冻结快照（D14 离线降级）。
            fallback = self._grants.latest_snapshot(employee_id)
            if fallback is not None:
                return fallback, SnapshotSource.FALLBACK
        raise NoSnapshotAvailable(
            f"no snapshot available for expert {employee_id!r}: "
            "Manager unreachable and no locally-frozen snapshot"
        )
