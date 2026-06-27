"""三端 OpenAPI route contract matrix（L1）。

目标：每个 `/api/<tier>/*` 北向 route 都必须由真实 FastAPI app 装配出来，且 HTTP
响应不能被 SPA fallback 或静态资源层吞成 text/html。
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from run import get_app

TIERS = ("operation", "manager", "agent")
HTTP_METHODS = ("get", "post", "put", "patch", "delete")
PLACEHOLDER_VALUES = {
    "catalog_type": "experts",
    "conversation_id": "missing-conversation",
    "run_id": "missing-run",
    "loop_id": "missing-loop",
    "tenant_id": "missing-tenant",
}


def _path_for_request(path_template: str) -> str:
    path = path_template
    for name, value in PLACEHOLDER_VALUES.items():
        path = path.replace("{" + name + "}", value)
    while "{" in path and "}" in path:
        start = path.index("{")
        end = path.index("}", start)
        path = path[:start] + "missing-id" + path[end + 1:]
    return path


def _body_for_request(operation: dict[str, Any]) -> dict[str, Any] | None:
    if "requestBody" not in operation:
        return None
    return {}


def _route_cases() -> list[tuple[str, str, str, bool]]:
    cases: list[tuple[str, str, str, bool]] = []
    for tier in TIERS:
        spec = TestClient(get_app(tier)).get("/openapi.json").json()
        for path, methods in spec["paths"].items():
            if not path.startswith(f"/api/{tier}/") and not path.startswith("/api/auth/"):
                continue
            for method, operation in methods.items():
                if method not in HTTP_METHODS:
                    continue
                cases.append((tier, method.upper(), path, "requestBody" in operation))
    return cases


@pytest.mark.parametrize(
    ("tier", "method", "path_template", "has_request_body"),
    _route_cases(),
    ids=lambda value: value if isinstance(value, str) else None,
)
def test_api_routes_return_envelope_or_problem_json(
    tier: str,
    method: str,
    path_template: str,
    has_request_body: bool,
):
    client = TestClient(get_app(tier))
    path = _path_for_request(path_template)
    kwargs: dict[str, Any] = {}
    if has_request_body:
        kwargs["json"] = _body_for_request({"requestBody": {}})

    response = client.request(method, path, **kwargs)
    content_type = response.headers.get("content-type", "")

    assert not content_type.startswith("text/html"), f"{method} {path} returned HTML"
    assert "<!doctype html" not in response.text.lower()

    if 200 <= response.status_code < 300:
        body = response.json()
        assert "data" in body, f"{method} {path} success response is not an envelope"
        assert "meta" in body or "page" in body, f"{method} {path} envelope lacks meta/page"
    else:
        assert content_type.startswith("application/problem+json"), (
            f"{method} {path} error response is not problem+json: {content_type}"
        )
        body = response.json()
        assert body["status"] == response.status_code
        assert body["code"]
