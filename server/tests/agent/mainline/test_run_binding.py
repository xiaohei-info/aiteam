"""AITEAM-689 (M1) 验收：Run 记录绑定快照元数据。

Run 必须能携带并持久化 snapshot_version / employee_id / runtime / provider_ref /
skill_refs，以便一次 run 可追溯到所用的专家快照版本与能力引用（M1 #5）。
"""

import asyncio

from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.models import MessageRole
from agent_service.mainline.service import RunBinding


def test_run_carries_binding_fields_with_defaults():
    """Run 模型新增的快照绑定字段默认安全（None / []），不影响既有构造。"""
    from agent_service.mainline.models import Run, RunStatus

    run = Run(id="run_x", conversation_id="conv_x")
    assert run.status is RunStatus.QUEUED
    assert run.snapshot_version is None
    assert run.employee_id is None
    assert run.runtime is None
    assert run.provider_ref is None
    assert run.skill_refs == []


def test_run_accepts_explicit_binding_fields():
    from agent_service.mainline.models import Run

    run = Run(
        id="run_y", conversation_id="conv_y",
        snapshot_version="snap-v3", employee_id="emp-1", runtime="hermes_acp",
        provider_ref="relay-main", skill_refs=["code-review", "testing"],
    )
    assert run.snapshot_version == "snap-v3"
    assert run.employee_id == "emp-1"
    assert run.runtime == "hermes_acp"
    assert run.provider_ref == "relay-main"
    assert run.skill_refs == ["code-review", "testing"]


def test_start_run_binds_run_binding_to_persisted_run():
    """start_run 接受 run_binding 参数，并把绑定字段落到持久化的 Run 记录上。"""
    svc = build_mainline_service()
    conv = svc.create_conversation()
    svc.add_message(conv.id, role=MessageRole.USER, content="hi")

    binding = RunBinding(
        employee_id="emp-1",
        snapshot_version="snap-v1",
        snapshot_source="frozen",
        runtime="hermes_acp",
        provider_ref="relay",
        skill_refs=["s1"],
    )
    run = asyncio.run(svc.start_run(conv.id, run_binding=binding))
    assert run.employee_id == "emp-1"
    assert run.snapshot_version == "snap-v1"
    assert run.snapshot_source == "frozen"
    assert run.runtime == "hermes_acp"
    assert run.provider_ref == "relay"
    assert run.skill_refs == ["s1"]
    # 重新读取确认落库持久化。
    persisted = svc.get_run(run.id)
    assert persisted.snapshot_version == "snap-v1"
    assert persisted.skill_refs == ["s1"]


def test_sqlite_run_repository_round_trips_binding_fields(tmp_path):
    """SQLite 仓储必须读写新的快照绑定列（含 skill_refs JSON 列表）。"""
    from agent_service.local_db import apply_migrations, connect
    from agent_service.mainline.store import SqliteRunRepository
    from agent_service.mainline.models import Run, RunStatus

    db = connect(str(tmp_path / "agent.db"))
    apply_migrations(db)
    repo = SqliteRunRepository(db)
    run = repo.create(Run(
        id="run_z", conversation_id="conv_z",
        snapshot_version="sv9", employee_id="emp-9", runtime="codex",
        provider_ref="direct", skill_refs=["a", "b"],
    ))
    assert run.id == "run_z"
    fetched = repo.get("run_z")
    assert fetched.snapshot_version == "sv9"
    assert fetched.employee_id == "emp-9"
    assert fetched.runtime == "codex"
    assert fetched.provider_ref == "direct"
    assert fetched.skill_refs == ["a", "b"]
    # 旧行（无绑定列值）回填默认，不报错。
    assert fetched.status is RunStatus.QUEUED
