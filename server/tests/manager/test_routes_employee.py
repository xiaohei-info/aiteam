"""employee 路由分支覆盖补齐（M2，无 DB 非集成）：401/503/422/200/201/204/404/403。

非 integration：mock 注入 service 覆盖 happy-path + 错误传播；401/503 不依赖 PG。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Forbidden, NotFound
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas import EmployeeConfigOut


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _auth_header(roles=("owner",), user_id="u1", tenant_id="t1"):
    token = sign_inmem_token(_SIGNER, tenant_id, list(roles), user_id=user_id)
    return {"Authorization": f"Bearer {token}"}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    settings = Settings(
        tier="manager", service_name="aiteam-manager-service", db_url=db_url,
    )
    app = create_app(settings, manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_employee_router(_VERIFIER))
    return TestClient(app)


def _fake_service(**overrides):
    svc = MagicMock()
    base = dict(employee_id="emp-1", employee_slug="exp-1", version=1, display_name="专家A", status="draft")
    base.update(overrides)
    out = EmployeeConfigOut(**base)
    svc.create.return_value = out
    svc.list_all.return_value = [out]
    svc.get.return_value = out
    svc.update.return_value = EmployeeConfigOut(**{**base, "version": 2})
    svc.delete.return_value = None
    return svc


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/manager/employees?employee_slug=exp-1"),
    ("GET", "/api/manager/employees"),
    ("GET", "/api/manager/employees/emp-1"),
    ("PUT", "/api/manager/employees/emp-1"),
    ("DELETE", "/api/manager/employees/emp-1"),
])
def test_no_token_401(method, path):
    client = _client(None)
    resp = client.request(method, path, json={"display_name": "x"})
    assert resp.status_code == 401
    assert resp.headers["content-type"].startswith("application/problem+json")


def test_create_no_db_503():
    client = _client(None)
    resp = client.post(
        "/api/manager/employees?employee_slug=exp-1",
        json={"display_name": "x"}, headers=_auth_header(),
    )
    assert resp.status_code == 503
    assert resp.json()["code"] == "manager_db_unconfigured"


def test_avatar_content_returns_binary_response():
    employee_id = "11111111-1111-1111-1111-111111111111"
    client = _client("postgresql://fake/fake")
    fake = MagicMock()
    fake.content.return_value = (b"\\x89PNG\\r\\n\\x1a\\n", "image/png")
    with patch("manager_service.routes_employee._avatar_service", return_value=fake):
        response = client.get(f"/api/manager/employees/{employee_id}/avatar/content", headers=_auth_header())
    assert response.status_code == 200, response.text
    assert response.content == b"\\x89PNG\\r\\n\\x1a\\n"
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "private, max-age=300"
    fake.content.assert_called_once()


def test_create_extra_field_422():
    client = _client("postgresql://fake/fake")
    resp = client.post(
        "/api/manager/employees?employee_slug=exp-1",
        json={"display_name": "x", "unexpected": 1}, headers=_auth_header(),
    )
    assert resp.status_code == 422


def test_update_extra_field_422():
    client = _client("postgresql://fake/fake")
    resp = client.put(
        "/api/manager/employees/emp-1",
        json={"display_name": "x", "unexpected": 1}, headers=_auth_header(),
    )
    assert resp.status_code == 422


def test_create_missing_slug_query_422():
    client = _client("postgresql://fake/fake")
    resp = client.post(
        "/api/manager/employees",
        json={"display_name": "x"}, headers=_auth_header(),
    )
    assert resp.status_code == 422


def test_role_title_http_roundtrip_validation_and_runtime_openapi():
    from manager_service.employee_config_service import EmployeeConfigService
    from manager_service.routes_org import build_org_router
    from shared.contracts.auth import TokenClaims
    from .test_employee_config import _FakeRepo

    client = _client("postgresql://fake/fake")
    client.app.state._employee_config_service = EmployeeConfigService(_FakeRepo())
    client.app.include_router(build_org_router(_VERIFIER))
    created = client.post("/api/manager/employees?employee_slug=role-title", headers=_auth_header(), json={"display_name": "研究员", "role_title": "研究分析师"})
    assert created.status_code == 201, created.text
    eid = created.json()["data"]["employee_id"]
    assert client.get(f"/api/manager/employees/{eid}", headers=_auth_header()).json()["data"]["role_title"] == "研究分析师"
    assert client.get("/api/manager/employees", headers=_auth_header()).json()["data"][0]["role_title"] == "研究分析师"
    for value in ["", "岗" * 101, 123]:
        response = client.put(f"/api/manager/employees/{eid}", headers=_auth_header(), json={"display_name": "研究员", "role_title": value})
        assert response.status_code == 422
        assert response.headers["content-type"].startswith("application/problem+json")
    for body in [{"display_name": "研究员", "role_title": None}, {"display_name": "研究员"}]:
        assert client.put(f"/api/manager/employees/{eid}", headers=_auth_header(), json=body).json()["data"]["role_title"] is None
    assert client.put(f"/api/manager/employees/{eid}", headers=_auth_header(roles=["member"]), json={"display_name": "x", "role_title": "owner"}).status_code == 403
    assert client.get(f"/api/manager/employees/{eid}", headers=_auth_header(tenant_id="other")).status_code == 404
    document = client.get("/openapi.json").json()
    for schema_name in ["EmployeeConfigIn", "EmployeeConfigOut", "OrgTreeNode"]:
        field = document["components"]["schemas"][schema_name]["properties"]["role_title"]
        text = next(item for item in field["anyOf"] if item["type"] == "string")
        assert (text["minLength"], text["maxLength"]) == (1, 100)
        assert any(item["type"] == "null" for item in field["anyOf"])
        assert field["description"] and field["examples"] == ["研究分析师", None]
    assert "完整替换" in document["paths"]["/api/manager/employees/{employee_id}"]["put"]["description"]
    # Operator uses the shared claims contract: do not tighten its nullable tenant.
    assert any(item["type"] == "null" for item in TokenClaims.model_json_schema()["properties"]["tenant_id"]["anyOf"])


def test_happy_path_multistep_covers_cache_hit():
    """同 client 多次请求：首次 cache-miss（build）→ 后续 cache-hit。"""
    fake = _fake_service()
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client("postgresql://fake/fake")
        r = client.post(
            "/api/manager/employees?employee_slug=exp-1",
            json={"display_name": "专家A", "persona": "p"}, headers=_auth_header(),
        )
        assert r.status_code == 201, r.text
        assert r.json()["data"]["employee_slug"] == "exp-1"
        assert fake.create.called
        # list
        r = client.get("/api/manager/employees", headers=_auth_header())
        assert r.status_code == 200
        assert len(r.json()["data"]) == 1
        # get
        r = client.get("/api/manager/employees/emp-1", headers=_auth_header())
        assert r.status_code == 200
        # update
        r = client.put("/api/manager/employees/emp-1", json={"display_name": "y"}, headers=_auth_header())
        assert r.status_code == 200
        assert r.json()["data"]["version"] == 2
        # delete
        r = client.delete("/api/manager/employees/emp-1", headers=_auth_header())
        assert r.status_code == 204


def test_get_not_found_404():
    fake = _fake_service()
    fake.get.side_effect = NotFound("nope")
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client("postgresql://fake/fake")
        r = client.get("/api/manager/employees/missing", headers=_auth_header())
        assert r.status_code == 404


def test_create_forbidden_403():
    fake = _fake_service()
    fake.create.side_effect = Forbidden("nope")
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client("postgresql://fake/fake")
        r = client.post(
            "/api/manager/employees?employee_slug=x",
            json={"display_name": "y"}, headers=_auth_header(roles=["member"]),
        )
        assert r.status_code == 403
