"""#173 真实验证：claude_code Driver 对照**真实 CLI 输出**的 golden 测试（CI 安全，无需二进制/网络/配额）。

fixture `fixtures/claude_code_stream.jsonl` 取自真实 `claude --print --output-format stream-json
--verbose` 输出（已裁去环境噪声字段，保留真实事件形状）。这把"驱动对照真实协议"钉成回归守卫。
"""

import json
import pathlib

from agent_gateway.drivers.claude_code import ClaudeCodeJsonStreamDriver

_FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "claude_code_stream.jsonl"
_TOOL_FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "claude_code_tool_stream.jsonl"


def _lines() -> list[dict]:
    return [json.loads(line) for line in _FIXTURE.read_text().splitlines() if line.strip()]


def _tool_lines() -> list[dict]:
    return [json.loads(line) for line in _TOOL_FIXTURE.read_text().splitlines() if line.strip()]


def test_golden_real_stream_maps_core_events():
    d = ClaudeCodeJsonStreamDriver()
    events = [d.parse_event(raw) for raw in _lines()]
    types = [e.type for e in events if e is not None]
    assert "status" in types          # system/init → status
    assert "reasoning_delta" in types  # assistant thinking block
    assert "text_delta" in types       # assistant text block
    assert "completed" in types        # result subtype=success
    # 无法映射的真实事件（rate_limit_event）→ None，不静默伪造（契约语义）。
    assert any(e is None for e in events)


def test_golden_text_and_final_text():
    d = ClaudeCodeJsonStreamDriver()
    evs = [e for e in (d.parse_event(r) for r in _lines()) if e is not None]
    assert next(e for e in evs if e.type == "text_delta").payload["text"] == "OK"
    assert next(e for e in evs if e.type == "completed").payload["final_text"] == "OK"


def test_golden_tool_call_started_and_completed():
    """真实工具流（echo hello-claude）：tool_use→tool_call_started，tool_result→tool_call_completed。"""
    d = ClaudeCodeJsonStreamDriver()
    evs = [e for e in (d.parse_event(r) for r in _tool_lines()) if e is not None]
    started = next(e for e in evs if e.type == "tool_call_started")
    assert started.payload["tool_id"] == "toolu_013RoYpsduF75D3jekf9Mk9U"
    assert started.payload["name"] == "Bash"
    assert started.payload["input"]["command"] == "echo hello-claude"
    completed = next(e for e in evs if e.type == "tool_call_completed")
    assert completed.payload["tool_id"] == "toolu_013RoYpsduF75D3jekf9Mk9U"
    assert completed.payload["output"] == "hello-claude"
    assert completed.payload["is_error"] is False
    # 工具调用前后仍能拿到思考与最终文本。
    assert "reasoning_delta" in [e.type for e in evs]
    assert next(e for e in evs if e.type == "completed").payload["final_text"] == "命令输出为：`hello-claude`"


def test_golden_session_id_extraction():
    d = ClaudeCodeJsonStreamDriver()
    assert d.extract_session_id(_lines()[0]) == "c17984be-d608-42fc-b8a0-a749033c4624"


def test_golden_usage_extraction_both_shapes():
    """真实数据：assistant 的 usage 在 message.usage；result 的 usage 在顶层。两处都要能取。"""
    d = ClaudeCodeJsonStreamDriver()
    lines = _lines()
    assistant = next(l for l in lines if l.get("type") == "assistant")
    result = next(l for l in lines if l.get("type") == "result")
    assert d.extract_usage(assistant) == {"input_tokens": 12, "output_tokens": 1}
    assert d.extract_usage(result) == {"input_tokens": 12, "output_tokens": 2}
