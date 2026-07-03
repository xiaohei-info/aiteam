"""用户端登录端点验收（A0 / 02 §10.1 路径前缀、03 §9.6）。

login 是公开端点（无 token 放行）；成功返回 token + 身份 envelope；凭据错误 → 401 problem+json。
端点只调本端 LocalLoginService（内部对 Manager 用 fake），不持签发密钥。
"""

import time

import pytest
from fastapi.testclient import TestClient

from agent_service.auth.local_login import LoginRequest, ManagerUnreachable, PasswordResetRequest
from agent_service.app import build_app
from shared.auth import RS256TokenSigner, generate_rsa_keypair
from shared.contracts.auth import TokenClaims
from shared.errors import Forbidden, Unauthorized


class _StubManager:
    online = True
    calls = 0

    def __init__(self) -> None:
        private_pem, _public_pem = generate_rsa_keypair()
        self._signer = RS256TokenSigner(private_pem, kid="t-1:1")
        self._jwks = self._signer.jwks()

    def login(self, req: LoginRequest):
        type(self).calls += 1
        if not self.online:
            raise ManagerUnreachable("offline")
        if req.password != "ok":
            raise Unauthorized("bad credentials")
        claims = TokenClaims(
            user_id="u-1", tenant_id="t-1", roles=["member"], exp=int(time.time()) + 3600
        )
        return self._signer.sign(claims), self._jwks

    def reset_password(self, req):
        type(self).calls += 1
        if not self.online:
            raise ManagerUnreachable("offline")
        if req.password != "ok":
            raise Unauthorized("bad credentials")
        if len(req.new_password) < 6:
            raise Forbidden("password too weak")
        claims = TokenClaims(
            user_id="u-1", tenant_id="t-1", roles=["member"], exp=int(time.time()) + 3600
        )
        return self._signer.sign(claims), self._jwks


@pytest.fixture
def client():
    # 注入 fake Manager，避免端点测试触网。
    return TestClient(build_app(manager_client=_StubManager()))


def test_login_endpoint_is_public_and_succeeds(client):
    r = client.post(
        "/api/agent/login",
        json={"account": "13800000000", "password": "ok", "tenant_hint": "t-1"},
    )
    assert r.status_code == 200
    body = r.json()["data"]
    assert body["claims"]["user_id"] == "u-1"
    assert body["token"]


def test_login_bad_credentials_401_problem_json(client):
    r = client.post(
        "/api/agent/login",
        json={"account": "x", "password": "nope", "tenant_hint": "t-1"},
    )
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "unauthorized"



def test_reset_password_endpoint_is_public_and_succeeds(client):
    r = client.post(
        "/api/agent/reset-password",
        json={
            "account": "13800000000",
            "password": "ok",
            "new_password": "newpass123",
            "tenant_hint": "t-1",
        },
    )
    assert r.status_code == 200
    body = r.json()["data"]
    assert body["claims"]["user_id"] == "u-1"
    assert body["token"]


def test_reset_password_bad_old_credentials_401(client):
    r = client.post(
        "/api/agent/reset-password",
        json={
            "account": "x",
            "password": "nope",
            "new_password": "newpass123",
            "tenant_hint": "t-1",
        },
    )
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")


def test_reset_password_weak_new_password_403(client):
    r = client.post(
        "/api/agent/reset-password",
        json={
            "account": "13800000000",
            "password": "ok",
            "new_password": "123",
            "tenant_hint": "t-1",
        },
    )
    assert r.status_code == 403
    assert r.json()["code"] == "forbidden"
