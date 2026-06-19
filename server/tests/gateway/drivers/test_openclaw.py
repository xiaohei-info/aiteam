"""OpenClaw JSON-stream Driver 验收：golden 映射 + resume 不支持的显式降级（06 §7.5.3/§7.5.4）。"""

from agent_gateway.drivers.openclaw import OpenClawJsonStreamDriver
from shared.contracts.runspec import RunSpec

GOLDEN = [
    ({"event": "start"}, "status", {"state": "running"}),
    ({"event": "message_delta", "text": "hi"}, "text_delta", {"text": "hi"}),
    ({"event": "thinking_delta", "text": "plan"}, "reasoning_delta", {"text": "plan"}),
    (
        {"event": "tool_use", "tool_id": "t1", "name": "search", "input": {"q": "x"}},
        "tool_call_started",
        {"tool_id": "t1", "name": "search", "input": {"q": "x"}},
    ),
    (
        {"event": "tool_result", "tool_id": "t1", "result": "ok"},
        "tool_call_completed",
        {"tool_id": "t1", "output": "ok", "is_error": False},
    ),
    ({"event": "done", "text": "done"}, "completed", {"final_text": "done"}),
    ({"event": "error", "message": "boom"}, "error", {"message": "boom"}),
]


def test_golden_event_mapping():
    d = OpenClawJsonStreamDriver()
    for raw, exp_type, exp_payload in GOLDEN:
        ev = d.parse_event(raw)
        assert ev is not None, raw
        assert ev.type == exp_type, raw
        assert ev.payload == exp_payload, raw
        assert ev.source == "openclaw"


def test_resume_unsupported_is_declared_and_not_translated():
    d = OpenClawJsonStreamDriver()
    assert d.capabilities().supports_resume is False  # 显式声明 unsupported，不静默假装
    cmd = d.build_command(RunSpec(resume_session_id="sid", model="m"))
    assert "--resume" not in cmd and "sid" not in cmd  # 不翻译，不静默丢弃为别的语义


def test_build_command_basic():
    d = OpenClawJsonStreamDriver()
    cmd = d.build_command(RunSpec(model="m", system_prompt="p"))
    assert cmd[:2] == ["openclaw", "--json"]
    assert cmd[cmd.index("--model") + 1] == "m"
    assert cmd[cmd.index("--system") + 1] == "p"
