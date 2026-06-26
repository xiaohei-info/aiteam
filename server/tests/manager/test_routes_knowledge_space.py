"""knowledge_space 路由分支覆盖补齐（M3，无 DB 非集成）。

覆盖 create/list/get/update/delete + bind/list_bindings/unbind 全分支。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import NotFound, Forbidden
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas import (
    KnowledgeSpaceBindingOut,
    KnowledgeSpaceOut,
)


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_knowledge_space import build_knowledge_space_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_knowledge_space_router(_VERIFIER))
    return TestClient(app)


def _ks_out(**kw):
    base = dict(knowledge_space_id="ks-1", workspace="t1:ks-1", display_name="KS")
    base.update(kw)
    return KnowledgeSpaceOut(**base)


def _bind_out(**kw):
    base = dict(id="b-1", tenant_id="t1", knowledge_space_id="ks-1",
                resource_type="expert", resource_id="emp-1")
    base.update(kw)
    return KnowledgeSpaceBindingOut(**base)


def _fake_svc():
    svc = MagicMock()
    ks = _ks_out()
    b = _bind_out()
    svc.create.return_value = ks
    svc.list_all.return_value = [ks]
    svc.get.return_value = ks
    svc.update.return_value = _ks_out(display_name="KS2")
    svc.delete.return_value = None
    svc.bind.return_value = b
    svc.list_bindings.return_value = [b]
    svc.unbind.return_value = None
    return svc


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/manager/knowledge-spaces"),
    ("GET", "/api/manager/knowledge-spaces"),
    ("GET", "/api/manager/knowledge-spaces/ks-1"),
    ("PATCH", "/api/manager/knowledge-spaces/ks-1"),
    ("DELETE", "/api/manager/knowledge-spaces/ks-1"),
    ("POST", "/api/manager/knowledge-spaces/ks-1/bindings"),
    ("GET", "/api/manager/knowledge-spaces/ks-1/bindings"),
    ("DELETE", "/api/manager/knowledge-spaces/ks-1/bindings/emp-1/e1"),
])
def test_no_token_401(method, path):
    client = _client(None)
    body = {"knowledge_space_id": "ks-1"} if method == "POST" and path.endswith("spaces") else (
        {"knowledge_space_id": "ks-1", "resource_type": "expert", "resource_id": "e1"}
        if method == "POST" and "bindings" in path else None
    )
    if method == "PATCH":
        body = {"display_name": "x"}
    r = client.request(method, path, json=body)
    assert r.status_code == 401


def test_create_no_db_503():
    client = _client(None)
    r = client.post("/api/manager/knowledge-spaces",
                    json={"knowledge_space_id": "ks-1"}, headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


def test_create_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/knowledge-spaces",
                    json={"knowledge_space_id": "ks-1", "bad": 1}, headers=_hdr())
    assert r.status_code == 422


def test_bind_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post(
        "/api/manager/knowledge-spaces/ks-1/bindings",
        json={"knowledge_space_id": "ks-1", "resource_type": "expert",
              "resource_id": "e1", "bad": 1}, headers=_hdr(),
    )
    assert r.status_code == 422


def test_happy_multistep():
    fake = _fake_svc()
    with patch("manager_service.routes_knowledge_space.build_knowledge_space_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/knowledge-spaces",
                   json={"knowledge_space_id": "ks-1"}, headers=_hdr())
        assert r.status_code == 201
        r = c.get("/api/manager/knowledge-spaces", headers=_hdr())
        assert r.status_code == 200
        r = c.get("/api/manager/knowledge-spaces/ks-1", headers=_hdr())
        assert r.status_code == 200
        r = c.patch("/api/manager/knowledge-spaces/ks-1",
                    json={"display_name": "KS2"}, headers=_hdr())
        assert r.status_code == 200
        # path 与体一致：以路径为准
        r = c.post(
            "/api/manager/knowledge-spaces/ks-1/bindings",
            json={"knowledge_space_id": "OTHER", "resource_type": "expert", "resource_id": "e1"},
            headers=_hdr(),
        )
        assert r.status_code == 201
        # binding body 被 model_copy update 成路径值
        assert fake.bind.call_args.args[1].knowledge_space_id == "ks-1"
        r = c.get("/api/manager/knowledge-spaces/ks-1/bindings", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1
        r = c.delete("/api/manager/knowledge-spaces/ks-1/bindings/expert/e1", headers=_hdr())
        assert r.status_code == 204
        r = c.delete("/api/manager/knowledge-spaces/ks-1", headers=_hdr())
        assert r.status_code == 204


def test_get_not_found_404():
    fake = _fake_svc()
    fake.get.side_effect = NotFound("nope")
    with patch("manager_service.routes_knowledge_space.build_knowledge_space_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/knowledge-spaces/missing", headers=_hdr())
        assert r.status_code == 404


def test_create_forbidden_403():
    fake = _fake_svc()
    fake.create.side_effect = Forbidden("nope")
    with patch("manager_service.routes_knowledge_space.build_knowledge_space_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/knowledge-spaces",
                   json={"knowledge_space_id": "x"}, headers=_hdr(roles=["member"]))
        assert r.status_code == 403


def test_unbind_not_found_404():
    fake = _fake_svc()
    fake.unbind.side_effect = NotFound("nope")
    with patch("manager_service.routes_knowledge_space.build_knowledge_space_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.delete("/api/manager/knowledge-spaces/ks-1/bindings/expert/e1", headers=_hdr())
        assert r.status_code == 404
