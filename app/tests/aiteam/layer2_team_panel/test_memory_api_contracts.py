from __future__ import annotations

import json

from tests.aiteam.layer0_contracts.test_host_routing import _delete, _get, _post, _patch


def _insert_memory_item(
    db_conn,
    *,
    memory_id: str,
    enterprise_id: str,
    employee_id: str,
    content: str,
    category: str = "preference",
    importance: int = 3,
    source_type: str = "manual",
    tags: list[str] | None = None,
    visibility_scope: str = "enterprise",
    runtime_ref: dict | None = None,
) -> None:
    cur = db_conn.cursor()
    try:
        cur.execute(
            """
            INSERT INTO memory_item
                (id, enterprise_id, employee_id, content, category, importance, source_type, tags_json, visibility_scope, runtime_ref_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb)
            """,
            (
                memory_id,
                enterprise_id,
                employee_id,
                content,
                category,
                importance,
                source_type,
                json.dumps(tags or []),
                visibility_scope,
                json.dumps(runtime_ref or {}),
            ),
        )
        db_conn.commit()
    finally:
        cur.close()


def _insert_review_decision(
    db_conn,
    *,
    decision_id: str,
    enterprise_id: str,
    memory_item_id: str,
    decision: str,
    reviewed_by: str = "usr_admin",
    comment: str | None = None,
    corrected_content: str | None = None,
) -> None:
    cur = db_conn.cursor()
    try:
        cur.execute(
            """
            INSERT INTO memory_review_decision
                (id, enterprise_id, memory_item_id, reviewer_user_id, decision, comment, corrected_content)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (decision_id, enterprise_id, memory_item_id, reviewed_by, decision, comment, corrected_content),
        )
        db_conn.commit()
    finally:
        cur.close()


class TestMemoriesGet:
    def test_get_memories_returns_canonical_envelope(self, seeded_enterprise):
        status, body = _get("/api/team/memories")
        assert status == 200, body
        assert body == {
            "items": [],
            "page": 1,
            "page_size": 20,
            "total": 0,
            "has_more": False,
            "sort_by": "importance",
            "sort_order": "desc",
        }

    def test_get_memories_filters_and_expands_prompt_trace(self, seeded_enterprise, db_conn):
        enterprise_id = seeded_enterprise["enterprise_id"]
        employee_id = seeded_enterprise["employee_id"]
        _insert_memory_item(
            db_conn,
            memory_id="mem_trace_1",
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            content="Preferred reporting format is weekly summary",
            tags=["vip", "reporting"],
            source_type="extraction",
            runtime_ref={"source_kind": "run_event", "run_id": "run_trace_1"},
        )
        _insert_memory_item(
            db_conn,
            memory_id="mem_rejected",
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            content="Rejected note",
            category="event",
            tags=["vip"],
            source_type="extraction",
        )
        _insert_review_decision(
            db_conn,
            decision_id="mrd_rejected",
            enterprise_id=enterprise_id,
            memory_item_id="mem_rejected",
            decision="rejected",
        )

        cur = db_conn.cursor()
        try:
            cur.execute(
                """
                INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, idempotency_key)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    "run_trace_1",
                    enterprise_id,
                    seeded_enterprise["conversation_id"],
                    "manual_run",
                    "single_agent",
                    "succeeded",
                    employee_id,
                    "idem_mem_trace_1",
                ),
            )
            cur.execute(
                """
                INSERT INTO run_event
                    (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    "evt_mem_trace_1",
                    enterprise_id,
                    "run_trace_1",
                    1,
                    "memory_written",
                    "session",
                    "sess_trace_1",
                    employee_id,
                    "Injected memory into prompt",
                    json.dumps(
                        {
                            "memory_id": "mem_trace_1",
                            "run_id": "run_trace_1",
                            "stage": "prompt_injected",
                        }
                    ),
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _get(
            "/api/team/memories?employee_id=emp_test&q=Preferred&tag=vip&include=prompt_use_trace&trace_limit=5"
        )
        assert status == 200, body
        assert body["total"] == 1, body
        assert body["page"] == 1
        assert body["page_size"] == 20
        assert body["has_more"] is False
        item = body["items"][0]
        assert item["memory_id"] == "mem_trace_1"
        assert item["employee_id"] == employee_id
        assert item["category"] == "preference"
        assert item["importance"] == 3
        assert item["source_type"] == "extraction"
        assert item["visibility_scope"] == "enterprise"
        assert item["runtime_ref"]["run_id"] == "run_trace_1"
        assert item["review"]["status"] == "pending"
        assert item["prompt_use_trace"][0] == {
            "run_id": "run_trace_1",
            "event_id": "evt_mem_trace_1",
            "event_cursor": 1,
            "stage": "prompt_injected",
            "used_at": item["prompt_use_trace"][0]["used_at"],
        }


class TestMemoriesPost:
    def test_post_memory_creates_manual_record_and_audit_event(self, seeded_enterprise, db_conn):
        employee_id = seeded_enterprise["employee_id"]

        status, body = _post(
            "/api/team/memories",
            {
                "employee_id": employee_id,
                "content": "Customer prefers concise weekly reports",
                "category": "preference",
                "importance": 5,
                "tags": ["vip", "reporting"],
                "visibility_scope": "admin_only",
            },
        )
        assert status == 201, body
        assert body["employee_id"] == employee_id
        assert body["importance"] == 5
        assert body["source_type"] == "manual"
        assert body["visibility_scope"] == "admin_only"
        assert body["runtime_ref"] == {}
        assert body["review"]["status"] == "not_required"
        assert body["tags"] == ["vip", "reporting"]

        detail_status, employee_body = _get(f"/api/team/employees/{employee_id}")
        assert detail_status == 200, employee_body
        assert employee_body["profile_config"]["memory_config"]["mode"] == "builtin"
        assert employee_body["profile_config"]["memory_config"]["writeback_enabled"] is True

        cur = db_conn.cursor()
        try:
            cur.execute(
                "SELECT content, importance, category, source_type, visibility_scope, runtime_ref_json FROM memory_item WHERE id = %s",
                (body["memory_id"],),
            )
            row = cur.fetchone()
            assert row == (
                "Customer prefers concise weekly reports",
                5,
                "preference",
                "manual",
                "admin_only",
                {},
            )

            cur.execute(
                "SELECT event_type, target_type, target_id FROM audit_event WHERE target_id = %s ORDER BY created_at DESC LIMIT 1",
                (body["memory_id"],),
            )
            audit_row = cur.fetchone()
            assert audit_row == ("memory.create", "memory_item", body["memory_id"])
        finally:
            cur.close()


class TestMemoriesPatch:
    def test_patch_memory_updates_review_and_corrected_content(self, seeded_enterprise, db_conn):
        enterprise_id = seeded_enterprise["enterprise_id"]
        employee_id = seeded_enterprise["employee_id"]
        _insert_memory_item(
            db_conn,
            memory_id="mem_patch_1",
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            content="Original extracted note",
            category="event",
            importance=2,
            tags=["draft"],
            source_type="extraction",
        )

        status, body = _patch(
            "/api/team/memories/mem_patch_1",
            {
                "content": "Updated note",
                "importance": 4,
                "tags": ["updated", "important"],
                "review": {
                    "decision": "corrected",
                    "comment": "remove unverified detail",
                    "corrected_content": "Corrected final note",
                },
            },
        )
        assert status == 200, body
        assert body["content"] == "Corrected final note"
        assert body["importance"] == 4
        assert body["tags"] == ["updated", "important"]
        assert body["review"]["status"] == "corrected"
        assert body["review"]["corrected_content"] == "Corrected final note"

        cur = db_conn.cursor()
        try:
            cur.execute(
                "SELECT content, importance, tags_json FROM memory_item WHERE id = %s",
                ("mem_patch_1",),
            )
            row = cur.fetchone()
            assert row == ("Corrected final note", 4, ["updated", "important"])
            cur.execute(
                "SELECT decision, corrected_content FROM memory_review_decision WHERE memory_item_id = %s ORDER BY created_at DESC LIMIT 1",
                ("mem_patch_1",),
            )
            review_row = cur.fetchone()
            assert review_row == ("corrected", "Corrected final note")
        finally:
            cur.close()

    def test_delete_and_bulk_delete_memory_entries(self, seeded_enterprise, db_conn):
        enterprise_id = seeded_enterprise["enterprise_id"]
        employee_id = seeded_enterprise["employee_id"]
        _insert_memory_item(
            db_conn,
            memory_id="mem_delete_1",
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            content="Delete me",
        )
        _insert_memory_item(
            db_conn,
            memory_id="mem_delete_2",
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            content="Delete me too",
        )

        status, body = _delete("/api/team/memories/mem_delete_1")
        assert status == 200, body
        assert body == {"memory_id": "mem_delete_1", "status": "deleted"}

        bulk_status, bulk_body = _post(
            "/api/team/memories/bulk-delete",
            {"employee_id": employee_id, "memory_ids": ["mem_delete_2"]},
        )
        assert bulk_status == 200, bulk_body
        assert bulk_body["deleted_count"] == 1
        assert bulk_body["memory_ids"] == ["mem_delete_2"]

        cur = db_conn.cursor()
        try:
            cur.execute("SELECT deleted_at IS NOT NULL FROM memory_item WHERE id = %s", ("mem_delete_1",))
            assert cur.fetchone() == (True,)
            cur.execute("SELECT deleted_at IS NOT NULL FROM memory_item WHERE id = %s", ("mem_delete_2",))
            assert cur.fetchone() == (True,)
        finally:
            cur.close()

    def test_post_memory_prunes_oldest_low_priority_when_employee_hits_limit(self, seeded_enterprise, db_conn):
        enterprise_id = seeded_enterprise["enterprise_id"]
        employee_id = seeded_enterprise["employee_id"]
        cur = db_conn.cursor()
        try:
            for index in range(1000):
                cur.execute(
                    """
                    INSERT INTO memory_item
                        (id, enterprise_id, employee_id, content, category, importance, source_type, tags_json, visibility_scope, runtime_ref_json)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb)
                    """,
                    (
                        f"mem_limit_{index:04d}",
                        enterprise_id,
                        employee_id,
                        f"Seed memory {index}",
                        "event",
                        1,
                        "manual",
                        "[]",
                        "enterprise",
                        "{}",
                    ),
                )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _post(
            "/api/team/memories",
            {
                "employee_id": employee_id,
                "content": "Newest pinned memory",
                "category": "decision",
                "importance": 5,
            },
        )
        assert status == 201, body
        assert body["degradation"]["strategy"] == "prune_oldest_low_priority"
        assert len(body["degradation"]["pruned_memory_ids"]) == 1

        cur = db_conn.cursor()
        try:
            cur.execute(
                "SELECT COUNT(*) FROM memory_item WHERE employee_id = %s AND deleted_at IS NULL",
                (employee_id,),
            )
            assert cur.fetchone() == (1000,)
        finally:
            cur.close()
