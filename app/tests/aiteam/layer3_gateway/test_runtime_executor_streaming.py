"""Runtime executor live streaming tests."""

import io
import json
import queue
from urllib.error import HTTPError

from agent_gateway import runtime_executor
from agent_gateway import webui_runtime_adapter
from agent_gateway.event_hydrator import get_hydrator
from agent_gateway.webui_runtime_adapter import TurnResult


def _payload_dict(payload):
    return json.loads(payload) if isinstance(payload, str) else payload


def test_webui_adapter_retries_with_internal_auth_when_password_enabled(monkeypatch):
    monkeypatch.setenv("HERMES_WEBUI_PASSWORD", "AIFred_2026")
    monkeypatch.setenv("HERMES_WEBUI_HOST", "127.0.0.1")
    monkeypatch.setenv("HERMES_WEBUI_PORT", "8787")
    calls = []

    class _Resp:
        def __init__(self, payload, headers=None):
            self._payload = json.dumps(payload).encode("utf-8")
            self.headers = headers or {}
            self.status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, *args, **kwargs):
            return self._payload

    def fake_urlopen(req, timeout=0):
        cookie = req.headers.get("Cookie", "")
        internal_auth = any("hermes" in str(key).lower() and "auth" in str(key).lower() for key in req.headers)
        calls.append((req.full_url, req.method, cookie, internal_auth, timeout))
        if req.full_url.endswith("/api/session/new"):
            assert internal_auth is True
            return _Resp({"session": {"session_id": "sess-auth"}})
        raise AssertionError(f"unexpected request: {req.full_url}")

    monkeypatch.setattr(webui_runtime_adapter.urllib.request, "urlopen", fake_urlopen)

    session_id = webui_runtime_adapter.ensure_session("profile-auth", "model-auth", "provider-auth")

    assert session_id == "sess-auth"
    assert len(calls) == 1
    assert calls[0][0].endswith("/api/session/new")
    assert calls[0][2] == ""
    assert calls[0][3] is True


def test_webui_adapter_does_not_login_when_auth_disabled(monkeypatch):
    monkeypatch.delenv("HERMES_WEBUI_PASSWORD", raising=False)
    monkeypatch.setenv("HERMES_WEBUI_HOST", "127.0.0.1")
    monkeypatch.setenv("HERMES_WEBUI_PORT", "8787")
    calls = []

    class _Resp:
        def __init__(self, payload):
            self._payload = json.dumps(payload).encode("utf-8")
            self.headers = {}
            self.status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, *args, **kwargs):
            return self._payload

    def fake_urlopen(req, timeout=0):
        calls.append((req.full_url, req.method, req.headers.get("Cookie", "")))
        if req.full_url.endswith("/api/session/new"):
            return _Resp({"session": {"session_id": "sess-open"}})
        raise AssertionError(f"unexpected request: {req.full_url}")

    monkeypatch.setattr(webui_runtime_adapter.urllib.request, "urlopen", fake_urlopen)

    session_id = webui_runtime_adapter.ensure_session("profile-open", "model-open", "provider-open")

    assert session_id == "sess-open"
    assert calls == [("http://127.0.0.1:8787/api/session/new", "POST", "")]


def test_webui_adapter_propagates_http_error_detail_from_chat_start(monkeypatch):
    monkeypatch.delenv("HERMES_WEBUI_PASSWORD", raising=False)
    monkeypatch.setenv("HERMES_WEBUI_HOST", "127.0.0.1")
    monkeypatch.setenv("HERMES_WEBUI_PORT", "8787")

    class _Resp:
        def __init__(self, payload):
            self._payload = json.dumps(payload).encode("utf-8")
            self.headers = {}
            self.status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, *args, **kwargs):
            return self._payload

    def fake_urlopen(req, timeout=0):
        if req.full_url.endswith("/api/session/new"):
            return _Resp({"session": {"session_id": "sess-start-error"}})
        if req.full_url.endswith("/api/chat/start"):
            raise HTTPError(
                req.full_url,
                400,
                "Bad Request",
                hdrs={},
                fp=io.BytesIO(b'{"error":"No LLM provider configured"}'),
            )
        raise AssertionError(f"unexpected request: {req.full_url}")

    monkeypatch.setattr(webui_runtime_adapter.urllib.request, "urlopen", fake_urlopen)

    result = webui_runtime_adapter.run_turn(
        profile="profile-start-error",
        message="hello",
        session_id="",
    )

    assert result.success is False
    assert result.error == 'chat/start 400: {"error":"No LLM provider configured"}'


def test_webui_adapter_prefers_stream_connection_error_over_timeout(monkeypatch):
    monkeypatch.delenv("HERMES_WEBUI_PASSWORD", raising=False)
    monkeypatch.setenv("HERMES_WEBUI_HOST", "127.0.0.1")
    monkeypatch.setenv("HERMES_WEBUI_PORT", "8787")

    class _Resp:
        def __init__(self, payload):
            self._payload = json.dumps(payload).encode("utf-8")
            self.headers = {}
            self.status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, *args, **kwargs):
            return self._payload

    def fake_urlopen(req, timeout=0):
        if req.full_url.endswith("/api/session/new"):
            return _Resp({"session": {"session_id": "sess-stream-error"}})
        if req.full_url.endswith("/api/chat/start"):
            return _Resp({"stream_id": "stream-broken"})
        if "/api/chat/stream?stream_id=stream-broken" in req.full_url:
            raise OSError("No LLM provider configured")
        raise AssertionError(f"unexpected request: {req.full_url}")

    monkeypatch.setattr(webui_runtime_adapter.urllib.request, "urlopen", fake_urlopen)

    result = webui_runtime_adapter.run_turn(
        profile="profile-stream-error",
        message="hello",
        session_id="",
    )

    assert result.success is False
    assert result.error == "stream connection error: No LLM provider configured"


def test_run_turn_streaming_pushes_token_delta_to_live_sse(monkeypatch):
    run_id = "run_streaming_token"
    hydrator = get_hydrator()
    hydrator.remove_stream(run_id)
    ingested: list[tuple[str, dict]] = []

    def fake_ingest_standalone(conn, actual_run_id, event_type, *, preview="", payload=None, employee_id=None):
        assert actual_run_id == run_id
        ingested.append((event_type, payload or {}))

    def fake_run_turn(**kwargs):
        kwargs["on_event"]("token", {"text": "hello"})
        kwargs["on_event"]("token", {"text": " world"})
        return TurnResult(True, text="hello world", session_id=kwargs["session_id"] or "sess_token")

    monkeypatch.setattr(runtime_executor, "_ingest_standalone", fake_ingest_standalone)
    monkeypatch.setattr(webui_runtime_adapter, "run_turn", fake_run_turn)
    monkeypatch.setattr(runtime_executor, "_current_event_cursor", lambda conn, rid: 7, raising=False)

    try:
        success, text, error, session_id, usage = runtime_executor._run_turn_streaming(
            None,
            run_id,
            "emp_token",
            profile="profile-token",
            prompt_text="say hello",
            model="model-token",
            model_provider="provider-token",
            webui_session_id="sess_token",
        )

        assert success is True
        assert text == "hello world"
        assert error == ""
        assert session_id == "sess_token"
        assert usage == {}
        assert ingested == [("message_delta", {"delta": "hello world"})]

        stream = hydrator.subscribe_stream(run_id)
        assert stream is not None
        subscriber = stream.subscribe()
        events = []
        while True:
            try:
                event, payload = subscriber.get_nowait()
            except queue.Empty:
                break
            events.append((event, _payload_dict(payload)))

        timeline_payloads = [payload for event, payload in events if event == "timeline"]
        assert any(
            payload["event_type"] == "message_delta"
            and payload["event_cursor"] == 8
            and payload["payload"] == {"delta": "hello world"}
            for payload in timeline_payloads
        )
        assert not any(payload["payload"] == {"delta": "hello"} for payload in timeline_payloads)
        assert events[-1][0] == "stream_end"
    finally:
        hydrator.remove_stream(run_id)


def test_finalize_keeps_cancelled_run_cancelled(db_conn, seeded_enterprise):
    from team_panel.domain.entities import TeamRun
    from team_panel.transactions.uow import UnitOfWork

    with UnitOfWork(db_conn) as uow:
        conv = uow.conversations().get_by_id("conv_test")
        assert conv is not None
        uow.team_runs().create(
            TeamRun(
                id="run_cancel_keep",
                enterprise_id="ent_test",
                conversation_id=conv.id,
                trigger_type="private_message",
                execution_mode="single_agent",
                status="cancelled",
                entry_employee_id="emp_test",
            )
        )

    runtime_executor._finalize(
        "run_cancel_keep",
        success=False,
        output="later failure",
        error="boom",
        conn=db_conn,
    )

    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id("run_cancel_keep")
        assert run is not None
        assert run.status == "cancelled"


def test_run_turn_streaming_pushes_reasoning_and_tool_completion(monkeypatch):
    run_id = "run_streaming_process"
    hydrator = get_hydrator()
    hydrator.remove_stream(run_id)
    ingested: list[tuple[str, dict]] = []

    def fake_ingest_standalone(conn, actual_run_id, event_type, *, preview="", payload=None, employee_id=None):
        assert actual_run_id == run_id
        ingested.append((event_type, payload or {}))

    def fake_run_turn(**kwargs):
        kwargs["on_event"]("reasoning", {"text": "需要先查知识库。"})
        kwargs["on_event"]("tool", {"name": "knowledge_search", "args": {"query": "入职流程"}, "tid": "tool_1"})
        kwargs["on_event"](
            "tool_complete",
            {
                "name": "knowledge_search",
                "args": {"query": "入职流程"},
                "tid": "tool_1",
                "preview": "找到入职手册。",
                "is_error": False,
            },
        )
        return TurnResult(True, text="done", session_id=kwargs["session_id"] or "sess_process")

    monkeypatch.setattr(runtime_executor, "_ingest_standalone", fake_ingest_standalone)
    monkeypatch.setattr(webui_runtime_adapter, "run_turn", fake_run_turn)
    monkeypatch.setattr(runtime_executor, "_current_event_cursor", lambda conn, rid: 3)

    try:
        success, text, error, session_id, usage = runtime_executor._run_turn_streaming(
            None,
            run_id,
            "emp_process",
            profile="profile-process",
            prompt_text="summarize onboarding",
            model="model-process",
            model_provider="provider-process",
            webui_session_id="sess_process",
        )

        assert success is True
        assert text == "done"
        assert error == ""
        assert session_id == "sess_process"
        assert usage == {}
        assert ingested == [
            ("message_delta", {"delta": "需要先查知识库。", "kind": "reasoning"}),
            ("tool_call", {"tool": "knowledge_search", "args": {"query": "入职流程"}, "tid": "tool_1", "done": False}),
            (
                "tool_call",
                {
                    "tool": "knowledge_search",
                    "args": {"query": "入职流程"},
                    "tid": "tool_1",
                    "done": True,
                    "result_snippet": "找到入职手册。",
                    "is_error": False,
                },
            ),
        ]

        stream = hydrator.subscribe_stream(run_id)
        assert stream is not None
        subscriber = stream.subscribe()
        events = []
        while True:
            try:
                event, payload = subscriber.get_nowait()
            except queue.Empty:
                break
            if event == "timeline":
                events.append(_payload_dict(payload))

        assert [event["event_cursor"] for event in events] == [4, 5, 6]
        assert events[0]["event_type"] == "message_delta"
        assert events[0]["payload"] == {"delta": "需要先查知识库。", "kind": "reasoning"}
        assert events[1]["event_type"] == "tool_call"
        assert events[1]["payload"]["done"] is False
        assert events[2]["event_type"] == "tool_call"
        assert events[2]["payload"]["done"] is True
        assert events[2]["payload"]["result_snippet"] == "找到入职手册。"
    finally:
        hydrator.remove_stream(run_id)
