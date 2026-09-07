"""routes_bootstrap 分支覆盖补齐（无 DB 非集成）：F02 负责人 bootstrap 收端。

verify_service_token 守卫：生产 SERVICE_TOKEN 配置下要求 X-Service-Token 匹配；dev 占位值 fail-open（AITEAM-331 B2：未配置不再 fail-open）。
_auth_service 缓存与 create-or-replace bootstrap 路径。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()
_BOUND_TENANT = "11111111-1111-4111-8111-111111111111"


def _client(db_url=None, admin_db_url=None, service_token="dev-service-token-placeholder"):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_bootstrap import router as bootstrap_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url,
                              admin_db_url=admin_db_url, service_token=service_token),
                     manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(bootstrap_router)
    return TestClient(app)


def _body():
    return {"tenant_id": _BOUND_TENANT, "owner_phone": "13800138000",
            "bootstrap_secret": "boot-Pw-1", "must_reset": True}


# ---- service token 守卫：生产模式 fail-closed ----

def test_bootstrap_no_service_token_in_prod_401():
    """生产模式（SERVICE_TOKEN 配置强密钥）无 X-Service-Token → 401。"""
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin",
                     service_token="prod-strong-secret")
    r = client.post("/api/manager/owner-bootstrap", json=_body())
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")


def test_bootstrap_wrong_service_token_in_prod_401():
    """token 不匹配 → 401。"""
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin",
                     service_token="prod-strong-secret")
    r = client.post("/api/manager/owner-bootstrap", json=_body(),
                    headers={"X-Service-Token": "wrong"})
    assert r.status_code == 401


def test_bootstrap_dev_placeholder_fail_open_succeeds_to_db_check():
    """dev 占位值 → fail-open → 进 DB 检查 → 503（AITEAM-331 B2：仅占位值 dev profile，未配置不再 fail-open）。"""
    client = _client(None, admin_db_url=None)  # service_token 默认占位值
    r = client.post("/api/manager/owner-bootstrap", json=_body())
    # 无 DB → 503（service_token 未配置 = dev）
    assert r.status_code == 503
    assert r.json()["code"] == "manager_admin_db_unconfigured"


# ---- DB 检查 ----

def test_bootstrap_no_db_503():
    client = _client(None, admin_db_url=None)
    r = client.post("/api/manager/owner-bootstrap", json=_body())
    assert r.status_code == 503


def test_bootstrap_no_admin_db_503():
    client = _client("postgresql://fake/fake", admin_db_url=None)
    r = client.post("/api/manager/owner-bootstrap", json=_body())
    assert r.status_code == 503


# ---- 422 ----

def test_bootstrap_missing_fields_422():
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
    r = client.post("/api/manager/owner-bootstrap", json={"tenant_id": "t1"})
    assert r.status_code == 422


def test_bootstrap_extra_field_422():
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
    r = client.post("/api/manager/owner-bootstrap",
                    json={**_body(), "extra": 1})
    assert r.status_code == 422


# ---- tenant guard / happy / idempotent ----

def test_bootstrap_stage_a_phase_gate():
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
    with patch("manager_service.routes_bootstrap._tenant_exists", return_value=False):
        r = client.post("/api/manager/owner-bootstrap", json=_body())
    assert r.status_code == 503
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "multitenancy_phase_pending"


def _fake_auth_svc(provision_uid="user-1"):
    svc = MagicMock()
    svc.sync_owner_bootstrap.return_value = provision_uid
    return svc


def test_bootstrap_writes_are_phase_gated():
    fake = _fake_auth_svc()
    with patch("manager_service.auth_service.build_auth_service", return_value=fake), \
            patch("manager_service.routes_bootstrap._tenant_exists", return_value=True):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/manager/owner-bootstrap", json=_body())
        r2 = c.post("/api/manager/owner-bootstrap", json=_body())
    assert r.status_code == 503 and r2.status_code == 503
    assert r.json()["code"] == "multitenancy_phase_pending"
    fake.sync_owner_bootstrap.assert_not_called()
