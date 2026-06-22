"""Hermes ACP Driver 验收：golden ACP session/update→AgentRuntimeEvent + 协议注入（06 §7.5.3）。"""

from agent_gateway.drivers.hermes import HermesAcpDriver
from shared.contracts.runspec import McpServerConfig, RunSpec


def _update(kind, **extra):
    return {"method": "session/update", "params": {"sessionId": "s1", "update": {"sessionUpdate": kind, **extra}}}


GOLDEN = [
    (_update("agent_message_chunk", content={"type": "text", "text": "hi"}), "text_delta", {"text": "hi"}),
    (_update("agent_thought_chunk", content={"type": "text", "text": "plan"}), "reasoning_delta", {"text": "plan"}),
    (
        _update("tool_call", toolCallId="c1", title="read_file", rawInput={"path": "/a"}),
        "tool_call_started",
        {"tool_id": "c1", "name": "read_file", "input": {"path": "/a"}},
    ),
    (
        _update("tool_call_update", toolCallId="c1", status="completed", content=[{"type": "text", "text": "ok"}]),
        "tool_call_completed",
        {"tool_id": "c1", "output": "ok", "is_error": False},
    ),
    (
        _update("tool_call_update", toolCallId="c1", status="failed", content={"type": "text", "text": "no"}),
        "tool_call_completed",
        {"tool_id": "c1", "output": "no", "is_error": True},
    ),
]


def test_golden_event_mapping():
    d = HermesAcpDriver()
    for raw, exp_type, exp_payload in GOLDEN:
        ev = d.parse_event(raw)
        assert ev is not None, raw
        assert ev.type == exp_type, raw
        assert ev.payload == exp_payload, raw
        assert ev.source == "hermes"


def test_ignores_non_session_update_and_in_progress_tool():
    d = HermesAcpDriver()
    assert d.parse_event({"method": "session/request_permission"}) is None
    assert d.parse_event(_update("tool_call_update", toolCallId="c1", status="in_progress")) is None


def test_build_command_keeps_b_class_out_of_cmdline():
    """ACP runtime：model/system_prompt 走协议/RPC 注入，不进命令行（system_prompt_injection=protocol）。"""
    d = HermesAcpDriver()
    spec = RunSpec(system_prompt="persona", model="hermes-default", mcp_config=[McpServerConfig(name="kb")])
    cmd = d.build_command(spec)
    assert cmd == ["hermes", "acp"]
    assert d.capabilities().system_prompt_injection == "protocol"


def test_thinking_level_declared_unsupported():
    """hermes acp 协议无思考深度通道：显式标 unsupported，不静默丢弃 RunSpec.thinking_level。"""
    assert HermesAcpDriver().capabilities().thinking_level_injection == "unsupported"


def test_custom_args_denylist_applied():
    d = HermesAcpDriver()
    cmd = d.build_command(RunSpec(custom_args=["--system-prompt", "x", "--ok"]))
    assert "--system-prompt" not in cmd and "x" not in cmd
    assert "--ok" in cmd


def test_extract_session_and_usage():
    d = HermesAcpDriver()
    assert d.extract_session_id({"params": {"sessionId": "s7"}}) == "s7"
    assert d.extract_session_id({"result": {"sessionId": "s8"}}) == "s8"
    usage = {"input_tokens": 1, "output_tokens": 2}
    assert d.extract_usage({"result": {"usage": usage}}) == usage
