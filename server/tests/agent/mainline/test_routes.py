"""A1.3 验收：北向路由 + SSE/WS。

端点链路：建会话 -> 发消息 -> 起 run -> timeline 增量 -> SSE/WS 收归一事件 + 终态。
红线断言：SSE/WS 不下发 runtime 原生事件；envelope/problem+json 统一。
"""

import json

import pytest
from fastapi.testclient import TestClient

from agent_service.app import build_app
from agent_service.mainline.factory import build_mainline_service


@pytest.fixture
def client():
    # 共享同一 mainline_service 实例，使 SSE/WS 与 REST 命中同一 broker/store。
    svc = build_mainline_service()
    return TestClient(build_app(mainline_service=svc))


def _create_conv(client) -> str:
    r = client.post("/api/agent/conversations", json={"title": "t"})
    assert r.status_code == 200
    return r.json()["data"]["id"]


def test_conversation_crud_envelope(client):
    cid = _create_conv(client)
    r = client.get(f"/api/agent/conversations/{cid}")
    assert r.json()["data"]["state"] == "active"
    r = client.get("/api/agent/conversations")
    assert any(c["id"] == cid for c in r.json()["data"])
    r = client.put(f"/api/agent/conversations/{cid}/state", json={"state": "archived"})
    assert r.json()["data"]["state"] == "archived"


def test_missing_conversation_404_problem_json(client):
    r = client.get("/api/agent/conversations/nope")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "not_found"


def test_message_endpoints(client):
    cid = _create_conv(client)
    r = client.post(f"/api/agent/conversations/{cid}/messages",
                    json={"role": "user", "content": "hi"})
    assert r.status_code == 200
    r = client.get(f"/api/agent/conversations/{cid}/messages")
    assert [m["content"] for m in r.json()["data"]] == ["hi"]


def test_start_run_api_forwards_current_identity_tenant_to_service():
    """Route-level regression: authenticated local identity tenant must reach MainlineService.start_run."""
    from shared.contracts.auth import TokenClaims

    captured: dict = {}

    class _Service:
        async def start_run(self, conversation_id, *, task_id=None, run_spec=None, tenant_id=None):
            captured["conversation_id"] = conversation_id
            captured["tenant_id"] = tenant_id
            return {"id": "run-1", "conversation_id": conversation_id, "status": "completed"}

    def _identity():
        return TokenClaims(user_id="u-1", tenant_id="tenant-from-login", roles=["member"], exp=9999999999)

    from fastapi import FastAPI

    from agent_service.mainline.routes import build_mainline_router

    app = FastAPI()
    app.include_router(build_mainline_router(_Service(), identity_provider=_identity))
    client = TestClient(app)

    r = client.post("/api/agent/conversations/conv-1/runs", json={})

    assert r.status_code == 200, r.text
    assert captured == {"conversation_id": "conv-1", "tenant_id": "tenant-from-login"}


def test_start_run_api_forwards_run_spec_model_and_thinking():
    """北向 API 必须把 run_spec（指定模型/切换思考深度）下达到 runtime，否则 API 用户无从指定。"""
    from agent_gateway.fake_runtime import FakeDriver
    from shared.contracts.gateway import Executor, RunResult

    captured: dict = {}

    class _CapturingExecutor(Executor):
        async def execute(self, request, driver, on_event):
            captured["model"] = request.run_spec.model
            captured["thinking_level"] = request.run_spec.thinking_level
            return RunResult(run_id=request.run_id, success=True)

        async def cancel(self, run_id):
            return None

    svc = build_mainline_service(executor=_CapturingExecutor(), driver=FakeDriver())
    client = TestClient(build_app(mainline_service=svc))
    cid = _create_conv(client)
    r = client.post(f"/api/agent/conversations/{cid}/runs",
                    json={"run_spec": {"model": "gpt-5-codex", "thinking_level": "high"}})
    assert r.status_code == 200
    assert captured == {"model": "gpt-5-codex", "thinking_level": "high"}


def test_run_then_timeline_increment(client):
    cid = _create_conv(client)
    r = client.post(f"/api/agent/conversations/{cid}/runs", json={})
    assert r.status_code == 200
    assert r.json()["data"]["status"] == "completed"

    r = client.get(f"/api/agent/conversations/{cid}/timeline?after=0")
    events = r.json()["data"]
    types = [e["type"] for e in events]
    assert types[-1] == "run_succeeded"
    # 前端只见业务事件：无 runtime 原生类型。
    assert "text_delta" not in types and "completed" not in types
    cursors = [e["cursor"] for e in events]
    assert cursors == list(range(1, len(events) + 1))

    # 增量拉取 after=末游标 -> 空。
    r = client.get(f"/api/agent/conversations/{cid}/timeline?after={cursors[-1]}")
    assert r.json()["data"] == []


def test_task_endpoints(client):
    cid = _create_conv(client)
    r = client.post(f"/api/agent/conversations/{cid}/tasks", json={"title": "job"})
    assert r.status_code == 200
    assert r.json()["data"]["status"] == "pending"
    r = client.get(f"/api/agent/conversations/{cid}/tasks")
    assert r.json()["data"][0]["title"] == "job"


def test_sse_endpoint_registered_and_streams_text_event_stream():
    """SSE 生成器：补发历史增量（cursor>after），SSE 帧格式 `event: timeline`，只下发归一事件。

    直接驱动模块级生成器（TestClient 不适合迭代长连接无限流）。
    """
    import asyncio

    from agent_service.mainline.routes import sse_event_stream

    svc = build_mainline_service()
    conv = svc.create_conversation()
    asyncio.run(svc.start_run(conv.id))  # 产生历史事件

    async def collect():
        out = []
        gen = sse_event_stream(svc, conv.id, 0)
        # 只取历史补发段（直播段会阻塞，长连接语义）。历史段长度 = 已落 timeline 数。
        n = len(svc.read_timeline(conv.id, 0))
        for _ in range(n):
            out.append(await gen.__anext__())
        await gen.aclose()
        return out

    frames = asyncio.run(collect())
    assert all(f.startswith("event: timeline\ndata: ") for f in frames)
    payloads = [json.loads(f.split("data: ", 1)[1].strip()) for f in frames]
    types = [p["event"]["type"] for p in payloads if p["kind"] == "timeline"]
    assert types[-1] == "run_succeeded"
    assert "text_delta" not in types and "completed" not in types


def test_ws_handler_delivers_live_normalized_frames():
    """WS 直播：broker 推送的帧经 frame_to_dict 序列化后只含归一事件 + display 镜像。"""
    import asyncio

    from agent_service.mainline.routes import frame_to_dict

    svc = build_mainline_service()
    conv = svc.create_conversation()

    async def scenario():
        async with await svc.broker.subscribe(conv.id) as sub:
            await svc.start_run(conv.id)  # 直播事件扇出到本订阅
            frames = []
            while not sub.empty():
                frames.append(frame_to_dict(sub.get_nowait()))
            return frames

    frames = asyncio.run(scenario())
    timeline_types = [f["event"]["type"] for f in frames if f["kind"] == "timeline"]
    display_states = [f["display"] for f in frames if f["kind"] == "display"]
    assert timeline_types[-1] == "run_succeeded"
    assert "text_delta" not in timeline_types and "completed" not in timeline_types
    # 展示态只经流（streaming/resolved 镜像），不落库。
    assert "streaming" in display_states and "resolved" in display_states


def test_websocket_end_to_end_live_stream(client):
    """真实 WS 链路（TestClient）：连上 -> 起 run -> 实时收归一事件直到终态。

    退出 with 即断开，WS 处理器捕获 WebSocketDisconnect 退出（不泄漏）。
    """
    cid = _create_conv(client)
    with client.websocket_connect(f"/api/agent/ws/conversations/{cid}/timeline") as ws:
        client.post(f"/api/agent/conversations/{cid}/runs", json={})
        types = []
        for _ in range(50):
            frame = ws.receive_json()
            if frame["kind"] == "timeline":
                types.append(frame["event"]["type"])
                if frame["event"]["type"] == "run_succeeded":
                    break
        assert "run_succeeded" in types
        assert "text_delta" not in types and "completed" not in types
