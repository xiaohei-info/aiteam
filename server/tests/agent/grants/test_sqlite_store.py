"""Grants SQLite 仓储测试（#159）。

验收：SQLite 实现与内存实现行为等价，且重启后数据保持。
"""

import pytest

from agent_service.grants.store import (
    SqliteProjectionRepository,
    SqliteSnapshotRepository,
)
from agent_service.local_db import apply_migrations, connect
from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.snapshot import EmployeeExecutionSnapshot


@pytest.fixture
def db():
    """内存 SQLite 数据库（每个测试独立）。"""
    db = connect(":memory:")
    apply_migrations(db)
    return db


@pytest.fixture
def projection_repo(db):
    return SqliteProjectionRepository(db)


@pytest.fixture
def snapshot_repo(db):
    return SqliteSnapshotRepository(db)


def test_projection_upsert(projection_repo):
    """插入和更新投影。"""
    proj = LoadedExpertProjection(
        employee_id="e1",
        tenant_id="t1",
        version="v1",
        display_name="Expert 1",
        runtime_binding="hermes",
    )
    projection_repo.upsert(proj)
    retrieved = projection_repo.get("e1")
    assert retrieved.employee_id == "e1"
    assert retrieved.display_name == "Expert 1"
    assert retrieved.runtime_binding == "hermes"
    assert not retrieved.revoked
    # 更新
    proj2 = LoadedExpertProjection(
        employee_id="e1",
        tenant_id="t1",
        version="v2",
        display_name="Expert 1 Updated",
    )
    projection_repo.upsert(proj2)
    retrieved2 = projection_repo.get("e1")
    assert retrieved2.display_name == "Expert 1 Updated"
    assert retrieved2.version == "v2"


def test_projection_revoke(projection_repo):
    """撤销投影。"""
    proj = LoadedExpertProjection(
        employee_id="e1", tenant_id="t1", version="v1", display_name="Expert 1"
    )
    projection_repo.upsert(proj)
    assert len(projection_repo.available()) == 1
    result = projection_repo.revoke("e1")
    assert result.revoked
    assert len(projection_repo.available()) == 0
    assert len(projection_repo.list_all()) == 1  # 仍保留条目


def test_projection_revoke_nonexistent(projection_repo):
    """撤销不存在的投影返回 None。"""
    result = projection_repo.revoke("nope")
    assert result is None


def test_projection_available_filters_revoked(projection_repo):
    """available() 只返回未撤销的投影。"""
    projection_repo.upsert(
        LoadedExpertProjection(
            employee_id="e1", tenant_id="t1", version="v1", display_name="E1"
        )
    )
    projection_repo.upsert(
        LoadedExpertProjection(
            employee_id="e2", tenant_id="t1", version="v1", display_name="E2"
        )
    )
    projection_repo.revoke("e1")
    available = projection_repo.available()
    assert len(available) == 1
    assert available[0].employee_id == "e2"


def test_projection_persistence(db):
    """重启后投影保持。"""
    repo1 = SqliteProjectionRepository(db)
    repo1.upsert(
        LoadedExpertProjection(
            employee_id="e1", tenant_id="t1", version="v1", display_name="E1"
        )
    )
    # 新建仓储实例，复用同一 db
    repo2 = SqliteProjectionRepository(db)
    proj = repo2.get("e1")
    assert proj.employee_id == "e1"


def test_snapshot_freeze(snapshot_repo):
    """冻结快照。"""
    snap = EmployeeExecutionSnapshot(
        employee_id="e1",
        version="v1",
        snapshot_version="snap1",
        display_name="Expert 1",
        tools=["tool1"],
        skills=["skill1"],
        knowledge_refs=["kb1"],
        connector_refs=["conn1"],
    )
    snapshot_repo.freeze(snap)
    retrieved = snapshot_repo.get("e1", "snap1")
    assert retrieved.employee_id == "e1"
    assert retrieved.snapshot_version == "snap1"
    assert retrieved.tools == ["tool1"]


def test_snapshot_freeze_is_idempotent(snapshot_repo):
    """同一快照重复 freeze 幂等返回既有。"""
    snap1 = EmployeeExecutionSnapshot(
        employee_id="e1",
        version="v1",
        snapshot_version="snap1",
        display_name="Expert 1",
        tools=["tool1"],
        skills=[],
        knowledge_refs=[],
        connector_refs=[],
    )
    snapshot_repo.freeze(snap1)
    snap2 = EmployeeExecutionSnapshot(
        employee_id="e1",
        version="v1",
        snapshot_version="snap1",
        display_name="Expert 1 Updated",
        tools=["tool2"],
        skills=[],
        knowledge_refs=[],
        connector_refs=[],
    )
    result = snapshot_repo.freeze(snap2)
    assert result.display_name == "Expert 1"  # 保留既有，不覆盖
    assert result.tools == ["tool1"]


def test_snapshot_latest(snapshot_repo):
    """获取最新快照。"""
    snapshot_repo.freeze(
        EmployeeExecutionSnapshot(
            employee_id="e1",
            version="v1",
            snapshot_version="snap1",
            display_name="E1",
            tools=[],
            skills=[],
            knowledge_refs=[],
            connector_refs=[],
        )
    )
    snapshot_repo.freeze(
        EmployeeExecutionSnapshot(
            employee_id="e1",
            version="v1",
            snapshot_version="snap2",
            display_name="E1",
            tools=[],
            skills=[],
            knowledge_refs=[],
            connector_refs=[],
        )
    )
    latest = snapshot_repo.latest("e1")
    assert latest.snapshot_version == "snap2"


def test_snapshot_latest_nonexistent(snapshot_repo):
    """不存在的 employee 返回 None。"""
    assert snapshot_repo.latest("nope") is None


def test_snapshot_persistence(db):
    """重启后快照保持。"""
    repo1 = SqliteSnapshotRepository(db)
    repo1.freeze(
        EmployeeExecutionSnapshot(
            employee_id="e1",
            version="v1",
            snapshot_version="snap1",
            display_name="E1",
            tools=[],
            skills=[],
            knowledge_refs=[],
            connector_refs=[],
        )
    )
    # 新建仓储实例，复用同一 db
    repo2 = SqliteSnapshotRepository(db)
    snap = repo2.get("e1", "snap1")
    assert snap.employee_id == "e1"
    assert snap.snapshot_version == "snap1"



def test_projection_persists_template_config(projection_repo):
    """AITEAM-288：模板能力配置（skills/knowledge_refs/memory_policy/model_policy）应持久化到 SQLite 投影仓储。"""
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    proj = LoadedExpertProjection(
        employee_id="e_tpl",
        tenant_id="t1",
        version="v1",
        display_name="模板专家",
        runtime_binding="hermes_acp",
        persona="资深后端",
        model_policy=ModelPolicy(model="gpt-5", provider_ref="relay", thinking_level="deep"),
        runtime_policy=RuntimePolicy(runtime_binding="hermes_acp", timeout_seconds=120),
        tools=["search"],
        skills=["code-review"],
        knowledge_refs=["ks_backend"],
        connector_refs=["slack"],
        memory_policy={"seed": "偏好"},
    )
    projection_repo.upsert(proj)

    retrieved = projection_repo.get("e_tpl")
    assert retrieved.persona == "资深后端"
    assert retrieved.model_policy.model == "gpt-5"
    assert retrieved.model_policy.thinking_level == "deep"
    assert retrieved.runtime_policy.timeout_seconds == 120
    assert retrieved.tools == ["search"]
    assert retrieved.skills == ["code-review"]
    assert retrieved.knowledge_refs == ["ks_backend"]
    assert retrieved.connector_refs == ["slack"]
    assert retrieved.memory_policy == {"seed": "偏好"}


def test_projection_config_defaults_for_old_rows(projection_repo):
    """AITEAM-288：对新字段缺失的旧投影（默认为空），读取不报错且走默认值。"""
    # 直接插入一行不含新字段的内容（模拟迁移前的存量行）
    projection_repo._db.execute(
        "INSERT INTO loaded_expert_projections "
        "(employee_id, tenant_id, version, display_name, runtime_binding, synced_at, revoked) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("e_old", "t1", "v1", "旧专家", "hermes_acp", None, 0),
    )
    old = projection_repo.get("e_old")
    assert old is not None
    assert old.display_name == "旧专家"
    assert old.skills == []
    assert old.knowledge_refs == []
    assert old.connector_refs == []
    assert old.memory_policy is None
    assert old.model_policy.model is None
    assert old.revoked is False
