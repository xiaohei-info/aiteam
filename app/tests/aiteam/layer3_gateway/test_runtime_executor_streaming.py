"""Runtime executor live streaming tests."""

import json
import queue

from agent_gateway import runtime_executor
from agent_gateway import webui_runtime_adapter
from agent_gateway.event_hydrator import get_hydrator
from agent_gateway.webui_runtime_adapter import TurnResult


def _payload_dict(payload):
    return json.loads(payload) if isinstance(payload, str) else payload


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
