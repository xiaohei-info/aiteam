"""A1.2 验收：事件归一映射。

覆盖：事件最小集映射、终态映射、未知类型报错（不外泄原生名）、cursor 占位由 store 分配。
parity：runtime done/cancel/error -> 产品 run_succeeded/run_cancelled/run_failed 终态。
"""

import pytest

from agent_service.mainline import event_mapper
from shared.contracts.events import AgentRuntimeEvent, RuntimeEventType


def _rt(type_: str, payload=None) -> AgentRuntimeEvent:
    return AgentRuntimeEvent(
        event_id="e1", run_id="r1", seq=1, type=type_, source="fake",
        timestamp="2026-06-19T00:00:00Z", payload=payload or {},
    )


def test_full_runtime_event_set_is_mapped():
    """RuntimeEventType 的每个取值都有产品映射（无遗漏 -> 不会落到外泄分支）。"""
    for t in RuntimeEventType.__args__:  # type: ignore[attr-defined]
        assert event_mapper.business_type_for(t)


def test_text_delta_maps_to_message_delta():
    ev = event_mapper.map_runtime_event(_rt("text_delta", {"text": "hi"}), conversation_id="c1")
    assert ev.type == "message_delta"
    assert ev.payload == {"text": "hi"}
    assert ev.conversation_id == "c1"
    assert ev.run_id == "r1"


def test_terminal_mappings():
    assert event_mapper.business_type_for("completed") == "run_succeeded"
    assert event_mapper.business_type_for("cancelled") == "run_cancelled"
    assert event_mapper.business_type_for("error") == "run_failed"
    assert event_mapper.is_terminal("run_succeeded")
    assert event_mapper.is_terminal("run_cancelled")
    assert event_mapper.is_terminal("run_failed")
    assert not event_mapper.is_terminal("message_delta")


def test_non_terminal_types_not_terminal():
    for t in ("status", "reasoning_delta", "tool_call_started", "usage", "artifact"):
        assert not event_mapper.is_terminal(event_mapper.business_type_for(t))


def test_unknown_type_raises_no_native_leak():
    with pytest.raises(ValueError):
        event_mapper.business_type_for("some_runtime_native_event")


def test_mapper_cursor_is_placeholder_zero():
    ev = event_mapper.map_runtime_event(_rt("status"), conversation_id="c1")
    assert ev.cursor == 0  # 真正游标由 TimelineStore 分配
