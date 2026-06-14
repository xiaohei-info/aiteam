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
