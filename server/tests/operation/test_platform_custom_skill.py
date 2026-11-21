"""Operator custom platform skills (design 2026-11-20 §4.7): import / write / edit, versions, routes."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from operation_service.platform_custom_skill import (
    CustomSkillRequest,
    CustomSkillService,
)
from operation_service.platform_skill_market import (
    CustomSkillState,
    plan_custom_version,
)
from shared.contracts.enums import PlatformRole
from shared.errors import NotFound
from shared.skill_package import catalog_package
from tests.operation.auth_helpers import operation_test_token


def _skill(name="weekly-report", description="把一周的工作整理成周报。用户要写周报时使用。", version=None, body="# 周报\n"):
    head = f"---\nname: {name}\ndescription: {description}\n" + (f"version: {version}\n" if version else "") + "---\n"
    return head + body


def _hash(files):
    return catalog_package(skill_id="x", version="0", files=files).content_hash


class _Store:
    """In-memory platform skill table with the same version rule as the PG repository."""

    def __init__(self, auto_publish=True):
        self.auto_publish = auto_publish
        self.skills: dict[str, dict] = {}

    def get_setting(self):
        return self.auto_publish

    def find_custom(self, *, name):
        skill = self.skills.get(name)
        if skill is None:
            return None
        versions = {v: data["hash"] for v, data in skill["versions"].items()}
        return CustomSkillState(skill["id"], skill["latest"], versions.get(skill["latest"]), versions)

    def save_custom(self, *, name, description, files, content_hash, declared_version, auto_publish, source_url):
        existing = self.find_custom(name=name)
        state, version = plan_custom_version(existing, content_hash=content_hash, declared=declared_version)
        if state == "same":
            return {"skill_id": existing.skill_id, "name": name, "version": version, "status": "duplicate"}
        skill = self.skills.setdefault(name, {"id": f"id-{name}", "versions": {}, "latest": None, "published": None, "summary": ""})
        skill["versions"].setdefault(version, {"hash": content_hash, "files": files})
        skill["latest"], skill["summary"] = version, description
        if auto_publish:
            skill["published"] = version
        return {"skill_id": skill["id"], "name": name, "version": version, "status": "installed" if existing is None else "updated"}

    def get_latest_files(self, *, skill_id):
        for name, skill in self.skills.items():
            if skill["id"] == skill_id:
                return {"skill_id": skill_id, "source": "custom", "display_name": name, "summary": skill["summary"],
                        "version": skill["latest"], "files": skill["versions"][skill["latest"]]["files"]}
        raise NotFound("platform skill not found")

    def list_internal(self, status=None):
        return []


# ---- version rule ----

def test_version_rule_new_same_changed_taken_and_revert():
    assert plan_custom_version(None, content_hash="a" * 16, declared="") == ("none", "a" * 12)
    assert plan_custom_version(None, content_hash="a" * 16, declared="1.0.0") == ("none", "1.0.0")
    state = CustomSkillState("s", "1.0.0", "a" * 16, {"1.0.0": "a" * 16})
    assert plan_custom_version(state, content_hash="a" * 16, declared="1.0.0") == ("same", "1.0.0")
    assert plan_custom_version(state, content_hash="b" * 16, declared="1.0.0") == ("update", "1.0.0-bbbbbbbb")
    assert plan_custom_version(state, content_hash="b" * 16, declared="1.1.0") == ("update", "1.1.0")
    later = CustomSkillState("s", "1.1.0", "b" * 16, {"1.0.0": "a" * 16, "1.1.0": "b" * 16})
    assert plan_custom_version(later, content_hash="a" * 16, declared="") == ("update", "1.0.0")  # back to an older content


# ---- service ----

def test_paste_previews_then_saves_published_and_detects_duplicates_and_new_versions():
    store = _Store()
    svc = CustomSkillService(store)
    request = CustomSkillRequest(source="text", text=_skill(version="1.0.0"))
    preview = svc.preview(request)["preview"]
    assert (preview["ok"], preview["name"], preview["version"], preview["existing"]) == (True, "weekly-report", "1.0.0", "none")
    assert store.skills == {}  # preview never writes
    saved = svc.save(request)
    assert saved["auto_publish"] is True and saved["results"][0]["status"] == "installed"
    assert store.skills["weekly-report"]["published"] == "1.0.0"
    assert svc.save(request)["results"][0]["status"] == "duplicate"
    changed = CustomSkillRequest(source="text", text=_skill(version="1.0.0", body="# 新版\n"))
    preview = svc.preview(changed)["preview"]
    assert preview["existing"] == "update" and preview["existing_version"] == "1.0.0" and preview["version"].startswith("1.0.0-")
    assert svc.save(changed)["results"][0]["status"] == "updated"


def test_editor_files_with_scripts_and_auto_publish_off_stays_a_draft():
    store = _Store(auto_publish=False)
    files = [("SKILL.md", _skill("fill-form").encode()), ("scripts/fill.sh", b"#!/bin/sh\necho hi\n"), ("assets/logo.png", b"\x89PNG\x00\xff")]
    saved = CustomSkillService(store).save(CustomSkillRequest(source="editor", entries=files))
    skill = store.skills["fill-form"]
    assert saved["auto_publish"] is False and skill["published"] is None
    stored = skill["versions"][skill["latest"]]["files"]
    assert {f["path"] for f in stored} == {"SKILL.md", "scripts/fill.sh"}  # binary skipped, script kept as text
    assert skill["latest"] == _hash(stored)[:12]


def test_folder_with_two_skills_saves_only_the_chosen_and_explains_bad_ones():
    store = _Store()
    svc = CustomSkillService(store)
    entries = [("pack/a/SKILL.md", _skill("skill-a").encode()), ("pack/b/SKILL.md", _skill("Bad_Name").encode())]
    scan = svc.preview(CustomSkillRequest(source="folder", entries=entries))["scan"]
    assert [(item["root"], item["ok"]) for item in scan] == [("pack/a", True), ("pack/b", False)]
    assert "小写字母" in scan[1]["reason"]
    result = svc.save(CustomSkillRequest(source="folder", entries=entries, roots=["pack/a"]))["results"]
    assert [(r["name"], r["status"]) for r in result] == [("skill-a", "installed")] and list(store.skills) == ["skill-a"]


@pytest.mark.parametrize("text, reason", [
    ("# 没有元数据\n", "格式不对"),
    ("---\nname: x\n---\n# 缺 description\n", "description"),
    ("---\ndescription: 没有名字\n---\n", "缺少 name"),
])
def test_invalid_skill_md_is_explained(text, reason):
    preview = CustomSkillService(_Store()).preview(CustomSkillRequest(source="text", text=text))["preview"]
    assert not preview["ok"] and reason in preview["reason"]


# ---- routes ----

@pytest.fixture
def client():
    from run import get_app

    app = get_app("operation")
    store = _Store()
    app.state._platform_skill_repository = store
    test_client = TestClient(app)
    test_client.store = store
    yield test_client


def _auth():
    from operation_service.app import _auth as auth

    return {"Authorization": "Bearer " + operation_test_token(auth, user_id="op1", role=PlatformRole.SYSTEM_OPERATOR.value)}


def test_routes_check_save_edit_and_read_files(client):
    response = client.post("/api/operation/skill-market/custom/preview", headers=_auth(), json={"source": "text", "text": _skill()})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["preview"]["name"] == "weekly-report"

    files = [("files", ("SKILL.md", _skill().encode())), ("files", ("fill.sh", b"echo"))]
    response = client.post("/api/operation/skill-market/custom", headers=_auth(), files=files,
                           data={"source": "editor", "paths": ["SKILL.md", "scripts/fill.sh"]})
    assert response.status_code == 200, response.text
    result = response.json()["data"]["results"][0]
    assert result["status"] == "installed" and result["skill_id"] == "id-weekly-report"

    response = client.get("/api/operation/skill-market/internal/id-weekly-report/files", headers=_auth())
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["source"] == "custom" and {f["path"] for f in data["files"]} == {"SKILL.md", "scripts/fill.sh"}

    edited = [("files", ("SKILL.md", _skill(body="# 改过\n").encode()))]
    response = client.post("/api/operation/skill-market/custom", headers=_auth(), files=edited, data={"source": "editor", "paths": ["SKILL.md"]})
    assert response.json()["data"]["results"][0]["status"] == "updated"


def test_routes_reject_unauthenticated_and_wrong_transport(client):
    assert client.post("/api/operation/skill-market/custom/preview", json={"source": "text", "text": _skill()}).status_code == 401
    response = client.post("/api/operation/skill-market/custom/preview", headers=_auth(), json={"source": "folder"})
    assert response.status_code == 422
    files = [("files", ("SKILL.md", _skill().encode()))]
    response = client.post("/api/operation/skill-market/custom/preview", headers=_auth(), files=files, data={"source": "text"})
    assert response.status_code == 422 and "multipart" in response.text
    assert client.get("/api/operation/skill-market/internal/nope/files", headers=_auth()).status_code == 404


def test_routes_refuse_oversized_bodies_before_reading_them(client):
    import operation_service.app as operation_app
    from operation_service.routes_skill_market import CUSTOM_SKILL_MAX_BODY_BYTES

    assert any(limit.path_prefix == "/api/operation/skill-market/custom" and limit.max_bytes == CUSTOM_SKILL_MAX_BODY_BYTES
               for limit in _body_limits(operation_app.app))
    big = b"x" * (CUSTOM_SKILL_MAX_BODY_BYTES + 1)
    for path in ("/api/operation/skill-market/custom", "/api/operation/skill-market/custom/preview"):
        response = client.post(path, headers=_auth(), files=[("files", ("SKILL.md", big))], data={"source": "file"})
        assert response.status_code == 413, (path, response.status_code)
    assert client.store.skills == {}


def _body_limits(app):
    from shared.body_limit import BodySizeLimitMiddleware

    for middleware in app.user_middleware:
        if middleware.cls is BodySizeLimitMiddleware:
            return middleware.kwargs["limits"]
    return ()


def test_save_refuses_content_that_changed_after_the_check():
    from shared.skill_import import ContentChanged

    store = _Store()
    svc = CustomSkillService(store)
    preview = svc.preview(CustomSkillRequest(source="text", text=_skill()))["preview"]
    assert preview["content_hash"]
    with pytest.raises(ContentChanged):
        svc.save(CustomSkillRequest(source="text", text=_skill(body="# 改过\n"), expected_hashes={"": preview["content_hash"]}))
    assert store.skills == {}
    saved = svc.save(CustomSkillRequest(source="text", text=_skill(), expected_hashes={"": preview["content_hash"]}))
    assert saved["results"][0]["status"] == "installed"


def test_route_passes_expected_hashes_and_answers_409(client):
    response = client.post("/api/operation/skill-market/custom", headers=_auth(),
                           json={"source": "text", "text": _skill(), "expected_hashes": {"": "0" * 64}})
    assert response.status_code == 409 and response.json()["code"] == "content_changed"
    assert client.store.skills == {}
