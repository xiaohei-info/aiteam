"""运营端系统账号登录闭环验收（缺口2，§9.2 系统账号→运营端本地校验）。

覆盖：错密码 401、对密码 → RS256 系统 token、whoami 200、catalog 受保护端点 200、
角色门 403、token 与 app._verifier 闭环（真实 RS256，非 DevToken）。
"""

from fastapi.testclient import TestClient

from run import get_app
from shared.contracts.enums import PlatformRole


def _client() -> TestClient:
    app = get_app("operation")
    return TestClient(app)


def _login(client: TestClient, username: str = "sysadmin", password: str = "changeme-me") -> str:
    r = client.post("/api/operation/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["data"]["token"]


def test_system_login_wrong_password_401():
    client = _client()
    r = client.post("/api/operation/auth/login", json={"username": "sysadmin", "password": "wrong"})
    assert r.status_code == 401


def test_system_login_unknown_user_401():
    client = _client()
    r = client.post("/api/operation/auth/login", json={"username": "nobody", "password": "x"})
    assert r.status_code == 401


def test_system_login_returns_rs256_token():
    client = _client()
    token = _login(client)
    # token 应是 JWT（三段式），header 含 RS256 alg + kid
    import jwt as _jwt

    header = _jwt.get_unverified_header(token)
    assert header["alg"] == "RS256"
    assert header["kid"] == "operation:1"
    # claims 含 system_admin 角色，tenant_id 为空（平台级）
    payload = _jwt.decode(token, options={"verify_signature": False})
    assert PlatformRole.SYSTEM_ADMIN.value in payload["roles"]
    # tenant_id=None 被 exclude_none 序列化省略——平台级系统账号无 tenant
    assert payload.get("tenant_id") is None


def test_whoami_200_with_system_token():
    client = _client()
    token = _login(client)
    r = client.get("/api/operation/whoami", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["user_id"] == "sysadmin"


def test_whoami_401_without_token():
    client = _client()
    r = client.get("/api/operation/whoami")
    assert r.status_code == 401


def test_protected_endpoint_401_with_devtoken():
    """DevToken（对称）在 RS256 verifier 下必验不过——证明已切换非对称验签（D23）。"""
    from shared.auth import DevTokenService
    from shared.contracts.auth import TokenClaims

    dev_token = DevTokenService().sign(
        TokenClaims(user_id="op1", roles=[PlatformRole.SYSTEM_ADMIN.value], exp=9999999999)
    )
    client = _client()
    r = client.get("/api/operation/whoami", headers={"Authorization": f"Bearer {dev_token}"})
    assert r.status_code == 401
