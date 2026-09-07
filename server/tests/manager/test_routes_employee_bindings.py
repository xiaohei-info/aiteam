"""employee 独立绑定实体 路由分支覆盖（AITEAM-234/280，无 DB 非集成）：401/503/422/200/201/204/404/403。

非 integration：mock 注入 service 覆盖 happy-path + 错误传播；401/503 不依赖 PG。
路径挂载在 /api/manager/employees/{employee_id}/...。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Conflict, Forbidden, NotFound
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _auth_header(roles=("owner",), user_id="u1", tenant_id="t1"):
    token = sign_inmem_token(_SIGNER, tenant_id, list(roles), user_id=user_id)
    return {"Authorization": f"Bearer {token}"}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_employee_bindings import build_employee_bindings_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    settings = Settings(
        tier="manager", service_name="aiteam-manager-service", db_url=db_url,
    )
    app = create_app(settings, manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_employee_router(_VERIFIER))
    app.include_router(build_employee_bindings_router(_VERIFIER))
    return TestClient(app)


PROMPT_OUT = dict(
    binding_id="pv-1", employee_id="emp-1", version=1, display_name="v1",
    persona="p", model="m", provider_ref="r", thinking_level="high",
    tools=["search"], is_current=True, change_note=None,
    created_at="2026-07-01T00:00:00",
)
SKILL_OUT = dict(
    binding_id="sk-1", employee_id="emp-1", skill_id="code-review", enabled=True,
    config={}, created_at="2026-07-01T00:00:00", updated_at="2026-07-01T00:00:00",
)
KNOW_OUT = dict(
    binding_id="kn-1", employee_id="emp-1", knowledge_space_id="ks_default", enabled=True,
    config={}, created_at="2026-07-01T00:00:00", updated_at="2026-07-01T00:00:00",
)
MEM_OUT = dict(
    binding_id="mem-1", employee_id="emp-1", policy={}, seed_memories=[],
    retention_days=30, scope="tenant", updated_at="2026-07-01T00:00:00",
)
CONN_OUT = dict(
    binding_id="co-1", employee_id="emp-1", connector_id="slack", grant_ref="grant-1",
    enabled=True, config={}, created_at="2026-07-01T00:00:00",
    updated_at="2026-07-01T00:00:00",
)


# ---------------- 401 未登录 ----------------

@pytest.mark.parametrize("method,path", [
    ("POST", "/api/manager/employees/emp-1/prompt-versions"),
    ("GET", "/api/manager/employees/emp-1/prompt-versions"),
    ("GET", "/api/manager/employees/emp-1/prompt-versions/current"),
    ("GET", "/api/manager/employees/emp-1/prompt-versions/pv-1"),
    ("POST", "/api/manager/employees/emp-1/prompt-versions/pv-1/activate"),
    ("DELETE", "/api/manager/employees/emp-1/prompt-versions/pv-1"),
    ("POST", "/api/manager/employees/emp-1/skill-bindings"),
    ("GET", "/api/manager/employees/emp-1/skill-bindings"),
    ("POST", "/api/manager/employees/emp-1/knowledge-bindings"),
    ("GET", "/api/manager/employees/emp-1/knowledge-bindings"),
    ("GET", "/api/manager/employees/emp-1/memory-setting"),
    ("PUT", "/api/manager/employees/emp-1/memory-setting"),
    ("POST", "/api/manager/employees/emp-1/connector-bindings"),
    ("GET", "/api/manager/employees/emp-1/connector-bindings"),
])
def test_no_token_401(method, path):
    client = _client(None)
    r = client.request(method, path, json={})
    assert r.status_code == 401, r.text
    assert r.headers["content-type"].startswith("application/problem+json")


# ---------------- 503 无业务 DB ----------------

@pytest.mark.parametrize("method,path", [
    ("GET", "/api/manager/employees/emp-1/prompt-versions"),
    ("POST", "/api/manager/employees/emp-1/prompt-versions"),
    ("GET", "/api/manager/employees/emp-1/skill-bindings"),
    ("GET", "/api/manager/employees/emp-1/memory-setting"),
])
def test_no_db_503(method, path):
    client = _client(None)
    r = client.request(method, path, json={}, headers=_auth_header())
    assert r.status_code == 503, r.text
    assert r.json()["code"] == "manager_db_unconfigured"


# ---------------- 422 额外字段（契约防腐） ----------------

def test_prompt_version_create_extra_field_422():
    client = _client("postgresql://fake/fake")
    body = {"display_name": "v1", "extra_field": 1}
    r = client.post("/api/manager/employees/emp-1/prompt-versions",
                    json=body, headers=_auth_header())
    assert r.status_code == 422, r.text


def test_skill_binding_create_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/employees/emp-1/skill-bindings",
                    json={"skill_id": "x", "surprise": 1}, headers=_auth_header())
    assert r.status_code == 422, r.text


# ---------------- happy path + 错误传播 ----------------

def test_prompt_version_create_and_activate():
    fake = MagicMock()
    fake.create.return_value = PROMPT_OUT
    fake.list_all.return_value = [PROMPT_OUT]
    fake.get.return_value = PROMPT_OUT
    fake.get_current.return_value = PROMPT_OUT
    fake.set_current.return_value = {**PROMPT_OUT, "is_current": True}
    fake.delete.return_value = None
    with patch("manager_service.routes_employee_bindings.build_prompt_version_service",
               return_value=fake):
        client = _client("postgresql://fake/fake")
        h = _auth_header()
        # create
        r = client.post("/api/manager/employees/emp-1/prompt-versions",
                        json={"display_name": "v1"}, headers=h)
        assert r.status_code == 201, r.text
        assert r.json()["data"]["binding_id"] == "pv-1"
        assert fake.create.called
        # list
        r = client.get("/api/manager/employees/emp-1/prompt-versions", headers=h)
        assert r.status_code == 200
        assert len(r.json()["data"]) == 1
        # current
        r = client.get("/api/manager/employees/emp-1/prompt-versions/current", headers=h)
        assert r.status_code == 200
        # activate
        r = client.post("/api/manager/employees/emp-1/prompt-versions/pv-1/activate", headers=h)
        assert r.status_code == 200
        assert r.json()["data"]["is_current"] is True
        # delete
        r = client.delete("/api/manager/employees/emp-1/prompt-versions/pv-1", headers=h)
        assert r.status_code == 204


def test_prompt_version_not_found_404():
    fake = MagicMock()
    fake.get.side_effect = NotFound("nope")
    with patch("manager_service.routes_employee_bindings.build_prompt_version_service",
               return_value=fake):
        client = _client("postgresql://fake/fake")
        r = client.get("/api/manager/employees/emp-1/prompt-versions/missing",
                       headers=_auth_header())
        assert r.status_code == 404, r.text


def test_skill_binding_create_conflict_409():
    fake = MagicMock()
    fake.create.side_effect = Conflict("already bound")
    with patch("manager_service.routes_employee_bindings.build_skill_binding_service",
               return_value=fake):
        client = _client("postgresql://fake/fake")
        r = client.post("/api/manager/employees/emp-1/skill-bindings",
                        json={"skill_id": "code-review"}, headers=_auth_header())
        assert r.status_code == 409, r.text


def test_skill_binding_member_full_config_read_and_write_403():
    fake = MagicMock()
    fake.list_all.return_value = [SKILL_OUT]
    fake.create.side_effect = Forbidden("denied")
    fake.delete.side_effect = Forbidden("denied")
    with patch("manager_service.routes_employee_bindings.build_skill_binding_service",
               return_value=fake):
        client = _client("postgresql://fake/fake")
        # member read OK
        r = client.get("/api/manager/employees/emp-1/skill-bindings",
                       headers=_auth_header(roles=["member"]))
        assert r.status_code == 403
        # member write 403
        r = client.post("/api/manager/employees/emp-1/skill-bindings",
                        json={"skill_id": "some"}, headers=_auth_header(roles=["member"]))
        assert r.status_code == 403
        r = client.delete("/api/manager/employees/emp-1/skill-bindings/sk-1",
                          headers=_auth_header(roles=["member"]))
        assert r.status_code == 403


def test_knowledge_binding_and_patch_ok():
    fake = MagicMock()
    fake.create.return_value = KNOW_OUT
    fake.list_all.return_value = [KNOW_OUT]
    fake.update.return_value = {**KNOW_OUT, "enabled": False}
    fake.delete.return_value = None
    with patch("manager_service.routes_employee_bindings.build_knowledge_binding_service",
               return_value=fake):
        client = _client("postgresql://fake/fake")
        h = _auth_header()
        r = client.post("/api/manager/employees/emp-1/knowledge-bindings",
                        json={"knowledge_space_id": "ks_default"}, headers=h)
        assert r.status_code == 201
        r = client.patch("/api/manager/employees/emp-1/knowledge-bindings/kn-1",
                         json={"enabled": False}, headers=h)
        assert r.status_code == 200
        assert r.json()["data"]["enabled"] is False


def test_memory_setting_upsert_and_patch():
    fake = MagicMock()
    fake.upsert.return_value = MEM_OUT
    fake.get.return_value = MEM_OUT
    fake.update.return_value = {**MEM_OUT, "retention_days": 60}
    fake.delete.return_value = None
    with patch("manager_service.routes_employee_bindings.build_memory_setting_service",
               return_value=fake):
        client = _client("postgresql://fake/fake")
        h = _auth_header()
        r = client.put("/api/manager/employees/emp-1/memory-setting",
                       json={"retention_days": 30}, headers=h)
        assert r.status_code == 200
        r = client.get("/api/manager/employees/emp-1/memory-setting", headers=h)
        assert r.status_code == 200
        r = client.patch("/api/manager/employees/emp-1/memory-setting",
                         json={"retention_days": 60}, headers=h)
        assert r.status_code == 200
        assert r.json()["data"]["retention_days"] == 60


def test_memory_setting_get_404_when_absent():
    fake = MagicMock()
    fake.get.side_effect = NotFound("none")
    with patch("manager_service.routes_employee_bindings.build_memory_setting_service",
               return_value=fake):
        client = _client("postgresql://fake/fake")
        r = client.get("/api/manager/employees/emp-1/memory-setting", headers=_auth_header())
        assert r.status_code == 404


def test_connector_binding_lifecycle():
    fake = MagicMock()
    fake.create.return_value = CONN_OUT
    fake.list_all.return_value = [CONN_OUT]
    fake.update.return_value = {**CONN_OUT, "enabled": False}
    fake.delete.return_value = None
    with patch("manager_service.routes_employee_bindings.build_connector_binding_service",
               return_value=fake):
        client = _client("postgresql://fake/fake")
        h = _auth_header()
        r = client.post("/api/manager/employees/emp-1/connector-bindings",
                        json={"connector_id": "slack", "grant_ref": "g1"}, headers=h)
        assert r.status_code == 201
        r = client.get("/api/manager/employees/emp-1/connector-bindings", headers=h)
        assert r.status_code == 200
        r = client.patch("/api/manager/employees/emp-1/connector-bindings/co-1",
                         json={"enabled": False}, headers=h)
        assert r.status_code == 200
        r = client.delete("/api/manager/employees/emp-1/connector-bindings/co-1", headers=h)
        assert r.status_code == 204
