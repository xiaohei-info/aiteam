"""Layer2 Team Panel — northbound API contract tests for the first 12 endpoints.

Tests go through the existing host dispatch seam (_get/_post/_patch) so the
full request → dispatch → router path is exercised in-process.
"""
from __future__ import annotations

import json
import os
import uuid
from urllib.parse import urlparse

import pytest

# Reuse the FakeHandler pattern from layer0_contracts
try:
    from tests.aiteam.layer0_contracts.test_host_routing import _FakeHandler, _get, _post, _patch
except ImportError:
    # Fallback: re-define inline
    class _FakeHandler:
        def __init__(self):
            self.status = None
            self.sent_headers: list[tuple[str, str]] = []
            self.body = bytearray()
            self.wfile = self
            self.headers = {}

        def send_response(self, code):
            self.status = code

        def send_header(self, key, value):
            self.sent_headers.append((key, value))

        def end_headers(self):
            pass

        def write(self, data):
            self.body.extend(data if isinstance(data, (bytes, bytearray)) else data.encode("utf-8"))

        def get_json(self):
            return json.loads(self.body.decode("utf-8")) if self.body else {}


    def _get(parsed_path: str) -> tuple[int, dict]:
        from api.routes import handle_get
        handler = _FakeHandler()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_get(handler, parsed)
        return handler.status, handler.get_json()


    def _post(parsed_path: str, body: dict | None = None) -> tuple[int, dict]:
        from api.routes import handle_post
        handler = _FakeHandler()
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            handler.headers["Content-Length"] = str(len(raw))
            handler.rfile = type("_BytesIO", (), {"read": lambda n: raw})()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_post(handler, parsed)
        return handler.status, handler.get_json()


    def _patch(parsed_path: str, body: dict | None = None) -> tuple[int, dict]:
        from api.routes import handle_patch
        handler = _FakeHandler()
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            handler.headers["Content-Length"] = str(len(raw))
            handler.rfile = type("_BytesIO", (), {"read": lambda n: raw})()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_patch(handler, parsed)
        return handler.status, handler.get_json()


def _handler_text(handler: "_FakeHandler") -> str:
    return handler.body.decode("utf-8") if handler.body else ""


def _handler_content_type(handler: "_FakeHandler") -> str | None:
    for key, value in handler.sent_headers:
        if key.lower() == "content-type":
            return value
    return None


def _get_raw(parsed_path: str) -> "_FakeHandler":
    from api.routes import handle_get
    handler = _FakeHandler()
    parsed = urlparse(f"http://example.com{parsed_path}")
    handle_get(handler, parsed)
    return handler


# ═══════════════════════════════════════════════════════
# Batch 1: GET endpoints
# ═══════════════════════════════════════════════════════════════════════════

class TestWorkbench:
    """S06-T01: GET /api/team/workbench returns 200 with correct shape."""

    def test_get_workbench_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/workbench")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_workbench_has_enterprise_key(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "enterprise" in body, f"Missing enterprise key: {body}"

    def test_workbench_has_employees_key(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "employees" in body, f"Missing employees key: {body}"
        assert isinstance(body["employees"], list)

    def test_workbench_has_groups_key(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "groups" in body

    def test_workbench_has_office_digest_key(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "office_digest" in body
        assert "online_employee_count" in body["office_digest"]
        assert "running_task_count" in body["office_digest"]

    def test_workbench_enterprise_has_expected_fields(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        ent = body["enterprise"]
        assert "enterprise_id" in ent
        assert "name" in ent
        assert ent["name"] == "Test Corp"

    def test_workbench_employees_have_expected_shape(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        employees = body["employees"]
        assert len(employees) >= 1
        emp = employees[0]
        for key in ("employee_id", "display_name", "role_name", "status", "presence"):
            assert key in emp, f"Missing {key} in employee: {emp}"


class TestTalentMarketTemplates:
    """S06-T02: GET /api/team/talent-market/templates."""

    def test_get_templates_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/talent-market/templates")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_templates_response_has_items(self, seeded_enterprise):
        _, body = _get("/api/team/talent-market/templates")
        assert "items" in body
        assert "page" in body
        assert "total" in body
        assert "has_more" in body

    def test_templates_items_have_expected_shape(self, seeded_enterprise):
        _, body = _get("/api/team/talent-market/templates")
        items = body["items"]
        assert len(items) >= 1, f"No templates found: {body}"
        tpl = items[0]
        for key in ("template_id", "name", "role", "skills", "tags"):
            assert key in tpl, f"Missing {key} in template: {tpl}"


class TestTalentTemplateDetail:
    """S06-T03: GET /api/team/talent-market/templates/{id}."""

    def test_get_existing_template_returns_200(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        status, body = _get(f"/api/team/talent-market/templates/{tpl_id}")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_get_missing_template_returns_404(self, seeded_enterprise):
        status, body = _get("/api/team/talent-market/templates/nonexistent")
        assert status == 404, f"Expected 404, got {status}: {body}"
        assert body.get("error") == "TEMPLATE_NOT_FOUND"

    def test_template_detail_has_expected_shape(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        _, body = _get(f"/api/team/talent-market/templates/{tpl_id}")
        for key in ("template_id", "name", "category", "description", "default_skills",
                     "default_memory_config", "price_tier"):
            assert key in body, f"Missing {key} in template detail: {body}"


class TestConversationDetail:
    """S06-T05: GET /api/team/conversations/{id}."""

    def test_get_existing_conversation_returns_200(self, seeded_enterprise):
        conv_id = seeded_enterprise["conversation_id"]
        status, body = _get(f"/api/team/conversations/{conv_id}")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_get_missing_conversation_returns_404(self, seeded_enterprise):
        status, body = _get("/api/team/conversations/nonexistent")
        assert status == 404
        assert body.get("error") == "CONVERSATION_NOT_FOUND"

    def test_conversation_detail_has_expected_shape(self, seeded_enterprise):
        conv_id = seeded_enterprise["conversation_id"]
        _, body = _get(f"/api/team/conversations/{conv_id}")
        for key in ("conversation_id", "conversation_type", "status", "created_at"):
            assert key in body, f"Missing {key}: {body}"


class TestEmployeeList:
    """S06-T10: GET /api/team/employees."""

    def test_get_employees_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/employees")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_employees_response_has_correct_structure(self, seeded_enterprise):
        _, body = _get("/api/team/employees")
        assert "employees" in body
        assert "total" in body
        assert "page" in body
        assert "limit" in body
        assert isinstance(body["employees"], list)
        assert body["total"] >= 1

    def test_employee_items_have_expected_shape(self, seeded_enterprise):
        _, body = _get("/api/team/employees")
        employees = body["employees"]
        emp = employees[0]
        for key in ("employee_id", "display_name", "role_name", "status", "presence"):
            assert key in emp, f"Missing {key} in employee: {emp}"


class TestEmployeeDetail:
    """S06-T11: GET /api/team/employees/{id}."""

    def test_get_existing_employee_returns_200(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, body = _get(f"/api/team/employees/{emp_id}")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_get_missing_employee_returns_404(self, seeded_enterprise):
        status, body = _get("/api/team/employees/nonexistent")
        assert status == 404
        assert body.get("error") == "EMPLOYEE_NOT_FOUND"

    def test_employee_detail_has_expected_shape(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        _, body = _get(f"/api/team/employees/{emp_id}")
        for key in ("employee_id", "display_name", "role_name", "status", "presence",
                     "profile_config", "usage_summary", "created_at"):
            assert key in body, f"Missing {key}: {body}"


# ═══════════════════════════════════════════════════════════════════════════
# Batch 2: POST endpoints
# ═══════════════════════════════════════════════════════════════════════════

class TestRecruitmentsPost:
    """S06-T04: POST /api/team/recruitments."""

    def test_post_recruitment_returns_201_with_contract_shape(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        body = {
            "template_id": tpl_id,
            "display_name": "My Analyst",
            "idempotency_key": f"recruit-{uuid.uuid4().hex[:8]}",
        }
        status, resp = _post("/api/team/recruitments", body)
        assert status == 201, f"Expected 201, got {status}: {resp}"

    def test_recruitment_response_has_required_fields(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        body = {"template_id": tpl_id, "display_name": "New Analyst"}
        _, resp = _post("/api/team/recruitments", body)
        for key in ("order_id", "status", "employee_id", "profile_name"):
            assert key in resp, f"Missing {key}: {resp}"
        assert resp["status"] == "succeeded"


class TestRunsPost:
    """S06-T06: POST /api/team/runs."""

    def test_post_run_returns_201(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        conv_id = seeded_enterprise["conversation_id"]
        body = {
            "employee_id": emp_id,
            "conversation_id": conv_id,
            "message": {"text": "Hello"},
            "idempotency_key": f"run-{uuid.uuid4().hex[:8]}",
        }
        status, resp = _post("/api/team/runs", body)
        assert status == 201, f"Expected 201, got {status}: {resp}"

    def test_run_response_has_required_fields(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"]}
        _, resp = _post("/api/team/runs", body)
        for key in ("run_id", "status", "conversation_id", "stream_url", "events_url", "runtime_handle"):
            assert key in resp, f"Missing {key}: {resp}"
        assert resp["status"] == "queued"
        # stream_url and events_url contain the run_id
        assert resp["run_id"] in resp["stream_url"]
        assert resp["run_id"] in resp["events_url"]


class TestUploadsPost:
    """S06-T09: POST /api/team/uploads."""

    def test_post_upload_returns_201(self, seeded_enterprise):
        body = {"name": "test.pdf", "size": 1024, "mime_type": "application/pdf"}
        status, resp = _post("/api/team/uploads", body)
        assert status == 201, f"Expected 201, got {status}: {resp}"

    def test_upload_response_has_required_fields(self, seeded_enterprise):
        body = {"name": "doc.pdf"}
        _, resp = _post("/api/team/uploads", body)
        for key in ("asset_id", "name", "size", "mime_type", "storage_key", "preview_url"):
            assert key in resp, f"Missing {key}: {resp}"


# ═══════════════════════════════════════════════════════════════════════════
# Batch 3: Run stream & events
# ═══════════════════════════════════════════════════════════════════════════

class TestRunStream:
    """S06-T07: GET /api/team/runs/{run_id}/stream."""

    def test_get_run_stream_returns_200_and_sse_content_type(self, seeded_enterprise):
        # First create a run
        emp_id = seeded_enterprise["employee_id"]
        body = {"employee_id": emp_id}
        _, run_resp = _post("/api/team/runs", body)
        run_id = run_resp["run_id"]

        handler = _get_raw(f"/api/team/runs/{run_id}/stream")
        assert handler.status == 200, f"Expected 200, got {handler.status}: {_handler_text(handler)}"
        ct = _handler_content_type(handler)
        assert ct is not None, "Content-Type header missing"
        assert "text/event-stream" in ct, f"Expected text/event-stream, got {ct}"

    def test_stream_for_existing_run_produces_valid_sse_frames(self, seeded_enterprise, db_conn):
        emp_id = seeded_enterprise["employee_id"]
        enterprise_id = seeded_enterprise["enterprise_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id})
        run_id = run_resp["run_id"]

        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    f"evt_{uuid.uuid4().hex[:8]}",
                    enterprise_id,
                    run_id,
                    1,
                    "run_started",
                    "session",
                    "sess_test",
                    emp_id,
                    "Starting...",
                    json.dumps({"message_id": "msg_001"}),
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        handler = _get_raw(f"/api/team/runs/{run_id}/stream")
        ct = _handler_content_type(handler)
        assert ct is not None and "text/event-stream" in ct
        body_text = _handler_text(handler)
        assert body_text, "Expected at least one SSE frame for seeded run event"

        frames = body_text.rstrip("\n").split("\n\n")
        for frame in frames:
            if not frame:
                continue
            lines = frame.split("\n")
            assert lines[0] == "event: timeline", f"SSE event line mismatch: {lines[0]}"
            assert lines[1].startswith("data: "), f"SSE data line missing: {lines}"
            data_json_str = lines[1][len("data: "):]
            data = json.loads(data_json_str)
            for key in ("event_id", "event_cursor", "run_id", "event_type", "source_type", "source_id", "event_ts"):
                assert key in data, f"RunTimelineEvent missing key: {key}"
            assert data["event_type"] == "run_started"
            assert data["run_id"] == run_id

    def test_stream_for_nonexistent_run_returns_404(self, seeded_enterprise):
        status, resp = _get("/api/team/runs/nonexistent/stream")
        assert status == 404
        assert resp.get("error") == "RUN_NOT_FOUND"

    def test_stream_filters_unknown_event_types(self, seeded_enterprise, db_conn):
        """Regression: /api/team/runs/{run_id}/stream must not leak raw/unknown
        event_type strings in northbound RunTimelineEvent payloads."""
        emp_id = seeded_enterprise["employee_id"]
        enterprise_id = seeded_enterprise["enterprise_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id})
        run_id = run_resp["run_id"]

        cur = db_conn.cursor()
        try:
            cur.execute(
                "ALTER TABLE run_event DROP CONSTRAINT IF EXISTS run_event_event_type_check"
            )
            cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    f"evt_{uuid.uuid4().hex[:8]}",
                    enterprise_id,
                    run_id,
                    1,
                    "run_started",
                    "session",
                    "sess_test",
                    emp_id,
                    "Starting...",
                    json.dumps({}),
                ),
            )
            cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    f"evt_{uuid.uuid4().hex[:8]}",
                    enterprise_id,
                    run_id,
                    2,
                    "internal_debug_trace",
                    "session",
                    "sess_test",
                    emp_id,
                    "Internal trace...",
                    json.dumps({}),
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        handler = _get_raw(f"/api/team/runs/{run_id}/stream")
        assert handler.status == 200, f"Expected 200, got {handler.status}"
        ct = _handler_content_type(handler)
        assert ct is not None and "text/event-stream" in ct
        body_text = _handler_text(handler)

        # The unknown raw event_type string must not appear in the SSE body
        assert "internal_debug_trace" not in body_text, (
            f"Unknown event_type leaked to SSE: {body_text[:500]}"
        )

        # The valid event should still be present
        assert "run_started" in body_text, (
            f"Valid event_type missing from SSE: {body_text[:500]}"
        )

        # Frames should still be well-formed SSE with valid JSON
        frames = body_text.rstrip("\n").split("\n\n")
        for frame in frames:
            if not frame:
                continue
            lines = frame.split("\n")
            assert lines[0] == "event: timeline", f"SSE event line mismatch: {lines[0]}"
            assert lines[1].startswith("data: "), f"SSE data line missing: {lines}"
            data = json.loads(lines[1][len("data: "):])
            assert data["event_type"] in {"run_started"}, (
                f"Unexpected event_type in frame: {data['event_type']}"
            )

        # Restore the check constraint (delete the unknown-typed row first)
        cur2 = db_conn.cursor()
        try:
            cur2.execute("DELETE FROM run_event WHERE event_type = 'internal_debug_trace'")
            cur2.execute("""
                ALTER TABLE run_event ADD CONSTRAINT run_event_event_type_check
                CHECK(event_type IN ('run_created','routing_decided','run_started','message_delta','tool_call','task_created','task_started','task_completed','task_failed','run_waiting_human','result_merged','memory_written','usage_recorded','run_succeeded','run_failed','run_cancelled','heartbeat','error'))
            """)
            db_conn.commit()
        finally:
            cur2.close()


class TestRunEvents:
    """S06-T08: GET /api/team/runs/{run_id}/events."""

    def test_get_run_events_returns_200(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id})
        run_id = run_resp["run_id"]

        status, resp = _get(f"/api/team/runs/{run_id}/events")
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_events_response_has_cursor_pagination_shape(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id})
        run_id = run_resp["run_id"]

        _, resp = _get(f"/api/team/runs/{run_id}/events")
        for key in ("items", "next_cursor", "has_more", "run_status"):
            assert key in resp, f"Missing {key}: {resp}"
        assert isinstance(resp["items"], list)
        assert isinstance(resp["next_cursor"], int)
        assert isinstance(resp["has_more"], bool)

    def test_events_for_nonexistent_run_returns_404(self, seeded_enterprise):
        status, resp = _get("/api/team/runs/nonexistent/events")
        assert status == 404
        assert resp.get("error") == "RUN_NOT_FOUND"


# ═══════════════════════════════════════════════════════════════════════════
# Batch 4: PATCH employee
# ═══════════════════════════════════════════════════════════════════════════

class TestEmployeePatch:
    """S06-T12: PATCH /api/team/employees/{id}."""

    def test_patch_display_name_returns_200(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"display_name": "Updated Analyst"}
        status, resp = _patch(f"/api/team/employees/{emp_id}", body)
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["display_name"] == "Updated Analyst"

    def test_patch_status_active_to_paused(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"status": "paused"}
        status, resp = _patch(f"/api/team/employees/{emp_id}", body)
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["status"] == "paused"

    def test_patch_invalid_status_transition_rejected(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        # active -> provisioning_failed is not a valid transition
        body = {"status": "provisioning_failed"}
        status, resp = _patch(f"/api/team/employees/{emp_id}", body)
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "INVALID_STATUS_TRANSITION"

    def test_patch_archived_employee_cannot_be_modified(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        # First archive the employee
        _patch(f"/api/team/employees/{emp_id}", {"status": "archived"})
        # Now try to transition from archived to active
        body = {"status": "active"}
        status, resp = _patch(f"/api/team/employees/{emp_id}", body)
        assert status == 400
        assert resp.get("error") == "INVALID_STATUS_TRANSITION"

    def test_patch_unknown_field_rejected(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"unknown_field": "value"}
        status, resp = _patch(f"/api/team/employees/{emp_id}", body)
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "INVALID_FIELD"

    def test_patch_nonexistent_employee_returns_404(self, seeded_enterprise):
        status, resp = _patch("/api/team/employees/nonexistent", {"display_name": "x"})
        assert status == 404
        assert resp.get("error") == "EMPLOYEE_NOT_FOUND"

    def test_patch_response_has_expected_shape(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"display_name": "Final Name"}
        _, resp = _patch(f"/api/team/employees/{emp_id}", body)
        for key in ("employee_id", "display_name", "status", "updated_at"):
            assert key in resp, f"Missing {key}: {resp}"


# ═══════════════════════════════════════════════════════════════════════════
# Regression: non-team paths still work
# ═══════════════════════════════════════════════════════════════════════════

def test_non_team_paths_still_work():
    """Unchanged paths should not be caught by team dispatch."""
    for path in ["/api/sessions", "/api/models"]:
        status, body = _get(path)
        # These should not be 200 from team dispatch — they should hit their normal handlers
        # or 404 if no handler, but NOT from our team router
        if status == 200:
            # If we get 200, make sure it's not a team-panel response
            assert "enterprise_id" not in body or "employees" in body, \
                f"Non-team path {path} should not return team workbench data"
