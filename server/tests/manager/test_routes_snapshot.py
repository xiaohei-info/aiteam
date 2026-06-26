"""routes_snapshot 分支覆盖补齐（无 DB 非集成）：执行快照生成 + member_id 匹配。

_service cache miss/hit + body.member_id != claims.user_id 403。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Forbidden
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from shared.contracts.snapshot import EmployeeExecutionSnapshot


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(user_id="u1"):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", ["owner"], user_id=user_id)}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_snapshot import build_snapshot_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_snapshot_router(_VERIFIER))
    app.include_router(build_employee_router(_VERIFIER))
    return TestClient(app)


def _snapshot():
    return EmployeeExecutionSnapshot(
        employee_id="emp-1", version="1", snapshot_version="snap-1",
        display_name="专家A",
    )


def _fake_svc():
    svc = MagicMock()
    svc.generate.return_value = _snapshot()
    return svc


# ---- 401 ----

def test_no_token_401():
    client = _client(None)
    r = client.post("/api/manager/snapshots",
                    json={"tenant_id": "t1", "member_id": "u1", "employee_id": "e1"})
    assert r.status_code == 401


# ---- 503 ----

def test_no_db_503():
    client = _client(None)
    r = client.post("/api/manager/snapshots",
                    json={"tenant_id": "t1", "member_id": "u1", "employee_id": "e1"},
                    headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


# ---- 422 ----

def test_missing_fields_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/snapshots",
                    json={"tenant_id": "t1"}, headers=_hdr())
    assert r.status_code == 422


def test_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/snapshots",
                    json={"tenant_id": "t1", "member_id": "u1", "employee_id": "e1", "bad": 1},
                    headers=_hdr())
    assert r.status_code == 422


# ---- 403: member_id 校验 ----

def test_member_mismatch_403():
    """body.member_id != claims.user_id → 403（禁止代拉）。"""
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/snapshots",
                    json={"tenant_id": "t1", "member_id": "other", "employee_id": "e1"},
                    headers=_hdr(user_id="u1"))
    assert r.status_code == 403


# ---- happy ----

def test_generate_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_snapshot.build_snapshot_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/snapshots",
                   json={"tenant_id": "t1", "member_id": "u1", "employee_id": "emp-1"},
                   headers=_hdr(user_id="u1"))
        assert r.status_code == 200
        assert r.json()["data"]["snapshot"]["employee_id"] == "emp-1"
        # 二次 cache hit
        r2 = c.post("/api/manager/snapshots",
                    json={"tenant_id": "t1", "member_id": "u1", "employee_id": "emp-1"},
                    headers=_hdr(user_id="u1"))
        assert r2.status_code == 200


def test_generate_service_forbidden_403():
    """service.generate 抛 Forbidden → 403（无授权）。"""
    fake = _fake_svc()
    fake.generate.side_effect = Forbidden("no grant")
    with patch("manager_service.routes_snapshot.build_snapshot_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/snapshots",
                   json={"tenant_id": "t1", "member_id": "u1", "employee_id": "emp-1"},
                   headers=_hdr(user_id="u1"))
        assert r.status_code == 403


def test_generate_service_with_employee_version_happy():
    """带 employee_version → 走带 version_snapshot 路径。"""
    fake = _fake_svc()
    with patch("manager_service.routes_snapshot.build_snapshot_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/snapshots",
                   json={"tenant_id": "t1", "member_id": "u1",
                         "employee_id": "emp-1", "employee_version": "5"},
                   headers=_hdr(user_id="u1"))
        assert r.status_code == 200
        # 校验调用发生
        assert fake.generate.called
        kw = fake.generate.call_args.kwargs
        assert kw["employee_version"] == "5"
