"""shared/service_client 验收（05 §5.3）：成功解码 + problem+json → 错误抛出。"""

import httpx
import pytest

from shared.errors import NotFound
from shared.service_client import ServiceClient


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


def test_post_idempotency_header_sent():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["idem"] = request.headers.get("Idempotency-Key")
        return httpx.Response(200, json={"data": None})

    client = ServiceClient("https://upstream.local", transport=httpx.MockTransport(handler))
    client.post("/write", json={"a": 1}, idempotency_key="key-123")
    assert seen["idem"] == "key-123"
    client.close()
