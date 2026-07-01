"""AITEAM-244 / GitHub #289：Loop 补齐 ScheduledJob 口径后的契约测试。

覆盖新增能力：
- 主状态机（active/paused/completed/error）合法转换 + 非法转换抛 InvalidTransition
- recurrence_type / recurrence_config / input_template / max_retries / retry_count 持久化 roundtrip
- 失败重试策略：record_failure 累计;达 max_retries 自迁至 error;record_success 重置
- preview_next_run: cron 类型可预测下一命中;非 cron 当前返回 None（待服务端 matcher）
"""

import tempfile
import os
from datetime import datetime, timezone, timedelta

import pytest

from agent_service.local_db import apply_migrations, connect
from agent_service.loop.models import (
    InvalidTransition,
    Loop,
    LoopStatus,
    RecurrenceType,
)
from agent_service.loop.store import (
    InMemoryLoopRepository,
    SqliteLoopRepository,
)
from shared.contracts.runspec import RunSpec


def _sample_loop(**overrides) -> Loop:
    base = dict(
        id="l1",
        conversation_id="c1",
        cron="0 9 * * 1",
        run_spec=RunSpec(system_prompt="weekly recap", model="m1"),
        title="weekly report",
        recurrence_type=RecurrenceType.WEEKLY,
        recurrence_config={"time": "09:00", "weekdays": [1]},
        input_template="Summarize last week",
        status=LoopStatus.PAUSED,
        max_retries=2,
        retry_count=0,
    )
    base.update(overrides)
    return Loop(**base)


# ── 主状态机 ──────────────────────────────────────────────────────────

def test_default_status_is_paused():
    loop = Loop(id="x", conversation_id="c1")
    assert loop.status is LoopStatus.PAUSED
    assert loop.max_retries == 3
    assert loop.retry_count == 0
    assert loop.recurrence_type is RecurrenceType.CRON
    assert not loop.is_active()


def test_pause_to_active_roundtrip():
    loop = _sample_loop()
    loop.activate()
    assert loop.status is LoopStatus.ACTIVE
    loop.pause()
    assert loop.status is LoopStatus.PAUSED


def test_active_to_completed():
    loop = _sample_loop(status=LoopStatus.ACTIVE)
    loop.complete()
    assert loop.status is LoopStatus.COMPLETED


def test_completed_can_reactivate():
    loop = _sample_loop(status=LoopStatus.ACTIVE)
    loop.complete()
    loop.activate()
    assert loop.status is LoopStatus.ACTIVE


def test_error_transitions():
    loop = _sample_loop(status=LoopStatus.ACTIVE)
    loop.mark_error()
    assert loop.status is LoopStatus.ERROR
    with pytest.raises(InvalidTransition):
        loop.mark_error()  # error -> error 非法
    loop.clear_error()
    assert loop.status is LoopStatus.PAUSED


def test_illegal_transitions_raise():
    loop = _sample_loop(status=LoopStatus.PAUSED)
    with pytest.raises(InvalidTransition):
        loop.pause()  # paused -> paused 非法
    with pytest.raises(InvalidTransition):
        loop.complete()  # paused -> completed 非法
    with pytest.raises(InvalidTransition):
        loop.mark_error()  # paused -> error 非法


# ── 失败重试 ──────────────────────────────────────────────────────────

def test_record_failure_accumulates_and_transitions_at_threshold():
    repo = InMemoryLoopRepository()
    loop = _sample_loop(status=LoopStatus.ACTIVE, max_retries=2)
    repo.create(loop)
    repo.record_failure(loop.id)
    assert repo.get(loop.id).retry_count == 1
    assert repo.get(loop.id).status is LoopStatus.ACTIVE
    repo.record_failure(loop.id)
    assert repo.get(loop.id).retry_count == 2
    assert repo.get(loop.id).status is LoopStatus.ERROR  # 达阈值自迁至 error


def test_record_failure_above_threshold_stays_error():
    repo = InMemoryLoopRepository()
    loop = _sample_loop(status=LoopStatus.ACTIVE, max_retries=2)
    repo.create(loop)
    repo.record_failure(loop.id)
    repo.record_failure(loop.id)
    assert repo.get(loop.id).status is LoopStatus.ERROR
    repo.record_failure(loop.id)
    assert repo.get(loop.id).retry_count == 3
    assert repo.get(loop.id).status is LoopStatus.ERROR


def test_record_failure_does_not_transition_when_not_active():
    repo = InMemoryLoopRepository()
    loop = _sample_loop(status=LoopStatus.PAUSED, max_retries=1)
    repo.create(loop)
    repo.record_failure(loop.id)
    assert repo.get(loop.id).retry_count == 1
    assert repo.get(loop.id).status is LoopStatus.PAUSED  # 非 active 不自动迁


def test_record_success_resets_retry_count():
    repo = InMemoryLoopRepository()
    loop = _sample_loop(status=LoopStatus.ACTIVE, max_retries=2)
    repo.create(loop)
    repo.record_failure(loop.id)
    repo.record_failure(loop.id)
    assert repo.get(loop.id).retry_count == 2
    repo.record_success(loop.id)
    assert repo.get(loop.id).retry_count == 0


# ── recurrence / input / retry 持久化 ─────────────────────────────────

def test_recurrence_and_retry_roundtrip_in_memory():
    repo = InMemoryLoopRepository()
    loop = _sample_loop()
    repo.create(loop)
    got = repo.get(loop.id)
    assert got.recurrence_type is RecurrenceType.WEEKLY
    assert got.recurrence_config == {"time": "09:00", "weekdays": [1]}
    assert got.input_template == "Summarize last week"
    assert got.max_retries == 2


def test_recurrence_config_null_roundtrip():
    repo = InMemoryLoopRepository()
    loop = _sample_loop(recurrence_config=None)
    repo.create(loop)
    assert repo.get(loop.id).recurrence_config is None


def test_recurrence_and_retry_roundtrip_sqlite():
    tmp = tempfile.mktemp(suffix=".db")
    db = connect(tmp)
    try:
        apply_migrations(db)
        repo = SqliteLoopRepository(db)
        loop = _sample_loop()
        repo.create(loop)
        got = repo.get(loop.id)
        assert got.recurrence_type is RecurrenceType.WEEKLY
        assert got.recurrence_config == {"time": "09:00", "weekdays": [1]}
        assert got.input_template == "Summarize last week"
        assert got.max_retries == 2

        # retry bookkeeping 跨重启保持
        repo.record_failure(loop.id)
        repo2 = SqliteLoopRepository(db)
        reloaded = repo2.get(loop.id)
        assert reloaded.retry_count == 1
    finally:
        db.close()
        os.remove(tmp)


def test_list_active_filters_by_active_status():
    repo = InMemoryLoopRepository()
    repo.create(_sample_loop(id="a", status=LoopStatus.ACTIVE))
    repo.create(_sample_loop(id="p", status=LoopStatus.PAUSED))
    repo.create(_sample_loop(id="e", status=LoopStatus.ERROR))
    assert [l.id for l in repo.list_active()] == ["a"]


# ── preview_next_run ───────────────────────────────────────────────────

def test_preview_next_run_for_cron():
    loop = _sample_loop(recurrence_type=RecurrenceType.CRON, cron="0 9 * * 1")
    nxt = loop.preview_next_run(after=datetime(2026, 6, 30, 0, 0, tzinfo=timezone.utc))
    assert nxt is not None
    assert nxt.hour == 9 and nxt.minute == 0 and nxt.weekday() == 0  # Monday
    # 返回值严格在 after 之后
    assert nxt > datetime(2026, 6, 30, 0, 0, tzinfo=timezone.utc)


def test_preview_next_run_rejects_invalid_cron():
    loop = _sample_loop(recurrence_type=RecurrenceType.CRON, cron="not a cron")
    assert loop.preview_next_run() is None


def test_preview_next_run_deferred_for_non_cron():
    # 服务端 matcher 暂只接走 cron；其他 recurrence 类型当前返回 None
    for t in (RecurrenceType.ONCE, RecurrenceType.DAILY,
              RecurrenceType.WEEKLY, RecurrenceType.MONTHLY):
        loop = _sample_loop(recurrence_type=t)
        assert loop.preview_next_run() is None, t


def test_loop_has_no_display_state_fields():
    """D6 回归：Loop 主状态只含 active/paused/completed/error，无展示态。"""
    from shared.contracts.enums import DisplayState
    display_values = {s.value for s in DisplayState}
    loop_values = {s.value for s in LoopStatus}
    assert not (loop_values & display_values)
