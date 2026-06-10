"""Layer2 P08/P09 contract tests — knowledge bases, documents, office scene/feed.

Verifies:
- T01: GET /api/team/knowledge-bases returns 200 with stable shape, empty-list safe
- T02: POST /api/team/knowledge-bases/{id}/documents returns 201 with contract shape; error paths
- T03: GET /api/team/office/scene returns 200 with stable shape, empty-state safe
- T04: GET /api/team/office/feed returns 200 with stable shape, empty-state safe
- T05: P09 event-driven seam polling contract (generated_cursor, refresh_hint_ms, per-item cursor pointers + events_url)
"""

from __future__ import annotations

import json
import uuid
from urllib.parse import urlparse

import pytest

# Reuse the known-working dispatch helpers from layer0
from tests.aiteam.layer0_contracts.test_host_routing import _FakeHandler, _get, _post


def _seed_enterprise(db_conn, ent_id: str) -> str:
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO enterprise (id, slug, name, status, owner_user_id) "
            "VALUES (%s, %s, %s, %s, %s)",
            (ent_id, f"slug-{ent_id[:8]}", "Test Corp", "active", "user_001"),
        )
        db_conn.commit()
    finally:
        cur.close()
    return ent_id


def _seed_kb(db_conn, kb_id: str, ent_id: str, name: str = "Test KB") -> str:
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO knowledge_base (id, enterprise_id, name, description, status, document_count, storage_prefix) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (kb_id, ent_id, name, "", "active", 0, ""),
        )
        db_conn.commit()
    finally:
        cur.close()
    return kb_id


def _seed_employee(db_conn, emp_id: str, ent_id: str) -> str:
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, profile_name, display_name, "
            "role_name, status, created_from, model_provider, model_name, "
            "prompt_version, config_version, capabilities_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (emp_id, ent_id, f"p-{emp_id[:8]}", f"Name-{emp_id[:6]}",
             "assistant", "active", "talent_market",
             "openai", "gpt-4o", 1, 1, '{}'),
        )
        db_conn.commit()
    finally:
        cur.close()
    return emp_id


def _seed_conversation(
    db_conn,
    conv_id: str,
    ent_id: str,
    *,
    conv_type: str = "private",
    title: str = "Test Conversation",
    entry_employee_id: str | None = None,
    preview: str = "",
) -> str:
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO conversation (id, enterprise_id, type, status, title, entry_employee_id, last_message_preview, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (conv_id, ent_id, conv_type, "active", title, entry_employee_id, preview, "user_001"),
        )
        db_conn.commit()
    finally:
        cur.close()
    return conv_id


def _seed_knowledge_binding(db_conn, bind_id: str, ent_id: str, employee_id: str, kb_id: str) -> str:
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO employee_knowledge_binding (id, enterprise_id, employee_id, knowledge_base_id, scope_mode, enabled, binding_version) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (bind_id, ent_id, employee_id, kb_id, "read", True, 1),
        )
        db_conn.commit()
    finally:
        cur.close()
    return bind_id


def _seed_run(db_conn, run_id: str, ent_id: str, emp_id: str, conv_id: str | None = None, status: str = "queued") -> str:
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, result_summary_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (run_id, ent_id, conv_id, "manual_run", "single_agent", status, emp_id, None),
        )
        db_conn.commit()
    finally:
        cur.close()
    return run_id


def _seed_run_event(db_conn, evt_id: str, run_id: str, ent_id: str, emp_id: str, event_type: str, cursor_no: int, preview: str = "") -> str:
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (evt_id, ent_id, run_id, cursor_no, event_type, "session", "sess_test", emp_id, preview, "{}"),
        )
        db_conn.commit()
    finally:
        cur.close()
    return evt_id


# ── P08 Knowledge Bases ───────────────────────────────────────────────────

class TestKnowledgeBasesList:
    """GET /api/team/knowledge-bases."""

    def test_empty_knowledge_bases_returns_list(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        status, body = _get("/api/team/knowledge-bases")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert "knowledge_bases" in body
        assert body["knowledge_bases"] == []

    def test_knowledge_bases_list_returns_kb_with_documents_and_bindings(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id, "Sales KB")
        emp_id = f"emp_{uuid.uuid4().hex[:8]}"
        _seed_employee(db_conn, emp_id, ent_id)
        _seed_knowledge_binding(db_conn, f"ekb_{uuid.uuid4().hex[:8]}", ent_id, emp_id, kb_id)
        status, body = _get("/api/team/knowledge-bases")
        assert status == 200, f"Expected 200, got {status}: {body}"
        items = body["knowledge_bases"]
        assert len(items) >= 1
        kb = next(item for item in items if item["knowledge_base_id"] == kb_id)
        assert kb["name"] == "Sales KB"
        assert "documents" in kb
        assert len(kb["employee_bindings"]) == 1
        assert kb["employee_bindings"][0]["employee_id"] == emp_id

    def test_knowledge_search_returns_answer_and_citations_for_ready_doc(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id, "入职知识库")
        body = {"asset_id": f"ast_{uuid.uuid4().hex[:8]}", "display_name": "入职手册"}
        _, created = _post(f"/api/team/knowledge-bases/{kb_id}/documents", body)

        cur = db_conn.cursor()
        try:
            cur.execute(
                "UPDATE knowledge_document SET status = 'ready', chunk_count = 12 WHERE id = %s",
                (created["document_id"],),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, payload = _get(f"/api/team/knowledge-bases/{kb_id}/search?q=入职")
        assert status == 200, payload
        assert payload["knowledge_base_id"] == kb_id
        assert payload["query"] == "入职"
        assert payload["answer"] == "已命中《入职手册》相关知识。"
        assert payload["citations"][0]["title"] == "入职手册"
        assert payload["items"][0]["document_id"] == created["document_id"]

    def test_knowledge_search_rejects_empty_query(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id, "Support KB")
        status, payload = _get(f"/api/team/knowledge-bases/{kb_id}/search?q=")
        assert status == 400, payload
        assert payload["error"] == "MISSING_QUERY"


class TestKnowledgeBasePost:
    """POST /api/team/knowledge-bases."""

    def test_post_knowledge_base_creates_new_base(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)

        status, body = _post(
            "/api/team/knowledge-bases",
            {"name": "新知识库", "description": "用于新员工资料"},
        )
        assert status == 201, body
        assert body["knowledge_base_id"].startswith("kb_")
        assert body["name"] == "新知识库"
        assert body["description"] == "用于新员工资料"
        assert body["status"] == "active"
        assert body["document_count"] == 0

    def test_post_knowledge_base_requires_name(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)

        status, body = _post(
            "/api/team/knowledge-bases",
            {"description": "缺名称"},
        )
        assert status == 400, body
        assert body["error"] == "MISSING_NAME"


# ── P08 Document POST ──────────────────────────────────────────────────────

class TestKnowledgeDocumentPost:
    """POST /api/team/knowledge-bases/{kb_id}/documents."""

    def test_post_document_returns_201(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id)
        body = {"asset_id": f"ast_{uuid.uuid4().hex[:8]}", "display_name": "faq.pdf"}
        status, resp = _post(f"/api/team/knowledge-bases/{kb_id}/documents", body)
        assert status == 201, f"Expected 201, got {status}: {resp}"

    def test_post_document_response_has_contract_shape(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id)
        body = {"asset_id": f"ast_{uuid.uuid4().hex[:8]}", "display_name": "sales.pdf"}
        _, resp = _post(f"/api/team/knowledge-bases/{kb_id}/documents", body)
        for key in ("document_id", "status", "ingestion_job_id"):
            assert key in resp, f"Missing {key}: {resp}"
        assert resp["status"] in ("uploaded", "ingesting", "ready", "error")

    def test_post_duplicate_document_is_idempotent(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id)
        asset_id = f"ast_{uuid.uuid4().hex[:8]}"
        body = {"asset_id": asset_id, "display_name": "faq.pdf"}
        _, first = _post(f"/api/team/knowledge-bases/{kb_id}/documents", body)
        _, second = _post(f"/api/team/knowledge-bases/{kb_id}/documents", body)
        assert second["document_id"] == first["document_id"]
        assert second["status"] == first["status"]

    def test_post_document_missing_asset_id_returns_400(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id)
        status, resp = _post(f"/api/team/knowledge-bases/{kb_id}/documents", {"display_name": "x"})
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "MISSING_ASSET_ID"

    def test_post_document_missing_body_returns_400(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id)
        status, resp = _post(f"/api/team/knowledge-bases/{kb_id}/documents", None)
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "MISSING_BODY"

    def test_post_document_nonexistent_kb_returns_404(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        status, resp = _post("/api/team/knowledge-bases/no-such-kb/documents", {"asset_id": "ast_x"})
        assert status == 404, f"Expected 404, got {status}: {resp}"
        assert resp.get("error") == "KNOWLEDGE_BASE_NOT_FOUND"

    def test_post_document_retry_restarts_error_document(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id)
        asset_id = f"ast_{uuid.uuid4().hex[:8]}"
        _, first = _post(f"/api/team/knowledge-bases/{kb_id}/documents", {"asset_id": asset_id, "display_name": "faq.pdf"})

        cur = db_conn.cursor()
        try:
            cur.execute(
                "UPDATE knowledge_document SET status = 'error', error_code = 'INGEST_FAILED', error_message = 'insert timeout' WHERE id = %s",
                (first["document_id"],),
            )
            cur.execute(
                "UPDATE knowledge_ingestion_job SET status = 'failed', error_message = 'insert timeout' WHERE id = %s",
                (first["ingestion_job_id"],),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, second = _post(
            f"/api/team/knowledge-bases/{kb_id}/documents",
            {"asset_id": asset_id, "display_name": "faq.pdf", "retry": True},
        )
        assert status == 201, f"Expected 201, got {status}: {second}"
        assert second["document_id"] == first["document_id"]
        assert second["status"] == "ingesting"
        assert second["ingestion_job_id"] != first["ingestion_job_id"]

    def test_knowledge_bases_list_advances_ingesting_document_to_ready(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id, "Support KB")
        _, created = _post(
            f"/api/team/knowledge-bases/{kb_id}/documents",
            {"asset_id": f"ast_{uuid.uuid4().hex[:8]}", "display_name": "faq.pdf"},
        )

        status, body = _get("/api/team/knowledge-bases")
        assert status == 200, body
        kb = next(item for item in body["knowledge_bases"] if item["knowledge_base_id"] == kb_id)
        doc = next(item for item in kb["documents"] if item["document_id"] == created["document_id"])
        assert doc["status"] == "ready"
        assert doc["rag_document_id"].startswith("rag_")
        assert doc["chunk_count"] >= 1

        cur = db_conn.cursor()
        try:
            cur.execute(
                "SELECT status, rag_document_id, chunk_count FROM knowledge_ingestion_job WHERE id = %s",
                (created["ingestion_job_id"],),
            )
            row = cur.fetchone()
        finally:
            cur.close()

        assert row is not None
        assert row[0] == "completed"
        assert str(row[1]).startswith("rag_")
        assert int(row[2]) >= 1

    def test_knowledge_bases_list_includes_document_error_message(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        kb_id = f"kb_{uuid.uuid4().hex[:8]}"
        _seed_kb(db_conn, kb_id, ent_id, "Support KB")
        asset_id = f"ast_{uuid.uuid4().hex[:8]}"
        _, first = _post(f"/api/team/knowledge-bases/{kb_id}/documents", {"asset_id": asset_id, "display_name": "faq.pdf"})

        cur = db_conn.cursor()
        try:
            cur.execute(
                "UPDATE knowledge_document SET status = 'error', error_code = 'INGEST_FAILED', error_message = 'insert timeout' WHERE id = %s",
                (first["document_id"],),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _get("/api/team/knowledge-bases")
        assert status == 200, body
        kb = next(item for item in body["knowledge_bases"] if item["knowledge_base_id"] == kb_id)
        doc = next(item for item in kb["documents"] if item["document_id"] == first["document_id"])
        assert doc["error_code"] == "INGEST_FAILED"
        assert doc["error_message"] == "insert timeout"


# ── P09 Office Scene ───────────────────────────────────────────────────────

class TestOfficeScene:
    """GET /api/team/office/scene."""

    def test_office_scene_returns_200(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        status, body = _get("/api/team/office/scene")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_office_scene_empty_enterprise_stable_shape(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        _, body = _get("/api/team/office/scene")
        assert "enterprise_id" in body, f"Missing enterprise_id: {body}"
        assert "generated_at" in body
        assert "summary" in body
        assert isinstance(body["summary"]["online_employee_count"], int)
        assert isinstance(body["seats"], list)

    def test_office_scene_with_employees_and_runs(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        emp_id = f"emp_{uuid.uuid4().hex[:8]}"
        _seed_employee(db_conn, emp_id, ent_id)
        run_id = f"run_{uuid.uuid4().hex[:8]}"
        _seed_run(db_conn, run_id, ent_id, emp_id, status="running")
        _seed_run_event(db_conn, f"evt_{uuid.uuid4().hex[:8]}", run_id, ent_id, emp_id, "message_delta", 1, "working...")
        _, body = _get("/api/team/office/scene")
        assert body["summary"]["online_employee_count"] >= 1
        assert body["summary"]["busy_employee_count"] >= 1
        assert len(body["seats"]) >= 1
        seat = next(s for s in body["seats"] if s["employee_id"] == emp_id)
        assert seat["presence"]["state"] == "streaming"
        assert seat["presence"]["current_run_id"] == run_id


# ── P09 Office Feed ────────────────────────────────────────────────────────

class TestOfficeFeed:
    """GET /api/team/office/feed."""

    def test_office_feed_returns_200(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        status, body = _get("/api/team/office/feed")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_office_feed_empty_enterprise_stable_shape(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        _, body = _get("/api/team/office/feed")
        assert "enterprise_id" in body, f"Missing enterprise_id: {body}"
        assert "items" in body
        assert body["items"] == []
        assert "queue" in body
        assert "billing_snapshot" in body

    def test_office_feed_with_runs(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        emp_id = f"emp_{uuid.uuid4().hex[:8]}"
        _seed_employee(db_conn, emp_id, ent_id)
        run_id = f"run_{uuid.uuid4().hex[:8]}"
        _seed_run(db_conn, run_id, ent_id, emp_id, status="running")
        _, body = _get("/api/team/office/feed")
        assert len(body["items"]) >= 1
        item = next(it for it in body["items"] if it["run_id"] == run_id)
        assert item["status"] == "running"
        assert "preview" in item

    def test_office_feed_exposes_group_navigation_target(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        emp_id = f"emp_{uuid.uuid4().hex[:8]}"
        _seed_employee(db_conn, emp_id, ent_id)
        conv_id = f"conv_group_{uuid.uuid4().hex[:8]}"
        _seed_conversation(
            db_conn,
            conv_id,
            ent_id,
            conv_type="group",
            title="预算评审群",
            entry_employee_id=emp_id,
            preview="群聊协作中",
        )
        run_id = f"run_{uuid.uuid4().hex[:8]}"
        _seed_run(db_conn, run_id, ent_id, emp_id, conv_id=conv_id, status="running")
        _seed_run_event(db_conn, f"evt_{uuid.uuid4().hex[:8]}", run_id, ent_id, emp_id, "task_started", 4, "群聊协作中")
        _, body = _get("/api/team/office/feed")
        item = next(it for it in body["items"] if it["run_id"] == run_id)
        assert item["conversation_id"] == conv_id
        assert item["conv_type"] == "group"
        assert item["navigation_target"] == f"/app/group/{conv_id}"


# ── P09 Real-time/event-driven seam ─────────────────────────────────────────

class TestOfficeEventDrivenSeam:
    """Polling contract: generated_cursor, refresh_hint_ms, per-item cursor pointers + events_url."""

    def test_scene_has_generated_cursor_and_refresh_hint(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        _, body = _get("/api/team/office/scene")
        assert "generated_cursor" in body, f"Missing generated_cursor: {body}"
        assert isinstance(body["generated_cursor"], int)
        assert "refresh_hint_ms" in body, f"Missing refresh_hint_ms: {body}"
        assert isinstance(body["refresh_hint_ms"], int)

    def test_feed_has_generated_cursor_and_refresh_hint(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        _, body = _get("/api/team/office/feed")
        assert "generated_cursor" in body, f"Missing generated_cursor: {body}"
        assert isinstance(body["generated_cursor"], int)
        assert "refresh_hint_ms" in body, f"Missing refresh_hint_ms: {body}"
        assert isinstance(body["refresh_hint_ms"], int)

    def test_scene_seat_has_cursor_pointers_with_run(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        emp_id = f"emp_{uuid.uuid4().hex[:8]}"
        _seed_employee(db_conn, emp_id, ent_id)
        run_id = f"run_{uuid.uuid4().hex[:8]}"
        _seed_run(db_conn, run_id, ent_id, emp_id, status="running")
        _seed_run_event(db_conn, f"evt_{uuid.uuid4().hex[:8]}", run_id, ent_id, emp_id, "message_delta", 1, "working...")
        _, body = _get("/api/team/office/scene")
        seat = next(s for s in body["seats"] if s["employee_id"] == emp_id)
        presence = seat["presence"]
        assert "latest_event_cursor" in presence, f"Missing latest_event_cursor: {presence}"
        assert presence["latest_event_cursor"] == 1, f"Expected cursor 1, got {presence['latest_event_cursor']}"
        assert presence["events_url"] is not None, f"Expected events_url, got None"
        assert f"/api/team/runs/{run_id}/events?cursor=1" in presence["events_url"]

    def test_scene_seat_exposes_group_navigation_target(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        emp_id = f"emp_{uuid.uuid4().hex[:8]}"
        _seed_employee(db_conn, emp_id, ent_id)
        conv_id = f"conv_group_{uuid.uuid4().hex[:8]}"
        _seed_conversation(
            db_conn,
            conv_id,
            ent_id,
            conv_type="group",
            title="预算评审群",
            entry_employee_id=emp_id,
            preview="群聊协作中",
        )
        run_id = f"run_{uuid.uuid4().hex[:8]}"
        _seed_run(db_conn, run_id, ent_id, emp_id, conv_id=conv_id, status="running")
        _seed_run_event(db_conn, f"evt_{uuid.uuid4().hex[:8]}", run_id, ent_id, emp_id, "task_started", 2, "群聊协作中")
        _, body = _get("/api/team/office/scene")
        seat = next(s for s in body["seats"] if s["employee_id"] == emp_id)
        presence = seat["presence"]
        assert presence["conversation_id"] == conv_id
        assert presence["conversation_type"] == "group"
        assert presence["navigation_target"] == f"/app/group/{conv_id}"

    def test_scene_seat_cursor_zero_without_run(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        emp_id = f"emp_{uuid.uuid4().hex[:8]}"
        _seed_employee(db_conn, emp_id, ent_id)
        _, body = _get("/api/team/office/scene")
        seat = next(s for s in body["seats"] if s["employee_id"] == emp_id)
        presence = seat["presence"]
        assert presence["latest_event_cursor"] == 0
        assert presence["events_url"] is None

    def test_feed_item_has_cursor_pointers(self, db_conn):
        ent_id = f"ent_{uuid.uuid4().hex[:8]}"
        _seed_enterprise(db_conn, ent_id)
        emp_id = f"emp_{uuid.uuid4().hex[:8]}"
        _seed_employee(db_conn, emp_id, ent_id)
        run_id = f"run_{uuid.uuid4().hex[:8]}"
        _seed_run(db_conn, run_id, ent_id, emp_id, status="running")
        _seed_run_event(db_conn, f"evt_{uuid.uuid4().hex[:8]}", run_id, ent_id, emp_id, "task_started", 3, "task started")
        _, body = _get("/api/team/office/feed")
        item = next(it for it in body["items"] if it["run_id"] == run_id)
        assert "latest_event_cursor" in item, f"Missing latest_event_cursor: {item}"
        assert item["latest_event_cursor"] == 3, f"Expected cursor 3, got {item['latest_event_cursor']}"
        assert "events_url" in item
        assert f"/api/team/runs/{run_id}/events?cursor=3" in item["events_url"]
