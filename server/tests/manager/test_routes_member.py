"""member/dept 路由分支覆盖补齐（无 DB 非集成）。

覆盖 departments + members CRUD + _services cache miss/hit + 401/503/422/404/403。
注意 member 路由用 _token_claims(从 app.state._token_verifier)，需 builder 注入 verifier。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Forbidden, NotFound
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas import DepartmentOut, MemberOut


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_member import router as member_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url,
                              admin_db_url=db_url), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(auth_router)
    app.include_router(member_router)
    return TestClient(app)


def _dept_out(**kw):
    base = dict(id="d-1", department_slug="eng", display_name="工程")
    base.update(kw)
    return DepartmentOut(**base)


def _mem_out(**kw):
    base = dict(id="m-1", display_name="Alice", status="active", roles=["member"], department_ids=[])
    base.update(kw)
    return MemberOut(**base)


def _fake_member_svc():
    svc = MagicMock()
    d = _dept_out()
    m = _mem_out()
    svc.create_department.return_value = d
    svc.list_departments.return_value = [d]
    svc.get_department.return_value = d
    svc.update_department.return_value = _dept_out(display_name="工程2")
    svc.delete_department.return_value = None
    svc.create_member.return_value = m
    svc.list_members.return_value = [m]
    svc.get_member.return_value = m
    svc.update_member.return_value = _mem_out(display_name="Bob")
    svc.delete_member.return_value = None
    return svc, MagicMock()  # (member_svc, grant_svc)


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/manager/departments"),
    ("GET", "/api/manager/departments"),
    ("GET", "/api/manager/departments/d-1"),
    ("PATCH", "/api/manager/departments/d-1"),
    ("DELETE", "/api/manager/departments/d-1"),
    ("POST", "/api/manager/members"),
    ("GET", "/api/manager/members"),
    ("GET", "/api/manager/members/m-1"),
    ("PATCH", "/api/manager/members/m-1"),
    ("DELETE", "/api/manager/members/m-1"),
])
def test_no_token_401(method, path):
    client = _client(None)
    body = {"department_slug": "x"} if path.endswith("departments") and method == "POST" else (
        {"account": "13800138000", "initial_password": "Pw1!"} if path.endswith("members") and method == "POST" else (
            {"display_name": "x"} if method == "PATCH" else None))
    r = client.request(method, path, json=body)
    assert r.status_code == 401


def test_create_dept_no_db_503():
    client = _client(None)
    r = client.post("/api/manager/departments", json={"department_slug": "x"}, headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


def test_create_dept_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/departments",
                    json={"department_slug": "x", "bad": 1}, headers=_hdr())
    assert r.status_code == 422


def test_create_member_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/members",
                    json={"account": "13800138000", "initial_password": "Pw1!", "bad": 1},
                    headers=_hdr())
    assert r.status_code == 422


def test_update_member_missing_body_422():
    client = _client("postgresql://fake/fake")
    r = client.patch("/api/manager/members/m-1", headers=_hdr())
    assert r.status_code == 422


def test_dept_crud_happy():
    fakes = _fake_member_svc()
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/departments", json={"department_slug": "eng"}, headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["department_slug"] == "eng"
        r = c.get("/api/manager/departments", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1
        r = c.get("/api/manager/departments/d-1", headers=_hdr())
        assert r.status_code == 200
        r = c.patch("/api/manager/departments/d-1", json={"display_name": "工程2"}, headers=_hdr())
        assert r.status_code == 200
        r = c.delete("/api/manager/departments/d-1", headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["deleted"] == "d-1"


def test_member_crud_happy():
    fakes = _fake_member_svc()
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/members",
                    json={"account": "13800138000", "initial_password": "Pw1!"},
                    headers=_hdr())
        assert r.status_code == 200
        r = c.get("/api/manager/members", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1
        r = c.get("/api/manager/members/m-1", headers=_hdr())
        assert r.status_code == 200
        r = c.patch("/api/manager/members/m-1", json={"display_name": "Bob"}, headers=_hdr())
        assert r.status_code == 200
        r = c.delete("/api/manager/members/m-1", headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["deleted"] == "m-1"


def test_get_dept_not_found_404():
    fakes = _fake_member_svc()
    fakes[0].get_department.side_effect = NotFound("nope")
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/departments/missing", headers=_hdr())
        assert r.status_code == 404


def test_create_member_forbidden_403():
    fakes = _fake_member_svc()
    fakes[0].create_member.side_effect = Forbidden("nope")
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/members",
                   json={"account": "13800138000", "initial_password": "Pw1!"},
                   headers=_hdr(roles=["member"]))
        assert r.status_code == 403
