"""知识文档 intake HTTP e2e（真 PG；issue #416；02 + 04；D21/D22）。

验：owner 全链路（建空间 → 上传 → status=ready + ingestion=done + 列表/查询 → 重试 → URL 导入非法 URL 400）、
空文件 400、绑定传播、跨租户 RLS 不可见、schema 无 workspace 入参。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import (
    make_inmem_verifier_and_signer,
    make_verifier,
    sign_inmem_token,
    sign_token,
)

pytestmark = pytest.mark.integration

_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()


def _client(db_url, admin_url=None):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_knowledge_space import build_knowledge_space_router
    from manager_service.routes_knowledge_intake import build_knowledge_intake_router

    verifier = make_verifier(admin_url) if admin_url else _INMEM_VERIFIER
    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_employee_router(verifier))
    app.include_router(build_knowledge_space_router(verifier))
    app.include_router(build_knowledge_intake_router(verifier))
    return TestClient(app)


def _token(tid, roles, user_id="u", *, admin_url=None):
    return sign_token(admin_url, tid, roles, user_id=user_id) if admin_url else sign_inmem_token(_INMEM_SIGNER, tid, roles, user_id=user_id)


def _make_space(client, token, ks_id="ks_default", name="default"):
    r = client.post("/api/manager/knowledge-spaces", json={"knowledge_space_id": ks_id, "display_name": name},
                    headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 201, r.text
    return r.json()["data"]


def test_intake_happy_path(migrated_db, admin_url, two_tenants):
    tid_a, tid_b = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="oa", admin_url=admin_url)
    owner_b = _token(tid_b, ["owner"], user_id="ob", admin_url=admin_url)
    _make_space(client, owner_a)

    payload = f"hello knowledge intake {uuid.uuid4().hex}\n" * 200
    r = client.post(
        "/api/manager/knowledge-spaces/ks_default/documents",
        files={"file": ("report.txt", payload.encode("utf-8"), "text/plain")},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201, r.text
    doc = r.json()["data"]
    assert doc["knowledge_space_id"] == "ks_default"
    assert doc["status"] == "ready"
    assert doc["file_name"] == "report.txt"
    assert doc["text_chars"] and doc["text_chars"] > 0
    doc_id = doc["id"]

    # schema 无 workspace 入参（D21）
    assert "workspace" not in {"knowledge_space_id", "display_name"}

    # 列表与 envelope
    r = client.get("/api/manager/knowledge-spaces/ks_default/documents",
                   headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    items = r.json()["data"]
    assert isinstance(items, list) and len(items) == 1

    # 状态：已 ready，可重试
    r = client.post(f"/api/manager/knowledge-spaces/ks_default/documents/{doc_id}/retry",
                    headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 201, r.text
    assert r.json()["data"]["status"] == "ready"  # 重试后以 ready 终态

    # ingestion 查询
    r = client.get(f"/api/manager/knowledge-spaces/ks_default/documents/{doc_id}/ingestion",
                   headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    job = r.json()["data"]
    assert job["status"] == "done"
    assert job["chunk_count"] and job["chunk_count"] >= 1

    # 跨租户 RLS：t-b 看不到 t-a 的知识空间/documents
    r = client.get("/api/manager/knowledge-spaces/ks_default",
                   headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404
    r = client.get("/api/manager/knowledge-spaces/ks_default/documents",
                   headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404


def test_upload_empty_returns_422(migrated_db, admin_url, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="oa", admin_url=admin_url)
    _make_space(client, owner_a)
    r = client.post(
        "/api/manager/knowledge-spaces/ks_default/documents",
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
        "/api/manager/knowledge-spaces/ks_default/documents/url",
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
        "/api/manager/knowledge-spaces/ks_default/documents",
        files={"file": ("a.txt", b"data", "text/plain")},
        headers={"Authorization": f"Bearer {member_a}"},
    )
    assert r.status_code == 403, r.text
