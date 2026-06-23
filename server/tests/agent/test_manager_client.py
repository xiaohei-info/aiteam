"""RealManagerLoginClient 单元测试（#174）。

测试用 mock/fake HTTP transport，验证：
1. 成功路径：调用 Manager login + jwks 端点，正确解析响应
2. 错误处理：401 透传为 Unauthorized，其他错误映射为 ManagerUnreachable
3. 响应解析：正确从 envelope 提取 token，独立获取 JWKS
"""

import httpx
import pytest

from agent_service.auth.manager_client import RealManagerLoginClient
from agent_service.auth.local_login import LoginRequest, ManagerUnreachable
from shared.errors import Unauthorized
from shared.service_client import ServiceClient


class FakeTransport(httpx.BaseTransport):
    """Fake HTTP transport，模拟 Manager 端点响应。"""

    def __init__(self):
        self.requests = []
        self.login_response = None
        self.jwks_response = None

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, str(request.url)))

        if request.url.path == "/api/auth/login":
            if self.login_response is None:
                # 默认成功响应
                return httpx.Response(
                    200,
                    json={
                        "data": {
                            "token": "fake-jwt-token",
                            "claims": {
                                "tenant_id": "t-1",
                                "user_id": "u-42",
                                "roles": ["member"],
                                "exp": 9999999999,
                            },
                        }
                    },
                )
            return self.login_response

        if request.url.path.startswith("/api/auth/") and request.url.path.endswith("/jwks.json"):
            if self.jwks_response is None:
                # 默认 JWKS 响应
                return httpx.Response(
                    200,
                    json={
                        "keys": [
                            {
                                "kty": "RSA",
                                "kid": "t-1:1",
                                "use": "sig",
                                "n": "fake-modulus",
                                "e": "AQAB",
                            }
                        ]
                    },
                )
            return self.jwks_response

        return httpx.Response(404, json={"detail": "not found"})


def test_successful_login():
    """成功路径：调用 login + jwks，返回 (token, jwks)。"""
    transport = FakeTransport()
    sc = ServiceClient("http://manager.local", transport=transport)
    client = RealManagerLoginClient(sc)

    req = LoginRequest(account="13800000000", password="pass123", tenant_hint="t-1")
    token, jwks = client.login(req)

    assert token == "fake-jwt-token"
    assert "keys" in jwks
    assert jwks["keys"][0]["kid"] == "t-1:1"
    # 验证调用顺序：先 login，后 jwks
    assert len(transport.requests) == 2
    assert transport.requests[0] == ("POST", "http://manager.local/api/auth/login")
    assert transport.requests[1] == ("GET", "http://manager.local/api/auth/t-1/jwks.json")


def test_unauthorized_credentials():
    """凭据错误：Manager 返回 401 → Unauthorized 透传。"""
    transport = FakeTransport()
    transport.login_response = httpx.Response(
        401, json={"status": 401, "code": "unauthorized", "detail": "invalid credentials"}
    )
    sc = ServiceClient("http://manager.local", transport=transport)
    client = RealManagerLoginClient(sc)

    req = LoginRequest(account="13800000000", password="wrong", tenant_hint="t-1")
    with pytest.raises(Unauthorized):
        client.login(req)


def test_manager_unreachable_503():
    """Manager 不可达（503）→ ManagerUnreachable。"""
    transport = FakeTransport()
    transport.login_response = httpx.Response(
        503, json={"status": 503, "code": "service_unavailable", "detail": "manager offline"}
    )
    sc = ServiceClient("http://manager.local", transport=transport)
    client = RealManagerLoginClient(sc)

    req = LoginRequest(account="13800000000", password="pass123", tenant_hint="t-1")
    with pytest.raises(ManagerUnreachable):
        client.login(req)


def test_missing_token_in_response():
    """Manager 响应缺失 token → ManagerUnreachable（契约异常）。"""
    transport = FakeTransport()
    transport.login_response = httpx.Response(200, json={"data": {}})
    sc = ServiceClient("http://manager.local", transport=transport)
    client = RealManagerLoginClient(sc)

    req = LoginRequest(account="13800000000", password="pass123", tenant_hint="t-1")
    with pytest.raises(ManagerUnreachable, match="missing token"):
        client.login(req)


def test_jwks_fetch_failure():
    """JWKS 获取失败（404/网络错误）→ ManagerUnreachable。"""
    transport = FakeTransport()
    transport.jwks_response = httpx.Response(404, json={"detail": "not found"})
    sc = ServiceClient("http://manager.local", transport=transport)
    client = RealManagerLoginClient(sc)

    req = LoginRequest(account="13800000000", password="pass123", tenant_hint="t-1")
    with pytest.raises(ManagerUnreachable):
        client.login(req)


def test_default_tenant_when_hint_missing():
    """tenant_hint 缺失时使用默认值 'default'。"""
    transport = FakeTransport()
    sc = ServiceClient("http://manager.local", transport=transport)
    client = RealManagerLoginClient(sc)

    req = LoginRequest(account="13800000000", password="pass123", tenant_hint=None)
    client.login(req)

    # 验证 JWKS 路径使用 'default'
    assert transport.requests[1] == ("GET", "http://manager.local/api/auth/default/jwks.json")
