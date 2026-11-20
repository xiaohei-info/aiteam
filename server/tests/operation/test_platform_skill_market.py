import hashlib
from io import BytesIO
from types import SimpleNamespace
from zipfile import ZIP_DEFLATED, ZipFile

import httpx
import pytest

import operation_service.routes_skill_market as skill_routes
from operation_service.platform_skill_market import ClawHubClient, clawhub_url_parts, normalize_security, parse_skill_zip
from operation_service.routes_skill_market import _repo, check_integrity, verified_artifact
from shared.errors import AppError, NotFound, TooManyRequests, ValidationProblem


def _zip(files):
    out = BytesIO()
    with ZipFile(out, "w", ZIP_DEFLATED) as archive:
        for path, content in files.items():
            archive.writestr(path, content)
    return out.getvalue()


def _sha(content):
    data = content if isinstance(content, bytes) else content.encode()
    return hashlib.sha256(data).hexdigest(), len(data)


def test_skill_route_repository_uses_business_dsn(monkeypatch):
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=SimpleNamespace(db_url="postgresql://app_rw/operation"))))
    monkeypatch.setattr(skill_routes, "PlatformSkillRepository", lambda dsn: ("repo", dsn))
    assert _repo(request) == ("repo", "postgresql://app_rw/operation")
    assert request.app.state._platform_skill_repository == ("repo", "postgresql://app_rw/operation")


def test_parse_skill_zip_keeps_scripts_assets_and_root_markdown():
    parsed = parse_skill_zip(_zip({
        "SKILL.md": "# Demo", "csv.md": "csv", "scripts/run.py": "print(1)", "assets/a.json": "{}",
        "_meta.json": "{}", "skill-card.md": "card",
    }))
    assert [item["path"] for item in parsed.files] == ["SKILL.md", "assets/a.json", "csv.md", "scripts/run.py"]
    assert parsed.skipped == []
    assert len(parsed.content_hash) == 16


def test_parse_skill_zip_skips_platform_hooks_and_binaries():
    parsed = parse_skill_zip(_zip({"SKILL.md": "# Demo", "hooks/openclaw/handler.js": "x", "assets/logo.png": b"\x89PNG\x00\x01"}))
    assert [item["path"] for item in parsed.files] == ["SKILL.md"]
    assert [(item.path, item.reason) for item in parsed.skipped] == [("assets/logo.png", "binary"), ("hooks/openclaw/handler.js", "platform_hook")]


def test_parse_skill_zip_unwraps_single_folder_and_requires_skill_md():
    parsed = parse_skill_zip(_zip({"demo/SKILL.md": "# Demo", "demo/references/a.md": "a"}))
    assert [item["path"] for item in parsed.files] == ["SKILL.md", "references/a.md"]
    with pytest.raises(ValidationProblem, match="SKILL.md"):
        parse_skill_zip(_zip({"references/guide.md": "guide"}))
    with pytest.raises(ValidationProblem, match="several"):
        parse_skill_zip(_zip({"a/SKILL.md": "a", "b/SKILL.md": "b"}))


def _verification(files, *, owner="publisher", slug="demo", version="1.0.0", **extra):
    return {
        "publisherHandle": owner, "slug": slug, "version": version,
        "artifact": {"files": [{"path": path, "sha256": _sha(content)[0], "size": _sha(content)[1]} for path, content in files.items()]},
        **extra,
    }


def test_verify_is_integrity_only_and_ignores_security():
    verification = _verification({"SKILL.md": "# Demo", "scripts/run.py": "print(1)"}, ok=False, reasons=["security.status_not_clean"], security={"passed": False, "status": "suspicious"})
    expected = verified_artifact(verification, owner="publisher", slug="demo", version="1.0.0")
    assert set(expected) == {"SKILL.md", "scripts/run.py"}


def test_verify_rejects_identity_mismatch_and_missing_manifest():
    with pytest.raises(ValidationProblem, match="不一致"):
        verified_artifact(_verification({"SKILL.md": "x"}, owner="someone-else"), owner="publisher", slug="demo", version="1.0.0")
    with pytest.raises(ValidationProblem, match="文件清单"):
        verified_artifact({"publisherHandle": "publisher", "slug": "demo", "version": "1.0.0", "artifact": {"files": []}}, owner="publisher", slug="demo", version="1.0.0")


def test_integrity_accepts_reported_skips_and_rejects_tampering_or_missing_files():
    files = {"SKILL.md": "# Demo", "hooks/openclaw/h.js": "x"}
    expected = verified_artifact(_verification(files), owner="publisher", slug="demo", version="1.0.0")
    check_integrity(parse_skill_zip(_zip(files)), expected)
    with pytest.raises(ValidationProblem, match="不一致"):
        check_integrity(parse_skill_zip(_zip({**files, "SKILL.md": "# Changed"})), expected)
    with pytest.raises(ValidationProblem, match="缺少"):
        check_integrity(parse_skill_zip(_zip({"SKILL.md": "# Demo"})), expected)
    with pytest.raises(ValidationProblem, match="不一致"):
        check_integrity(parse_skill_zip(_zip({**files, "extra.md": "smuggled"})), expected)


def test_security_keeps_both_scanners_side_by_side():
    security = normalize_security({"security": {"status": "clean", "hasWarnings": True, "scanners": {
        "skillspector": {"status": "suspicious", "severity": "CRITICAL", "recommendation": "DO_NOT_INSTALL", "issueCount": 18},
        "llm": {"status": "clean", "verdict": "benign", "confidence": "high"},
    }}})
    assert security["has_warnings"] is True
    assert security["scanners"] == [
        {"name": "skillspector", "status": "suspicious", "recommendation": "DO_NOT_INSTALL", "severity": "CRITICAL", "issue_count": 18},
        {"name": "llm", "status": "clean", "verdict": "benign", "confidence": "high"},
    ]
    assert normalize_security({}) is None


def test_clawhub_url_parts():
    assert clawhub_url_parts("https://clawhub.ai/pskoett/skills/self-improving-agent") == ("pskoett", "self-improving-agent")
    assert clawhub_url_parts("https://clawhub.ai/skills/pdf") == (None, "pdf")
    assert clawhub_url_parts("https://evil.example/pskoett/skills/x") is None
    assert clawhub_url_parts("http://clawhub.ai/a/skills/x") is None
    assert clawhub_url_parts("https://clawhub.ai/a/b/skills/x") is None


def test_clawhub_search_does_not_use_internal_version_record_id():
    def handler(request: httpx.Request):
        assert "nonSuspiciousOnly" not in request.url.params
        return httpx.Response(200, json={"results": [{
            "slug": "demo", "displayName": "Demo", "ownerHandle": "publisher", "version": None,
            "native": {"skill": {"tags": {"latest": "internal-record-id"}}},
        }]})

    client = ClawHubClient(transport=httpx.MockTransport(handler))
    assert client.search("demo")[0].latest_version is None


def test_clawhub_browse_uses_owner_qualified_skill_catalog():
    def handler(request: httpx.Request):
        assert request.url.path == "/api/v1/packages"
        assert request.url.params["family"] == "skill"
        assert "nonSuspiciousOnly" not in request.url.params
        return httpx.Response(200, json={"items": [{
            "family": "skill", "name": "demo", "ownerHandle": "publisher",
            "displayName": "Demo", "latestVersion": "1.2.3", "summary": "x",
            "stats": {"downloads": 4}, "updatedAt": 10,
        }], "nextCursor": None})

    client = ClawHubClient(transport=httpx.MockTransport(handler))
    items, cursor = client.browse()

    assert cursor is None
    assert items[0].owner == "publisher"
    assert items[0].slug == "demo"
    assert items[0].canonical_url.endswith("/publisher/skills/demo")


def test_clawhub_errors_keep_their_cause():
    def handler(request: httpx.Request):
        return httpx.Response(429 if "search" in request.url.path else 404, json={})

    client = ClawHubClient(transport=httpx.MockTransport(handler))
    with pytest.raises(TooManyRequests):
        client.search("x")
    with pytest.raises(NotFound):
        client.detail(owner="a", slug="b")


# ---- fake ClawHub end to end: resolve -> preview -> import ----

PACKAGE = {
    "SKILL.md": "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n",
    "scripts/run.sh": "#!/bin/sh\necho hi\n",
    "assets/schema.json": "{}",
    "hooks/openclaw/handler.js": "module.exports = 1",
}


def _fake_clawhub(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/api/v1/skills/demo" and request.url.params.get("ownerHandle") == "publisher":
        return httpx.Response(200, json={"skill": {"displayName": "Demo", "summary": "A demo"}, "latestVersion": {"version": "2.0.0"}})
    if path == "/api/v1/skills/demo":
        return httpx.Response(409, json={"code": "AMBIGUOUS_SKILL_SLUG", "matches": [
            {"ownerHandle": "publisher", "slug": "demo", "url": "https://clawhub.ai/publisher/skills/demo"},
            {"ownerHandle": "other", "slug": "demo", "url": "https://clawhub.ai/other/skills/demo"},
        ]})
    if path == "/api/v1/skills/demo/verify":
        return httpx.Response(200, json=_verification(PACKAGE, version="2.0.0", ok=False, reasons=["security.pending"], security={"passed": False}))
    if path == "/api/v1/download":
        return httpx.Response(200, content=_zip({**PACKAGE, "_meta.json": "{}", "skill-card.md": "card"}))
    if path == "/api/v1/skills/demo/scan":
        return httpx.Response(200, json={"security": {"status": "suspicious", "hasWarnings": True, "scanners": {"skillspector": {"status": "suspicious", "recommendation": "DO_NOT_INSTALL"}}}})
    return httpx.Response(404, json={})


class _FakeRepo:
    def __init__(self):
        self.saved = None

    def list_internal(self, status=None):
        return []

    def get_setting(self):
        return False

    def upsert_download(self, **kwargs):
        self.saved = kwargs
        return {"skill_id": "s1", "version_id": "v1", "owner": kwargs["owner"], "slug": kwargs["slug"], "display_name": kwargs["display_name"],
                "summary": kwargs["summary"], "version": kwargs["version"], "content_hash": kwargs["content_hash"], "status": "draft"}


def _request(repo):
    client = ClawHubClient("https://clawhub.ai", transport=httpx.MockTransport(_fake_clawhub))
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(_clawhub_client=client, _platform_skill_repository=repo)))


def test_resolve_returns_candidates_when_owner_missing():
    request = _request(_FakeRepo())
    data = skill_routes.resolve_external(request, url="https://clawhub.ai/skills/demo", _claims=None).data
    assert data.owner is None and [item.owner for item in data.candidates] == ["publisher", "other"]
    data = skill_routes.resolve_external(request, url="https://clawhub.ai/publisher/skills/demo", _claims=None).data
    assert (data.owner, data.slug) == ("publisher", "demo")
    with pytest.raises(ValidationProblem):
        skill_routes.resolve_external(request, url="https://example.com/x", _claims=None)


def test_preview_then_import_suspicious_skill_with_scripts():
    repo = _FakeRepo()
    request = _request(repo)
    preview = skill_routes.preview_external("publisher", "demo", request, version=None, _claims=None).data
    assert preview.version == "2.0.0"
    assert [item.path for item in preview.files] == ["SKILL.md", "assets/schema.json", "scripts/run.sh"]
    assert [(item.path, item.reason) for item in preview.skipped] == [("hooks/openclaw/handler.js", "platform_hook")]
    assert preview.security.scanners[0].recommendation == "DO_NOT_INSTALL"
    assert repo.saved is None  # preview never writes

    imported = skill_routes.download_external("publisher", "demo", request, version=None, _claims=None).data
    assert imported.status == "draft" and imported.skipped[0].reason == "platform_hook"
    assert {item["path"] for item in repo.saved["files"]} == {"SKILL.md", "assets/schema.json", "scripts/run.sh"}
    assert repo.saved["security"]["status"] == "suspicious"
    assert repo.saved["source_url"] == "https://clawhub.ai/publisher/skills/demo"


def test_route_errors_are_problem_errors_not_generic_503():
    request = _request(_FakeRepo())
    with pytest.raises(NotFound):
        skill_routes.preview_external("nobody", "missing", request, version=None, _claims=None)

    def broken(request: httpx.Request):
        raise httpx.ConnectError("down")

    request.app.state._clawhub_client = ClawHubClient(transport=httpx.MockTransport(broken))
    with pytest.raises(AppError, match="ClawHub"):
        skill_routes.preview_external("publisher", "demo", request, version=None, _claims=None)
