"""Codex JSON-RPC Driver 验收：golden codex/event→AgentRuntimeEvent + RunSpec 翻译（06 §7.5.3）。"""

from agent_gateway.drivers.codex import CodexJsonRpcDriver
from shared.contracts.runspec import RunSpec


def _ev(msg):
    return {"method": "codex/event", "params": {"msg": msg}}


GOLDEN = [
    (_ev({"type": "task_started"}), "status", {"state": "running"}),
    (_ev({"type": "agent_message_delta", "delta": "hi"}), "text_delta", {"text": "hi"}),
    (_ev({"type": "agent_reasoning_delta", "delta": "think"}), "reasoning_delta", {"text": "think"}),
    (
        _ev({"type": "exec_command_begin", "call_id": "c1", "command": ["ls", "-l"]}),
        "command_started",
        {"call_id": "c1", "command": ["ls", "-l"]},
    ),
    (
        _ev({"type": "exec_command_end", "call_id": "c1", "stdout": "out", "exit_code": 0}),
        "command_output",
        {"call_id": "c1", "stdout": "out", "exit_code": 0},
    ),
    (
        _ev({"type": "token_count", "info": {"input_tokens": 5, "output_tokens": 9}}),
        "usage",
        {"input_tokens": 5, "output_tokens": 9},
    ),
    (_ev({"type": "task_complete", "last_agent_message": "done"}), "completed", {"final_text": "done"}),
    (_ev({"type": "error", "message": "boom"}), "error", {"message": "boom"}),
]


def test_golden_event_mapping():
    d = CodexJsonRpcDriver()
    for raw, exp_type, exp_payload in GOLDEN:
        ev = d.parse_event(raw)
        assert ev is not None, raw
        assert ev.type == exp_type, raw
        assert ev.payload == exp_payload, raw
        assert ev.source == "codex"


def test_ignores_non_codex_event():
    assert CodexJsonRpcDriver().parse_event({"method": "initialize"}) is None


def test_build_command_translates_fields():
    d = CodexJsonRpcDriver()
    cmd = d.build_command(RunSpec(model="gpt-5", thinking_level="high", resume_session_id="sid"))
    assert cmd[:2] == ["codex", "app-server"]
    assert cmd[cmd.index("--model") + 1] == "gpt-5"
    assert "model_reasoning_effort=high" in cmd
    assert cmd[cmd.index("resume") + 1] == "sid"


def test_extract_session_and_usage():
    d = CodexJsonRpcDriver()
    assert d.extract_session_id(_ev({"type": "session_configured", "session_id": "abc"})) == "abc"
    info = {"input_tokens": 5, "output_tokens": 9}
    assert d.extract_usage(_ev({"type": "token_count", "info": info})) == info
    assert d.extract_usage(_ev({"type": "agent_message_delta"})) is None
