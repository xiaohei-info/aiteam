"""auth 路由分支覆盖补齐（无 DB 非集成）：login/owner_reset/jwks happy + 503 + 422。

非 integration：mock 注入 auth_service 覆盖响应 happy-path；503 不依赖 PG。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.contracts.auth import TokenClaims
from tests.manager._auth_helper import make_inmem_verifier_and_signer
from manager_service.auth_service import AuthResult


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _client(db_url, admin_db_url=None):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url,
                              admin_db_url=admin_db_url), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(auth_router)
    return TestClient(app)


def _fake_auth_svc():
    svc = MagicMock()
    r = AuthResult(
        token="t.jwt",
        claims=TokenClaims(tenant_id="t1", user_id="u1", roles=["owner"], exp=9999999999),
    )
    svc.login.return_value = r
    svc.owner_reset.return_value = r
    svc.jwks.return_value = {"keys": [{"kid": "k1", "kty": "RSA"}]}
    return svc


# ---- 503（DB/admin DB 缺） ----

@pytest.mark.parametrize("db_url,admin_db_url", [
    (None, None),
    ("postgresql://fake/fake", None),
    (None, "postgresql://admin/admin"),
])
def test_login_no_db_503(db_url, admin_db_url):
    """db_url 或 admin_db_url 缺失 → 503（_auth_service 检查两个 DSN）。"""
    client = _client(db_url, admin_db_url=admin_db_url)
    r = client.post("/api/auth/login", json={
        "tenant_id": "t1", "account": "13800138000", "password": "Pw1!",
    })
    assert r.status_code == 503
    assert r.headers["content-type"].startswith("application/problem+json")
    # body 不回显密码
    assert "Pw1!" not in str(r.json())


@pytest.mark.parametrize("db_url,admin_db_url", [
    (None, None),
    ("postgresql://fake/fake", None),
])
def test_jwks_no_db_503(db_url, admin_db_url):
    client = _client(db_url, admin_db_url=admin_db_url)
    r = client.get("/api/auth/t1/jwks.json")
    assert r.status_code == 503


@pytest.mark.parametrize("endpoint,body", [
    ("/api/auth/login", {"tenant_id": "t1"}),  # missing account/password
    ("/api/auth/owner-reset", {"tenant_id": "t1"}),  # missing fields
    ("/api/auth/login", {"tenant_id": "t1", "account": "x", "password": "p", "extra": 1}),
    ("/api/auth/owner-reset", {"tenant_id": "t1", "account": "x", "old_password": "p", "new_password": "q", "extra": 1}),
])
def test_auth_422(endpoint, body):
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
    r = client.post(endpoint, json=body)
    assert r.status_code == 422


# ---- happy path ----

def test_login_happy_cache_hit():
    """同 client 多次 login → 首次 build（mock）→ 后续 cache hit。"""
    fake = _fake_auth_svc()
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r1 = c.post("/api/auth/login", json={
            "tenant_id": "t1", "account": "13800138000", "password": "Pw1!",
        })
        assert r1.status_code == 200
        assert r1.json()["data"]["token"] == "t.jwt"
        # 第二次：cache hit
        r2 = c.post("/api/auth/login", json={
            "tenant_id": "t1", "account": "13800138000", "password": "Pw1!",
        })
        assert r2.status_code == 200


def test_owner_reset_happy():
    fake = _fake_auth_svc()
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/auth/owner-reset", json={
            "tenant_id": "t1", "account": "13800138000",
            "old_password": "Pw1!", "new_password": "NewPw2!",
        })
        assert r.status_code == 200


def test_jwks_happy():
    fake = _fake_auth_svc()
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.get("/api/auth/t1/jwks.json")
        assert r.status_code == 200
        assert "keys" in r.json()
