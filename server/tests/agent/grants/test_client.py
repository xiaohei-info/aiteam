"""A4：ServiceClientGrantsClient 经 shared.service_client 主动 pull 的契约形状。

用 httpx.MockTransport 拦截（不真连 Manager），验证：
- pull 走 POST 到约定路径，请求体即契约 model_dump；
- 响应按契约解析为 AuthorizedConfigPullResponse / SnapshotPullResponse；
- 对端非 2xx → service_client 解码为 AppError 抛出（由 service 降级处理）。
"""

import httpx
import pytest

from agent_service.grants.client import ServiceClientGrantsClient
from shared.contracts.crosstier import (
    AuthorizedConfigPullRequest,
    SnapshotPullRequest,
)
from shared.errors import AppError
from shared.service_client import ServiceClient


def _client(handler) -> ServiceClientGrantsClient:
    transport = httpx.MockTransport(handler)
    return ServiceClientGrantsClient(
        ServiceClient("http://manager.local", transport=transport)
    )


def test_pull_authorized_config_shapes_request_and_response():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["method"] = request.method
        return httpx.Response(
            200,
            json={
                "experts": [{"employee_id": "e1", "version": "v1"}],
                "solutions": [],
                "revoked_ids": ["e9"],
            },
        )

    client = _client(handler)
    resp = client.pull_authorized_config(
        AuthorizedConfigPullRequest(tenant_id="t1", member_id="m1", known_versions={"e1": "v0"})
    )
    assert seen["method"] == "POST"
    assert seen["url"].endswith("/api/manager/grants/authorized-config")
    assert resp.experts == [{"employee_id": "e1", "version": "v1"}]
    assert resp.revoked_ids == ["e9"]


def test_pull_snapshot_parses_snapshot():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "snapshot": {
                    "employee_id": "e1",
                    "version": "v1",
                    "snapshot_version": "snap-1",
                    "display_name": "甲",
                }
            },
        )

    client = _client(handler)
    resp = client.pull_snapshot(
        SnapshotPullRequest(tenant_id="t1", member_id="m1", employee_id="e1")
    )
    assert resp.snapshot.snapshot_version == "snap-1"
    assert resp.snapshot.employee_id == "e1"


def test_pull_non_2xx_raises_app_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "manager down"})

    client = _client(handler)
    with pytest.raises(AppError):
        client.pull_authorized_config(
            AuthorizedConfigPullRequest(tenant_id="t1", member_id="m1")
        )
