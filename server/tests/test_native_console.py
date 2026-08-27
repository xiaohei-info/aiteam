from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from starlette.requests import Request

from manager_service.routes_native_console import build_native_console_router
from operation_service.routes_native_console import build_newapi_console_router
from shared.app_factory import create_app
from shared.config import Settings
from shared.contracts.auth import TokenClaims
from shared.native_console import (
    NativeConsoleConfig,
    NativeConsolePathError,
    NativeConsoleProxy,
)


class _Verifier:
    def verify(self, token: str) -> TokenClaims:
        if token not in {"platform-token", "enterprise-token"}:
            raise ValueError("bad token")
        roles = ["system_admin"] if token == "platform-token" else ["owner"]
        return TokenClaims(user_id="u1", tenant_id="t1", roles=roles, exp=4_000_000_000)


def _request(path: str, *, headers: dict[str, str] | None = None, query_string: bytes = b"") -> Request:
    raw_headers = [(key.lower().encode(), value.encode()) for key, value in (headers or {}).items()]

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "raw_path": path.encode(),
            "headers": raw_headers,
            "query_string": query_string,
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("testclient", 50000),
            "root_path": "",
        },
        receive,
    )


def test_native_console_proxy_injects_fixed_credentials_and_rewrites_root_urls():
    seen: dict[str, str] = {}

    async def run() -> bytes:
        async def upstream(request: httpx.Request) -> httpx.Response:
            seen["authorization"] = request.headers.get("authorization", "")
            seen["cookie"] = request.headers.get("cookie", "")
            seen["query"] = request.url.query.decode()
            return httpx.Response(
                200,
                headers={"content-type": "application/javascript"},
                content=b'fetch("/api/status");',
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        try:
            proxy = NativeConsoleProxy(
                NativeConsoleConfig(
                    name="test",
                    base_url="http://vendor.test",
                    prefix="/api/operation/newapi-console",
                    upstream_headers={"Authorization": "Bearer service-token"},
                    blocked_query_params=frozenset({"workspace"}),
                ),
                client=client,
            )
            response = await proxy.proxy(
                _request(
                    "/api/operation/newapi-console/app.js",
                    headers={"Authorization": "Bearer browser-token", "Cookie": "manager-token"},
                    query_string=b"workspace=other&keep=yes",
                ),
                "app.js",
            )
            return response.body
        finally:
            await client.aclose()

    body = asyncio.run(run()).decode()
    assert "/api/operation/newapi-console/api/status" in body
    assert seen == {"authorization": "Bearer service-token", "cookie": "", "query": "keep=yes"}


def test_native_console_proxy_rewrites_html_and_scopes_upstream_cookies():
    async def run() -> tuple[bytes, str]:
        async def upstream(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={
                    "content-type": "text/html",
                    "set-cookie": "vendor_session=opaque; Domain=vendor.test; Path=/; HttpOnly",
                },
                content=b'<script src="/_next/static/app.js"></script><a href="/dashboard">Dashboard</a>',
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        try:
            proxy = NativeConsoleProxy(
                NativeConsoleConfig(name="test", base_url="http://vendor.test", prefix="/console"),
                client=client,
            )
            response = await proxy.proxy(_request("/console/", headers={"Cookie": "manager-token"}), "")
            return response.body, response.headers.get("set-cookie", "")
        finally:
            await client.aclose()

    body, cookie = asyncio.run(run())
    assert b"/console/_next/static/app.js" in body
    assert b"/console/dashboard" in body
    assert "Domain=vendor.test" not in cookie
    assert "Path=/console" in cookie


def test_native_console_proxy_rejects_path_traversal():
    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200)))
        try:
            proxy = NativeConsoleProxy(
                NativeConsoleConfig(name="test", base_url="http://vendor.test", prefix="/console"),
                client=client,
            )
            with pytest.raises(NativeConsolePathError):
                await proxy.proxy(_request("/console/../secret"), "../secret")
        finally:
            await client.aclose()

    asyncio.run(run())


def test_operation_console_session_is_role_gated_and_does_not_return_component_token(monkeypatch):
    monkeypatch.setenv("NEWAPI_ADMIN_BASE_URL", "http://newapi.internal")
    monkeypatch.setenv("NEWAPI_ADMIN_TOKEN", "newapi-secret")
    monkeypatch.setenv("NEWAPI_ADMIN_USER_ID", "1")
    app = create_app(Settings(tier="operation", service_name="operation"), APIRouter())
    app.include_router(build_newapi_console_router(_Verifier()))
    client = TestClient(app)

    response = client.post(
        "/api/operation/newapi-console/session",
        headers={"Authorization": "Bearer platform-token"},
    )
    assert response.status_code == 200
    assert response.json()["data"] == {
        "url": "/api/operation/newapi-console/",
        "expires_in": 600,
    }
    assert "newapi-secret" not in response.text
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "Path=/api/operation/newapi-console" in response.headers["set-cookie"]

    forbidden = client.post(
        "/api/operation/newapi-console/session",
        headers={"Authorization": "Bearer enterprise-token"},
    )
    assert forbidden.status_code == 403


def test_manager_native_console_session_has_separate_component_paths(monkeypatch):
    monkeypatch.setenv("LIGHTRAG_URL", "http://lightrag.internal")
    monkeypatch.setenv("LIGHTRAG_API_KEY", "lightrag-secret")
    monkeypatch.setenv("LIGHTRAG_WORKSPACE", "enterprise_shared")
    monkeypatch.setenv("HINDSIGHT_CONSOLE_URL", "http://hindsight-ui.internal")
    monkeypatch.setenv("HINDSIGHT_SERVICE_TOKEN", "hindsight-secret")
    app = create_app(Settings(tier="manager", service_name="manager"), APIRouter())
    app.include_router(build_native_console_router(_Verifier()))
    client = TestClient(app)
    headers = {"Authorization": "Bearer enterprise-token"}

    rag = client.post("/api/manager/native-console/lightrag/session", headers=headers)
    hindsight = client.post("/api/manager/native-console/hindsight/session", headers=headers)
    assert rag.status_code == hindsight.status_code == 200
    assert rag.json()["data"]["url"] == "/api/manager/native-console/lightrag/"
    assert hindsight.json()["data"]["url"] == "/api/manager/native-console/hindsight/"
    assert "lightrag-secret" not in rag.text
    assert "hindsight-secret" not in hindsight.text
    assert "Path=/api/manager/native-console/lightrag" in rag.headers["set-cookie"]
    assert "Path=/api/manager/native-console/hindsight" in hindsight.headers["set-cookie"]
