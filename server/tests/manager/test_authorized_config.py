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

import dataclasses
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


def test_avatar_only_change_uses_additive_sync_version_without_config_cas_change():
    config_svc, grant_svc, member_svc, _ = _services()
    ctx = _ctx("t-a", roles=["owner"], user_id="admin-1")
    created = config_svc.create(ctx, _body(), employee_slug="exp-avatar")
    grant_svc.set_grant("t-a", created.employee_id, member_ids=["admin-1"])
    avatar = SimpleNamespace(employee_id=created.employee_id, version=4)
    avatar_repository = SimpleNamespace(get=lambda _ctx, _employee_id: avatar)
    svc = AuthorizedConfigService(
        config_service=config_svc,
        grant_service=grant_svc,
        member_service=member_svc,
        avatar_repository=avatar_repository,
    )

    first = svc.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="admin-1",
        known_versions={created.employee_id: f"{created.version}:avatar-3"},
    ))
    assert first.experts[0]["version"] == created.version
    assert first.experts[0]["avatar_version"] == 4
    assert first.experts[0]["avatar_sync_version"] == f"{created.version}:avatar-4"
    # 投影是同源相对路径，?v= 跟随头像版本，不依赖请求 Host。
    assert first.experts[0]["avatar_url"] == f"/api/manager/employees/{created.employee_id}/avatar/content?v=4"

    same = svc.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="admin-1",
        known_versions={created.employee_id: f"{created.version}:avatar-4"},
    ))
    assert same.experts == []

    no_avatar_service = AuthorizedConfigService(
        config_service=config_svc,
        grant_service=grant_svc,
        member_service=member_svc,
        avatar_repository=SimpleNamespace(get=lambda _ctx, _employee_id: None),
    )
    no_avatar = no_avatar_service.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="admin-1",
        known_versions={created.employee_id: f"{created.version}:avatar-0"},
    ))
    assert no_avatar.experts == []
    # Agents predating avatar_sync_version only send the employee config
    # version; an employee without a Manager avatar must still be a no-op.
    legacy_no_avatar = no_avatar_service.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="admin-1",
        known_versions={created.employee_id: str(created.version)},
    ))
    assert legacy_no_avatar.experts == []


@pytest.mark.parametrize("with_avatar_repository", [False, True])
@pytest.mark.parametrize("known_format", ["plain", "avatar"])
def test_expert_provenance_backfill_uses_config_revision(with_avatar_repository, known_format):
    repo = _FakeRepo()
    config_svc = EmployeeConfigService(repo)
    member_svc = _FakeMemberService()
    member_svc.set_member("t-a", "admin-1")
    ctx = _ctx("t-a", roles=["owner"], user_id="admin-1")
    recruited = config_svc.create(ctx, _body(), employee_slug="exp-tpl")
    direct = config_svc.create(ctx, _body(), employee_slug="exp-direct")
    bucket = repo._bucket(ctx)
    # Migration 0047 advances existing template-backed employees once.
    bucket[recruited.employee_id] = dataclasses.replace(
        bucket[recruited.employee_id], source_template_id="tpl-hr", source_template_version="v3",
        version=recruited.version + 1,
    )
    svc = AuthorizedConfigService(
        config_service=config_svc,
        grant_service=_FakeGrantService(),
        member_service=member_svc,
        avatar_repository=SimpleNamespace(get=lambda _ctx, _employee_id: None) if with_avatar_repository else None,
    )
    def known(version):
        return str(version) if known_format == "plain" else f"{version}:avatar-0"

    before = {recruited.employee_id: known(recruited.version), direct.employee_id: known(direct.version)}
    resp = svc.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="admin-1", known_versions=before,
    ))
    assert len(resp.experts) == 1
    expert = resp.experts[0]
    assert expert["employee_id"] == recruited.employee_id
    assert expert["version"] == recruited.version + 1
    assert expert["source_template_id"] == "tpl-hr"
    assert expert["source_template_version"] == "v3"
    assert expert["avatar_sync_version"] == f"{recruited.version + 1}:avatar-0"
    before[recruited.employee_id] = expert["avatar_sync_version"]
    again = svc.pull(ctx, AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="admin-1", known_versions=before,
    ))
    assert again.experts == []


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



# ---- 成员在对话中自行安装技能（设计 §11.1）----

_SKILL_MD = "---\nname: sheet\ndescription: 读表\n---\n读表格。"


def _shaped(files):
    """与仓库 SQL 一致的结构判断：数组、文件数与内容总量在共享契约上限内、含 SKILL.md。"""
    from shared.contracts.skill import MAX_SKILL_FILES, MAX_SKILL_TOTAL_BYTES
    return (isinstance(files, list) and 1 <= len(files) <= MAX_SKILL_FILES
            and any(isinstance(f, dict) and f.get("path") == "SKILL.md" for f in files)
            and sum(len(str(f.get("content", "")).encode()) for f in files if isinstance(f, dict)) <= MAX_SKILL_TOTAL_BYTES)


def _catalog_with(rows):
    class _Repo:
        def __init__(self):
            self.calls = []

        def list_skills(self, ctx):
            raise AssertionError("可自装技能不得读取全量技能（含文件内容）")

        def list_skill_summaries(self, ctx):
            self.calls.append(("summaries",))
            return [
                SimpleNamespace(skill_id=row.skill_id, display_name=row.display_name, version=row.version,
                                binding_policy=row.binding_policy, visibility=row.visibility, config=row.config,
                                content_hash=row.content_hash, package_shaped=_shaped(row.files))
                for row in rows
            ]

        def get_skill_by_skill_id(self, ctx, *, skill_id):
            self.calls.append(("one", skill_id))
            return next((row for row in rows if row.skill_id == skill_id), None)

    class _Catalog:
        _repo = _Repo()

    return _Catalog()


def _skill_row(skill_id, *, visibility="tenant", binding_policy="opt_in", files=None, source=""):
    from manager_service.custom_skill_package import catalog_package
    files = files if files is not None else [{"path": "SKILL.md", "content": _SKILL_MD}]
    try:
        content_hash = catalog_package(skill_id=skill_id, version="1", files=files).content_hash
    except ValueError:
        content_hash = ""
    return SimpleNamespace(
        skill_id=skill_id, display_name=skill_id.upper(), version="1", files=files, content_hash=content_hash,
        catalog_id=skill_id, install_policy="on_demand", binding_policy=binding_policy, visibility=visibility,
        config={"source": "operator", "source_skill_id": source} if source else {}, catalog_version=1,
    )


def _installer(rows, signer=None):
    service = AuthorizedConfigService(
        config_service=EmployeeConfigService(_FakeRepo()), grant_service=_FakeGrantService(), member_service=_FakeMemberService(),
        capability_catalog=_catalog_with(rows), skill_signer=signer or SkillPackageSigner(Ed25519PrivateKey.generate(), "k1"),
    )
    service._members.set_member("t-a", "m-1")
    return service


def test_members_can_only_self_install_tenant_visible_enabled_executable_skills():
    rows = [
        _skill_row("sheet", source="plat-sheet"),
        _skill_row("public", visibility="public"),
        _skill_row("secret", visibility="private"),
        _skill_row("off", binding_policy="disabled"),
        _skill_row("legacy", files=[{"path": "references/a.md", "content": "x"}]),
    ]
    items = _installer(rows).installable_skills(_ctx("t-a", user_id="m-1"))
    assert [(item.skill_id, item.source_skill_id) for item in items] == [("sheet", "plat-sheet"), ("public", "")]
    # Only skills installed from the platform skill market are platform-origin (auto-install eligible, §11.3).
    assert [item.origin for item in items] == ["platform", "enterprise"]
    assert all(item.content_hash for item in items)


def test_installable_skills_carry_skill_md_name_namespace_and_provenance():
    """Design「技能MCP命名空间出处与更新提示」§4.4: the desktop shows taiyim/x or 企业名/x and checks same-name skills."""
    platform = _skill_row("platform-p1", source="p1")
    platform.config.update({"namespace": "taiyim", "provenance": None, "skill_name": "weather", "slug": "weather"})
    hub = _skill_row("self-improving")
    hub.config.update({"source": "clawhub", "provenance": {"kind": "clawhub", "label": "ClawHub o/self-improving", "edited": False}})
    items = _installer([platform, _skill_row("notes"), hub]).installable_skills(_ctx("t-a", user_id="m-1"), enterprise_namespace="太一科技")
    assert [(item.name, item.namespace) for item in items] == [("weather", "taiyim"), ("notes", "太一科技"), ("self-improving", "")]
    assert items[2].provenance.label == "ClawHub o/self-improving" and items[0].provenance is None


def test_installable_package_is_signed_for_the_calling_member_and_out_of_scope_skills_are_404():
    service = _installer([_skill_row("sheet"), _skill_row("secret", visibility="private")])
    result = service.installable_skill_package(_ctx("t-a", user_id="m-1"), "sheet")
    assert (result.package.tenant_id, result.package.member_id, result.package.key_id) == ("t-a", "m-1", "k1")
    assert [key.key_id for key in result.signing_keys] == ["k1"]
    for skill_id in ("secret", "missing"):
        with pytest.raises(NotFound):
            service.installable_skill_package(_ctx("t-a", user_id="m-1"), skill_id)


def test_installable_list_reads_summaries_only_and_package_reads_exactly_one_row():
    rows = [_skill_row("sheet"), _skill_row("other"), _skill_row("off", binding_policy="disabled")]
    service = _installer(rows)
    repo = service._capability._repo
    service.installable_skills(_ctx("t-a", user_id="m-1"))
    assert repo.calls == [("summaries",)]
    repo.calls.clear()
    service.installable_skill_package(_ctx("t-a", user_id="m-1"), "sheet")
    assert repo.calls == [("one", "sheet")]


def test_private_disabled_and_tampered_skills_are_404_on_package_fetch():
    tampered = _skill_row("tampered")
    tampered.files = [{"path": "SKILL.md", "content": _SKILL_MD + "\n改过。"}]
    service = _installer([_skill_row("secret", visibility="private"), _skill_row("off", binding_policy="disabled"), tampered,
                          _skill_row("legacy", files=[{"path": "references/a.md", "content": "x"}])])
    for skill_id in ("secret", "off", "tampered", "legacy"):
        with pytest.raises(NotFound):
            service.installable_skill_package(_ctx("t-a", user_id="m-1"), skill_id)


def test_self_install_is_unavailable_without_catalog_or_signer():
    from shared.errors import ServiceUnavailable

    service = AuthorizedConfigService(
        config_service=EmployeeConfigService(_FakeRepo()), grant_service=_FakeGrantService(), member_service=_FakeMemberService(),
        capability_catalog=None, skill_signer=None,
    )
    service._skill_signer = None
    with pytest.raises(ServiceUnavailable):
        service.installable_skills(_ctx("t-a", user_id="m-1"))


# ---- 跳过的技能引用（设计 2026-11-22 §3.4）----


class _MutableCatalog:
    """给员工配置服务用的目录：读状态时按当前内容，不走真库。"""

    def __init__(self):
        self.skills = {}

    def snapshot(self, ctx):
        from manager_service.employee_capability_refs import CatalogSnapshot
        return CatalogSnapshot(skills=dict(self.skills))

    def statuses(self, ctx, skills, connectors, *, snapshot=None):
        view = snapshot or self.snapshot(ctx)
        return [view.skill_status(ref) for ref in skills], [view.connector_status(ref) for ref in connectors]

    def validate_additions(self, *a, **kw):
        return None


def test_pull_reports_why_each_skill_ref_was_not_delivered_even_when_version_is_unchanged():
    catalog = _MutableCatalog()
    # skill_id -> (display_name, version, binding_policy, package_shaped, content_hash)
    catalog.skills = {"ok": ("好用", "1", "opt_in", True, "h"), "off": ("停用的", "1", "disabled", True, "h"),
                      "wip": ("没写完", "1", "opt_in", False, ""), "bad": ("坏了", "1", "opt_in", True, "")}
    config_svc = EmployeeConfigService(_FakeRepo(), capability_refs=catalog)
    member_svc = _FakeMemberService(); member_svc.set_member("t-a", "m-1")
    svc = AuthorizedConfigService(config_service=config_svc, grant_service=_FakeGrantService(), member_service=member_svc)
    body = _body().model_copy(update={"skills": ["ok", "off", "wip", "bad", "gone@2"]})
    owner = _ctx("t-a", roles=["owner"], user_id="m-1")
    created = config_svc.create(owner, body, employee_slug="x")
    req = AuthorizedConfigPullRequest(tenant_id="t-a", member_id="m-1", known_versions={created.employee_id: str(created.version)})

    response = svc.pull(owner, req)

    assert response.experts == []  # 员工配置没变，不重发
    got = {(item.skill_id, item.reason) for item in response.skipped_refs}
    assert got == {("off", "disabled"), ("wip", "draft"), ("bad", "invalid"), ("gone", "missing")}
    assert {item.employee_id for item in response.skipped_refs} == {created.employee_id}
    assert next(item for item in response.skipped_refs if item.skill_id == "gone").ref == "gone@2"
    assert "skill_status" not in str(response.model_dump()["experts"])
    # 跨端契约：与 Agent 测试共用同一份样例，字段名 / 取值任何一边改了都会有一边失败。
    import json, pathlib
    fixture = json.loads((pathlib.Path(__file__).parent.parent / "contract_fixtures" / "sync_skipped_refs.json").read_text(encoding="utf8"))
    emitted = [{**item, "employee_id": "EMP"} for item in response.model_dump(mode="json")["skipped_refs"]]
    assert sorted(emitted, key=lambda i: i["skill_id"]) == sorted(fixture["skipped_refs"], key=lambda i: i["skill_id"])

    catalog.skills["off"] = ("停用的", "1", "opt_in", True, "h")  # 管理员重新启用
    again = svc.pull(owner, req)
    assert {item.skill_id for item in again.skipped_refs} == {"wip", "bad", "gone"}
