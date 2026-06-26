"""routes_tenant 分支覆盖补齐（无 DB 非集成）：F01 企业开通收端。

verify_service_token 守卫 + psycopg mock + initial_quota_policy / visible_catalog_policy 条件分支。
"""
from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _client(db_url=None, admin_db_url=None, service_token=None):
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
    base = dict(enterprise_id="ent-1", tenant_id="t1", enterprise_name="Acme")
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

def test_provision_no_policies_happy():
    """无 initial_quota_policy 且无 visible_catalog_policy → 只 INSERT tenant_registry。"""
    mc = _mock_psycopg()
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/manager/tenants", json=_body())
        assert r.status_code == 201
        assert r.json()["data"]["tenant_id"] == "t1"
        assert mc.called  # psycopg.connect 被调用一次


def test_provision_with_quota_policy_only():
    """带 initial_quota_policy（visible_catalog_policy=None）→ 调用 _provision_quota_policy。"""
    mc = _mock_psycopg()
    quota_policy = {"policy_slug": "default", "display_name": "Default",
                    "scope": "tenant", "window_days": 30,
                    "dimensions": {"cost_cap_usd": 100}, "enforcement": "soft"}
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/manager/tenants", json=_body(initial_quota_policy=quota_policy))
        assert r.status_code == 201
        # psycopg.connect 被调两次（插入 tenant_registry + quota_policy）
        assert mc.call_count == 2


def test_provision_with_visible_catalog_policy_only():
    """带 visible_catalog_policy → _provision_visible_catalog_policy 走 pass 分支。"""
    mc = _mock_psycopg()
    visible_policy = {"visible_skills": ["s1"], "visible_connectors": ["c1"],
                      "default_visibility": "private"}
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/manager/tenants",
                   json=_body(visible_catalog_policy=visible_policy))
        assert r.status_code == 201
        # _provision_visible_catalog_policy 只 pass（不连库），故 psycopg 调用仍 1
        assert mc.call_count == 1


def test_provision_with_both_policies():
    mc = _mock_psycopg()
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/manager/tenants", json=_body(
            initial_quota_policy={"policy_slug": "d"},
            visible_catalog_policy={"visible_skills": ["s1"]},
        ))
        assert r.status_code == 201
        # quota_policy 连一次 + visible_catalog 不连库 → total 2
        assert mc.call_count == 2


def test_provision_enterprise_code_slug():
    """enterprise_code 非 None → slug = enterprise_code（else 分支覆盖）。"""
    mc = _mock_psycopg()
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r = c.post("/api/manager/tenants", json=_body(enterprise_code="acme-corp"))
        assert r.status_code == 201
        # execute 第一个参数是 SQL，第二个是 (tenant_id, slug, enterprise_code)
        # 用 code 做为 slug
        # 检查 slug 取值（验证 _service 路径行为）
        first_call_args = mc.return_value.execute.call_args_list[0]
        assert first_call_args.args[1] == ("t1", "acme-corp", "acme-corp")


def test_provision_idempotent_no_policies():
    """同一 body 多次调（无策略）→ 201 且行为稳定（幂等 ON CONFLICT）。"""
    mc = _mock_psycopg()
    with patch("psycopg.connect", mc):
        c = _client("postgresql://fake/fake", admin_db_url="postgresql://admin/admin")
        r1 = c.post("/api/manager/tenants", json=_body())
        r2 = c.post("/api/manager/tenants", json=_body())
        assert r1.status_code == 201 and r2.status_code == 201
