"""A4：本地投影 / 冻结快照仓储单元行为（04 §6.2/§6.3）。"""

from agent_service.grants.store import (
    InMemoryProjectionRepository,
    InMemorySnapshotRepository,
)
from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.snapshot import EmployeeExecutionSnapshot


def _proj(employee_id: str, version: str = "v1") -> LoadedExpertProjection:
    return LoadedExpertProjection(employee_id=employee_id, tenant_id="t1", version=version)


def _snap(employee_id: str, snap_version: str) -> EmployeeExecutionSnapshot:
    return EmployeeExecutionSnapshot(
        employee_id=employee_id, version="v1", snapshot_version=snap_version
    )


def test_projection_upsert_overwrites_by_employee_id():
    repo = InMemoryProjectionRepository()
    repo.upsert(_proj("e1", "v1"))
    repo.upsert(_proj("e1", "v2"))  # 同 employee_id 增量覆盖
    assert len(repo.list_all()) == 1
    assert repo.get("e1").version == "v2"


def test_projection_revoke_excludes_from_available_keeps_in_all():
    repo = InMemoryProjectionRepository()
    repo.upsert(_proj("e1"))
    revoked = repo.revoke("e1")
    assert revoked.revoked is True
    assert repo.available() == []         # 可用列表剔除
    assert len(repo.list_all()) == 1      # 条目保留供审计/再授权


def test_projection_revoke_missing_returns_none():
    assert InMemoryProjectionRepository().revoke("nope") is None


def test_snapshot_freeze_is_immutable_per_key():
    repo = InMemorySnapshotRepository()
    first = repo.freeze(_snap("e1", "snap-1"))
    again = repo.freeze(_snap("e1", "snap-1").model_copy(update={"display_name": "改"}))
    assert again is first  # 同 key 冻结幂等返回既有，不覆盖
    assert repo.get("e1", "snap-1").display_name == ""


def test_snapshot_latest_tracks_newest_frozen():
    repo = InMemorySnapshotRepository()
    repo.freeze(_snap("e1", "snap-1"))
    repo.freeze(_snap("e1", "snap-2"))
    assert repo.latest("e1").snapshot_version == "snap-2"
    assert repo.latest("missing") is None
