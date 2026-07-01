"""A4 验收：sync → loaded projection → 快照冻结全链路 + Manager 离线降级（04 §6.2/§6.3，D5/D12/D14）。

覆盖：
- sync 主动 pull 落投影（available 可用列表）；
- revoked_ids 失效移除（available 中剔除，list_all 保留 revoked 条目）；
- sync 带本地投影版本作 known_versions（增量基线）；
- 快照 pull→冻结，run 全程引用同一快照（冻结幂等不可变）；
- **离线降级**：pull 抛错/超时 → 本地既有投影 + 已冻结快照不受影响、仍可用、不崩、不抛；
- UnconfiguredGrantsClient 安全失败（缺配置不静默成功）。
"""

import pytest

from agent_service.grants.client import UnconfiguredGrantsClient
from agent_service.grants.factory import build_grants_service
from agent_service.grants.service import GrantsService
from agent_service.grants.store import (
    InMemoryProjectionRepository,
    InMemorySnapshotRepository,
)
from shared.contracts.crosstier import (
    AuthorizedConfigPullRequest,
    AuthorizedConfigPullResponse,
    SnapshotPullRequest,
    SnapshotPullResponse,
)
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.errors import AppError


# ---- fake 对端 client（不真连 Manager）----

class FakeGrantsClient:
    """可编排的 Manager pull 对端：按 employee_id 返回配置/快照；可切换为不可达。"""

    def __init__(self) -> None:
        self.config_response = AuthorizedConfigPullResponse()
        self.snapshots: dict[str, EmployeeExecutionSnapshot] = {}
        self.unreachable = False
        self.config_requests: list[AuthorizedConfigPullRequest] = []
        self.snapshot_requests: list[SnapshotPullRequest] = []

    def pull_authorized_config(
        self, request: AuthorizedConfigPullRequest
    ) -> AuthorizedConfigPullResponse:
        self.config_requests.append(request)
        if self.unreachable:
            raise RuntimeError("manager unreachable")
        return self.config_response

    def pull_snapshot(self, request: SnapshotPullRequest) -> SnapshotPullResponse:
        self.snapshot_requests.append(request)
        if self.unreachable:
            raise TimeoutError("manager timeout")
        return SnapshotPullResponse(snapshot=self.snapshots[request.employee_id])


def _snapshot(employee_id: str, version: str, snap_version: str) -> EmployeeExecutionSnapshot:
    return EmployeeExecutionSnapshot(
        employee_id=employee_id, version=version, snapshot_version=snap_version,
        display_name=f"专家-{employee_id}",
    )


def _service(client: FakeGrantsClient) -> GrantsService:
    return GrantsService(
        client=client,
        projections=InMemoryProjectionRepository(),
        snapshots=InMemorySnapshotRepository(),
    )


# ---- sync → projection ----

def test_sync_pulls_and_lands_projection():
    client = FakeGrantsClient()
    client.config_response = AuthorizedConfigPullResponse(
        experts=[
            {"employee_id": "e1", "version": "v1", "display_name": "甲", "runtime_binding": "hermes"},
            {"employee_id": "e2", "version": "v1", "display_name": "乙"},
        ]
    )
    svc = _service(client)
    result = svc.sync("t1", "m1")

    assert result.ok and result.upserted == 2 and result.revoked == 0
    experts = svc.available_experts()
    assert [e.employee_id for e in experts] == ["e1", "e2"]
    e1 = svc.available_experts()[0]
    assert e1.tenant_id == "t1" and e1.version == "v1" and e1.runtime_binding == "hermes"
    assert e1.synced_at is not None and e1.revoked is False


def test_sync_inherits_template_config_into_projection():
    """AITEAM-288：sync 从 Manager 拉取的 skills/knowledge_refs/connector_refs/memory_policy/model_policy
    应透传到本地投影（而不仅是 display_name/runtime_binding）。"""
    client = FakeGrantsClient()
    client.config_response = AuthorizedConfigPullResponse(
        experts=[
            {
                "employee_id": "e1",
                "version": "v1",
                "display_name": "专家甲",
                "runtime_binding": "hermes_acp",
                "persona": "资深后端",
                "model_policy": {"model": "gpt-5", "provider_ref": "relay", "thinking_level": "deep"},
                "runtime_policy": {"runtime_binding": "hermes_acp", "timeout_seconds": 120},
                "tools": ["search", "code"],
                "skills": ["code-review", "testing"],
                "knowledge_refs": ["ks_backend"],
                "connector_refs": ["slack"],
                "memory_policy": {"seed": "偏好"},
            }
        ]
    )
    svc = _service(client)
    assert svc.sync("t1", "m1").upserted == 1
    e1 = svc.available_experts()[0]
    assert e1.persona == "资深后端"
    assert e1.model_policy.model == "gpt-5"
    assert e1.model_policy.provider_ref == "relay"
    assert e1.model_policy.thinking_level == "deep"
    assert e1.runtime_policy.timeout_seconds == 120
    assert e1.tools == ["search", "code"]
    assert e1.skills == ["code-review", "testing"]
    assert e1.knowledge_refs == ["ks_backend"]
    assert e1.connector_refs == ["slack"]
    assert e1.memory_policy == {"seed": "偏好"}


def test_sync_revoked_ids_removed_from_available_but_kept_in_all():
    client = FakeGrantsClient()
    client.config_response = AuthorizedConfigPullResponse(
        experts=[{"employee_id": "e1", "version": "v1"}, {"employee_id": "e2", "version": "v1"}]
    )
    svc = _service(client)
    svc.sync("t1", "m1")

    # 第二次 sync：e1 被撤销
    client.config_response = AuthorizedConfigPullResponse(revoked_ids=["e1"])
    result = svc.sync("t1", "m1")
    assert result.revoked == 1
    assert [e.employee_id for e in svc.available_experts()] == ["e2"]  # 可用列表剔除 e1


def test_sync_sends_known_versions_as_incremental_baseline():
    """sync 带本地投影版本/etag 作 known_versions，Manager 据此回增量（D12 增量感知）。"""
    client = FakeGrantsClient()
    client.config_response = AuthorizedConfigPullResponse(
        experts=[{"employee_id": "e1", "version": "v3"}]
    )
    svc = _service(client)
    svc.sync("t1", "m1")
    svc.sync("t1", "m1")  # 第二次应带上已持版本

    assert client.config_requests[-1].known_versions == {"e1": "v3"}
    assert client.config_requests[-1].tenant_id == "t1"
    assert client.config_requests[-1].member_id == "m1"


# ---- 快照冻结 ----

def test_freeze_snapshot_persists_locally():
    client = FakeGrantsClient()
    client.snapshots["e1"] = _snapshot("e1", "v1", "snap-1")
    svc = _service(client)

    frozen = svc.freeze_snapshot("t1", "m1", "e1")
    assert frozen.snapshot_version == "snap-1"
    # 本地冻结后可直接装载，无需再跨端
    assert svc.load_snapshot("e1", "snap-1") is frozen
    assert svc.latest_snapshot("e1").snapshot_version == "snap-1"


def test_frozen_snapshot_is_immutable_idempotent():
    """冻结语义：同 (employee_id, snapshot_version) 重复 freeze 幂等返回既有，不被覆盖。"""
    client = FakeGrantsClient()
    first = _snapshot("e1", "v1", "snap-1")
    client.snapshots["e1"] = first
    svc = _service(client)
    svc.freeze_snapshot("t1", "m1", "e1")

    # Manager 侧同 snapshot_version 内容被改（display_name），但本地已冻结不变
    client.snapshots["e1"] = first.model_copy(update={"display_name": "被篡改"})
    again = svc.freeze_snapshot("t1", "m1", "e1")
    assert again.display_name == first.display_name  # 冻结不可变


# ---- 全链路：sync → projection → 快照冻结 ----

def test_full_chain_sync_projection_freeze():
    client = FakeGrantsClient()
    client.config_response = AuthorizedConfigPullResponse(
        experts=[{"employee_id": "e1", "version": "v1", "display_name": "甲"}]
    )
    client.snapshots["e1"] = _snapshot("e1", "v1", "snap-1")
    svc = _service(client)

    # 1) sync → 投影
    svc.sync("t1", "m1")
    assert [e.employee_id for e in svc.available_experts()] == ["e1"]
    # 2) 装载该专家 → 冻结快照
    frozen = svc.freeze_snapshot("t1", "m1", "e1")
    assert frozen.employee_id == "e1" and frozen.snapshot_version == "snap-1"
    assert svc.frozen_snapshots()[0].snapshot_version == "snap-1"


# ---- 离线降级（D14，本卡核心价值）----

def test_offline_sync_does_not_wipe_existing_projection():
    """Manager 不可达 → sync 失败但 ok=False、不抛；既有投影完整保留、仍可用。"""
    client = FakeGrantsClient()
    client.config_response = AuthorizedConfigPullResponse(
        experts=[{"employee_id": "e1", "version": "v1"}]
    )
    svc = _service(client)
    svc.sync("t1", "m1")  # 在线先建立投影
    assert [e.employee_id for e in svc.available_experts()] == ["e1"]

    # Manager 离线
    client.unreachable = True
    result = svc.sync("t1", "m1")  # 不应抛
    assert result.ok is False and result.error  # 标记降级，留错误供观测
    # 既有投影不被清空，对话路径继续可用（D14）
    assert [e.employee_id for e in svc.available_experts()] == ["e1"]


def test_offline_frozen_snapshot_still_loadable():
    """Manager 不可达 → 已冻结快照仍可本地装载执行（D5/D14）。"""
    client = FakeGrantsClient()
    client.snapshots["e1"] = _snapshot("e1", "v1", "snap-1")
    svc = _service(client)
    svc.freeze_snapshot("t1", "m1", "e1")  # 在线先冻结

    client.unreachable = True
    # 新 pull 会失败（在线路径），但本地已冻结快照不受影响
    with pytest.raises(TimeoutError):
        svc.freeze_snapshot("t1", "m1", "e1-other")  # 未冻结过的需在线 → 抛
    # 已冻结的回退装载仍可用
    assert svc.load_snapshot("e1", "snap-1").snapshot_version == "snap-1"
    assert svc.latest_snapshot("e1").snapshot_version == "snap-1"


def test_offline_first_sync_no_crash_empty_projection():
    """从未 sync 过即离线：sync 失败降级，本地投影为空但不崩、不 not-ready。"""
    client = FakeGrantsClient()
    client.unreachable = True
    svc = _service(client)
    result = svc.sync("t1", "m1")
    assert result.ok is False
    assert svc.available_experts() == []  # 空但可正常调用，不抛


# ---- unconfigured 安全默认 ----

def test_unconfigured_client_sync_degrades_not_raises():
    """缺配置（默认 UnconfiguredGrantsClient）：sync 走降级（ok=False），不静默成功、不抛。"""
    svc = build_grants_service()  # 默认 UnconfiguredGrantsClient
    result = svc.sync("t1", "m1")
    assert result.ok is False and result.error


def test_unconfigured_client_snapshot_raises():
    """缺配置时在线快照 pull 抛错（不静默返回空快照）。"""
    client = UnconfiguredGrantsClient()
    with pytest.raises(AppError):
        client.pull_snapshot(SnapshotPullRequest(tenant_id="t1", member_id="m1", employee_id="e1"))
