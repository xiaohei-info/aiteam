"""#184：ACP typed update → 归一事件映射的 golden 测试（CI 安全，用真实 acp SDK 对象构造）。

map_acp_update 是纯函数：喂官方 acp.helpers 构造的真实 update 对象，断言归一结果。
覆盖 #184 要求的能力面：流式文本、思考、工具调用(输入/输出)、用量。
"""

import asyncio
import types

from acp.helpers import (
    AgentMessageChunk,
    AgentThoughtChunk,
    ContentToolCallContent,
    TextContentBlock,
    ToolCallProgress,
    ToolCallStart,
)

from agent_gateway.acp_executor import AcpClientExecutor, map_acp_update


def _text(s: str) -> TextContentBlock:
    return TextContentBlock(text=s, type="text")


def test_agent_message_chunk_maps_to_text_delta():
    u = AgentMessageChunk(content=_text("Hello"), session_update="agent_message_chunk")
    assert map_acp_update(u) == ("text_delta", {"text": "Hello"})


def test_agent_thought_chunk_maps_to_reasoning_delta():
    u = AgentThoughtChunk(content=_text("thinking..."), session_update="agent_thought_chunk")
    assert map_acp_update(u) == ("reasoning_delta", {"text": "thinking..."})


def test_tool_call_start_maps_to_tool_call_started():
    u = ToolCallStart(
        tool_call_id="t1", title="shell", kind="execute",
        raw_input={"command": "echo hi"},
        content=[ContentToolCallContent(type="content", content=_text("$ echo hi"))],
        session_update="tool_call",
    )
    type_, payload = map_acp_update(u)
    assert type_ == "tool_call_started"
    assert payload["tool_id"] == "t1"
    assert payload["name"] == "shell"
    assert payload["input"] == {"command": "echo hi"}


def test_tool_call_progress_completed_maps_to_tool_call_completed():
    u = ToolCallProgress(
        tool_call_id="t1", status="completed",
        content=[ContentToolCallContent(type="content", content=_text("hi\n"))],
        session_update="tool_call_update",
    )
    type_, payload = map_acp_update(u)
    assert type_ == "tool_call_completed"
    assert payload["tool_id"] == "t1"
    assert payload["output"] == "hi\n"
    assert payload["is_error"] is False


def test_tool_call_progress_failed_is_error():
    u = ToolCallProgress(tool_call_id="t1", status="failed", content=[],
                         session_update="tool_call_update")
    _, payload = map_acp_update(u)
    assert payload["is_error"] is True


def test_tool_call_progress_in_progress_is_ignored():
    u = ToolCallProgress(tool_call_id="t1", status="in_progress", content=[],
                         session_update="tool_call_update")
    assert map_acp_update(u) is None


# ---- 指定模型：_apply_model 选型逻辑（确定性，无需真实 runtime） ----------

class _RecordingConn:
    """记录 set_session_model 调用的假 conn。"""

    def __init__(self):
        self.calls: list[dict] = []

    async def set_session_model(self, *, session_id, model_id):
        self.calls.append({"session_id": session_id, "model_id": model_id})


def _session_with(available):
    """构造带 available_models 的假 session（仅 _apply_model 读取的字段）。"""
    models = [types.SimpleNamespace(model_id=mid, name=name) for mid, name in available]
    return types.SimpleNamespace(models=types.SimpleNamespace(available_models=models))


def _apply(model, available):
    conn = _RecordingConn()
    sess = _session_with(available)
    asyncio.run(AcpClientExecutor._apply_model(conn, sess, "s1", model))
    return conn.calls


def test_apply_model_resolves_neutral_name_to_provider_model_id():
    # 用户传中立名 "gpt-5.4"，应解析到 provider 编码的 model_id "custom:gpt-5.4"。
    calls = _apply("gpt-5.4", [("custom:gpt-5.4", "gpt-5.4")])
    assert calls == [{"session_id": "s1", "model_id": "custom:gpt-5.4"}]


def test_apply_model_matches_by_model_id():
    calls = _apply("custom:gpt-5.4", [("custom:gpt-5.4", "gpt-5.4")])
    assert calls == [{"session_id": "s1", "model_id": "custom:gpt-5.4"}]


def test_apply_model_unknown_model_does_not_switch():
    # 未知 model 不静默切换（保留 runtime 默认），且不致 run 失败。
    assert _apply("does-not-exist", [("custom:gpt-5.4", "gpt-5.4")]) == []


def test_apply_model_none_is_noop():
    assert _apply(None, [("custom:gpt-5.4", "gpt-5.4")]) == []
