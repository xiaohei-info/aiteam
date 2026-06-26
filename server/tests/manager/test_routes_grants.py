"""grants 路由分支覆盖补齐（无 DB 非集成）。

覆盖 grants CRUD + authorized-config-pull（member_id/tenant_id 校验）+ 401/503/422/403/404。
_authorized_config_service 也走 app.state 缓存。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Forbidden, NotFound
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas import MemberGrantOut
from shared.contracts.crosstier import AuthorizedConfigPullResponse


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(roles=("owner",), user_id="u1", tenant_id="t1"):
    return {"Authorization": "Bearer " + sign_inmem_token(
        _SIGNER, tenant_id, list(roles), user_id=user_id)}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_member import router as member_router
    from manager_service.routes_grants import router as grants_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url,
                              admin_db_url=db_url), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(auth_router)
    app.include_router(member_router)
    app.include_router(grants_router)
    return TestClient(app)


def _g_out(**kw):
    base = dict(id="g-1", tenant_id="t1", resource_type="expert", resource_id="emp-1",
                department_ids=[], member_ids=[])
    base.update(kw)
    return MemberGrantOut(**base)


def _fake_grant_svc():
    svc = MagicMock()
    g = _g_out()
    svc.create_grant.return_value = g
    svc.list_grants.return_value = [g]
    svc.list_grants_by_resource.return_value = [g]
    svc.get_grant.return_value = g
    svc.update_grant.return_value = _g_out(member_ids=["u1"])
    svc.delete_grant.return_value = None
    return svc


def _fake_authorized_cfg_svc():
    svc = MagicMock()
    svc.pull.return_value = MagicMock()  # AuthorizedConfigPullResponse
    return svc


_ENDPOINTS = [
    ("POST", "/api/manager/grants"),
    ("GET", "/api/manager/grants"),
    ("GET", "/api/manager/grants/g-1"),
    ("PATCH", "/api/manager/grants/g-1"),
    ("DELETE", "/api/manager/grants/g-1"),
    ("POST", "/api/manager/grants/authorized-config"),
]


@pytest.mark.parametrize("method,path", _ENDPOINTS)
def test_no_token_401(method, path):
    client = _client(None)
    body = {"resource_type": "expert", "resource_id": "e1"} if method == "POST" and path.endswith("grants") else (
        {"department_ids": [], "member_ids": []} if method == "PATCH" else (
            {"tenant_id": "t1", "member_id": "u1"} if path.endswith("authorized-config") else None))
    r = client.request(method, path, json=body)
    assert r.status_code == 401


def test_create_no_db_503():
    client = _client(None)
    r = client.post("/api/manager/grants",
                    json={"resource_type": "expert", "resource_id": "e1"}, headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


def test_create_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/grants",
                    json={"resource_type": "expert", "resource_id": "e1", "bad": 1},
                    headers=_hdr())
    assert r.status_code == 422


def test_create_invalid_resource_type_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/grants",
                    json={"resource_type": "badtype", "resource_id": "e1"}, headers=_hdr())
    assert r.status_code == 422


def test_grants_crud_happy():
    fakes = (MagicMock(), _fake_grant_svc())
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/grants",
                   json={"resource_type": "expert", "resource_id": "e1"}, headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["resource_type"] == "expert"
        # list with resource filter
        r = c.get("/api/manager/grants?resource_type=expert&resource_id=e1", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1
        # list without filter
        r = c.get("/api/manager/grants", headers=_hdr())
        assert r.status_code == 200
        r = c.get("/api/manager/grants/g-1", headers=_hdr())
        assert r.status_code == 200
        r = c.patch("/api/manager/grants/g-1",
                    json={"department_ids": [], "member_ids": ["u1"]}, headers=_hdr())
        assert r.status_code == 200
        r = c.delete("/api/manager/grants/g-1", headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["revoked"] == "g-1"


def test_authorized_config_pull_member_mismatch_403():
    fakes = (MagicMock(), _fake_grant_svc())
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()), \
         patch("manager_service.routes_grants.AuthorizedConfigService",
               return_value=_fake_authorized_cfg_svc()):
        c = _client("postgresql://fake/fake")
        # token user_id=u1，body.member_id=other
        r = c.post("/api/manager/grants/authorized-config",
                   json={"tenant_id": "t1", "member_id": "other"}, headers=_hdr(user_id="u1"))
        assert r.status_code == 403


def test_authorized_config_pull_tenant_mismatch_403():
    fakes = (MagicMock(), _fake_grant_svc())
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()), \
         patch("manager_service.routes_grants.AuthorizedConfigService",
               return_value=_fake_authorized_cfg_svc()):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/grants/authorized-config",
                   json={"tenant_id": "other", "member_id": "u1"}, headers=_hdr(user_id="u1"))
        assert r.status_code == 403


def test_authorized_config_pull_happy():
    fakes = (MagicMock(), _fake_grant_svc())
    fake_auth_cfg = MagicMock()
    fake_auth_cfg.pull.return_value = AuthorizedConfigPullResponse()
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()), \
         patch("manager_service.routes_grants.AuthorizedConfigService",
               return_value=fake_auth_cfg):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/grants/authorized-config",
                   json={"tenant_id": "t1", "member_id": "u1"}, headers=_hdr(user_id="u1"))
        assert r.status_code == 200


def test_authorized_config_pull_cache_hit_branch():
    """预注入 _authorized_config_service → 命中缓存覆盖 38->49。"""
    fakes = (MagicMock(), _fake_grant_svc())
    fake_auth_cfg = MagicMock()
    fake_auth_cfg.pull.return_value = AuthorizedConfigPullResponse()
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()), \
         patch("manager_service.routes_grants.AuthorizedConfigService",
               return_value=fake_auth_cfg):
        c = _client("postgresql://fake/fake")
        # 预设缓存使第二次 pull 命中 cache（38->49 False 分支）
        r1 = c.post("/api/manager/grants/authorized-config",
                    json={"tenant_id": "t1", "member_id": "u1"}, headers=_hdr(user_id="u1"))
        assert r1.status_code == 200
        # 第二次 pull：cache 已设（mock.pull 仍可返回）
        r2 = c.post("/api/manager/grants/authorized-config",
                    json={"tenant_id": "t1", "member_id": "u1"}, headers=_hdr(user_id="u1"))
        assert r2.status_code == 200


def test_authorized_config_service_no_db_raises_503():
    """直接调 _authorized_config_service 覆盖 line 36（db_url=None 分支）。

    路由前置 _services 已会 503，故直接调助手覆盖该分支。
    """
    import manager_service.routes_grants as rg
    client = _client(None)
    req = MagicMock()
    # 绕开 starlette scope：直接复用 client app.state（db_url=None）
    req.app.state = client.app.state
    with pytest.raises(rg._ManagerNotConfigured) as exc:
        rg._authorized_config_service(req)
    assert exc.value.status == 503


def test_get_grant_not_found_404():
    fakes = (MagicMock(), _fake_grant_svc())
    fakes[1].get_grant.side_effect = NotFound("nope")
    with patch("manager_service.routes_member.build_member_dept_service", return_value=fakes), \
         patch("manager_service.routes_member._auth_service", return_value=MagicMock()):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/grants/missing", headers=_hdr())
        assert r.status_code == 404
