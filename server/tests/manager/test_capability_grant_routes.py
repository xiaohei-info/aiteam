"""成员能力授权上报路由（Agent→Manager 窄通道，设计 2026-11-19 §3.2/§3.4）。

授权跟着安装走：上报「成员装着哪个企业 MCP」（平台 server_id），卸载时删除。
无 DB 非集成：用假仓库替身，只验证鉴权、tenant 绑定、字段校验与删除范围。
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.routes_capability_grant import build_capability_grant_router
from shared.app_factory import create_app
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()
TENANT = "00000000-0000-4000-8000-0000000000aa"


def _client(repo) -> TestClient:
    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://x/y",
                              admin_db_url="postgresql://x/y"), APIRouter())
    app.state._token_verifier = _VERIFIER
    app.state._member_capability_grant_repo = repo
    app.include_router(build_capability_grant_router(_VERIFIER))
    return TestClient(app)


def _hdr(roles=("member",), user_id="m-1"):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, TENANT, list(roles), user_id=user_id)}


class FakeRepo:
    def __init__(self):
        self.upserts: list[tuple[str, str, str, str]] = []
        self.deleted: list[tuple[str, str, str]] = []

    def upsert(self, ctx, *, member_id, capability_kind, capability_ref):
        self.upserts.append((ctx.tenant_id, member_id, capability_kind, capability_ref))

    def delete(self, ctx, *, member_id, capability_kind, capability_ref):
        self.deleted.append((member_id, capability_kind, capability_ref))
        return 1


def test_put_records_installed_enterprise_mcp_for_the_authenticated_member():
    repo = FakeRepo()
    client = _client(repo)
    assert client.post("/api/manager/capability-grants", json={"grants": []}).status_code == 401
    body = {"tenant_id": TENANT, "grants": [{"server_id": "s9"}, {"server_id": "s7"}]}
    response = client.post("/api/manager/capability-grants", json=body, headers=_hdr(user_id="m-1"))
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"accepted": 2}
    assert repo.upserts == [(TENANT, "m-1", "mcp", "s9"), (TENANT, "m-1", "mcp", "s7")]


def test_tenant_mismatch_and_old_session_fields_are_rejected():
    repo = FakeRepo()
    client = _client(repo)
    mismatch = client.post("/api/manager/capability-grants",
                           json={"tenant_id": "00000000-0000-4000-8000-0000000000bb", "grants": []}, headers=_hdr())
    assert mismatch.status_code == 403
    # 旧的会话级字段（conversation_id / kind / ref / scope）不再接受。
    old = client.post("/api/manager/capability-grants",
                      json={"grants": [{"conversation_id": "c-1", "kind": "mcp", "ref": "x"}]}, headers=_hdr())
    assert old.status_code == 422
    empty = client.post("/api/manager/capability-grants", json={"grants": [{"server_id": ""}]}, headers=_hdr())
    assert empty.status_code == 422
    assert repo.upserts == []


def test_delete_removes_only_the_authenticated_members_grant():
    repo = FakeRepo()
    client = _client(repo)
    assert client.request("DELETE", "/api/manager/capability-grants", headers=_hdr(user_id="m-1"),
                          params={"server_id": "s9"}).status_code == 204
    assert repo.deleted == [("m-1", "mcp", "s9")]
    assert client.request("DELETE", "/api/manager/capability-grants", headers=_hdr(),
                          params={"server_id": ""}).status_code == 422


def test_manager_without_db_is_503():
    app = create_app(Settings(tier="manager", service_name="m", db_url=None, admin_db_url=None), APIRouter())
    app.state._token_verifier = _VERIFIER
    client = TestClient(app, raise_server_exceptions=False)
    app.include_router(build_capability_grant_router(_VERIFIER))
    response = client.post("/api/manager/capability-grants", json={"grants": [{"server_id": "s9"}]}, headers=_hdr())
    assert response.status_code == 503
