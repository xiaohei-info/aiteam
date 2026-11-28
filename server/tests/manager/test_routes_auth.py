"""auth 路由分支覆盖补齐（无 DB 非集成）：login/owner_reset/jwks happy + 503 + 422。

非 integration：mock 注入 auth_service 覆盖响应 happy-path；503 不依赖 PG。
"""
from __future__ import annotations

from unittest.mock import MagicMock, call, patch

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.contracts.auth import TokenClaims
from tests.manager._auth_helper import make_inmem_verifier_and_signer
from manager_service.auth_service import AuthResult, EnterpriseAmbiguous, TenantSelectionRequired


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

def test_unbound_manager_is_ready_without_process_tenant():
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = ("tenant_registry",)
    with patch("psycopg.connect") as connect:
        connect.return_value.__enter__.return_value = conn
        client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        assert client.get("/healthz").status_code == 200
        ready = client.get("/readyz")
    assert ready.status_code == 200
    assert ready.json()["status"] == "ready"
    assert connect.call_args_list == [
        call("postgresql://fake/fake", autocommit=True, connect_timeout=5),
        call("postgresql://admin/admin", autocommit=True, connect_timeout=5),
    ]


def test_resolve_tenant_ignores_host_headers():
    fake = _fake_auth_svc()
    fake.resolve_tenant.return_value = "t-resolved"
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post(
            "/api/auth/resolve-tenant",
            json={"enterprise": "acme"},
            headers={"Host": "other.example.com", "X-Forwarded-Host": "evil.example.com"},
        )
    assert r.status_code == 200
    assert r.json()["data"]["tenant_id"] == "t-resolved"
    fake.resolve_tenant.assert_called_once_with("acme")


def test_login_accepts_enterprise_without_tenant_id():
    fake = _fake_auth_svc()
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/auth/login", json={
            "enterprise": "acme", "account": "13800138000", "password": "Pw1!",
        })
    assert r.status_code == 200
    body = fake.login.call_args[0][0]
    assert body.enterprise == "acme"
    assert body.tenant_id is None
    assert "Pw1!" not in str(r.json())


def test_owner_reset_accepts_enterprise_without_tenant_id():
    fake = _fake_auth_svc()
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/auth/owner-reset", json={
            "enterprise": "acme", "account": "13800138000",
            "old_password": "Pw1!", "new_password": "NewPw2!",
        })
    assert r.status_code == 200
    body = fake.owner_reset.call_args[0][0]
    assert body.enterprise == "acme"
    assert body.tenant_id is None


def test_login_enterprise_ambiguous_409():
    fake = _fake_auth_svc()
    fake.login.side_effect = EnterpriseAmbiguous("enterprise identifier is ambiguous: acme")
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/auth/login", json={
            "enterprise": "acme", "account": "13800138000", "password": "Pw1!",
        })
    assert r.status_code == 409
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "enterprise_ambiguous"
    assert "Pw1!" not in str(r.json())


def test_resolve_tenant_enterprise_ambiguous_409():
    fake = _fake_auth_svc()
    fake.resolve_tenant.side_effect = EnterpriseAmbiguous("enterprise identifier is ambiguous: acme")
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/auth/resolve-tenant", json={"enterprise": "acme"})
    assert r.status_code == 409
    assert r.json()["code"] == "enterprise_ambiguous"


def test_owner_reset_enterprise_ambiguous_409():
    fake = _fake_auth_svc()
    fake.owner_reset.side_effect = EnterpriseAmbiguous("enterprise identifier is ambiguous: acme")
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/auth/owner-reset", json={
            "enterprise": "acme", "account": "13800138000",
            "old_password": "Pw1!", "new_password": "NewPw2!",
        })
    assert r.status_code == 409
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "enterprise_ambiguous"
    assert "Pw1!" not in str(r.json()) and "NewPw2!" not in str(r.json())


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


def test_login_selection_required_carries_password_matched_candidates():
    """未填企业：多个企业密码通过 → 409 problem+json，meta.candidates 原样透出（tenant_id + 企业名）。"""
    candidates = [{"tenant_id": "t-a", "enterprise_name": "甲"}, {"tenant_id": "t-b", "enterprise_name": "乙"}]
    fake = _fake_auth_svc()
    fake.login.side_effect = TenantSelectionRequired("multiple", candidates=candidates)
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/auth/login", json={"account": "13800138000", "password": "Pw1!"})
    assert r.status_code == 409
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "tenant_selection_required"
    assert r.json()["meta"] == {"candidates": candidates}
    assert "Pw1!" not in str(r.json())


@pytest.mark.parametrize("body", [
    {"account": "13800138000"},
    {"account": "19900000000", "enterprise": "acme"},
    {},
])
@pytest.mark.parametrize("db", [("postgresql://fake/fake", "postgresql://admin/admin"), (None, None)])
def test_resolve_tenant_by_account_is_retired_with_410(body, db):
    """旧接口已停用：不论账号是否存在、请求体是否合法、是否配库，都返回同一个 410，且不查询账号。"""
    fake = _fake_auth_svc()
    with patch("manager_service.routes_auth.build_auth_service", return_value=fake) as build:
        c = _client(db[0], admin_db_url=db[1])
        r = c.post("/api/auth/resolve-tenant-by-account", json=body)
    assert r.status_code == 410
    assert r.headers["content-type"].startswith("application/problem+json")
    payload = r.json()
    assert payload["code"] == "client_upgrade_required"
    assert payload["detail"] == "客户端版本过旧，请升级后登录"
    assert "meta" not in payload or payload["meta"] is None
    build.assert_not_called()
