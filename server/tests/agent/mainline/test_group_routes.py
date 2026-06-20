"""A2 验收：群聊北向路由 + 多 run 并入同一 timeline（端到端 over HTTP）。

端点：POST /api/agent/conversations/{id}/group-dispatch
  body: { text, experts:[{handle, system_prompt?, model?}] }
触发被 @ 的专家各起一个 run，事件并入同一 conversation 时间线（复用 A1 timeline 端点读取）。
"""

import pytest
from fastapi.testclient import TestClient

from agent_service.app import build_app
from agent_service.mainline.factory import build_mainline_service


@pytest.fixture
def client():
    svc = build_mainline_service()
    return TestClient(build_app(mainline_service=svc))


def _create_conv(client) -> str:
    return client.post("/api/agent/conversations", json={"title": "群聊"}).json()["data"]["id"]


def _roster_body(text: str) -> dict:
    return {
        "text": text,
        "experts": [
            {"handle": "alice", "system_prompt": "你是 Alice"},
            {"handle": "bob", "system_prompt": "你是 Bob", "model": "m1"},
            {"handle": "carol", "system_prompt": "你是 Carol"},
        ],
    }


def test_group_dispatch_triggers_mentioned_experts(client):
    cid = _create_conv(client)
    r = client.post(f"/api/agent/conversations/{cid}/group-dispatch",
                    json=_roster_body("@alice @bob 协作一下"))
    assert r.status_code == 200
    data = r.json()["data"]
    assert sorted(data["triggered_handles"]) == ["alice", "bob"]
    assert len(data["runs"]) == 2
    assert all(run["status"] == "completed" for run in data["runs"])


def test_group_dispatch_merges_into_single_timeline(client):
    cid = _create_conv(client)
    client.post(f"/api/agent/conversations/{cid}/group-dispatch",
                json=_roster_body("@alice @bob go"))
    events = client.get(f"/api/agent/conversations/{cid}/timeline").json()["data"]
    cursors = [e["cursor"] for e in events]
    assert cursors == list(range(1, len(events) + 1))  # 单调连续
    run_ids = {e["run_id"] for e in events}
    assert len(run_ids) == 2  # 两个 run 的事件交织进同一条 timeline


def test_group_dispatch_no_mention_no_run(client):
    cid = _create_conv(client)
    r = client.post(f"/api/agent/conversations/{cid}/group-dispatch",
                    json=_roster_body("大家好"))
    data = r.json()["data"]
    assert data["triggered_handles"] == []
    assert data["runs"] == []


def test_group_dispatch_unknown_conversation_404(client):
    r = client.post("/api/agent/conversations/nope/group-dispatch",
                    json=_roster_body("@alice hi"))
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")
