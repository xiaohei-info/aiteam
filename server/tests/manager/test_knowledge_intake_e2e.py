"""知识文档 intake HTTP e2e（真 PG；issue #416；02 + 04；D21/D22）。

验：owner 全链路（建空间 → 上传 → status=ready + ingestion=done + 列表/查询 → 重试 → URL 导入非法 URL 400）、
空文件 400、绑定传播、跨租户 RLS 不可见、schema 无 workspace 入参。
"""

from __future__ import annotations

import time
import uuid

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from manager_service.rag_ingestion import RagIngestionResult
from tests.manager._auth_helper import (
    make_inmem_verifier_and_signer,
    make_verifier,
    sign_inmem_token,
    sign_token,
)

pytestmark = pytest.mark.integration

ENTERPRISE_SPACE_ID = "enterprise_shared"

_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()


class _FakeIngestion:
    def ingest_text(self, *, workspace, file_source, text):
        return RagIngestionResult(rag_document_id=file_source, chunk_count=1)

    def delete_document(self, *, workspace, doc_ids, delete_file=False, delete_llm_cache=True):
        return type("Deletion", (), {"deletion_started": True, "busy": False})()

    def document_ids_present(self, *, workspace, doc_ids):
        return set()


def _client(db_url, admin_url=None):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_employee_bindings import build_employee_bindings_router
    from manager_service.routes_knowledge_space import build_knowledge_space_router
    from manager_service.routes_knowledge_intake import build_knowledge_intake_router

    verifier = make_verifier(admin_url) if admin_url else _INMEM_VERIFIER
    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_employee_router(verifier))
    app.include_router(build_employee_bindings_router(verifier))
    app.include_router(build_knowledge_space_router(verifier))
    app.include_router(build_knowledge_intake_router(verifier))
    # Integration tests exercise Manager DB/RLS, while upstream LightRAG is an
    # explicit fake transport boundary rather than an accidental live dependency.
    app.state._knowledge_intake_ingestion_client = _FakeIngestion()
    return TestClient(app)


def _token(tid, roles, user_id="u", *, admin_url=None):
    return sign_token(admin_url, tid, roles, user_id=user_id) if admin_url else sign_inmem_token(_INMEM_SIGNER, tid, roles, user_id=user_id)


def _make_space(client, token, ks_id=ENTERPRISE_SPACE_ID, name="default"):
    assert ks_id == ENTERPRISE_SPACE_ID
    r = client.post("/api/manager/knowledge-spaces", json={"knowledge_space_id": ENTERPRISE_SPACE_ID, "display_name": name},
                    headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 201, r.text
    return r.json()["data"]


def _wait_ready(client, token, document_id: str) -> dict:
    """BackgroundTasks are asynchronous even with TestClient; poll the durable row."""
    headers = {"Authorization": f"Bearer {token}"}
    path = f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents"
    for _ in range(40):
        response = client.get(path, headers=headers)
        assert response.status_code == 200, response.text
        document = next(item for item in response.json()["data"] if item["id"] == document_id)
        if document["status"] in {"ready", "failed"}:
            return document
        time.sleep(0.05)
    raise AssertionError(f"document {document_id} did not reach a terminal status")


def test_intake_happy_path(migrated_db, admin_url, two_tenants):
    tid_a, tid_b = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="oa", admin_url=admin_url)
    owner_b = _token(tid_b, ["owner"], user_id="ob", admin_url=admin_url)
    _make_space(client, owner_a)

    payload = f"hello knowledge intake {uuid.uuid4().hex}\n" * 200
    r = client.post(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents",
        files={"file": ("report.txt", payload.encode("utf-8"), "text/plain")},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201, r.text
    doc = r.json()["data"]
    assert doc["knowledge_space_id"] == ENTERPRISE_SPACE_ID
    assert doc["status"] in {"uploaded", "parsing", "indexing", "ready"}
    assert doc["file_name"] == "report.txt"
    doc = _wait_ready(client, owner_a, doc["id"])
    assert doc["status"] == "ready"
    assert doc["text_chars"] and doc["text_chars"] > 0
    doc_id = doc["id"]

    # schema 无 workspace 入参（D21）
    assert "workspace" not in {"knowledge_space_id", "display_name"}

    # 列表与 envelope
    r = client.get(f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents",
                   headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    items = r.json()["data"]
    assert isinstance(items, list) and len(items) == 1

    # 状态：已 ready，可重试
    r = client.post(f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents/{doc_id}/retry",
                    headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 201, r.text
    assert r.json()["data"]["status"] == "ready"  # 重试后以 ready 终态

    # ingestion 查询
    r = client.get(f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents/{doc_id}/ingestion",
                   headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    job = r.json()["data"]
    assert job["status"] == "done"
    assert job["chunk_count"] and job["chunk_count"] >= 1

    # 跨租户 RLS：t-b 看不到 t-a 的知识空间/documents
    r = client.get(f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}",
                   headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404
    r = client.get(f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents",
                   headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404


def test_delete_reconcile_returns_envelope_and_completes_only_after_probe(
    migrated_db, admin_url, two_tenants
):
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner = _token(tid_a, ["owner"], user_id="delete-owner", admin_url=admin_url)
    member = _token(tid_a, ["member"], user_id="delete-member", admin_url=admin_url)
    auth = {"Authorization": f"Bearer {owner}"}
    _make_space(client, owner, name="Delete")
    uploaded = client.post(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents",
        files={"file": ("delete.txt", b"delete me", "text/plain")}, headers=auth,
    )
    assert uploaded.status_code == 201, uploaded.text
    document_id = uploaded.json()["data"]["id"]
    _wait_ready(client, owner, document_id)
    deleted = client.delete(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents/{document_id}",
        headers={**auth, "Idempotency-Key": "delete-1"},
    )
    assert deleted.status_code == 202, deleted.text
    assert deleted.json()["data"]["status"] == "pending"
    assert deleted.json()["data"]["document_status"] == "deleting"

    member_reconcile = client.post(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents/{document_id}/reconcile-delete",
        headers={"Authorization": f"Bearer {member}", "Idempotency-Key": "delete-1"},
    )
    assert member_reconcile.status_code == 403
    assert member_reconcile.headers["content-type"].startswith("application/problem+json")

    reconciled = client.post(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents/{document_id}/reconcile-delete",
        headers={**auth, "Idempotency-Key": "delete-1"},
    )
    assert reconciled.status_code == 202, reconciled.text
    assert reconciled.json()["data"]["status"] == "completed"
    assert reconciled.json()["data"]["document_status"] == "deleted"
    assert reconciled.json()["data"]["upstream_status"] == "deleted"
    assert "delete me" not in reconciled.text

    repeated = client.post(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents/{document_id}/reconcile-delete",
        headers=auth,
    )
    assert repeated.status_code == 202, repeated.text
    assert repeated.json()["data"]["status"] == "completed"


def test_new_employee_binding_backfills_ready_documents(migrated_db, admin_url, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner = _token(tid_a, ["owner"], user_id="owner-backfill", admin_url=admin_url)
    auth = {"Authorization": f"Bearer {owner}"}
    _make_space(client, owner, name="Backfill")
    uploaded = client.post(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents",
        files={"file": ("ready.txt", b"already indexed", "text/plain")}, headers=auth,
    )
    assert uploaded.status_code == 201, uploaded.text
    document_id = uploaded.json()["data"]["id"]
    _wait_ready(client, owner, document_id)
    employee = client.post(
        f"/api/manager/employees?employee_slug=backfill-{uuid.uuid4().hex[:8]}",
        json={"display_name": "Backfill employee", "persona": "p"}, headers=auth,
    )
    assert employee.status_code == 201, employee.text
    employee_id = employee.json()["data"]["employee_id"]
    bound = client.post(
        f"/api/manager/employees/{employee_id}/knowledge-bindings",
        json={"knowledge_space_id": ENTERPRISE_SPACE_ID, "enabled": True}, headers=auth,
    )
    assert bound.status_code == 201, bound.text
    bindings = client.get(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents/{document_id}/bindings", headers=auth,
    )
    assert bindings.status_code == 200, bindings.text
    assert [(row["employee_id"], row["status"], row["rag_document_id"]) for row in bindings.json()["data"]] == [
        (employee_id, "ready", document_id)
    ]


def test_upload_empty_returns_422(migrated_db, admin_url, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="oa", admin_url=admin_url)
    _make_space(client, owner_a)
    r = client.post(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents",
        files={"file": ("empty.txt", b"", "text/plain")},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    # 统一错误模型（02）：输入校验失败 = 422 validation_error（shared.errors.ValidationProblem）。
    assert r.status_code == 422, r.text


def test_import_url_invalid_returns_400(migrated_db, admin_url, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="oa", admin_url=admin_url)
    _make_space(client, owner_a)
    r = client.post(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents/url",
        json={"url": "ftp://nope"},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 400, r.text


def test_intake_missing_space_returns_404(migrated_db, admin_url, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="oa", admin_url=admin_url)
    r = client.post(
        "/api/manager/knowledge-spaces/no-such-space/documents",
        files={"file": ("a.txt", b"data", "text/plain")},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 404, r.text


def test_intake_member_forbidden(migrated_db, admin_url, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="oa", admin_url=admin_url)
    member_a = _token(tid_a, ["member"], user_id="ma", admin_url=admin_url)
    _make_space(client, owner_a)
    r = client.post(
        f"/api/manager/knowledge-spaces/{ENTERPRISE_SPACE_ID}/documents",
        files={"file": ("a.txt", b"data", "text/plain")},
        headers={"Authorization": f"Bearer {member_a}"},
    )
    assert r.status_code == 403, r.text
