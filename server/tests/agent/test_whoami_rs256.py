"""Agent whoami RS256 一致性验收（批次C）。

whoami 复用 LocalLoginService.current_identity（本地 RS256 验签，经 token_cache 缓存的 JWKS）。
登录前 401、登录后 200、登录用 stub Manager（RS256 签发 + JWKS）。
"""

import time

from fastapi.testclient import TestClient

from agent_service.app import build_app
from agent_service.auth.local_login import LoginRequest
from shared.auth import RS256TokenSigner, generate_rsa_keypair
from shared.contracts.auth import TokenClaims


class _StubManager:
    """fake Manager：RS256 签发 + 返回 JWKS（对齐真实 Manager 协议）。"""

    def __init__(self) -> None:
        private_pem, _ = generate_rsa_keypair()
        self._signer = RS256TokenSigner(private_pem, kid="t-1:1")

    def login(self, req: LoginRequest):
        claims = TokenClaims(
            user_id="u-1", tenant_id="t-1", roles=["member"], exp=int(time.time()) + 3600
        )
        return self._signer.sign(claims), self._signer.jwks()


def _client() -> TestClient:
    return TestClient(build_app(manager_client=_StubManager()))


def _login(client: TestClient) -> str:
    r = client.post(
        "/api/agent/login",
        json={"account": "13800000000", "password": "ok", "tenant_hint": "t-1"},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["token"]


def test_whoami_401_before_login():
    client = _client()
    r = client.get("/api/agent/whoami")
    assert r.status_code == 401


def test_whoami_200_after_login():
    client = _client()
    _login(client)
    r = client.get("/api/agent/whoami")
    assert r.status_code == 200, r.text
    assert r.json()["data"]["user_id"] == "u-1"
    assert r.json()["data"]["tenant_id"] == "t-1"


def test_whoami_with_devtoken_rejected():
    """DevToken（对称）在 Agent RS256 验签下必拒——证明已切换非对称（D23）。"""
    from shared.auth import DevTokenService

    dev_token = DevTokenService().sign(
        TokenClaims(user_id="u1", tenant_id="t1", roles=["member"], exp=9999999999)
    )
    client = _client()
    r = client.get("/api/agent/whoami", headers={"Authorization": f"Bearer {dev_token}"})
    assert r.status_code == 401
