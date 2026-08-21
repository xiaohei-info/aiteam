from __future__ import annotations

import httpx
import json
import pytest

from manager_service.hindsight_client import HindsightClient, HindsightSettings, HindsightUnavailable
from shared.contracts.tenancy import TenantContext


def test_hindsight_client_sends_tenant_context_and_never_falls_back():
    seen = {"methods": []}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["methods"].append(request.method)
        seen["path"] = request.url.path
        seen["tenant"] = request.headers["X-Tenant-ID"]
        seen["member"] = request.headers["X-Member-ID"]
        seen["body"] = request.read()
        return httpx.Response(200, json={"items": []})

    client = HindsightClient(
        HindsightSettings("http://hindsight", "secret", "/v1/default/banks/{bank_id}/memories/recall", "/retain", "/delete"),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = client.recall(TenantContext(tenant_id="tenant-a", user_id="u", roles=[]),
                           employee_id="employee-a", query="hello", limit=3)
    assert result == {"items": []}
    assert seen["methods"] == ["PUT", "POST"]
    assert seen["path"] == "/v1/default/banks/tenant_tenant-a_member_u_employee_employee-a/memories/recall"
    assert seen["tenant"] == "tenant-a"
    assert seen["member"] == "u"
    assert json.loads(seen["body"]) == {"query": "hello", "max_tokens": 768}


def test_env_backed_hindsight_client_uses_manager_derived_bank_scope(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        return httpx.Response(200, json={"items": []})

    monkeypatch.setenv("HINDSIGHT_URL", "http://hindsight")
    monkeypatch.setenv("HINDSIGHT_SERVICE_TOKEN", "manager-secret")
    monkeypatch.setenv("HINDSIGHT_RECALL_PATH", "/v1/default/banks/{bank_id}/memories/recall")
    client = HindsightClient(
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    client.recall(TenantContext(tenant_id="tenant-a", user_id="u", roles=[]), employee_id="employee-a", query="q", limit=1)
    from manager_service.hindsight_credentials import derive_hindsight_bank_id

    assert seen["path"] == f"/v1/default/banks/{derive_hindsight_bank_id('tenant-a', 'u', 'employee-a')}/memories/recall"


def test_hindsight_unconfigured_fails_closed():
    client = HindsightClient(HindsightSettings(None, None, None, None, None))
    with pytest.raises(HindsightUnavailable):
        client.recall(TenantContext(tenant_id="t", user_id="u", roles=[]),
                      employee_id="e", query="q", limit=1)
