"""Claude Code Driver 验收：golden raw→AgentRuntimeEvent + RunSpec→flag 翻译（06 §7.5.3）。"""

import os

from agent_gateway.drivers.claude_code import ClaudeCodeJsonStreamDriver
from shared.contracts.runspec import McpServerConfig, RunSpec

# golden: Claude Code stream-json 原始事件 → 期望归一类型/净荷。
GOLDEN = [
    ({"type": "system", "subtype": "init", "session_id": "s1"}, "status", {"state": "running"}),
    (
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}},
        "text_delta",
        {"text": "hi"},
    ),
    (
        {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hmm"}]}},
        "reasoning_delta",
        {"text": "hmm"},
    ),
    (
        {
            "type": "assistant",
            "message": {
                "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"cmd": "ls"}}]
            },
        },
        "tool_call_started",
        {"tool_id": "t1", "name": "Bash", "input": {"cmd": "ls"}},
    ),
    (
        {
            "type": "user",
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]
            },
        },
        "tool_call_completed",
        {"tool_id": "t1", "output": "ok", "is_error": False},
    ),
    (
        {"type": "result", "subtype": "success", "result": "done", "session_id": "s1"},
        "completed",
        {"final_text": "done"},
    ),
    (
        {"type": "result", "subtype": "error_max_turns", "is_error": True, "result": "boom"},
        "error",
        {"message": "boom"},
    ),
]


def test_golden_event_mapping():
    d = ClaudeCodeJsonStreamDriver()
    for raw, exp_type, exp_payload in GOLDEN:
        ev = d.parse_event(raw)
        assert ev is not None, raw
        assert ev.type == exp_type, raw
        assert ev.payload == exp_payload, raw
        assert ev.source == "claude_code"


def test_unmappable_returns_none():
    assert ClaudeCodeJsonStreamDriver().parse_event({"type": "stream_event"}) is None


def test_build_command_translates_b_class_fields():
    d = ClaudeCodeJsonStreamDriver()
    spec = RunSpec(
        system_prompt="be terse",
        model="claude-sonnet",
        thinking_level="high",
        resume_session_id="sid-9",
    )
    cmd = d.build_command(spec)
    assert cmd[0] == "claude"
    assert "--append-system-prompt" in cmd and "be terse" in cmd
    assert cmd[cmd.index("--model") + 1] == "claude-sonnet"
    assert cmd[cmd.index("--effort") + 1] == "high"
    assert cmd[cmd.index("--resume") + 1] == "sid-9"
    assert "stream-json" in cmd


def test_build_command_materializes_mcp_to_file_not_profile():
    d = ClaudeCodeJsonStreamDriver()
    spec = RunSpec(mcp_config=[McpServerConfig(name="mem0", command="openmemory")])
    cmd = d.build_command(spec)
    path = cmd[cmd.index("--mcp-config") + 1]
    try:
        # A 类能力经临时 MCP 文件注入，不写共享 profile。
        assert os.path.exists(path)
        import tempfile

        assert path.startswith(tempfile.gettempdir())
    finally:
        os.unlink(path)


def test_custom_args_denylist_blocks_capability_bypass():
    d = ClaudeCodeJsonStreamDriver()
    spec = RunSpec(custom_args=["--mcp-config", "/evil.json", "--keep", "1"])
    cmd = d.build_command(spec)
    # custom_args 里的 --mcp-config 被 denylist 拦掉（不许旁路注入能力）。
    assert "/evil.json" not in cmd
    assert "--keep" in cmd


def test_extract_session_and_usage():
    d = ClaudeCodeJsonStreamDriver()
    assert d.extract_session_id({"type": "system", "session_id": "s1"}) == "s1"
    usage = {"input_tokens": 3, "output_tokens": 7}
    assert d.extract_usage({"type": "result", "usage": usage}) == usage
    assert d.extract_usage({"type": "assistant"}) is None
