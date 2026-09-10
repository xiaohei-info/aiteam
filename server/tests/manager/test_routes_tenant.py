"""routes_tenant 分支覆盖补齐（无 DB 非集成）：F01 企业开通收端。

verify_service_token 守卫 + psycopg mock + initial_quota_policy 条件分支；未实现的目录策略明确返回 422。
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from shared.config import Settings
from shared.contracts.crosstier import TenantProvisionRequest
from tests.manager._auth_helper import make_inmem_verifier_and_signer


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()
_BOUND_TENANT = "11111111-1111-4111-8111-111111111111"


def _client(db_url=None, admin_db_url=None, service_token="dev-service-token-placeholder", *, aiteam_env="development", force_no_principal=False, onboarding_writes_enabled=False):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_tenant import router as tenant_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url,
                              admin_db_url=admin_db_url, service_token=service_token,
                              aiteam_env=aiteam_env, test_onboarding_writes_enabled=onboarding_writes_enabled),
                     manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.state.service_identity_verifier = None
    app.state._service_identity_verifier = None
    if force_no_principal:
        from manager_service.service_ingress import require_operator_service_principal
        app.dependency_overrides[require_operator_service_principal] = lambda: None
    app.include_router(tenant_router)
    return TestClient(app)


def _body(**kw):
    base = dict(enterprise_id="ent-1", tenant_id=_BOUND_TENANT, enterprise_name="Acme")
    base.update(kw)
    return base


def _trusted_client(body, *, raise_server_exceptions=True):
    from fastapi import APIRouter
    from shared.app_factory import create_app
    from manager_service.routes_tenant import router as tenant_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient
    from manager_service.service_ingress import canonical_body_sha256

    principal = SimpleNamespace(
        iss="https://trust.example.test",
        sub="operator-provisioner",
        aud="manager-service",
        purpose="service",
        deployment_id="operator-prod",
        enterprise_id=body["enterprise_id"],
        tenant_id=body["tenant_id"],
        scope=("enterprise:provision",),
        origin="https://operator.example.test",
        capability="provision-enterprise",
        kid="operator-kid-1",
        path="/api/manager/tenants",
        idempotency_key="f01-fastapi-1",
        body_sha256=canonical_body_sha256(TenantProvisionRequest.model_validate(body)),
    )
    app = create_app(
        Settings(
            tier="manager",
            service_name="trusted-f01-fixture",
            db_url="postgresql://fake/business",
            admin_db_url="postgresql://fake/admin",
            service_token="test-service-token",
            aiteam_env="test",
            test_onboarding_writes_enabled=True,
        ),
        APIRouter(),
    )
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.state.service_identity_trust = {
        "operator-kid-1": {
            "status": "active",
            "issuer": "https://trust.example.test",
            "subject": "operator-provisioner",
            "deployment_id": "operator-prod",
            "audiences": ["manager-service"],
            "origins": ["https://operator.example.test"],
            "scopes": ["enterprise:provision"],
            "provisioning_capabilities": ["provision-enterprise"],
            "target_bindings": [],
        }
    }

    @app.middleware("http")
    async def inject_principal(request, call_next):
        request.state.service_principal = principal
        return await call_next(request)

    app.include_router(tenant_router)
    return TestClient(app, raise_server_exceptions=raise_server_exceptions)


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


def test_f01_fastapi_omitted_optional_fields_use_signed_canonical_body():
    body = {
        "enterprise_id": "33333333-3333-4333-8333-333333333333",
        "tenant_id": "44444444-4444-4444-8444-444444444444",
        "enterprise_name": "CanonicalCo",
    }
    client = _trusted_client(body)
    with (
        patch("manager_service.routes_tenant.require_control_plane_writes_ready"),
        patch("manager_service.routes_tenant.OperatorTenantBindingRepository.ensure_registry_and_binding"),
        patch("manager_service.routes_tenant.ensure_enterprise_knowledge_space"),
    ):
        response = client.post(
            "/api/manager/tenants",
            json=body,
            headers={
                "X-Service-Token": "test-service-token",
                "Idempotency-Key": "f01-fastapi-1",
            },
        )
    assert response.status_code == 201, response.text
    assert response.json()["data"]["tenant_id"] == body["tenant_id"]


def test_provision_stage_a_phase_gate():
    """Stage A: F01 stays fail-closed with an explicit non-tenant phase gate."""
    mc = _mock_psycopg()
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/manager/tenants", json=_body())
    assert r.status_code == 503
    assert r.json()["code"] == "multitenancy_phase_pending"
    assert not mc.called


def test_provision_initializes_enterprise_space_after_phase_gate_opens(monkeypatch):
    monkeypatch.setenv("AITEAM_TEST_ENABLE_ONBOARDING_WRITES", "true")
    with (
        patch("manager_service.routes_tenant.OperatorTenantBindingRepository.ensure_registry_and_binding"),
        patch("manager_service.routes_tenant.ensure_enterprise_knowledge_space") as ensure_space,
    ):
        c = _client("postgresql://fake/business", admin_db_url="postgresql://fake/admin", service_token="test-service-token", aiteam_env="test", force_no_principal=True, onboarding_writes_enabled=True)
        response = c.post("/api/manager/tenants", json=_body(), headers={"X-Service-Token": "test-service-token", "Idempotency-Key": "f01-test"})

    assert response.status_code == 201, response.text
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


def test_f01_retry_replays_registry_and_repairs_business_initialization(monkeypatch):
    monkeypatch.setenv("AITEAM_TEST_ENABLE_ONBOARDING_WRITES", "true")
    body = {"enterprise_id": "11111111-1111-4111-8111-111111111111", "tenant_id": "22222222-2222-4222-8222-222222222222", "enterprise_name": "Retry onboarding"}
    with (
        patch("manager_service.routes_tenant.OperatorTenantBindingRepository.ensure_registry_and_binding", side_effect=[True, False]) as ensure_registry,
        patch("manager_service.routes_tenant.ensure_enterprise_knowledge_space", side_effect=[RuntimeError("business init failed"), None]) as ensure_space,
    ):
        client = _trusted_client(body, raise_server_exceptions=False)
        first = client.post("/api/manager/tenants", json=body, headers={"X-Service-Token": "test-service-token", "Idempotency-Key": "f01-fastapi-1"})
        second = client.post("/api/manager/tenants", json=body, headers={"X-Service-Token": "test-service-token", "Idempotency-Key": "f01-fastapi-1"})
    assert first.status_code == 500
    assert second.status_code == 201
    assert ensure_registry.call_count == 1
    assert ensure_space.call_count == 2


def test_test_opt_in_requires_f01_idempotency_key_without_signed_principal(monkeypatch):
    monkeypatch.setenv("AITEAM_TEST_ENABLE_ONBOARDING_WRITES", "true")
    response = _client("postgresql://fake/business", admin_db_url="postgresql://fake/admin", service_token="test-service-token", aiteam_env="test", force_no_principal=True, onboarding_writes_enabled=True).post(
        "/api/manager/tenants", json=_body(), headers={"X-Service-Token": "test-service-token"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_test_opt_in_allows_f01_without_removing_default_gate(monkeypatch):
    monkeypatch.setenv("AITEAM_TEST_ENABLE_ONBOARDING_WRITES", "true")
    body = {"enterprise_id": "11111111-1111-4111-8111-111111111111", "tenant_id": "22222222-2222-4222-8222-222222222222", "enterprise_name": "Test onboarding"}
    with (
        patch("manager_service.routes_tenant.OperatorTenantBindingRepository.ensure_registry_and_binding"),
        patch("manager_service.routes_tenant.ensure_enterprise_knowledge_space"),
    ):
        response = _trusted_client(body).post(
            "/api/manager/tenants",
            json=body,
            headers={"X-Service-Token": "test-service-token", "Idempotency-Key": "f01-fastapi-1"},
        )
    assert response.status_code == 201


def test_test_opt_in_requires_business_db_before_f01_registry_write():
    with patch("manager_service.routes_tenant.OperatorTenantBindingRepository.ensure_registry_and_binding") as ensure_registry:
        response = _client(None, admin_db_url="postgresql://fake/admin", service_token="test-service-token", aiteam_env="test", force_no_principal=True, onboarding_writes_enabled=True).post(
            "/api/manager/tenants",
            json=_body(),
            headers={"X-Service-Token": "test-service-token", "Idempotency-Key": "f01-business-db"},
        )
    assert response.status_code == 503
    assert response.json()["code"] == "manager_admin_db_unconfigured"
    ensure_registry.assert_not_called()


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
    assert visible.status_code == both.status_code == 422
    for response in (visible, both):
        assert response.json()["code"] == "validation_error"
    for response in (coded, again):
        assert response.status_code == 503
        assert response.json()["code"] == "multitenancy_phase_pending"
    assert not mc.called
