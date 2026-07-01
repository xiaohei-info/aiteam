"""A3 验收：Loop 领域模型 + 仓储。

覆盖：默认 disabled、状态切换、record_fire 累计计数/last_run_id、不存在 NotFound、
LoopStatus 是固定枚举（非展示态）、Loop 不持展示态字段（D6）。
只 import shared.contracts.runspec.RunSpec（中立规格，禁重定义）。
"""

import pytest

from agent_service.loop.models import Loop, LoopStatus
from agent_service.loop.store import InMemoryLoopRepository
from shared.contracts.enums import DisplayState
from shared.contracts.runspec import RunSpec
from shared.errors import NotFound


def test_loop_default_disabled():
    loop = Loop(id="l1", conversation_id="c1", cron="* * * * *")
    assert loop.status is LoopStatus.PAUSED
    assert loop.fire_count == 0
    assert loop.last_run_id is None


def test_loop_status_is_persistent_enum_not_display():
    """LoopStatus 是持久化主状态枚举，非展示态。"""
    display_values = {s.value for s in DisplayState}
    loop_values = {s.value for s in LoopStatus}
    assert not (loop_values & display_values)  # 无交集
    assert "active" in loop_values and "paused" in loop_values and "completed" in loop_values and "error" in loop_values


def test_loop_model_carries_no_display_state_field():
    """D6：Loop 持久化模型不得含展示态字段。"""
    fields = set(Loop.model_fields)
    assert "display_state" not in fields
    assert "display" not in fields
    display_values = {s.value for s in DisplayState}
    for name, info in Loop.model_fields.items():
        assert info.default not in display_values, f"Loop.{name} 不得默认展示态"


def test_loop_carries_neutral_runspec_only():
    """Loop.run_spec 来自 shared.contracts.runspec.RunSpec（中立规格，禁重定义）。"""
    loop = Loop(id="l1", conversation_id="c1", cron="* * * * *",
                run_spec=RunSpec(system_prompt="hi", model="m1"))
    assert isinstance(loop.run_spec, RunSpec)
    assert loop.run_spec.system_prompt == "hi"


def test_repo_crud_and_status_transition():
    repo = InMemoryLoopRepository()
    repo.create(Loop(id="l1", conversation_id="c1", cron="* * * * *"))
    assert repo.get("l1").status is LoopStatus.PAUSED
    enabled = repo.set_status("l1", LoopStatus.ACTIVE)
    assert enabled.status is LoopStatus.ACTIVE
    assert repo.get("l1").status is LoopStatus.ACTIVE
    assert repo.list_active() == [repo.get("l1")]


def test_repo_list_sorted_by_created():
    repo = InMemoryLoopRepository()
    repo.create(Loop(id="l2", conversation_id="c1", cron="* * * * *"))
    repo.create(Loop(id="l1", conversation_id="c1", cron="* * * * *"))
    assert [l.id for l in repo.list()] == ["l2", "l1"]  # 按 created_at 入序


def test_repo_record_fire_accumulates():
    repo = InMemoryLoopRepository()
    repo.create(Loop(id="l1", conversation_id="c1", cron="* * * * *"))
    repo.record_fire("l1", run_id="run_a")
    repo.record_fire("l1", run_id="run_b")
    loop = repo.get("l1")
    assert loop.fire_count == 2
    assert loop.last_run_id == "run_b"
    assert loop.last_fired_at is not None


def test_repo_missing_raises_notfound():
    repo = InMemoryLoopRepository()
    with pytest.raises(NotFound):
        repo.get("nope")
    with pytest.raises(NotFound):
        repo.set_status("nope", LoopStatus.ACTIVE)
    with pytest.raises(NotFound):
        repo.record_fire("nope", run_id="run_x")
