"""Codex Driver 验收：build_command 只拉协议端点 + parse_event 委托单一事实源（06 §7.5.3，#185）。

归一映射的 golden 在 test_codex_executor.py（`map_codex_notification` 单一事实源）；本文件验证
Driver 层：B 类能力**不进 cmdline**（走 turn/start 协议字段）+ parse_event 委托 + 能力声明。
"""

from agent_gateway.drivers.codex import CodexJsonRpcDriver
from shared.contracts.runspec import RunSpec


def _notif(method, **params):
    return {"method": method, "params": params}


def test_parse_event_delegates_to_map_codex_notification():
    d = CodexJsonRpcDriver()
    ev = d.parse_event(_notif("item/agentMessage/delta", delta="hi"))
    assert ev is not None and ev.type == "text_delta" and ev.payload == {"text": "hi"}
    assert ev.source == "codex"


def test_ignores_non_mappable_methods():
    assert CodexJsonRpcDriver().parse_event({"method": "thread/status/changed", "params": {}}) is None
    assert CodexJsonRpcDriver().parse_event({"result": {"thread": {"id": "x"}}}) is None


def test_build_command_only_starts_app_server_no_b_class_flags():
    """B 类（model/effort/system_prompt/resume）走 turn/start 协议字段，不进 cmdline。"""
    d = CodexJsonRpcDriver()
    cmd = d.build_command(
        RunSpec(model="gpt-5-codex", thinking_level="high", system_prompt="p", resume_session_id="sid")
    )
    assert cmd == ["codex", "app-server"]


def test_capabilities_declare_protocol_injection():
    cap = CodexJsonRpcDriver().capabilities()
    assert cap.system_prompt_injection == "protocol"
    assert cap.thinking_level_injection == "protocol"  # turn/start effort
    assert cap.model_catalog_mode == "dynamic"


def test_extract_session_and_usage():
    d = CodexJsonRpcDriver()
    assert d.extract_session_id(_notif("thread/started", thread={"id": "abc"})) == "abc"
    total = {"totalTokens": 100, "inputTokens": 80, "outputTokens": 20}
    assert d.extract_usage(_notif("thread/tokenUsage/updated", tokenUsage={"total": total})) == total
    assert d.extract_usage(_notif("item/agentMessage/delta", delta="x")) is None
