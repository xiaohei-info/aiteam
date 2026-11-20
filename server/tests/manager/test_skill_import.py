"""Enterprise skill import (design 2026-11-20 §4.3, P2): six sources, multi-skill packages, upgrades, SSRF."""
from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from manager_service.capability_origin import skill_origin
from manager_service.skill_import_service import (
    ImportRequest,
    SkillImportService,
    SkillSourceUnavailable,
)
from shared.config import Settings
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, ValidationProblem
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from tests.manager.test_capability_catalog import _FakeRepo


def _skill(name="weekly-report", description="把一周的工作整理成周报", version=None, body="# 周报\n"):
    head = f"---\nname: {name}\ndescription: {description}\n" + (f"version: {version}\n" if version else "") + "---\n"
    return head + body


def _zip(files: dict[str, str | bytes]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        for path, content in files.items():
            archive.writestr(path, content)
    return out.getvalue()


class _Audit:
    def __init__(self):
        self.events = []

    def record(self, ctx, **kw):
        self.events.append(kw)


class _Fetch:
    """Scripted remote: url -> (status, headers, body). Records every URL asked for."""

    def __init__(self, routes: dict[str, tuple[int, dict, bytes]]):
        self.routes = routes
        self.seen: list[str] = []

    def __call__(self, method, url, headers, body, deadline):
        self.seen.append(url)
        return self.routes.get(url, (404, {}, b""))


def _ctx(tenant="t-a", roles=("owner",)):
    return TenantContext(tenant_id=tenant, user_id="admin-1", roles=list(roles))


def _svc(fetch=None, repo=None, audit=None):
    return SkillImportService(repo or _FakeRepo(), fetch=fetch, audit=audit, clawhub_base="https://clawhub.ai")


def _install(svc, ctx, request):
    return svc.install(ctx, request, visibility="tenant", binding_policy="opt_in", install_policy="on_demand")


# ---- the six sources ----

def test_text_source_previews_then_installs_with_frontmatter_version():
    audit = _Audit()
    svc = _svc(audit=audit)
    request = ImportRequest(source="text", text=_skill(version="1.2.0"))
    preview = svc.preview(_ctx(), request)["preview"]
    assert (preview["name"], preview["version"], preview["existing"], preview["ok"]) == ("weekly-report", "1.2.0", "none", True)
    result = _install(svc, _ctx(), request)["results"][0]
    assert (result["status"], result["version"]) == ("installed", "1.2.0")
    assert audit.events[0]["action"] == "skill_catalog.imported"
    assert "周报" not in audit.events[0]["detail"]  # never file contents


def test_folder_source_keeps_scripts_and_reports_binaries_and_hooks():
    svc = _svc()
    entries = [
        ("report/SKILL.md", _skill().encode()), ("report/scripts/run.sh", b"#!/bin/sh\necho hi\n"),
        ("report/assets/logo.png", b"\x89PNG\x00\x01"), ("report/hooks/openclaw/h.js", b"x"), ("report/.DS_Store", b"x"),
    ]
    preview = svc.preview(_ctx(), ImportRequest(source="folder", entries=entries))["preview"]
    assert [f["path"] for f in preview["files"]] == ["SKILL.md", "scripts/run.sh"]
    assert {(s["path"], s["reason"]) for s in preview["skipped"]} == {("assets/logo.png", "binary"), ("hooks/openclaw/h.js", "platform_hook")}
    assert len(preview["version"]) == 12  # no frontmatter version -> content hash prefix


def test_zip_source_with_several_skills_lists_them_and_installs_only_the_chosen():
    repo = _FakeRepo()
    svc = _svc(repo=repo)
    archive = _zip({"a/SKILL.md": _skill("alpha"), "b/SKILL.md": _skill("beta"), "c/SKILL.md": "no frontmatter"})
    scan = svc.preview(_ctx(), ImportRequest(source="zip", entries=[("pack.zip", archive)]))["scan"]
    assert [(item["root"], item["ok"]) for item in scan] == [("a", True), ("b", True), ("c", False)]
    results = _install(svc, _ctx(), ImportRequest(source="zip", entries=[("pack.zip", archive)], roots=["b"]))["results"]
    assert [(r["name"], r["status"]) for r in results] == [("beta", "installed")]
    assert [row.skill_id for row in repo.list_skills(_ctx())] == ["beta"]
    # without roots: every valid skill, invalid ones are left out instead of failing the batch
    results = _install(svc, _ctx(), ImportRequest(source="zip", entries=[("pack.zip", archive)]))["results"]
    assert [(r["name"], r["status"]) for r in results] == [("alpha", "installed"), ("beta", "duplicate")]


def test_single_md_file_source():
    preview = _svc().preview(_ctx(), ImportRequest(source="file", entries=[("whatever.md", _skill("one-file").encode())]))["preview"]
    assert preview["name"] == "one-file"
    with pytest.raises(ValidationProblem):
        _svc().preview(_ctx(), ImportRequest(source="file", entries=[("x.txt", b"x")]))


def test_url_source_github_tree_uses_codeload_subfolder():
    archive = _zip({"skills-main/tools/pdf/SKILL.md": _skill("pdf-tool"), "skills-main/tools/pdf/ref.md": "r", "skills-main/README.md": "x"})
    fetch = _Fetch({"https://codeload.github.com/acme/skills/zip/refs/heads/main": (200, {}, archive)})
    preview = _svc(fetch).preview(_ctx(), ImportRequest(source="url", url="https://github.com/acme/skills/tree/main/tools/pdf"))
    assert preview["preview"]["name"] == "pdf-tool"
    assert [f["path"] for f in preview["preview"]["files"]] == ["SKILL.md", "ref.md"]
    assert preview["origin"] == {"kind": "url", "label": "https://github.com/acme/skills/tree/main/tools/pdf", "url": "https://github.com/acme/skills/tree/main/tools/pdf"}


def test_url_source_plain_md_and_same_host_redirect():
    fetch = _Fetch({
        "https://example.com/s.md": (302, {"location": "/v2/s.md"}, b""),
        "https://example.com/v2/s.md": (200, {}, _skill("plain").encode()),
    })
    assert _svc(fetch).preview(_ctx(), ImportRequest(source="url", url="https://example.com/s.md"))["preview"]["name"] == "plain"


def test_clawhub_source_returns_candidates_then_installs_with_security_and_registry_files_dropped():
    package = {"SKILL.md": _skill("self-improving"), "scripts/x.sh": "echo", "hooks/openclaw/h.js": "x", "_meta.json": "{}", "skill-card.md": "c"}
    scan = {"security": {"status": "clean", "hasWarnings": True, "scanners": {"skillspector": {"status": "suspicious", "recommendation": "DO_NOT_INSTALL"}}}}
    fetch = _Fetch({
        "https://clawhub.ai/api/v1/skills/self-improving": (409, {}, json.dumps({"matches": [
            {"ownerHandle": "a", "slug": "self-improving", "url": "https://clawhub.ai/a/skills/self-improving"},
            {"ownerHandle": "b", "slug": "self-improving", "url": "https://clawhub.ai/b/skills/self-improving"}]}).encode()),
        "https://clawhub.ai/api/v1/download?slug=self-improving&ownerHandle=a": (200, {}, _zip(package)),
        "https://clawhub.ai/api/v1/skills/self-improving/scan?ownerHandle=a": (200, {}, json.dumps(scan).encode()),
    })
    repo = _FakeRepo()
    svc = _svc(fetch, repo=repo)
    ambiguous = svc.preview(_ctx(), ImportRequest(source="clawhub", url="https://clawhub.ai/skills/self-improving"))
    assert [c["owner"] for c in ambiguous["clawhub"]["candidates"]] == ["a", "b"] and "preview" not in ambiguous
    with pytest.raises(ValidationProblem, match="作者"):
        _install(svc, _ctx(), ImportRequest(source="clawhub", url="https://clawhub.ai/skills/self-improving"))
    request = ImportRequest(source="clawhub", url="https://clawhub.ai/a/skills/self-improving")
    preview = svc.preview(_ctx(), request)
    assert [f["path"] for f in preview["preview"]["files"]] == ["SKILL.md", "scripts/x.sh"]
    assert preview["clawhub"]["security"]["scanners"][0]["recommendation"] == "DO_NOT_INSTALL"
    assert _install(svc, _ctx(), request)["results"][0]["status"] == "installed"
    row = repo.get_skill_by_id(_ctx(), skill_id="self-improving")
    assert row.config["source"] == "clawhub" and row.config["origin"]["url"] == "https://clawhub.ai/a/skills/self-improving"
    assert row.config["security"]["status"] == "clean" and row.config["skipped"] == [{"path": "hooks/openclaw/h.js", "reason": "platform_hook"}]


def test_clawhub_scan_failure_does_not_block():
    fetch = _Fetch({"https://clawhub.ai/api/v1/download?slug=x&ownerHandle=o": (200, {}, _zip({"SKILL.md": _skill("x")}))})
    preview = _svc(fetch).preview(_ctx(), ImportRequest(source="clawhub", url="https://clawhub.ai/o/skills/x"))
    assert preview["clawhub"]["security"] is None and preview["preview"]["ok"]


# ---- same name: duplicate / upgrade / protected ----

def test_same_name_different_content_becomes_new_version_and_keeps_policies():
    repo = _FakeRepo()
    svc = _svc(repo=repo)
    first = _install(svc, _ctx(), ImportRequest(source="text", text=_skill(version="1.0.0")))["results"][0]
    row = repo.get_skill_by_id(_ctx(), skill_id="weekly-report")
    repo.update_skill(_ctx(), catalog_id=row.catalog_id, visibility="private", display_name=None, version=None,
                      install_policy=None, binding_policy=None, config=None)
    again = ImportRequest(source="text", text=_skill(version="1.0.0"))
    assert svc.preview(_ctx(), again)["preview"]["existing"] == "same"
    assert _install(svc, _ctx(), again)["results"][0]["status"] == "duplicate"
    changed = ImportRequest(source="text", text=_skill(version="1.0.0", body="# 新版\n"))
    preview = svc.preview(_ctx(), changed)["preview"]
    assert preview["existing"] == "update" and preview["version"].startswith("1.0.0-") and preview["existing_version"] == "1.0.0"
    result = _install(svc, _ctx(), changed)["results"][0]
    assert result["status"] == "updated" and result["catalog_id"] == first["catalog_id"]
    updated = repo.get_skill_by_id(_ctx(), skill_id="weekly-report")
    assert updated.version == preview["version"] and updated.visibility == "private"


def test_editor_source_saves_a_skill_and_editing_a_clawhub_skill_makes_it_custom():
    """「从零写一个」/「编辑」 send the editor's files; editing an imported skill makes it the enterprise's own."""
    fetch = _Fetch({
        "https://clawhub.ai/api/v1/download?slug=x&ownerHandle=o": (200, {}, _zip({"SKILL.md": _skill("x"), "hooks/openclaw/h.js": "x"})),
        "https://clawhub.ai/api/v1/skills/x/scan?ownerHandle=o": (200, {}, json.dumps({"security": {"status": "suspicious"}}).encode()),
    })
    repo = _FakeRepo()
    svc = _svc(fetch, repo=repo)
    written = ImportRequest(source="editor", entries=[("SKILL.md", _skill("weekly-report").encode()), ("scripts/fill.sh", b"echo")])
    result = _install(svc, _ctx(), written)["results"][0]
    row = repo.get_skill_by_id(_ctx(), skill_id="weekly-report")
    assert result["status"] == "installed" and row.config["source"] == "custom" and row.config["origin"]["label"] == "在线编辑"
    assert {f["path"] for f in row.files} == {"SKILL.md", "scripts/fill.sh"} and row.version == row.content_hash[:12]

    _install(svc, _ctx(), ImportRequest(source="clawhub", url="https://clawhub.ai/o/skills/x"))
    assert repo.get_skill_by_id(_ctx(), skill_id="x").config["security"]["status"] == "suspicious"
    edited = ImportRequest(source="editor", entries=[("SKILL.md", _skill("x", body="# 改过\n").encode())])
    assert _install(svc, _ctx(), edited)["results"][0]["status"] == "updated"
    row = repo.get_skill_by_id(_ctx(), skill_id="x")
    assert row.config["source"] == "custom" and "security" not in row.config and "skipped" not in row.config
    assert [f["content"] for f in row.files] == [_skill("x", body="# 改过\n")]


def test_provenance_is_cited_until_edited_and_kept_after():
    """Design「技能MCP命名空间出处与更新提示」§4.1: imported as is → 来自 ClawHub; after an edit → 改自, enterprise namespace."""
    fetch = _Fetch({"https://clawhub.ai/api/v1/download?slug=x&ownerHandle=o": (200, {}, _zip({"SKILL.md": _skill("x")}))})
    repo = _FakeRepo()
    svc = _svc(fetch, repo=repo)
    _install(svc, _ctx(), ImportRequest(source="clawhub", url="https://clawhub.ai/o/skills/x"))
    prov = repo.get_skill_by_id(_ctx(), skill_id="x").config["provenance"]
    assert prov == {"kind": "clawhub", "label": "ClawHub o/x", "url": "https://clawhub.ai/o/skills/x", "version": "", "edited": False}
    _install(svc, _ctx(), ImportRequest(source="editor", entries=[("SKILL.md", _skill("x", body="# 改过\n").encode())]))
    row = repo.get_skill_by_id(_ctx(), skill_id="x")
    assert row.config["provenance"]["edited"] is True and row.config["provenance"]["label"] == "ClawHub o/x"
    origin = skill_origin(row.config, skill_id="x", enterprise="太一科技")
    assert origin["namespace"] == "太一科技"
    _install(svc, _ctx(), ImportRequest(source="text", text=_skill("own")))
    assert repo.get_skill_by_id(_ctx(), skill_id="own").config["provenance"] is None


def test_editing_a_platform_market_skill_saves_an_enterprise_copy_and_leaves_the_original():
    repo = _FakeRepo()
    platform = repo.create_skill(
        _ctx(), skill_id="platform-p1", display_name="weather", version="8c2d", install_policy="on_demand", binding_policy="opt_in",
        visibility="tenant", config={"source": "operator", "owner": "platform", "slug": "weather", "namespace": "taiyim", "provenance": None, "skill_name": "weather"},
        files=[{"path": "SKILL.md", "content": _skill("weather")}], content_hash="h",
    )
    svc = _svc(repo=repo)
    copy = ImportRequest(source="editor", entries=[("SKILL.md", _skill("weather", body="# 企业改的\n").encode())], fork_of=platform.catalog_id)
    assert _install(svc, _ctx(), copy)["results"][0]["status"] == "installed"
    row = repo.get_skill_by_id(_ctx(), skill_id="weather")
    assert row.config["provenance"] == {"kind": "platform", "label": "taiyim/weather", "url": "", "version": "8c2d", "edited": True}
    assert repo.get_skill_by_id(_ctx(), skill_id="platform-p1").version == "8c2d"  # the platform original stays
    with pytest.raises(ValidationProblem, match="平台技能市场"):
        _install(svc, _ctx(), ImportRequest(source="editor", entries=[("SKILL.md", _skill("weather").encode())], fork_of=row.catalog_id))


def test_platform_skill_name_is_not_overwritten():
    repo = _FakeRepo()
    repo.create_skill(_ctx(), skill_id="pdf", display_name="pdf", version="1", install_policy="on_demand", binding_policy="opt_in",
                      visibility="tenant", config={"source": "operator"}, files=[], content_hash="")
    preview = _svc(repo=repo).preview(_ctx(), ImportRequest(source="text", text=_skill("pdf")))["preview"]
    assert not preview["ok"] and "平台技能市场" in preview["reason"]
    with pytest.raises(ValidationProblem, match="没有可导入"):
        _install(_svc(repo=repo), _ctx(), ImportRequest(source="text", text=_skill("pdf")))
    # an explicitly chosen root reports its failure instead of being dropped
    result = _install(_svc(repo=repo), _ctx(), ImportRequest(source="text", text=_skill("pdf"), roots=[""]))["results"][0]
    assert result["status"] == "failed" and "平台技能市场" in result["reason"]


@pytest.mark.parametrize("text, reason", [
    (_skill("Bad_Name"), "小写字母"),
    (_skill("platform-x"), "platform-"),
    ("---\nname: ok\n---\n# no description", "description"),
])
def test_invalid_skills_are_explained(text, reason):
    preview = _svc().preview(_ctx(), ImportRequest(source="text", text=text))["preview"]
    assert not preview["ok"] and reason in preview["reason"]


def test_tenants_are_isolated_and_members_cannot_import():
    repo = _FakeRepo()
    svc = _svc(repo=repo)
    _install(svc, _ctx("t-a"), ImportRequest(source="text", text=_skill()))
    assert svc.preview(_ctx("t-b"), ImportRequest(source="text", text=_skill()))["preview"]["existing"] == "none"
    with pytest.raises(Forbidden):
        svc.preview(_ctx(roles=("member",)), ImportRequest(source="text", text=_skill()))


# ---- SSRF (real pinned fetch, no network needed: the guard refuses before connecting) ----

@pytest.mark.parametrize("url", ["https://127.0.0.1/s.md", "https://169.254.169.254/latest/s.md", "https://[::1]/s.md", "https://10.0.0.8/a.zip"])
def test_private_addresses_are_refused(url):
    with pytest.raises(ValidationProblem, match="内网"):
        _svc().preview(_ctx(), ImportRequest(source="url", url=url))


def test_http_and_cross_host_redirects_are_refused():
    with pytest.raises(ValidationProblem, match="https"):
        _svc().preview(_ctx(), ImportRequest(source="url", url="http://example.com/s.md"))
    fetch = _Fetch({"https://example.com/s.md": (302, {"location": "https://169.254.169.254/s.md"}, b"")})
    with pytest.raises(SkillSourceUnavailable, match="其他网站"):
        _svc(fetch).preview(_ctx(), ImportRequest(source="url", url="https://example.com/s.md"))
    assert fetch.seen == ["https://example.com/s.md"]


def test_unsupported_url_shape():
    with pytest.raises(ValidationProblem, match="GitHub"):
        _svc(_Fetch({})).preview(_ctx(), ImportRequest(source="url", url="https://example.com/page"))


# ---- HTTP routes ----

_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _client(service):
    from manager_service.app import router as manager_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient
    from manager_service.routes_capability import build_capability_router
    from shared.app_factory import create_app

    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://unused"), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.state._skill_import_service = service
    app.include_router(build_capability_router(_VERIFIER))
    return TestClient(app)


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}


def test_routes_accept_json_and_multipart_folder():
    repo = _FakeRepo()
    client = _client(_svc(repo=repo))
    response = client.post("/api/manager/skills/import/preview", headers=_hdr(), json={"source": "text", "text": _skill()})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["preview"]["name"] == "weekly-report"

    files = [("files", ("SKILL.md", _skill("folder-skill").encode())), ("files", ("run.sh", b"echo"))]
    data = {"source": "folder", "paths": ["my/SKILL.md", "my/scripts/run.sh"], "visibility": "private"}
    response = client.post("/api/manager/skills/import", headers=_hdr(), files=files, data=data)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["results"][0]["status"] == "installed"
    row = repo.list_skills(TenantContext(tenant_id="t1", user_id="u", roles=["owner"]))[0]
    assert row.visibility == "private" and {f["path"] for f in row.files} == {"SKILL.md", "scripts/run.sh"}

    files = [("files", ("SKILL.md", _skill("written").encode()))]
    response = client.post("/api/manager/skills/import", headers=_hdr(), files=files, data={"source": "editor", "paths": ["SKILL.md"]})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["results"][0]["status"] == "installed"


def test_routes_reject_wrong_transport_member_role_and_unauthenticated():
    client = _client(_svc())
    assert client.post("/api/manager/skills/import/preview", headers=_hdr(), json={"source": "folder"}).status_code == 422
    assert client.post("/api/manager/skills/import/preview", headers=_hdr(), files=[("files", ("a.md", b"x"))], data={"source": "text"}).status_code == 422
    assert client.post("/api/manager/skills/import/preview", headers=_hdr(("member",)), json={"source": "text", "text": _skill()}).status_code == 403
    assert client.post("/api/manager/skills/import/preview", json={"source": "text", "text": _skill()}).status_code == 401
    # fork_of only makes sense for the editor (an edited copy of a platform-market skill)
    files = [("files", ("SKILL.md", _skill().encode()))]
    assert client.post("/api/manager/skills/import", headers=_hdr(), files=files, data={"source": "folder", "paths": ["SKILL.md"], "fork_of": "x"}).status_code == 422
    assert client.post("/api/manager/skills/import", headers=_hdr(), json={"source": "text", "text": _skill(), "fork_of": "x"}).status_code == 422
