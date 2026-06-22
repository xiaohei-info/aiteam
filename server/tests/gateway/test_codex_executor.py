"""#185：codex app-server notification → 归一事件映射 + B 类协议注入参数（CI 安全，纯函数）。

样本取自真实 `codex app-server` 实测 notification 形状（2026-06-22 spike）。
覆盖 #185 能力面：流式文本、思考、工具调用(输入/输出)、用量、指定模型、切换思考深度。
"""

import asyncio
import sys

from agent_gateway.codex_executor import (
    CodexAppServerExecutor,
    _effort_of,
    map_codex_notification,
)
from shared.contracts.gateway import Driver, RuntimeCapability
from shared.contracts.runspec import AgentRunRequest, RunSpec


def _req(**spec):
    return AgentRunRequest(
        run_id="r1", tenant_id="t1", run_spec=RunSpec(**spec),
        input_messages=[{"role": "user", "content": "hello codex"}],
    )


# ---- notification 归一 golden -------------------------------------------


def test_agent_message_delta_maps_to_text_delta():
    p = {"threadId": "t", "turnId": "u", "itemId": "msg1", "delta": "Hello"}
    assert map_codex_notification("item/agentMessage/delta", p) == ("text_delta", {"text": "Hello"})


def test_reasoning_text_delta_maps_to_reasoning_delta():
    p = {"delta": "thinking"}
    assert map_codex_notification("item/reasoning/textDelta", p) == ("reasoning_delta", {"text": "thinking"})
    assert map_codex_notification("item/reasoning/summaryTextDelta", p) == ("reasoning_delta", {"text": "thinking"})


def test_command_execution_started_maps_to_tool_call_started():
    p = {"item": {"type": "commandExecution", "id": "c1", "command": "echo hi", "cwd": "/tmp"}}
    type_, payload = map_codex_notification("item/started", p)
    assert type_ == "tool_call_started"
    assert payload["tool_id"] == "c1"
    assert payload["name"] == "echo hi"
    assert payload["input"] == {"command": "echo hi", "cwd": "/tmp"}


def test_command_execution_completed_maps_output_and_exit():
    p = {"item": {"type": "commandExecution", "id": "c1", "aggregatedOutput": "hi\n", "exitCode": 0}}
    type_, payload = map_codex_notification("item/completed", p)
    assert type_ == "tool_call_completed"
    assert payload["tool_id"] == "c1"
    assert payload["output"] == "hi\n"
    assert payload["is_error"] is False


def test_command_execution_nonzero_exit_is_error():
    p = {"item": {"type": "commandExecution", "id": "c1", "aggregatedOutput": "boom", "exitCode": 2}}
    _, payload = map_codex_notification("item/completed", p)
    assert payload["is_error"] is True


def test_mcp_tool_call_maps_arguments_and_result():
    started = {"item": {"type": "mcpToolCall", "id": "m1", "tool": "search", "arguments": {"q": "x"}}}
    t, payload = map_codex_notification("item/started", started)
    assert t == "tool_call_started" and payload["name"] == "search" and payload["input"] == {"q": "x"}
    done = {"item": {"type": "mcpToolCall", "id": "m1", "tool": "search", "result": "ok", "status": "completed"}}
    t2, payload2 = map_codex_notification("item/completed", done)
    assert t2 == "tool_call_completed" and payload2["output"] == "ok" and payload2["is_error"] is False


def test_user_message_item_is_not_a_tool_call():
    p = {"item": {"type": "userMessage", "id": "u1", "content": []}}
    assert map_codex_notification("item/started", p) is None
    assert map_codex_notification("item/completed", p) is None


def test_token_usage_maps_to_usage():
    p = {"tokenUsage": {"total": {"totalTokens": 100, "inputTokens": 80, "outputTokens": 20}}}
    type_, payload = map_codex_notification("thread/tokenUsage/updated", p)
    assert type_ == "usage"
    assert payload == {"totalTokens": 100, "inputTokens": 80, "outputTokens": 20}


def test_unknown_method_is_ignored():
    assert map_codex_notification("thread/status/changed", {}) is None
    # 终态信号不在 map 产事件（执行器处理）。
    assert map_codex_notification("turn/completed", {"turn": {"status": "completed"}}) is None


# ---- 切换思考深度：_effort_of 映射 --------------------------------------


def test_effort_maps_neutral_levels():
    assert _effort_of("low") == "low"
    assert _effort_of("medium") == "medium"
    assert _effort_of("high") == "high"
    assert _effort_of("max") == "xhigh"
    assert _effort_of("off") == "none"
    assert _effort_of("HIGH") == "high"  # 大小写不敏感


def test_effort_unknown_or_empty_returns_none():
    assert _effort_of(None) is None
    assert _effort_of("") is None
    assert _effort_of("bogus") is None


# ---- 协议注入参数：指定模型 / 思考深度 / persona 走协议字段，不进 cmdline ----


def test_turn_params_inject_model_and_effort():
    params = CodexAppServerExecutor._turn_params(_req(model="gpt-5-codex", thinking_level="high"), "th1")
    assert params["threadId"] == "th1"
    assert params["input"] == [{"type": "text", "text": "hello codex"}]
    assert params["model"] == "gpt-5-codex"
    assert params["effort"] == "high"


def test_turn_params_omit_model_and_effort_when_absent():
    params = CodexAppServerExecutor._turn_params(_req(), "th1")
    assert "model" not in params
    assert "effort" not in params


def test_thread_params_inject_system_prompt_and_never_approval():
    params = CodexAppServerExecutor._thread_params(_req(system_prompt="persona"), "/run/cwd")
    assert params["cwd"] == "/run/cwd"
    assert params["approvalPolicy"] == "never"
    assert params["developerInstructions"] == "persona"


# ---- 执行器端到端：经 fake codex app-server 覆盖握手/读循环/终态/取消 ------

# fake codex app-server：真子进程，按真实协议 line-delimited JSON-RPC 应答。
# argv[1] 为 mode：ok（正常一轮）| error（发 error 终态）| hang（不自然完成，等 turn/interrupt）。
_FAKE_SERVER = r"""
import sys, json
mode = sys.argv[1] if len(sys.argv) > 1 else "ok"
def send(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
def notify(m, p):
    send({"jsonrpc": "2.0", "method": m, "params": p})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    m = msg.get("method"); mid = msg.get("id")
    if m == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif m == "initialized":
        pass
    elif m == "thread/start":
        send({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": "th-fake"}}})
    elif m == "turn/start":
        send({"jsonrpc": "2.0", "id": mid, "result": {"turn": {"id": "tn-fake"}}})
        if mode == "error":
            notify("error", {"message": "boom from fake"})
            continue
        notify("item/agentMessage/delta", {"delta": "Hello "})
        notify("item/agentMessage/delta", {"delta": "world"})
        notify("item/started", {"item": {"type": "commandExecution", "id": "c1", "command": "echo hi", "cwd": "/tmp"}})
        notify("item/completed", {"item": {"type": "commandExecution", "id": "c1", "aggregatedOutput": "hi", "exitCode": 0}})
        notify("thread/tokenUsage/updated", {"tokenUsage": {"total": {"totalTokens": 10, "inputTokens": 8, "outputTokens": 2}}})
        if mode != "hang":
            notify("turn/completed", {"threadId": "th-fake", "turn": {"id": "tn-fake", "status": "completed", "error": None}})
    elif m == "turn/interrupt":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
        notify("turn/completed", {"threadId": "th-fake", "turn": {"id": "tn-fake", "status": "aborted", "error": None}})
"""


class _FakeDriver(Driver):
    """指向 fake codex app-server 的最小 Driver（执行器只用 build_command + runtime_name）。"""

    runtime_name = "codex"

    def __init__(self, mode: str = "ok", command: list[str] | None = None):
        self._command = command or [sys.executable, "-c", _FAKE_SERVER, mode]

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(runtime="codex")

    def build_command(self, run_spec) -> list[str]:
        return self._command

    def parse_event(self, raw):
        return None

    def extract_session_id(self, raw):
        return None

    def extract_usage(self, raw):
        return None


def _run(driver, request, executor=None):
    executor = executor or CodexAppServerExecutor()
    events = []

    async def sink(ev):
        events.append(ev)

    result = asyncio.run(executor.execute(request, driver, sink))
    return events, result


def test_execute_full_turn_streams_text_tool_usage_and_completes():
    events, result = _run(_FakeDriver("ok"), _req())
    types = [e.type for e in events]
    assert result.success, result.error
    assert types[-1] == "completed"
    assert "text_delta" in types
    assert "".join(e.payload["text"] for e in events if e.type == "text_delta") == "Hello world"
    assert "tool_call_started" in types and "tool_call_completed" in types
    # Executor 是 seq 权威方：单调从 1 起、run_id/source 重盖。
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    assert all(e.run_id == "r1" and e.source == "codex" for e in events)
    assert result.session_id == "th-fake"
    assert result.usage == {"totalTokens": 10, "inputTokens": 8, "outputTokens": 2}


def test_execute_error_notification_is_terminal_failure():
    events, result = _run(_FakeDriver("error"), _req())
    assert result.success is False
    assert "boom from fake" in (result.error or "")
    assert events[-1].type == "error"


def test_execute_spawn_failure_returns_error_not_crash():
    driver = _FakeDriver(command=["/nonexistent/codex-xyz-binary"])
    events, result = _run(driver, _req())
    assert result.success is False
    assert "spawn failed" in (result.error or "")
    assert events[-1].type == "error"


def test_cancel_mid_run_terminates_and_emits_cancelled():
    executor = CodexAppServerExecutor()

    async def scenario():
        events = []

        async def sink(ev):
            events.append(ev)

        task = asyncio.create_task(executor.execute(_req(), _FakeDriver("hang"), sink))
        await asyncio.sleep(0.5)  # 让握手走完、停在 done.wait()。
        await executor.cancel("r1")
        result = await asyncio.wait_for(task, timeout=10)
        return events, result

    events, result = asyncio.run(scenario())
    assert result.success is False
    assert result.error == "cancelled"
    assert events[-1].type == "cancelled"


def test_cancel_before_execute_short_circuits():
    executor = CodexAppServerExecutor()

    async def scenario():
        await executor.cancel("r1")
        events = []

        async def sink(ev):
            events.append(ev)

        result = await executor.execute(_req(), _FakeDriver("hang"), sink)
        return events, result

    events, result = asyncio.run(scenario())
    assert result.success is False
    assert result.error == "cancelled"
    assert events[-1].type == "cancelled"
