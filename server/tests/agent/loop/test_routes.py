"""A3 验收：Loop 北向路由（端到端 over HTTP）。

端点：
  POST   /api/agent/loops                         建 loop
  GET    /api/agent/loops                         列 loop
  GET    /api/agent/loops/{id}                    取 loop
  POST   /api/agent/loops/{id}/enable             启用
  POST   /api/agent/loops/{id}/disable            停用
  POST   /api/agent/loops/{id}/fire               立即手动触发（不经 cron）
  POST   /api/agent/loops/tick                    手动驱动一次调度 tick（dev/测试）

红线：触发产生的 run 与私聊 run 同构，事件并入 conversation timeline（复用 A1 timeline 端点）。
envelope/problem+json 统一。
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
    return client.post("/api/agent/conversations", json={"title": "巡检"}).json()["data"]["id"]


def _create_loop(client, conv_id: str, *, enabled: bool = False) -> str:
    r = client.post("/api/agent/loops", json={
        "conversation_id": conv_id,
        "cron": "* * * * *",
        "run_spec": {"system_prompt": "每日巡检", "model": "m1"},
        "enabled": enabled,
    })
    assert r.status_code == 200
    return r.json()["data"]["id"]


def test_create_loop_default_disabled(client):
    cid = _create_conv(client)
    r = client.post("/api/agent/loops", json={
        "conversation_id": cid, "cron": "*/5 * * * *",
    })
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["conversation_id"] == cid
    assert data["cron"] == "*/5 * * * *"
    assert data["status"] == "paused"
    assert data["fire_count"] == 0


def test_list_and_get_loop(client):
    cid = _create_conv(client)
    loop_id = _create_loop(client, cid)
    r = client.get("/api/agent/loops")
    assert any(l["id"] == loop_id for l in r.json()["data"])
    r = client.get(f"/api/agent/loops/{loop_id}")
    assert r.json()["data"]["id"] == loop_id


def test_enable_disable(client):
    cid = _create_conv(client)
    loop_id = _create_loop(client, cid)
    r = client.post(f"/api/agent/loops/{loop_id}/enable")
    assert r.json()["data"]["status"] == "active"
    r = client.post(f"/api/agent/loops/{loop_id}/disable")
    assert r.json()["data"]["status"] == "paused"


def test_fire_loop_now_starts_run(client):
    """手动触发：绕过 cron，直接起 run -> run 终态落库、事件并入 timeline。"""
    cid = _create_conv(client)
    loop_id = _create_loop(client, cid)

    r = client.post(f"/api/agent/loops/{loop_id}/fire")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["ok"] is True
    run_id = data["run_id"]
    assert run_id is not None

    # run 终态落库（复用 A1 run 端点）。
    r = client.get(f"/api/agent/runs/{run_id}")
    assert r.json()["data"]["status"] == "succeeded"

    # loop 记了一次 fire。
    r = client.get(f"/api/agent/loops/{loop_id}")
    assert r.json()["data"]["fire_count"] == 1
    assert r.json()["data"]["last_run_id"] == run_id

    # 事件并入 conversation timeline。
    r = client.get(f"/api/agent/conversations/{cid}/timeline")
    events = r.json()["data"]
    assert events
    assert events[-1]["type"] == "run_succeeded"


def test_tick_fires_enabled_loops_at_due_time(client):
    """手动 tick：以当前时刻判定 enabled loop。由于 cron="* * * * *" 必然命中。"""
    cid = _create_conv(client)
    _create_loop(client, cid, enabled=True)

    r = client.post("/api/agent/loops/tick")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1
    assert data[0]["ok"] is True
    assert data[0]["run_id"] is not None


def test_tick_skips_disabled_loops(client):
    cid = _create_conv(client)
    _create_loop(client, cid, enabled=False)

    r = client.post("/api/agent/loops/tick")
    assert r.json()["data"] == []


def test_missing_loop_404_problem_json(client):
    r = client.get("/api/agent/loops/nope")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "not_found"


def test_fire_missing_loop_404(client):
    r = client.post("/api/agent/loops/nope/fire")
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"
