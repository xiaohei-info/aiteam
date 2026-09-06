"""授权配置增量 pull 验收（F10 / 05 §5.4 / D5/D12/D22）。

非 integration（不依赖 PG）：
- 普通 member 只得 grant 可见的 expert 增量。
- owner/enterprise_admin 豁免 grant 可见全量。
- known_versions 版本命中 → 不回同版本；版本不同 → 回增量。
- 不可见（或已无）且在 known_versions 中 → revoked_ids。
- 路由受保护（无 token → 401；DB 未配置 → 503）。
- member_id != token 主体 → 403。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.contracts.crosstier import AuthorizedConfigPullRequest
from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound

from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

# 无 DB 非集成测试用固定 RSA key 的 inmem verifier/signer（与 app 真实 DynamicRS256 同源逻辑）。
_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()

from manager_service.authorized_config_service import AuthorizedConfigService
from manager_service.employee_config_service import EmployeeConfigService
from manager_service.member_service import GrantService, MemberDeptService
from manager_service.repository_member import GrantRow, MemberRow
from manager_service.schemas import EmployeeConfigIn
from manager_service.skill_signing import SkillPackageSigner

from .test_employee_config import _FakeRepo
from .test_snapshot import _FakeGrantService, _FakeMemberService


# ---- 内存伪 config repo（复用 test_employee_config._FakeRepo）----


def _ctx(tid: str, roles=None, user_id="u-1") -> TenantContext:
    return TenantContext(tenant_id=tid, user_id=user_id, roles=roles or ["member"])


def _body() -> EmployeeConfigIn:
    from shared.contracts.snapshot import ModelPolicy, ExecutionPolicy
    return EmployeeConfigIn(
        display_name="专家X",
        model_policy=ModelPolicy(model="gpt-5"),
        execution_policy=ExecutionPolicy(),
    )


def _services():
    config_svc = EmployeeConfigService(_FakeRepo())
    grant_svc = _FakeGrantService()
    member_svc = _FakeMemberService()
    for tenant in ("t-a", "t-b"):
        for user in ("admin-1", "u-1", "m-1"):
            member_svc.set_member(tenant, user)
    svc = AuthorizedConfigService(
        config_service=config_svc, grant_service=grant_svc, member_service=member_svc
    )
    return config_svc, grant_svc, member_svc, svc


# ---- 成员级授权裁剪 ----

def test_legacy_catalog_without_skill_md_is_skipped_without_breaking_config():
    class _CatalogRepo:
        def get_skill_by_skill_id(self, ctx, *, skill_id):
            return SimpleNamespace(
                skill_id=skill_id, display_name="Legacy", version="1", files=[{"path": "references/legacy.md", "content": "legacy"}],
                content_hash="", catalog_id="legacy", install_policy="on_demand", binding_policy="opt_in", visibility="private", config={}, catalog_version=1,
            )

    class _Catalog:
        _repo = _CatalogRepo()

    service = AuthorizedConfigService(
        config_service=EmployeeConfigService(_FakeRepo()), grant_service=_FakeGrantService(), member_service=_FakeMemberService(),
        capability_catalog=_Catalog(), skill_signer=SkillPackageSigner(Ed25519PrivateKey.generate(), "test"),
    )
    result = service._resolve_skill_packages(_ctx("t-a", user_id="m-1"), [{"skills": ["legacy"]}])
    assert result == []


def test_authorized_config_publishes_only_public_skill_signing_key_metadata():
    class _Catalog:
        _repo = object()

    signer = SkillPackageSigner(Ed25519PrivateKey.generate(), "current", next_private_key=Ed25519PrivateKey.generate(), next_key_id="next")
    service = AuthorizedConfigService(
        config_service=EmployeeConfigService(_FakeRepo()), grant_service=_FakeGrantService(), member_service=_FakeMemberService(),
        capability_catalog=_Catalog(), skill_signer=signer,
    )
    service._members.set_member("t-a", "m-1")
    response = service.pull(_ctx("t-a", user_id="m-1"), AuthorizedConfigPullRequest(tenant_id="t-a", member_id="m-1"))
    assert [item.key_id for item in response.skill_signing_keys] == ["current", "next"]
    assert all(item.public_key and item.algorithm == "Ed25519" for item in response.skill_signing_keys)
    assert all("private_key" not in item.model_dump() for item in response.skill_signing_keys)


def test_missing_skill_catalog_marks_empty_response_non_authoritative():
    _, _, _, svc = _services()
    response = svc.pull(_ctx("t-a", user_id="m-1"), AuthorizedConfigPullRequest(tenant_id="t-a", member_id="m-1"))
    assert response.skill_packages == []
    assert response.skill_packages_authoritative is False


def test_member_with_grant_sees_expert():
    config_svc, grant_svc, member_svc, svc = _services()
    ctx_owner = _ctx("t-a", roles=["owner"])
    created = config_svc.create(ctx_owner, _body(), employee_slug="exp-x")
    member_svc.set_member("t-a", "m-1")
    grant_svc.set_grant("t-a", created.employee_id, member_ids=["m-1"])

    ctx = _ctx("t-a", roles=["member"], user_id="m-1")
    resp = svc.pull(ctx, AuthorizedConfigPullRequest(tenant_id="t-a", member_id="m-1"))
    assert any(e["employee_id"] == created.employee_id for e in resp.experts)
    assert resp.revoked_ids == []


def test_member_without_grant_sees_nothing():
    config_svc, _gs, member_svc, svc = _services()
    ctx_owner = _ctx("t-a", roles=["owner"])
    config_svc.create(ctx_owner, _body(), employee_slug="exp-x")
    member_svc.set_member("t-a", "m-1")  # exists but no grant

    ctx = _ctx("t-a", roles=["member"], user_id="m-1")
    resp = svc.pull(ctx, AuthorizedConfigPullRequest(tenant_id="t-a", member_id="m-1"))
    assert resp.experts == []


def test_member_via_department_grant_sees_expert():
    config_svc, grant_svc, member_svc, svc = _services()
    ctx_owner = _ctx("t-a", roles=["owner"])
    created = config_svc.create(ctx_owner, _body(), employee_slug="exp-x")
    member_svc.set_member("t-a", "m-1", department_ids=["d-eng"])
    grant_svc.set_grant("t-a", created.employee_id, department_ids=["d-eng"])

    ctx = _ctx("t-a", roles=["member"], user_id="m-1")
    resp = svc.pull(ctx, AuthorizedConfigPullRequest(tenant_id="t-a", member_id="m-1"))
    assert any(e["employee_id"] == created.employee_id for e in resp.experts)


# ---- 管理角色豁免 ----

@pytest.mark.parametrize("role", ["owner", "enterprise_admin"])
def test_admin_exempt_sees_all(role):
    config_svc, _gs, _ms, svc = _services()
    ctx = _ctx("t-a", roles=[role], user_id="admin-1")
    c1 = config_svc.create(ctx, _body(), employee_slug="e1")
    c2 = config_svc.create(ctx, _body(), employee_slug="e2")
    resp = svc.pull(ctx, AuthorizedConfigPullRequest(tenant_id="t-a", member_id="admin-1"))
    ids = {e["employee_id"] for e in resp.experts}
    assert c1.employee_id in ids and c2.employee_id in ids


# ---- 增量（etag/known_versions）----

def test_known_version_match_skips():
    config_svc, grant_svc, _ms, svc = _services()
    ctx = _ctx("t-a", roles=["owner"], user_id="admin-1")
    created = config_svc.create(ctx, _body(), employee_slug="exp-x")
    grant_svc.set_grant("t-a", created.employee_id, member_ids=["admin-1"])
    # admin豁免，known_versions 含当前版本 → 不回此条
    resp = svc.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="admin-1",
        known_versions={created.employee_id: str(created.version)},
    ))
    assert not any(e["employee_id"] == created.employee_id for e in resp.experts)


def test_stale_version_returns_delta():
    config_svc, _gs, _ms, svc = _services()
    ctx = _ctx("t-a", roles=["owner"], user_id="admin-1")
    created = config_svc.create(ctx, _body(), employee_slug="exp-x")
    # 旧版本（"0"）→ 当前是 "1" → 返回增量
    resp = svc.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="admin-1",
        known_versions={created.employee_id: "0"},
    ))
    assert any(e["employee_id"] == created.employee_id for e in resp.experts)


def test_role_title_change_reaches_only_authorized_member_delta():
    config, grants, members, service = _services()
    owner = _ctx("t-a", roles=["owner"])
    created = config.create(owner, _body(), employee_slug="role-delta")
    members.set_member("t-a", "m-1")
    members.set_member("t-a", "m-2")
    grants.set_grant("t-a", created.employee_id, member_ids=["m-1"])
    known = {created.employee_id: str(created.version)}
    updated = config.update(owner, _body().model_copy(update={"role_title": "研究分析师", "department_ids": ["d-a", "d-b"]}), employee_id=created.employee_id)
    req = AuthorizedConfigPullRequest(tenant_id="t-a", member_id="m-1", known_versions=known)
    result = service.pull(_ctx("t-a", user_id="m-1"), req)
    assert result.experts[0]["role_title"] == "研究分析师"
    assert result.experts[0]["department_ids"] == ["d-a", "d-b"]
    assert result.experts[0]["version"] == updated.version
    req.known_versions = {created.employee_id: str(updated.version)}
    assert service.pull(_ctx("t-a", user_id="m-1"), req).experts == []
    for tenant, member in [("t-a", "m-2"), ("t-b", "m-1")]:
        assert service.pull(_ctx(tenant, user_id=member), AuthorizedConfigPullRequest(tenant_id=tenant, member_id=member)).experts == []


# ---- revoked_ids ----

def test_non_business_exception_propagates():
    # 非 NotFound 异常（模拟 PG 连接失败）必须透传，不能被吞成空集合。
    class _BrokenMemberService(_FakeMemberService):
        def get_member(self, ctx, member_id):
            raise RuntimeError("simulated PG failure")

    config_svc = EmployeeConfigService(_FakeRepo())
    svc = AuthorizedConfigService(
        config_service=config_svc,
        grant_service=_FakeGrantService(),
        member_service=_BrokenMemberService(),
    )
    ctx = _ctx("t-a", roles=["member"], user_id="m-1")
    with pytest.raises(RuntimeError, match="simulated PG failure"):
        svc.pull(ctx, AuthorizedConfigPullRequest(tenant_id="t-a", member_id="m-1"))


def test_revoked_ids_for_no_longer_authorized():
    config_svc, _gs, member_svc, svc = _services()
    ctx = _ctx("t-a", roles=["member"], user_id="m-1")
    member_svc.set_member("t-a", "m-1")
    # member 曾持 "old-eid"，现在没 grant → revoked
    resp = svc.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="m-1",
        known_versions={"old-eid": "v1"},
    ))
    assert "old-eid" in resp.revoked_ids


def test_bundle_citation_versions_are_not_projection_versions():
    config_svc, _gs, _member_svc, svc = _services()
    ctx = _ctx("t-a", roles=["owner"], user_id="owner-1")
    config_svc.create(ctx, _body(), employee_slug="exp-x")
    _member_svc.set_member("t-a", "owner-1")
    citation_id = "citation-1"

    # Real AuthorizedConfigService treats unknown keys as revoked projection IDs.
    polluted = svc.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="owner-1", known_versions={citation_id: "v1"},
    ))
    assert citation_id in polluted.revoked_ids

    # The bundle pull must therefore call this service with its own empty map.
    clean = svc.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="owner-1", known_versions={},
    ))
    assert citation_id not in clean.revoked_ids


# ---- HTTP 端点（非 integration）----

def _token(tenant_id: str, roles: list[str], user_id: str) -> str:
    return sign_inmem_token(_INMEM_SIGNER, tenant_id, roles, user_id=user_id)


def _client(db_url: str | None) -> TestClient:
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_grants import router as grants_router

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.state._token_verifier = _INMEM_VERIFIER
    app.include_router(grants_router)
    return TestClient(app)


def test_authorized_config_unauth_401():
    client = _client(db_url=None)
    r = client.post(
        "/api/manager/grants/authorized-config",
        json={"tenant_id": "t1", "member_id": "m1"},
    )
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")


def test_authorized_config_member_id_mismatch_403():
    client = _client(db_url=None)
    tok = _token("t1", ["owner"], user_id="real-user")
    r = client.post(
        "/api/manager/grants/authorized-config",
        json={"tenant_id": "t1", "member_id": "someone-else"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")


def test_authorized_config_tenant_id_mismatch_403():
    # 契约自洽（03 §9.7）：body.tenant_id 与 token claims 的 tenant_id 不一致 → 拒绝。
    client = _client(db_url=None)
    tok = _token("t1", ["owner"], user_id="real-user")
    r = client.post(
        "/api/manager/grants/authorized-config",
        json={"tenant_id": "t-other", "member_id": "real-user"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")


def test_authorized_config_no_db_503():
    client = _client(db_url=None)
    tok = _token("t1", ["owner"], user_id="real-user")
    r = client.post(
        "/api/manager/grants/authorized-config",
        json={"tenant_id": "t1", "member_id": "real-user"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"
