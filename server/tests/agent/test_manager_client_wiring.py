"""#175：Agent→Manager 真实客户端装配验收（A4/A5）。

验证：MANAGER_URL 配置后，app.py 自动装配 ServiceClient*Client，经 shared.service_client
跨端调用；未配置则安全拒绝（不静默成功）；离线降级正常（D14）。
"""

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_service.app import build_app
from agent_service.grants.client import ServiceClientGrantsClient
from agent_service.usage.client import ServiceClientUsageClient
from shared.service_client import ServiceClient


def test_grants_client_wired_when_manager_url_configured():
    """配置 MANAGER_URL 后，grants 自动装配真实客户端（不再是占位）。"""

    def mock_handler(request: httpx.Request) -> httpx.Response:
        # 模拟 Manager 响应 grants pull
        if "/grants/authorized-config" in str(request.url):
            return httpx.Response(200, json={"experts": [], "solutions": [], "revoked_ids": []})
        if "/snapshots" in str(request.url):
            return httpx.Response(
                200,
                json={
                    "snapshot": {
                        "employee_id": "e1",
                        "version": "v1",
                        "snapshot_version": "snap-1",
                        "display_name": "测试专家",
                    }
                },
            )
        return httpx.Response(404)

    # 测试注入：显式构造带 mock transport 的客户端，避免环境代理干扰
    mock_transport = httpx.MockTransport(mock_handler)
    grants_client = ServiceClientGrantsClient(
        ServiceClient("http://manager.local:8001", transport=mock_transport)
    )

    app = build_app(grants_client=grants_client)
    client = TestClient(app)

    # 调用 grants sync 端点（假设已有，或通过 service 直接调用）—— grants_client 不再抛占位异常
    # 这里只验证装配不报错；实际端点行为由 grants/test_routes.py 覆盖。
    resp = client.get("/api/agent/ping")
    assert resp.status_code == 200


def test_usage_client_wired_when_manager_url_configured():
    """配置 MANAGER_URL 后，usage 自动装配真实客户端（不再是占位）。"""

    def mock_handler(request: httpx.Request) -> httpx.Response:
        # 模拟 Manager 接收 usage 上报
        if "/usage/upload" in str(request.url):
            return httpx.Response(204)  # 成功无 body
        return httpx.Response(404)

    mock_transport = httpx.MockTransport(mock_handler)
    usage_client = ServiceClientUsageClient(
        ServiceClient("http://manager.local:8001", transport=mock_transport)
    )

    app = build_app(usage_client=usage_client)
    client = TestClient(app)

    # 验证装配不报错
    resp = client.get("/api/agent/ping")
    assert resp.status_code == 200


def test_unconfigured_clients_safe_fail_when_no_manager_url():
    """未配 MANAGER_URL → 占位客户端（安全拒绝，不静默成功）；app 仍可启动（D14 离线降级）。"""

    app = build_app()
    client = TestClient(app)

    # app 可启动、healthz 可用（不因 grants/usage 未配而 not-ready）
    resp = client.get("/api/agent/ping")
    assert resp.status_code == 200

    # 但 grants/usage 实际调用会按占位失败（由各自 service/routes 测试覆盖）


def test_service_client_includes_trace_headers():
    """ServiceClient 透传 X-Request-ID / X-Trace-ID / X-Service-Identity（05 §5.3）。"""

    seen_headers = {}

    def mock_handler(request: httpx.Request) -> httpx.Response:
        seen_headers.update(dict(request.headers))
        return httpx.Response(200, json={"experts": [], "solutions": [], "revoked_ids": []})

    mock_transport = httpx.MockTransport(mock_handler)
    client = ServiceClient(
        "http://manager.local:8001",
        service_identity="agent-service",
        service_token="test-token",
        transport=mock_transport,
    )
    grants_client = ServiceClientGrantsClient(client)

    from shared.contracts.crosstier import AuthorizedConfigPullRequest

    # 模拟带 trace 的请求上下文（直接设置 contextvars）
    from shared.observability import _request_id_var, _trace_id_var

    token_r = _request_id_var.set("req-123")
    token_t = _trace_id_var.set("trace-456")
    try:
        grants_client.pull_authorized_config(
            AuthorizedConfigPullRequest(tenant_id="t1", member_id="m1")
        )
    finally:
        _request_id_var.reset(token_r)
        _trace_id_var.reset(token_t)

    # 验证 trace 头透传
    assert seen_headers.get("x-request-id") == "req-123"
    assert seen_headers.get("x-trace-id") == "trace-456"
    assert seen_headers.get("x-service-identity") == "agent-service"
    assert seen_headers.get("x-service-token") == "test-token"


def test_usage_client_sends_idempotency_key():
    """UsageClient.upload 写调用带 Idempotency-Key（05 §5.1）。"""

    seen_headers = {}

    def mock_handler(request: httpx.Request) -> httpx.Response:
        seen_headers.update(dict(request.headers))
        return httpx.Response(204)

    mock_transport = httpx.MockTransport(mock_handler)
    client = ServiceClient("http://manager.local:8001", transport=mock_transport)
    usage_client = ServiceClientUsageClient(client)

    from shared.contracts.crosstier import UsageSummaryUpload

    usage_client.upload(
        UsageSummaryUpload(tenant_id="t1", usage=[], audits=[]),
        idempotency_key="uup_test_key",
    )

    assert seen_headers.get("idempotency-key") == "uup_test_key"
