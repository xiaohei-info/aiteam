"""capability 路由分支覆盖补齐（M4，无 DB 非集成）：技能/连接器/记忆策略三组 CRUD。

覆盖 _service cache miss/hit + 各端点 happy path + 401/422/404/403。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Forbidden, NotFound
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas import (
    ConnectorCatalogOut,
    MemoryPolicyCatalogOut,
    SkillCatalogOut,
)


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_capability import build_capability_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_capability_router(_VERIFIER))
    return TestClient(app)


def _skill_out(**kw):
    base = dict(skill_id="code-review", display_name="评审", version="1", config={},
                 catalog_id="sk-1", catalog_version=1)
    base.update(kw)
    return SkillCatalogOut(**base)


def _conn_out(**kw):
    base = dict(connector_id="slack", display_name="Slack", config={},
                catalog_id="co-1", catalog_version=1)
    base.update(kw)
    return ConnectorCatalogOut(**base)


def _memp_out(**kw):
    base = dict(policy_id="default", display_name="默认", policy={}, seed_memories=[],
                config={}, catalog_id="mp-1", catalog_version=1)
    base.update(kw)
    return MemoryPolicyCatalogOut(**base)


def _fake_svc():
    svc = MagicMock()
    sk = _skill_out()
    co = _conn_out()
    mp = _memp_out()
    svc.create_skill.return_value = sk
    svc.list_skills.return_value = [sk]
    svc.get_skill.return_value = sk
    svc.update_skill.return_value = _skill_out(catalog_version=2)
    svc.delete_skill.return_value = None
    svc.create_connector.return_value = co
    svc.list_connectors.return_value = [co]
    svc.get_connector.return_value = co
    svc.update_connector.return_value = _conn_out(catalog_version=2)
    svc.delete_connector.return_value = None
    svc.create_memory_policy.return_value = mp
    svc.list_memory_policies.return_value = [mp]
    svc.get_memory_policy.return_value = mp
    svc.update_memory_policy.return_value = _memp_out(catalog_version=2)
    svc.delete_memory_policy.return_value = None
    return svc


# ---- 401 ----

@pytest.mark.parametrize("method,path", [
    ("POST", "/api/manager/skills"),
    ("GET", "/api/manager/skills"),
    ("GET", "/api/manager/skills/sk-1"),
    ("PUT", "/api/manager/skills/sk-1"),
    ("DELETE", "/api/manager/skills/sk-1"),
    ("POST", "/api/manager/connectors"),
    ("GET", "/api/manager/connectors"),
    ("GET", "/api/manager/connectors/co-1"),
    ("PUT", "/api/manager/connectors/co-1"),
    ("DELETE", "/api/manager/connectors/co-1"),
    ("POST", "/api/manager/memory-policies"),
    ("GET", "/api/manager/memory-policies"),
    ("GET", "/api/manager/memory-policies/mp-1"),
    ("PUT", "/api/manager/memory-policies/mp-1"),
    ("DELETE", "/api/manager/memory-policies/mp-1"),
])
def test_no_token_401(method, path):
    client = _client(None)
    r = client.request(method, path, json={"skill_id": "x"} if "skills" in path and method in ("POST", "PUT") else
                       ({"connector_id": "x"} if "connectors" in path and method in ("POST", "PUT") else
                        ({"policy_id": "x"} if "memory" in path and method in ("POST", "PUT") else None)))
    assert r.status_code == 401


# ---- 503 ----

def test_skills_no_db_503():
    client = _client(None)
    r = client.get("/api/manager/skills", headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


# ---- 422 ----

def test_skill_create_extra_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/skills", json={"skill_id": "x", "unknown": 1}, headers=_hdr())
    assert r.status_code == 422


def test_memory_policy_retention_negative_422():
    """retention_days >=0 约束。"""
    client = _client("postgresql://fake/fake")
    r = client.post(
        "/api/manager/memory-policies",
        json={"policy_id": "x", "retention_days": -1}, headers=_hdr(),
    )
    assert r.status_code == 422


# ---- happy path: skills ----

def test_skill_crud_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_capability.build_capability_catalog_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/skills", json={"skill_id": "cr", "display_name": "评审"}, headers=_hdr())
        assert r.status_code == 201
        r = c.get("/api/manager/skills", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1
        r = c.get("/api/manager/skills/sk-1", headers=_hdr())
        assert r.status_code == 200
        r = c.put("/api/manager/skills/sk-1", json={"skill_id": "cr", "display_name": "新"}, headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["catalog_version"] == 2
        r = c.delete("/api/manager/skills/sk-1", headers=_hdr())
        assert r.status_code == 204


# ---- happy path: connectors ----

def test_connector_crud_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_capability.build_capability_catalog_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/connectors", json={"connector_id": "sl"}, headers=_hdr())
        assert r.status_code == 201
        r = c.get("/api/manager/connectors", headers=_hdr())
        assert r.status_code == 200
        r = c.get("/api/manager/connectors/co-1", headers=_hdr())
        assert r.status_code == 200
        r = c.put("/api/manager/connectors/co-1", json={"connector_id": "sl", "display_name": "S"}, headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["catalog_version"] == 2
        r = c.delete("/api/manager/connectors/co-1", headers=_hdr())
        assert r.status_code == 204


# ---- happy path: memory-policies ----

def test_memory_policy_crud_happy():
    fake = _fake_svc()
    with patch("manager_service.routes_capability.build_capability_catalog_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/memory-policies", json={"policy_id": "d"}, headers=_hdr())
        assert r.status_code == 201
        r = c.get("/api/manager/memory-policies", headers=_hdr())
        assert r.status_code == 200
        r = c.get("/api/manager/memory-policies/mp-1", headers=_hdr())
        assert r.status_code == 200
        r = c.put("/api/manager/memory-policies/mp-1", json={"policy_id": "d", "display_name": "新"}, headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["catalog_version"] == 2
        r = c.delete("/api/manager/memory-policies/mp-1", headers=_hdr())
        assert r.status_code == 204


# ---- errors ----

def test_skill_get_not_found_404():
    fake = _fake_svc()
    fake.get_skill.side_effect = NotFound("nope")
    with patch("manager_service.routes_capability.build_capability_catalog_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/skills/missing", headers=_hdr())
        assert r.status_code == 404


def test_skill_create_forbidden_403():
    fake = _fake_svc()
    fake.create_skill.side_effect = Forbidden("nope")
    with patch("manager_service.routes_capability.build_capability_catalog_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/skills", json={"skill_id": "x"}, headers=_hdr(roles=["member"]))
        assert r.status_code == 403


def test_connector_delete_not_found_404():
    fake = _fake_svc()
    fake.delete_connector.side_effect = NotFound("nope")
    with patch("manager_service.routes_capability.build_capability_catalog_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.delete("/api/manager/connectors/missing", headers=_hdr())
        assert r.status_code == 404
