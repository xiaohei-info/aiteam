"""RealManagerLoginClient 自动解析 tenant 单元测试（#382).

tenant_hint 空缺时，应调 Manager `POST /api/auth/resolve-tenant-by-account` 解析员工账号所属 tenant，
再走 login / owner-reset；404 / 409 透传；其它失败归一为 ManagerUnreachable。
"""

import httpx
import pytest

from agent_service.auth.local_login import LoginRequest, ManagerUnreachable, PasswordResetRequest
from agent_service.auth.manager_client import RealManagerLoginClient
from shared.errors import Conflict, Forbidden, NotFound, Unauthorized, ValidationProblem
from shared.service_client import ServiceClient


class FakeTransport(httpx.BaseTransport):
    """Fake HTTP transport：按 path+payload 分派响应。"""

    def __init__(self):
        self.requests = []
        self.resolve_response = None
        self.login_response = None
        self.reset_response = None
        self.jwks_response = None

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, str(request.url), request.content))

        if request.url.path == "/api/auth/resolve-tenant-by-account":
            if self.resolve_response is not None:
                return self.resolve_response
            return httpx.Response(
                200,
                json={"data": {"tenant_id": "t-resolved"}},
            )

        if request.url.path == "/api/auth/login":
            if self.login_response is not None:
                return self.login_response
            return httpx.Response(
                200,
                json={"data": {"token": "tok-resolved", "claims": {"tenant_id": "t-resolved", "user_id": "u", "roles": ["member"], "exp": 9999999999}}},
            )

        if request.url.path == "/api/auth/owner-reset":
            if self.reset_response is not None:
                return self.reset_response
            return httpx.Response(
                200,
                json={"data": {"token": "tok-reset", "claims": {"tenant_id": "t-resolved", "user_id": "u", "roles": ["member"], "exp": 9999999999}}},
            )

        if request.url.path.startswith("/api/auth/") and request.url.path.endswith("/jwks.json"):
            if self.jwks_response is not None:
                return self.jwks_response
            return httpx.Response(200, json={"keys": [{"kid": "t-resolved:1", "kty": "RSA", "n": "x", "e": "AQAB"}]})

        return httpx.Response(404, json={"detail": "not found"})


def _client(transport=None):
    transport = transport or FakeTransport()
    return RealManagerLoginClient(ServiceClient("http://manager.local", transport=transport))


def test_login_auto_resolves_tenant_when_hint_absent():
    """tenant_hint 空缺 → 先调 resolve-tenant-by-account，再用解析到的 tenant 登录。"""
    transport = FakeTransport()
    client = _client(transport)

    token, jwks = client.login(LoginRequest(account="13800138000", password="ok"))
    assert token == "tok-resolved"
    assert "keys" in jwks
    paths = [(m, p) for (m, p, _) in transport.requests]
    assert ("POST", "http://manager.local/api/auth/resolve-tenant-by-account") in paths
    assert ("POST", "http://manager.local/api/auth/login") in paths
    assert ("GET", "http://manager.local/api/auth/t-resolved/jwks.json") in paths


def test_login_skips_resolve_when_hint_present():
    """tenant_hint 已传 → 不调 resolve，直接用传入 tenant 登录。"""
    transport = FakeTransport()
    client = _client(transport)

    token, jwks = client.login(LoginRequest(account="13800138000", password="ok", tenant_hint="t-explicit"))
    assert token
    paths = [(m, p) for (m, p, _) in transport.requests]
    assert ("POST", "http://manager.local/api/auth/resolve-tenant-by-account") not in paths
    assert ("GET", "http://manager.local/api/auth/t-explicit/jwks.json") in paths


def test_resolve_not_found_404_propagates():
    """账号未绑定任何 tenant → 404 透传给调用方。"""
    transport = FakeTransport()
    transport.resolve_response = httpx.Response(404, json={"status": 404, "code": "not_found", "detail": "no tenant"})
    client = _client(transport)

    with pytest.raises(NotFound):
        client.login(LoginRequest(account="13800138000", password="ok"))


def test_resolve_multiple_tenants_409_propagates():
    """账号属于多个 tenant → 409 透传。"""
    transport = FakeTransport()
    transport.resolve_response = httpx.Response(
        409, json={"status": 409, "code": "conflict", "detail": "multiple tenants"}
    )
    client = _client(transport)

    with pytest.raises(Conflict):
        client.login(LoginRequest(account="13800138000", password="ok"))


def test_resolve_network_error_becomes_unreachable():
    """resolve 端网络错误 → ManagerUnreachable（不抛原始异常）。"""

    class BoomTransport(httpx.BaseTransport):
        def handle_request(self, request):
            raise httpx.ConnectError("boom")

    client = RealManagerLoginClient(ServiceClient("http://manager.local", transport=BoomTransport()))
    with pytest.raises(ManagerUnreachable):
        client.login(LoginRequest(account="13800138000", password="ok"))


def test_reset_password_auto_resolves_tenant_when_hint_absent():
    """reset_password 在 tenant_hint 空缺时同样自动解析 tenant。"""
    transport = FakeTransport()
    client = _client(transport)

    token, jwks = client.reset_password(
        PasswordResetRequest(account="13800138000", password="old", new_password="new12345")
    )
    assert token == "tok-reset"
    paths = [(m, p) for (m, p, _) in transport.requests]
    assert ("POST", "http://manager.local/api/auth/resolve-tenant-by-account") in paths
    assert ("POST", "http://manager.local/api/auth/owner-reset") in paths
    assert ("GET", "http://manager.local/api/auth/t-resolved/jwks.json") in paths
