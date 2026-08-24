import json

import httpx
import pytest

from operation_service.newapi_client import NewApiAdminClient, NewApiError
from operation_service.platform_provider_service import newapi_urls


def test_newapi_url_is_configurable_like_other_manager_services(monkeypatch):
    monkeypatch.setenv("NEWAPI_URL", "https://relay.example/ai")
    monkeypatch.delenv("NEWAPI_ADMIN_BASE_URL", raising=False)
    monkeypatch.delenv("NEWAPI_PUBLIC_BASE_URL", raising=False)
    assert newapi_urls() == ("https://relay.example/ai", "https://relay.example/ai/v1")


def test_explicit_newapi_urls_override_common_base(monkeypatch):
    monkeypatch.setenv("NEWAPI_URL", "https://relay.example/ai")
    monkeypatch.setenv("NEWAPI_ADMIN_BASE_URL", "http://newapi:3000")
    monkeypatch.setenv("NEWAPI_PUBLIC_BASE_URL", "https://relay.example/v1")
    assert newapi_urls() == ("http://newapi:3000", "https://relay.example/v1")


def test_newapi_client_uses_server_management_identity_and_normalizes_models():
    seen = {}

    def handler(request: httpx.Request):
        seen["headers"] = request.headers
        seen["path"] = request.url.path
        return httpx.Response(200, json={"success": True, "data": ["minimax-m3", "minimax-m3", " gpt-4o "]})

    client = NewApiAdminClient("http://newapi.test", "admin-pat", "1", transport=httpx.MockTransport(handler))
    assert client.fetch_channel_models(7) == ["gpt-4o", "minimax-m3"]
    assert seen["path"] == "/api/channel/fetch_models/7"
    assert seen["headers"]["authorization"] == "Bearer admin-pat"
    assert seen["headers"]["new-api-user"] == "1"


def test_newapi_client_checks_business_failure_even_on_http_200():
    client = NewApiAdminClient(
        "http://newapi.test", "admin-pat", "1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"success": False, "message": "denied"})),
    )
    with pytest.raises(NewApiError, match="denied"):
        client.fetch_channel_models(7)


def test_newapi_client_rejects_oversized_responses():
    client = NewApiAdminClient(
        "http://newapi.test", "admin-pat", "1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=json.dumps({"success": True, "data": "x" * (2 * 1024 * 1024)}))),
    )
    with pytest.raises(NewApiError, match="2 MiB"):
        client.pricing()
