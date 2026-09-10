"""shared/service_client 验收（05 §5.3）：成功解码 + problem+json → 错误抛出。"""

import httpx
import pytest

from shared.auth import generate_rsa_keypair
from shared.errors import NotFound, Unauthorized
from shared.observability import get_propagation_headers
from shared.service_client import ServiceClient
from shared.service_identity import ServiceIdentitySigner


def _transport():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/ok":
            return httpx.Response(200, json={"data": {"x": 1}})
        if request.url.path == "/missing":
            return httpx.Response(
                404,
                json={"type": "t", "title": "Not Found", "status": 404,
                      "code": "not_found", "detail": "gone"},
                headers={"content-type": "application/problem+json"},
            )
        return httpx.Response(204)
    return httpx.MockTransport(handler)


def test_get_success_decodes_body():
    client = ServiceClient("https://upstream.local", transport=_transport())
    assert client.get("/ok") == {"data": {"x": 1}}
    client.close()


def test_problem_json_raises_typed_error():
    client = ServiceClient("https://upstream.local", transport=_transport())
    with pytest.raises(NotFound):
        client.get("/missing")
    client.close()


def test_propagation_headers_include_valid_w3c_traceparent():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["traceparent"] = request.headers.get("traceparent")
        return httpx.Response(200, json={"data": None})

    client = ServiceClient(
        "https://upstream.local",
        transport=httpx.MockTransport(handler),
    )
    client.get("/propagation")
    traceparent = seen["traceparent"]
    assert traceparent is not None
    parts = traceparent.split("-")
    assert len(parts) == 4
    assert parts[0] == "00"
    assert len(parts[1]) == 32 and set(parts[1]) != {"0"}
    assert len(parts[2]) == 16 and set(parts[2]) != {"0"}
    assert len(parts[3]) == 2
    assert get_propagation_headers()["traceparent"] != traceparent
    client.close()


def test_service_client_rejects_invalid_modes_targets_and_partial_signers(monkeypatch):
    with pytest.raises(ValueError):
        ServiceClient("https://upstream.local", service_auth_mode="broken")
    monkeypatch.setenv("SERVICE_IDENTITY_TARGET_ORIGIN", "https://other.local")
    with pytest.raises(ValueError, match="target origin"):
        ServiceClient("https://upstream.local")
    monkeypatch.delenv("SERVICE_IDENTITY_TARGET_ORIGIN", raising=False)
    with pytest.raises(ValueError):
        ServiceClient("https://upstream.local", service_private_key="private")


def test_service_client_signed_and_legacy_error_paths(monkeypatch):
    private_key, _ = generate_rsa_keypair()
    signer = ServiceIdentitySigner(private_key, kid="k", issuer="issuer", subject="service", deployment_id="deployment", audience="peer")
    client = ServiceClient("https://upstream.local", service_signer=signer, service_auth_mode="legacy", aiteam_env="production")
    with pytest.raises(Unauthorized, match="legacy"):
        client._headers(None, path="/write")
    client.close()

    monkeypatch.setenv("SERVICE_IDENTITY_PRIVATE_KEY", "invalid")
    monkeypatch.setenv("SERVICE_IDENTITY_KEY_ID", "k")
    monkeypatch.setenv("SERVICE_IDENTITY_ISSUER", "issuer")
    monkeypatch.setenv("SERVICE_IDENTITY_DEPLOYMENT_ID", "deployment")
    client = ServiceClient("https://upstream.local", service_auth_mode="signed", aiteam_env="test")
    with pytest.raises(Unauthorized, match="not configured"):
        client.get("/write")
    client.close()


def test_post_idempotency_header_sent():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["idem"] = request.headers.get("Idempotency-Key")
        return httpx.Response(200, json={"data": None})

    client = ServiceClient("https://upstream.local", transport=httpx.MockTransport(handler))
    client.post("/write", json={"a": 1}, idempotency_key="key-123")
    assert seen["idem"] == "key-123"
    client.close()
