"""成员能力授权上报路由（Agent→Manager 窄通道，设计 2026-11-19 §3.2/§3.4）。

无 DB 非集成：用假仓库替身，只验证鉴权、tenant 绑定、字段校验与删除范围。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
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
        self.upserts: list[dict] = []
        self.deleted: list[tuple[str, str]] = []

    def upsert(self, ctx, *, member_id, conversation_id, capability_kind, capability_ref, source="", scope="session"):
        self.upserts.append({
            "tenant_id": ctx.tenant_id, "member_id": member_id, "conversation_id": conversation_id,
            "kind": capability_kind, "ref": capability_ref, "source": source, "scope": scope,
        })
        return SimpleNamespace(**self.upserts[-1])

    def delete_conversation(self, ctx, *, member_id, conversation_id):
        self.deleted.append((member_id, conversation_id))
        return 1


def test_put_records_grants_bound_to_the_authenticated_member():
    repo = FakeRepo()
    client = _client(repo)
    assert client.post("/api/manager/capability-grants", json={"grants": []}).status_code == 401
    body = {"tenant_id": TENANT, "grants": [
        {"conversation_id": "c-1", "kind": "mcp", "ref": "cr-test", "source": "platform_catalog", "scope": "session"},
        {"conversation_id": "c-1", "kind": "skill", "ref": "weekly-report", "source": "enterprise_catalog"},
    ]}
    response = client.post("/api/manager/capability-grants", json=body, headers=_hdr(user_id="m-1"))
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"accepted": 2}
    assert [(item["member_id"], item["kind"], item["ref"], item["tenant_id"]) for item in repo.upserts] == [
        ("m-1", "mcp", "cr-test", TENANT),
        ("m-1", "skill", "weekly-report", TENANT),
    ]


def test_tenant_mismatch_and_bad_fields_are_rejected():
    repo = FakeRepo()
    client = _client(repo)
    mismatch = client.post("/api/manager/capability-grants",
                           json={"tenant_id": "00000000-0000-4000-8000-0000000000bb", "grants": []}, headers=_hdr())
    assert mismatch.status_code == 403
    bad_kind = client.post("/api/manager/capability-grants",
                           json={"grants": [{"conversation_id": "c-1", "kind": "other", "ref": "x"}]}, headers=_hdr())
    assert bad_kind.status_code == 422
    bad_scope = client.post("/api/manager/capability-grants",
                            json={"grants": [{"conversation_id": "c-1", "kind": "mcp", "ref": "x", "scope": "member"}]}, headers=_hdr())
    assert bad_scope.status_code == 422
    assert repo.upserts == []


def test_delete_removes_only_the_authenticated_members_grants():
    repo = FakeRepo()
    client = _client(repo)
    assert client.request("DELETE", "/api/manager/capability-grants", headers=_hdr(user_id="m-1"),
                          params={"conversation_id": "c-1"}).status_code == 204
    assert repo.deleted == [("m-1", "c-1")]
    assert client.request("DELETE", "/api/manager/capability-grants", headers=_hdr(),
                          params={"conversation_id": ""}).status_code == 422


def test_manager_without_db_is_503():
    app = create_app(Settings(tier="manager", service_name="m", db_url=None, admin_db_url=None), APIRouter())
    app.state._token_verifier = _VERIFIER
    client = TestClient(app, raise_server_exceptions=False)
    app.include_router(build_capability_grant_router(_VERIFIER))
    response = client.post("/api/manager/capability-grants",
                           json={"grants": [{"conversation_id": "c-1", "kind": "mcp", "ref": "x"}]}, headers=_hdr())
    assert response.status_code == 503
