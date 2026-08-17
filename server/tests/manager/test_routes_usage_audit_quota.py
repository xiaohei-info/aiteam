"""routes_usage_audit_quota 分支覆盖补齐（无 DB 非集成）：usage/audit/quota 三组 CRUD。

覆盖 upload/rollup/rollup_list/audits/quota-policies CRUD + evaluate + cache miss/hit。
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Conflict, Forbidden, NotFound
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas import (
    AuditSummaryOut,
    QuotaEnforcementActionOut,
    QuotaPolicyOut,
    UsageAggregateOut,
    UsageRollupOut,
)


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}


def _svc_hdr():
    return {"X-Service-Token": "test-service-token"}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(
        Settings(tier="manager", service_name="m", db_url=db_url, service_token="test-service-token"),
        manager_router,
    )
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    @app.middleware("http")
    async def _test_service_claim(request, call_next):
        request.state.service_tenant_id = "t1"
        return await call_next(request)
    app.include_router(build_usage_audit_quota_router(_VERIFIER))
    app.include_router(build_employee_router(_VERIFIER))
    return TestClient(app)


def _quota_out(**kw):
    base = dict(
        policy_id="qp-1", policy_slug="default", display_name="Default",
        scope="tenant", target_ref=None,
        window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        window_end=datetime(2026, 1, 31, tzinfo=timezone.utc),
        dimensions={"cost_cap_usd": "100"}, enforcement="soft", status="active", version=1,
    )
    base.update(kw)
    return QuotaPolicyOut(**base)


def _rollup_out(**kw):
    base = dict(
        rollup_id="r-1", summary_id="s-1", employee_id="emp-1",
        window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        window_end=datetime(2026, 1, 31, tzinfo=timezone.utc),
        run_count=1, token_total=1000, cost_total=Decimal("0.5"),
        error_count=0, duration_seconds_total=60,
    )
    base.update(kw)
    return UsageRollupOut(**base)


def _audit_out(**kw):
    base = dict(
        event_id="ev-1", summary_id="s-1", actor="u1", action="run.start",
        resource_type="run", resource_id="run-1",
        occurred_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    base.update(kw)
    return AuditSummaryOut(**base)


def _action_out(**kw):
    base = dict(
        policy_id="qp-1", policy_slug="default", enforcement="soft",
        actions=["alert_threshold"], severity="warn", detail="接近配额",
    )
    base.update(kw)
    return QuotaEnforcementActionOut(**base)


def _fake_svc():
    svc = MagicMock()
    svc.ingest_upload.return_value = {"ingested": 1, "audits": 0}
    svc.list_usage.return_value = [_rollup_out()]
    svc.aggregate_usage.return_value = UsageAggregateOut(
        rollup_count=1, run_count=1, token_total=1000,
        cost_total=Decimal("0.5"), error_count=0, duration_seconds_total=60,
    )
    svc.list_audits.return_value = [_audit_out()]
    svc.create_quota.return_value = _quota_out()
    svc.list_quotas.return_value = [_quota_out()]
    svc.get_quota.return_value = _quota_out()
    svc.update_quota.return_value = _quota_out(version=2)
    svc.delete_quota.return_value = None
    svc.evaluate_quota.return_value = _action_out()
    return svc


_UPLOAD_BODY = {"tenant_id": "t1", "usage": [], "audits": []}
_QUOTA_BODY = {"policy_slug": "d", "window_start": "2026-01-01T00:00:00Z",
               "window_end": "2026-01-31T00:00:00Z"}


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/manager/usage/upload"),
    ("GET", "/api/manager/usage/rollup"),
    ("GET", "/api/manager/usage/rollup/list"),
    ("GET", "/api/manager/audits"),
    ("POST", "/api/manager/quota-policies"),
    ("GET", "/api/manager/quota-policies"),
    ("GET", "/api/manager/quota-policies/qp-1"),
    ("PUT", "/api/manager/quota-policies/qp-1"),
    ("DELETE", "/api/manager/quota-policies/qp-1"),
    ("POST", "/api/manager/quota-policies/qp-1/evaluate"),
])
def test_no_token_401(method, path):
    client = _client(None)
    body = _UPLOAD_BODY if path.endswith("upload") else (
        _QUOTA_BODY if path == "/api/manager/quota-policies" and method == "POST" else (
            _QUOTA_BODY if method == "PUT" else None))
    r = client.request(method, path, json=body)
    assert r.status_code == 401


def test_quota_create_no_db_503():
    client = _client(None)
    r = client.post("/api/manager/quota-policies", json=_QUOTA_BODY, headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


def test_usage_upload_no_db_503():
    client = _client(None)
    r = client.post("/api/manager/usage/upload", json=_UPLOAD_BODY, headers=_svc_hdr())
    assert r.status_code == 503


def test_usage_upload_extra_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/usage/upload",
                    json={**_UPLOAD_BODY, "bad": 1}, headers=_svc_hdr())
    assert r.status_code == 422


def test_quota_create_missing_fields_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/quota-policies",
                    json={"policy_slug": "d"}, headers=_hdr())
    assert r.status_code == 422


def test_quota_create_bad_enforcement_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/quota-policies",
                    json={**_QUOTA_BODY, "enforcement": "nope"},
                    headers=_hdr())
    assert r.status_code == 422


def test_quota_evaluate_missing_query_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/quota-policies/qp-1/evaluate", headers=_hdr())
    assert r.status_code == 422


def test_quota_crud_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/quota-policies",
                   json={**_QUOTA_BODY, "display_name": "Default"}, headers=_hdr())
        assert r.status_code == 201 and r.json()["data"]["policy_id"] == "qp-1"
        r = c.get("/api/manager/quota-policies", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1
        r = c.get("/api/manager/quota-policies/qp-1", headers=_hdr())
        assert r.status_code == 200
        r = c.put("/api/manager/quota-policies/qp-1", json=_QUOTA_BODY, headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["version"] == 2
        r = c.delete("/api/manager/quota-policies/qp-1", headers=_hdr())
        assert r.status_code == 204


def test_quota_evaluate_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post(
            "/api/manager/quota-policies/qp-1/evaluate"
            "?window_start=2026-01-01T00:00:00Z&window_end=2026-01-31T00:00:00Z",
            headers=_hdr(),
        )
        assert r.status_code == 200
        assert r.json()["data"]["actions"] == ["alert_threshold"]


def test_usage_upload_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/usage/upload",
                   json={**_UPLOAD_BODY, "tenant_id": "forged", "usage": [{"id": "s1"}]},
                   headers=_svc_hdr())
        assert r.status_code == 200
        assert r.json()["data"]["ingested"] == 1
        assert fake.ingest_upload.call_args.args[0].tenant_id == "t1"


def test_usage_rollup_with_window_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get(
            "/api/manager/usage/rollup"
            "?window_start=2026-01-01T00:00:00Z&window_end=2026-01-31T00:00:00Z",
            headers=_hdr(),
        )
        assert r.status_code == 200
        assert "rollup_count" in r.json()["data"]


def test_usage_rollup_without_window_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/usage/rollup", headers=_hdr())
        assert r.status_code == 200
        assert "items" in r.json()["data"]


def test_usage_rollup_list_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/usage/rollup/list", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1


def test_audits_list_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/audits", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1


def test_quota_get_not_found_404():
    fake = _fake_svc()
    fake.get_quota.side_effect = NotFound("nope")
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/quota-policies/missing", headers=_hdr())
        assert r.status_code == 404


def test_quota_create_conflict_409():
    fake = _fake_svc()
    fake.create_quota.side_effect = Conflict("dup slug")
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/quota-policies", json=_QUOTA_BODY, headers=_hdr())
        assert r.status_code == 409


def test_quota_update_forbidden_403():
    fake = _fake_svc()
    fake.update_quota.side_effect = Forbidden("nope")
    with patch("manager_service.routes_usage_audit_quota.build_usage_audit_quota_service",
               return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.put("/api/manager/quota-policies/qp-1", json=_QUOTA_BODY,
                  headers=_hdr(roles=["member"]))
        assert r.status_code == 403

# ---- run-events / usage-ledger routes (issue #292) ----

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


_VERIFIER2, _SIGNER2 = make_inmem_verifier_and_signer()


def _hdr2(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER2, "t9", list(roles))}


def _svc_hdr2():
    return {"X-Service-Token": "test-service-token"}


def _client2(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(
        Settings(tier="manager", service_name="m", db_url=db_url, service_token="test-service-token"),
        manager_router,
    )
    app.state._token_verifier = _VERIFIER2
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_usage_audit_quota_router(_VERIFIER2))
    return TestClient(app)
