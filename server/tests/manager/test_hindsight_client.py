from __future__ import annotations

import httpx
import pytest

from manager_service.hindsight_client import HindsightClient, HindsightSettings, HindsightUnavailable
from shared.contracts.tenancy import TenantContext


def test_hindsight_client_sends_tenant_context_and_never_falls_back():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["tenant"] = request.headers["X-Tenant-ID"]
        seen["body"] = request.read()
        return httpx.Response(200, json={"items": []})

    client = HindsightClient(
        HindsightSettings("http://hindsight", "secret", "/recall", "/retain", "/delete"),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = client.recall(TenantContext(tenant_id="tenant-a", user_id="u", roles=[]),
                           employee_id="employee-a", query="hello", limit=3)
    assert result == {"items": []}
    assert seen["path"] == "/recall"
    assert seen["tenant"] == "tenant-a"
    assert b'"employee_id": "employee-a"' in seen["body"]


def test_hindsight_unconfigured_fails_closed():
    client = HindsightClient(HindsightSettings(None, None, None, None, None))
    with pytest.raises(HindsightUnavailable):
        client.recall(TenantContext(tenant_id="t", user_id="u", roles=[]),
                      employee_id="e", query="q", limit=1)
