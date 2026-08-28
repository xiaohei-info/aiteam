from zipfile import ZIP_DEFLATED, ZipFile
from io import BytesIO

import httpx
import pytest

from operation_service.platform_skill_market import ClawHubClient, parse_skill_zip
from operation_service.routes_skill_market import _verified_text_manifest
from shared.errors import ValidationProblem


def _zip(files):
    out = BytesIO()
    with ZipFile(out, "w", ZIP_DEFLATED) as archive:
        for path, content in files.items():
            archive.writestr(path, content)
    return out.getvalue()


def test_parse_skill_zip_accepts_only_text_skill_files():
    files, digest = parse_skill_zip(_zip({"SKILL.md": "# Demo", "references/guide.md": "guide", "_meta.json": "{}"}))
    assert [item["path"] for item in files] == ["SKILL.md", "references/guide.md"]
    assert len(digest) == 16


def test_parse_skill_zip_rejects_scripts():
    with pytest.raises(ValidationProblem, match="unsupported"):
        parse_skill_zip(_zip({"SKILL.md": "# Demo", "scripts/run.py": "print(1)"}))


def test_parse_skill_zip_requires_skill_md():
    with pytest.raises(ValidationProblem, match="SKILL.md"):
        parse_skill_zip(_zip({"references/guide.md": "guide"}))


def test_missing_skill_card_is_allowed_when_security_passed_and_files_are_text_only():
    manifest = _verified_text_manifest(
        {
            "ok": False,
            "reasons": ["card.missing"],
            "publisherHandle": "publisher",
            "slug": "demo",
            "version": "1.0.0",
            "security": {"passed": True},
            "artifact": {"files": [{"path": "SKILL.md", "sha256": "abc", "size": 3}]},
        },
        owner="publisher", slug="demo", version="1.0.0",
    )
    assert manifest == {("SKILL.md", "abc", 3)}


def test_non_text_skill_reports_compatibility_error_before_download():
    with pytest.raises(ValidationProblem, match="当前仅支持"):
        _verified_text_manifest(
            {
                "ok": False,
                "reasons": ["card.missing"],
                "publisherHandle": "publisher",
                "slug": "demo",
                "version": "1.0.0",
                "security": {"passed": True},
                "artifact": {"files": [
                    {"path": "SKILL.md", "sha256": "abc", "size": 3},
                    {"path": "scripts/run.py", "sha256": "def", "size": 3},
                ]},
            },
            owner="publisher", slug="demo", version="1.0.0",
        )


def test_clawhub_search_does_not_use_internal_version_record_id():
    def handler(request: httpx.Request):
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
