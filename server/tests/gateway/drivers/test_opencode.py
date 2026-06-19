"""OpenCode JSON-stream Driver 验收：golden 映射 + RunSpec 翻译（06 §7.5.3）。"""

import os

from agent_gateway.drivers.opencode import OpenCodeJsonStreamDriver
from shared.contracts.runspec import McpServerConfig, RunSpec

GOLDEN = [
    ({"type": "session.start", "sessionID": "s1"}, "status", {"state": "running"}),
    ({"type": "text", "text": "hi"}, "text_delta", {"text": "hi"}),
    ({"type": "reasoning", "text": "plan"}, "reasoning_delta", {"text": "plan"}),
    (
        {"type": "tool.start", "id": "t1", "tool": "edit", "input": {"f": "a"}},
        "tool_call_started",
        {"tool_id": "t1", "name": "edit", "input": {"f": "a"}},
    ),
    (
        {"type": "tool.end", "id": "t1", "output": "ok"},
        "tool_call_completed",
        {"tool_id": "t1", "output": "ok", "is_error": False},
    ),
    ({"type": "session.end", "text": "done"}, "completed", {"final_text": "done"}),
    ({"type": "session.end", "error": "boom"}, "error", {"message": "boom"}),
]


def test_golden_event_mapping():
    d = OpenCodeJsonStreamDriver()
    for raw, exp_type, exp_payload in GOLDEN:
        ev = d.parse_event(raw)
        assert ev is not None, raw
        assert ev.type == exp_type, raw
        assert ev.payload == exp_payload, raw
        assert ev.source == "opencode"


def test_build_command_and_mcp_file():
    d = OpenCodeJsonStreamDriver()
    spec = RunSpec(model="m", system_prompt="p", mcp_config=[McpServerConfig(name="kb")])
    cmd = d.build_command(spec)
    assert cmd[:2] == ["opencode", "run"]
    assert cmd[cmd.index("--model") + 1] == "m"
    path = cmd[cmd.index("--mcp-config") + 1]
    try:
        assert os.path.exists(path)
    finally:
        os.unlink(path)


def test_extract_session_and_usage():
    d = OpenCodeJsonStreamDriver()
    assert d.extract_session_id({"sessionID": "s1"}) == "s1"
    usage = {"input_tokens": 1, "output_tokens": 1}
    assert d.extract_usage({"usage": usage}) == usage
