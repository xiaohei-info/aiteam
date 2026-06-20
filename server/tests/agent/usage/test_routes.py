"""A5 验收：usage outbox 北向路由（只读 pending + 手动 flush）。

经 TestClient 验证端点装配与 envelope 形状；用 fake usage_client 注入，不真连 Manager。
"""

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from fastapi import FastAPI

from agent_service.app import build_app
from agent_service.usage.factory import build_usage_service
from agent_service.usage.models import RawUsageEvent
from agent_service.usage.routes import build_usage_router
from shared.contracts.crosstier import UsageSummaryUpload


class CapturingClient:
    def __init__(self) -> None:
        self.calls: list[UsageSummaryUpload] = []

    def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None:
        self.calls.append(payload)


def test_outbox_and_flush_endpoints():
    client = CapturingClient()
    service = build_usage_service(client=client)
    service.record_usage("t1", [
        RawUsageEvent(run_id="r1", employee_id="e1", usage={"total_tokens": 5},
                      occurred_at=datetime(2026, 6, 18, 10, 1, tzinfo=timezone.utc)),
    ])

    app = FastAPI()
    app.include_router(build_usage_router(service))
    http = TestClient(app)

    listed = http.get("/api/agent/usage/outbox")
    assert listed.status_code == 200
    assert len(listed.json()["data"]) == 1

    flushed = http.post("/api/agent/usage/flush")
    assert flushed.status_code == 200
    assert flushed.json()["data"]["sent"] == 1
    assert client.calls  # 经 fake client 上报


def test_default_app_wires_usage_routes():
    """默认 app 装配的 usage 路由可访问，pending 为空（对端未配置，无 record 触发）。"""
    http = TestClient(build_app())
    resp = http.get("/api/agent/usage/outbox")
    assert resp.status_code == 200
    assert resp.json()["data"] == []
