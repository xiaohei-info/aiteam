"""行业文档生成北向路由（/api/operation/solution-authoring）：鉴权、角色分权、envelope、problem+json、上传与幂等。

经 TestClient + dependency_overrides 注入内存仓储与假 runner；任务执行器在测试里手动跑一轮。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from operation_service.solution_authoring_dependencies import (
    get_solution_authoring_service,
)
from run import get_app
from shared.contracts.enums import EnterpriseRole, PlatformRole
from tests.operation.auth_helpers import operation_test_token
from tests.operation.test_solution_authoring_service import MANUAL, PHONE, Env

BASE = "/api/operation/solution-authoring"
OPERATOR = PlatformRole.SYSTEM_OPERATOR.value
ADMIN = PlatformRole.SYSTEM_ADMIN.value
MISSING = "00000000-0000-4000-8000-000000000000"
DRAFT = {"title": "质检方案", "platform_model_ref": {"provider_id": "provider-1", "model_id": "model-1"}}


@pytest.fixture
def env(tmp_path) -> Env:
    return Env(tmp_path)


@pytest.fixture
def client(env):
    app = get_app("operation")
    app.dependency_overrides[get_solution_authoring_service] = lambda: env.service
    yield TestClient(app)
    app.dependency_overrides.clear()


def _auth(role: str = OPERATOR, user_id: str = "op1") -> dict[str, str]:
    from operation_service.app import _auth as auth_service

    return {"Authorization": f"Bearer {operation_test_token(auth_service, user_id=user_id, role=role)}"}


def _create(client) -> str:
    response = client.post(f"{BASE}/drafts", json=DRAFT, headers=_auth())
    assert response.status_code == 201
    return response.json()["data"]["draft_id"]


def _upload(client, draft_id: str, name: str = "质量手册.md", data: bytes = MANUAL):
    return client.post(f"{BASE}/drafts/{draft_id}/sources", files={"file": (name, data, "application/octet-stream")}, headers=_auth())


def _generated(client, env) -> str:
    draft_id = _create(client)
    assert _upload(client, draft_id).status_code == 201
    response = client.post(f"{BASE}/drafts/{draft_id}/generate", headers={**_auth(), "Idempotency-Key": "k1"})
    assert response.status_code == 202
    assert env.executor.run_once() is True
    return draft_id


def _problem(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["code"] == code
    return body


# ---- 鉴权 ----

def test_every_route_requires_a_platform_role(client):
    _problem(client.get(f"{BASE}/drafts"), 401, "unauthorized")
    _problem(client.post(f"{BASE}/drafts", json=DRAFT), 401, "unauthorized")
    _problem(client.get(f"{BASE}/drafts", headers=_auth(EnterpriseRole.OWNER.value)), 403, "forbidden")
    _problem(client.post(f"{BASE}/drafts", json=DRAFT, headers=_auth(EnterpriseRole.OWNER.value)), 403, "forbidden")


def test_only_system_admin_can_approve_reject_and_publish(client, env):
    draft_id = _generated(client, env)
    for action, body in (("approve", {"note": ""}), ("reject", {"note": "不通过"}), ("publish", None)):
        _problem(client.post(f"{BASE}/drafts/{draft_id}/{action}", json=body, headers=_auth(OPERATOR)), 403, "forbidden")
    assert client.get(f"{BASE}/drafts/{draft_id}", headers=_auth()).json()["data"]["status"] == "ready_for_review"


# ---- 草稿与资料 ----

def test_create_list_and_get_use_the_envelope(client):
    created = client.post(f"{BASE}/drafts", json={**DRAFT, "image_recognition": "vision", "supplement": "侧重检验"}, headers=_auth())
    assert created.status_code == 201
    data = created.json()["data"]
    assert (data["title"], data["status"], data["image_recognition"], data["created_by"]) == ("质检方案", "draft", "vision", "op1")
    assert data["platform_model_ref"] == DRAFT["platform_model_ref"]

    listed = client.get(f"{BASE}/drafts", headers=_auth())
    assert listed.status_code == 200 and [item["draft_id"] for item in listed.json()["data"]] == [data["draft_id"]]
    assert "package" not in listed.json()["data"][0]

    detail = client.get(f"{BASE}/drafts/{data['draft_id']}", headers=_auth()).json()["data"]
    assert (detail["supplement"], detail["package"], detail["sources"], detail["latest_job"]) == ("侧重检验", None, [], None)


def test_create_validation_and_unknown_ids(client):
    _problem(client.post(f"{BASE}/drafts", json={**DRAFT, "title": "  "}, headers=_auth()), 422, "validation_error")
    _problem(client.post(f"{BASE}/drafts", json={**DRAFT, "unknown": 1}, headers=_auth()), 422, "validation_error")
    _problem(client.post(f"{BASE}/drafts", json={**DRAFT, "image_recognition": "ocr"}, headers=_auth()), 422, "validation_error")
    _problem(client.get(f"{BASE}/drafts/not-a-uuid", headers=_auth()), 422, "validation_error")
    _problem(client.get(f"{BASE}/drafts/{MISSING}", headers=_auth()), 404, "not_found")
    _problem(_upload(client, MISSING), 404, "not_found")


def test_upload_accepts_multipart_and_reports_what_was_parsed(client):
    draft_id = _create(client)
    uploaded = _upload(client, draft_id)
    assert uploaded.status_code == 201
    source = uploaded.json()["data"]
    assert (source["file_name"], source["status"], source["size_bytes"], source["image_count"]) == ("质量手册.md", "parsed", len(MANUAL), 0)
    assert source["chunk_count"] >= 1 and "storage_key" not in source and "sha256" not in source

    _problem(_upload(client, draft_id), 409, "conflict")
    deleted = client.delete(f"{BASE}/drafts/{draft_id}/sources/{source['source_id']}", headers=_auth())
    assert deleted.status_code == 204 and deleted.content == b""
    _problem(client.delete(f"{BASE}/drafts/{draft_id}/sources/{source['source_id']}", headers=_auth()), 404, "not_found")


def test_upload_rejects_unsupported_and_oversized_files(client, monkeypatch):
    draft_id = _create(client)
    body = _problem(_upload(client, draft_id, "方案.exe", b"MZ"), 422, "validation_error")
    assert body["errors"][0]["type"] == "unsupported_format" and body["errors"][0]["loc"] == ["body", "file"]
    assert _problem(_upload(client, draft_id, "旧版.doc", b"\xd0\xcf"), 422, "validation_error")["errors"][0]["type"] == "legacy_format"
    _problem(client.post(f"{BASE}/drafts/{draft_id}/sources", headers=_auth()), 422, "validation_error")

    monkeypatch.setattr("operation_service.routes_solution_authoring.MAX_SOURCE_BYTES", 64)
    monkeypatch.setattr("operation_service.solution_authoring_service.MAX_SOURCE_BYTES", 64)
    _problem(_upload(client, draft_id, "大.txt", b"x" * 65), 413, "request_too_large")
    assert client.get(f"{BASE}/drafts/{draft_id}", headers=_auth()).json()["data"]["sources"] == []


# ---- 生成 ----

def test_generate_needs_an_idempotency_key_and_returns_the_same_job_for_a_retry(client, env):
    draft_id = _create(client)
    _upload(client, draft_id)
    _problem(client.post(f"{BASE}/drafts/{draft_id}/generate", headers=_auth()), 422, "validation_error")

    first = client.post(f"{BASE}/drafts/{draft_id}/generate", headers={**_auth(), "Idempotency-Key": "k1"})
    retry = client.post(f"{BASE}/drafts/{draft_id}/generate", headers={**_auth(), "Idempotency-Key": "k1"})
    assert (first.status_code, retry.status_code) == (202, 202)
    job = first.json()["data"]
    assert retry.json()["data"]["job_id"] == job["job_id"] and job["status"] == "queued"
    _problem(client.post(f"{BASE}/drafts/{draft_id}/generate", headers={**_auth(), "Idempotency-Key": "k2"}), 409, "conflict")

    assert env.executor.run_once() is True
    polled = client.get(f"{BASE}/drafts/{draft_id}/jobs/{job['job_id']}", headers=_auth()).json()["data"]
    assert (polled["status"], polled["error_code"], polled["usage"]["total_tokens"]) == ("succeeded", None, 100)
    _problem(client.get(f"{BASE}/drafts/{draft_id}/jobs/{MISSING}", headers=_auth()), 404, "not_found")


def test_generate_without_sources_or_configuration_is_refused(client, env):
    draft_id = _create(client)
    headers = {**_auth(), "Idempotency-Key": "k1"}
    _problem(client.post(f"{BASE}/drafts/{draft_id}/generate", headers=headers), 422, "validation_error")
    _upload(client, draft_id)
    env.models.ready = False
    _problem(client.post(f"{BASE}/drafts/{draft_id}/generate", headers=headers), 503, "service_unavailable")
    assert client.get(f"{BASE}/drafts/{draft_id}", headers=_auth()).json()["data"]["status"] == "draft"


# ---- 正文、敏感项、审核、发布 ----

def test_findings_expose_only_masked_text(client, env):
    draft_id = _generated(client, env)
    detail = client.get(f"{BASE}/drafts/{draft_id}", headers=_auth()).json()["data"]
    assert detail["open_finding_count"] == 2
    phone = next(item for item in detail["findings"] if item["kind"] == "phone")
    assert "excerpt" not in phone and PHONE not in str(detail["findings"]) and phone["masked"].count("*") == 8
    assert all(PHONE not in event["summary"] for event in detail["events"])


def test_edit_resolve_review_and_publish_over_http(client, env):
    draft_id = _generated(client, env)
    url = f"{BASE}/drafts/{draft_id}"
    detail = client.get(url, headers=_auth()).json()["data"]

    _problem(client.post(f"{url}/submit-review", headers=_auth()), 409, "conflict")
    stale = {"version": detail["version"] - 1, "package": detail["package"]}
    _problem(client.put(f"{url}/package", json=stale, headers=_auth()), 409, "conflict")
    edited = client.put(f"{url}/package", json={"version": detail["version"], "package": detail["package"]}, headers=_auth())
    assert edited.status_code == 200 and edited.json()["data"]["version"] == detail["version"] + 1
    broken = {"version": detail["version"] + 1, "package": {**detail["package"], "coordinator_key": "nobody"}}
    _problem(client.put(f"{url}/package", json=broken, headers=_auth()), 422, "validation_error")

    for item in detail["findings"]:
        resolution = "redact" if item["field_path"] else "acknowledge"
        wrong = "acknowledge" if item["field_path"] else "redact"
        _problem(client.post(f"{url}/findings/{item['finding_id']}/resolve", json={"resolution": wrong}, headers=_auth()), 422, "validation_error")
        resolved = client.post(f"{url}/findings/{item['finding_id']}/resolve", json={"resolution": resolution}, headers=_auth())
        assert resolved.status_code == 200
    _problem(client.post(f"{url}/findings/{MISSING}/resolve", json={"resolution": "redact"}, headers=_auth()), 404, "not_found")
    _problem(client.post(f"{url}/findings/{detail['findings'][0]['finding_id']}/resolve", json={"resolution": "delete"}, headers=_auth()), 422, "validation_error")

    _problem(client.post(f"{url}/publish", headers=_auth(ADMIN, "admin")), 409, "invalid_transition")
    assert client.post(f"{url}/submit-review", headers=_auth()).json()["data"]["status"] == "in_review"
    _problem(client.post(f"{url}/reject", json={"note": " "}, headers=_auth(ADMIN, "admin")), 422, "validation_error")
    approved = client.post(f"{url}/approve", json={"note": "可以发布"}, headers=_auth(ADMIN, "admin"))
    assert approved.status_code == 200 and approved.json()["data"]["status"] == "approved"

    published = client.post(f"{url}/publish", headers=_auth(ADMIN, "admin"))
    assert published.status_code == 200
    data = published.json()["data"]
    assert data["status"] == "published" and data["published_solution_id"].startswith("sa-")
    assert PHONE not in published.text
    assert [event["actor_id"] for event in data["events"]][-3:] == ["admin", "admin", "admin"]
    _problem(client.post(f"{url}/publish", headers=_auth(ADMIN, "admin")), 409, "invalid_transition")


def test_archive_returns_204_and_hides_the_draft(client, env):
    draft_id = _generated(client, env)
    archived = client.delete(f"{BASE}/drafts/{draft_id}", headers=_auth())
    assert archived.status_code == 204 and archived.content == b""
    assert client.get(f"{BASE}/drafts", headers=_auth()).json()["data"] == []
    assert env.files() == []


def test_archiving_an_approved_draft_needs_the_reviewer_role(client, env):
    draft_id = _generated(client, env)
    url = f"{BASE}/drafts/{draft_id}"
    for item in client.get(url, headers=_auth()).json()["data"]["findings"]:
        resolution = "redact" if item["field_path"] else "acknowledge"
        client.post(f"{url}/findings/{item['finding_id']}/resolve", json={"resolution": resolution}, headers=_auth())
    assert client.post(f"{url}/submit-review", headers=_auth()).status_code == 200
    assert client.post(f"{url}/approve", json={"note": ""}, headers=_auth(ADMIN, "admin")).status_code == 200
    _problem(client.delete(url, headers=_auth()), 403, "forbidden")
    assert env.files() != []
    assert client.delete(url, headers=_auth(ADMIN, "admin")).status_code == 204
    assert env.files() == []


# ---- 契约 ----

def test_openapi_exposes_solution_authoring_routes(client):
    paths = client.get("/openapi.json").json()["paths"]
    expected = {
        f"{BASE}/drafts": {"get", "post"},
        f"{BASE}/drafts/{{draft_id}}": {"get", "delete"},
        f"{BASE}/drafts/{{draft_id}}/sources": {"post"},
        f"{BASE}/drafts/{{draft_id}}/sources/{{source_id}}": {"delete"},
        f"{BASE}/drafts/{{draft_id}}/generate": {"post"},
        f"{BASE}/drafts/{{draft_id}}/jobs/{{job_id}}": {"get"},
        f"{BASE}/drafts/{{draft_id}}/package": {"put"},
        f"{BASE}/drafts/{{draft_id}}/findings/{{finding_id}}/resolve": {"post"},
        f"{BASE}/drafts/{{draft_id}}/submit-review": {"post"},
        f"{BASE}/drafts/{{draft_id}}/approve": {"post"},
        f"{BASE}/drafts/{{draft_id}}/reject": {"post"},
        f"{BASE}/drafts/{{draft_id}}/publish": {"post"},
    }
    for path, methods in expected.items():
        assert methods <= set(paths[path]), path
    upload = paths[f"{BASE}/drafts/{{draft_id}}/sources"]["post"]
    assert "multipart/form-data" in upload["requestBody"]["content"]
