"""routes_tenant 分支覆盖补齐（无 DB 非集成）：F01 企业开通收端。

verify_service_token 守卫 + psycopg mock + initial_quota_policy / visible_catalog_policy 条件分支。
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
    from manager_service.routes_tenant import router as tenant_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url,
                              admin_db_url=admin_db_url, service_token=service_token),
                     manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(tenant_router)
    return TestClient(app)


def _body(**kw):
    base = dict(enterprise_id="ent-1", tenant_id=_BOUND_TENANT, enterprise_name="Acme")
    base.update(kw)
    return base


def _mock_psycopg():
    """Mock psycopg.connect 返回 context manager；conn.execute() 返回 MagicMock。"""
    mock_conn = MagicMock()
    mock_conn.execute = MagicMock()
    mock_conn.__enter__ = MagicMock(return_value=mock_conn)
    mock_conn.__exit__ = MagicMock(return_value=None)
    mock_connect = MagicMock(return_value=mock_conn)
    return mock_connect


# ---- service token 守卫：生产模式 fail-closed ----

def test_provision_no_service_token_in_prod_401():
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin",
                     service_token="prod-secret")
    r = client.post("/api/manager/tenants", json=_body())
    assert r.status_code == 401


def test_provision_wrong_service_token_in_prod_401():
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin",
                     service_token="prod-secret")
    r = client.post("/api/manager/tenants", json=_body(),
                    headers={"X-Service-Token": "wrong"})
    assert r.status_code == 401


def test_provision_dev_mode_fail_open_to_db_check_503():
    """dev mode 无 SERVICE_TOKEN → fail-open → 进 DB 检查 → 503。"""
    client = _client(None, admin_db_url=None)
    r = client.post("/api/manager/tenants", json=_body())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_admin_db_unconfigured"


def test_provision_no_admin_db_503():
    client = _client("postgresql://fake/fake", admin_db_url=None)
    r = client.post("/api/manager/tenants", json=_body())
    assert r.status_code == 503


# ---- 422 ----

def test_provision_missing_fields_422():
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
    r = client.post("/api/manager/tenants", json={"tenant_id": "t1"})
    assert r.status_code == 422


def test_provision_extra_field_422():
    client = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
    r = client.post("/api/manager/tenants", json={**_body(), "extra": 1})
    assert r.status_code == 422


# ---- happy + 条件分支 ----

def test_provision_stage_a_phase_gate():
    """Stage A: F01 stays fail-closed with an explicit non-tenant phase gate."""
    mc = _mock_psycopg()
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/manager/tenants", json=_body())
    assert r.status_code == 503
    assert r.json()["code"] == "multitenancy_phase_pending"
    assert not mc.called


def test_provision_initializes_enterprise_space_after_phase_gate_opens():
    mc = _mock_psycopg()
    with (
        patch("psycopg.connect", mc),
        patch("manager_service.routes_tenant.require_control_plane_writes_ready"),
        patch("manager_service.routes_tenant.ensure_enterprise_knowledge_space") as ensure_space,
    ):
        c = _client("postgresql://fake/business", admin_db_url="postgresql://admin/admin")
        response = c.post("/api/manager/tenants", json=_body())

    assert response.status_code == 201
    ensure_space.assert_called_once_with(
        "postgresql://fake/business", _BOUND_TENANT, instance_registry=None,
    )


def test_provision_with_quota_policy_only_is_phase_gated():
    mc = _mock_psycopg()
    quota_policy = {"policy_slug": "default", "display_name": "Default",
                    "scope": "tenant", "window_days": 30,
                    "dimensions": {"cost_cap_usd": 100}, "enforcement": "soft"}
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/manager/tenants", json=_body(initial_quota_policy=quota_policy))
    assert r.status_code == 503
    assert r.json()["code"] == "multitenancy_phase_pending"
    assert not mc.called


def test_quota_policy_window_uses_parameterized_interval():
    """Provision quota must not quote a ``%s`` placeholder inside an interval literal.

    PostgreSQL treats ``interval '%s days'`` as a malformed literal; the resulting
    database error used to surface as a 500 from the Operation→Manager provision chain.
    """
    calls = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, query, params=()):
            calls.append((query, params))

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def cursor(self):
            return Cursor()

        def commit(self):
            return None

    with patch("psycopg.connect", return_value=Connection()):
        from manager_service.routes_tenant import _provision_initial_quota_policy

        _provision_initial_quota_policy(
            "postgresql://fake/fake",
            "tenant-1",
            {"policy_slug": "default", "window_days": 30},
        )

    insert_query, insert_params = calls[-1]
    assert "interval '%s days'" not in insert_query
    assert "(%s * interval '1 day')" in insert_query
    assert insert_params[4] == 30


def test_provision_policy_bodies_remain_phase_gated():
    mc = _mock_psycopg()
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        visible = c.post("/api/manager/tenants", json=_body(visible_catalog_policy={"visible_skills": ["s1"]}))
        both = c.post("/api/manager/tenants", json=_body(
            initial_quota_policy={"policy_slug": "d"},
            visible_catalog_policy={"visible_skills": ["s1"]},
        ))
        coded = c.post("/api/manager/tenants", json=_body(enterprise_code="acme-corp"))
        again = c.post("/api/manager/tenants", json=_body())
    for response in (visible, both, coded, again):
        assert response.status_code == 503
        assert response.json()["code"] == "multitenancy_phase_pending"
    assert not mc.called
