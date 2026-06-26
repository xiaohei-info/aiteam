"""ACP executor 分支覆盖补充：_text_of / map_acp_update / _user_text / execute / cancel。

用真子进程（小段 python 脚本作 fake ACP agent）覆盖 AcpClientExecutor.execute 全链路，
并补齐纯函数 _text_of / map_acp_update / _user_text 中尚未覆盖的分支。
"""

import asyncio
import sys
import types

from agent_gateway.acp_executor import AcpClientExecutor, _text_of, map_acp_update, _user_text
from shared.contracts.gateway import Driver, RuntimeCapability
from shared.contracts.runspec import AgentRunRequest, RunSpec

_FAKE_ACP_AGENT = r"""
import sys, json

mode = sys.argv[1] if len(sys.argv) > 1 else "ok"

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})

def _text_chunk(s):
    return {
        "sessionUpdate": "agent_message_chunk",
        "content": {"type": "text", "text": s},
    }

def _session_update(session_id, update):
    return {"sessionId": session_id, "update": update}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    m = msg.get("method")
    mid = msg.get("id")

    if m == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}})
    elif m == "session/new":
        result = {"sessionId": "acp-fake-1"}
        if mode in ("model", "set_model_err"):
            result["models"] = {
                "availableModels": [
                    {"modelId": "custom:gpt-5.4", "name": "gpt-5.4"},
                ],
                "currentModelId": "custom:gpt-5.4",
            }
        send({"jsonrpc": "2.0", "id": mid, "result": result})
    elif m == "session/set_model":
        if mode == "set_model_err":
            send({"jsonrpc": "2.0", "id": mid,
                  "error": {"code": -1, "message": "unsupported model"}})
        else:
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif m == "session/prompt":
        sid = msg.get("params", {}).get("sessionId", "acp-fake-1")
        notify("session/update", _session_update(sid, _text_chunk("Hello ")))
        notify("session/update", _session_update(sid, _text_chunk("world")))
        notify("session/update", {
            "sessionId": sid,
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "title": "shell",
                "kind": "execute",
                "rawInput": {"command": "echo hi"},
                "content": [],
            },
        })
        notify("session/update", {
            "sessionId": sid,
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "content": [{"type": "content",
                             "content": {"type": "text", "text": "hi\n"}}],
            },
        })
        notify("session/update", {
            "sessionId": sid,
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t2",
                "status": "in_progress",
                "content": [],
            },
        })
        notify("session/update", {
            "sessionId": sid,
            "update": {
                "sessionUpdate": "usage_update",
                "used": 10,
                "size": 100,
                "cost": None,
            },
        })
        if mode == "refusal":
            stop = "refusal"
        elif mode == "cancel":
            continue
        else:
            stop = "end_turn"
        send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": stop}})
    elif m == "session/cancel":
        sys.exit(0)
"""


class _AcpDriver(Driver):
    runtime_name = "acp-fake"

    def __init__(self, mode: str = "ok", command: list[str] | None = None):
        self._command = command or [sys.executable, "-c", _FAKE_ACP_AGENT, mode]

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(runtime="acp-fake")

    def build_command(self, run_spec) -> list[str]:
        return self._command

    def parse_event(self, raw):
        return None

    def extract_session_id(self, raw):
        return None

    def extract_usage(self, raw):
        return None


def _req(run_id="r-acp", model=None, messages=None):
    msgs = messages or [{"role": "user", "content": "hello acp"}]
    return AgentRunRequest(
        run_id=run_id, tenant_id="t1",
        run_spec=RunSpec(model=model),
        input_messages=msgs,
    )


def _run(driver, request, executor=None):
    executor = executor or AcpClientExecutor()
    events = []

    async def sink(ev):
        events.append(ev)

    result = asyncio.run(executor.execute(request, driver, sink))
    return events, result


# ---- _text_of branch coverage -----------------------------------------------


def test_text_of_none():
    assert _text_of(None) == ""


def test_text_of_str():
    assert _text_of("hi") == "hi"


def test_text_of_object_without_content_or_text():
    obj = types.SimpleNamespace()
    assert _text_of(obj) == ""


def test_text_of_empty_list():
    assert _text_of([]) == ""


def test_text_of_nested_list_with_strings():
    assert _text_of(["a", ["b", "c"]]) == "abc"


def test_text_of_tuple():
    assert _text_of(("x", "y")) == "xy"


def test_text_of_inner_is_self():
    obj = types.SimpleNamespace()
    obj.content = obj
    obj.text = "self-ref"
    assert _text_of(obj) == "self-ref"


# ---- map_acp_update additional branches -------------------------------------


def test_map_acp_update_usage_update():
    u = types.SimpleNamespace(
        session_update="usage_update", used=10, size=100, cost=None,
    )
    type_, payload = map_acp_update(u)
    assert type_ == "usage"
    assert payload == {"used": 10, "size": 100, "cost": None}


def test_map_acp_update_unknown_kind_returns_none():
    u = types.SimpleNamespace(session_update="some_unknown_thing")
    assert map_acp_update(u) is None


def test_map_acp_update_no_session_update_attr():
    u = types.SimpleNamespace()
    assert map_acp_update(u) is None


def test_map_acp_update_tool_call():
    u = types.SimpleNamespace(
        session_update="tool_call", tool_call_id="tc1",
        title="editor", kind="edit", raw_input={"file": "x.py"},
    )
    type_, payload = map_acp_update(u)
    assert type_ == "tool_call_started"
    assert payload["tool_id"] == "tc1"
    assert payload["name"] == "editor"
    assert payload["input"] == {"file": "x.py"}


def test_map_acp_update_tool_call_no_title_uses_kind():
    u = types.SimpleNamespace(
        session_update="tool_call", tool_call_id="tc2",
        title=None, kind="search", raw_input=None,
    )
    _, payload = map_acp_update(u)
    assert payload["name"] == "search"
    assert payload["input"] == {}


def test_map_acp_update_tool_call_completed_raw_output_fallback():
    u = types.SimpleNamespace(
        session_update="tool_call_update", tool_call_id="tc3",
        status="completed", content=None, raw_output="fallback output",
    )
    _, payload = map_acp_update(u)
    assert payload["output"] == "fallback output"
    assert payload["is_error"] is False


# ---- _user_text branch coverage ---------------------------------------------


def test_user_text_finds_last_user_message():
    req = _req(messages=[
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "last question"},
    ])
    assert _user_text(req) == "last question"


def test_user_text_no_user_role_falls_back_to_last():
    req = _req(messages=[
        {"role": "assistant", "content": "hello"},
    ])
    assert _user_text(req) == "hello"


def test_user_text_empty_messages():
    req = AgentRunRequest(
        run_id="r", tenant_id="t", run_spec=RunSpec(),
        input_messages=[],
    )
    assert _user_text(req) == ""


# ---- AcpClientExecutor.execute — e2e with fake ACP agent --------------------


def test_execute_full_turn_streams_events_and_completes():
    events, result = _run(_AcpDriver("ok"), _req())
    types_ = [e.type for e in events]

    assert result.success is True
    assert result.session_id == "acp-fake-1"
    assert types_[-1] == "completed"
    assert "text_delta" in types_
    assert "tool_call_started" in types_
    assert "tool_call_completed" in types_
    assert "usage" in types_
    text = "".join(e.payload["text"] for e in events if e.type == "text_delta")
    assert text == "Hello world"
    assert result.usage is not None
    assert result.usage.get("used") == 10
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    assert all(e.run_id == "r-acp" for e in events)
    assert all(e.source == "acp-fake" for e in events)


def test_execute_refusal_stop_reason():
    events, result = _run(_AcpDriver("refusal"), _req())
    assert result.success is False
    assert result.error == "refusal"
    assert events[-1].type == "cancelled"
    assert events[-1].payload.get("stop_reason") == "refusal"


def test_execute_spawn_failure_returns_error():
    driver = _AcpDriver(command=["/nonexistent/acp-agent-binary"])
    events, result = _run(driver, _req())
    assert result.success is False
    assert result.success is False
    assert events[-1].type == "error"
    assert "acp run failed" in events[-1].payload.get("message", "")
    assert events[-1].type == "error"


def test_execute_with_model_switches():
    events, result = _run(_AcpDriver("model"), _req(model="gpt-5.4"))
    assert result.success is True
    assert result.session_id == "acp-fake-1"


def test_execute_set_model_error_is_swallowed():
    events, result = _run(_AcpDriver("set_model_err"), _req(model="gpt-5.4"))
    assert result.success is True


def test_execute_cleans_up_active_after_success():
    executor = AcpClientExecutor()
    _run(_AcpDriver("ok"), _req(), executor)
    assert "r-acp" not in executor._active


def test_execute_cleans_up_active_after_error():
    executor = AcpClientExecutor()
    driver = _AcpDriver(command=["/nonexistent/acp-agent-binary"])
    events, result = _run(driver, _req(), executor)
    assert result.success is False
    assert "r-acp" not in executor._active


# ---- AcpClientExecutor.cancel ------------------------------------------------


def test_cancel_when_not_active_is_noop():
    executor = AcpClientExecutor()
    asyncio.run(executor.cancel("nonexistent-run"))


def test_cancel_calls_conn_cancel():
    executor = AcpClientExecutor()
    called = []

    class FakeConn:
        async def cancel(self, session_id):
            called.append(session_id)

    executor._active["r-cancel"] = (FakeConn(), "sess-1")
    asyncio.run(executor.cancel("r-cancel"))
    assert called == ["sess-1"]


def test_cancel_swallows_conn_cancel_error():
    executor = AcpClientExecutor()

    class BoomConn:
        async def cancel(self, session_id):
            raise RuntimeError("boom")

    executor._active["r-boom"] = (BoomConn(), "sess-2")
    asyncio.run(executor.cancel("r-boom"))  # should not raise


# ---- _apply_model error swallowing -------------------------------------------


def test_apply_model_swallows_set_session_model_exception():
    class ErrConn:
        async def set_session_model(self, *, session_id, model_id):
            raise RuntimeError("unsupported")

    models = [types.SimpleNamespace(model_id="m1", name="m1")]
    sess = types.SimpleNamespace(models=types.SimpleNamespace(available_models=models))

    asyncio.run(AcpClientExecutor._apply_model(ErrConn(), sess, "s1", "m1"))


def test_apply_model_no_models_attr():
    class NoopConn:
        async def set_session_model(self, *, session_id, model_id):
            pass

    sess = types.SimpleNamespace(models=None)
    asyncio.run(AcpClientExecutor._apply_model(NoopConn(), sess, "s1", "m1"))
