"""AITEAM-331 B3 回归：Operator→Manager 目录通知网关必须携带 service_token。

历史 bug：catalog_dependencies.get_catalog_gateway() 构造 ServiceClient 时遗漏 service_token，
导致目录发布/下架/可见范围变更通知（/api/manager/catalog/notify）以无鉴权裸调用发出——
被调端 verify_service_token 必然拒绝，且无法审计来源。本测试断言该路径已修。
"""

from __future__ import annotations

import httpx

from operation_service.catalog_dependencies import get_catalog_gateway
from operation_service.catalog_gateway import HttpCatalogManagerGateway


def test_catalog_gateway_client_carries_service_token(monkeypatch):
    """AITEAM-331 B3：get_catalog_gateway() 构造的客户端必须附带 service_token。"""
    monkeypatch.setenv("MANAGER_URL", "http://manager.test.local:8000")
    monkeypatch.setenv("SERVICE_TOKEN", "op-real-secret-abc")

    gateway = get_catalog_gateway()
    assert isinstance(gateway, HttpCatalogManagerGateway)
    # 内部 ServiceClient 应携带 service_token（出站请求自动附带 X-Service-Token）。
    assert gateway._client._service_token == "op-real-secret-abc"


def test_catalog_gateway_sends_x_service_token_on_notify(monkeypatch):
    """AITEAM-331 B3：notify_catalog_release 出站请求头携带 X-Service-Token。"""
    monkeypatch.setenv("MANAGER_URL", "http://manager.test.local:8000")
    monkeypatch.setenv("SERVICE_TOKEN", "op-real-secret-abc")

    seen_headers = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers["X-Service-Token"] = request.headers.get("X-Service-Token")
        seen_headers["X-Service-Identity"] = request.headers.get("X-Service-Identity")
        return httpx.Response(200, json={"data": None})

    gateway = get_catalog_gateway()
    # 替换内部 httpx.Client 的 transport 为 mock（保留已设的 service_token）。
    gateway._client._client = httpx.Client(
        base_url="http://manager.test.local:8000",
        transport=httpx.MockTransport(handler),
    )

    from shared.contracts.crosstier import CatalogReleaseNotify

    notify = CatalogReleaseNotify(
        catalog_type="expert_template",
        template_id="tpl-1",
        action="publish",
        version="1",
    )
    gateway.notify_catalog_release(notify, idempotency_key="k-1")

    assert seen_headers["X-Service-Token"] == "op-real-secret-abc"
    assert seen_headers["X-Service-Identity"] is not None
