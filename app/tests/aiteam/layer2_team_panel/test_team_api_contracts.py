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

from team_panel.transactions.uow import UnitOfWork
from team_panel.application.commands.conversation_service import create_group_conversation

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

    def test_workbench_exposes_navigation_permissions_and_task_digest(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "my_team" in body
        assert "conversations" in body
        assert "navigation" in body
        assert "task_status_digest" in body
        assert "permissions" in body
        assert body["navigation"]["talent"]["target"] == "/app/marketplace"
        assert body["navigation"]["org"]["target"] == "/app/workbench"
        assert body["permissions"]["role"] == "member"
        assert body["permissions"]["can_view_admin"] is False

    def test_workbench_ignores_public_role_query_param(self, seeded_enterprise):
        _, body = _get("/api/team/workbench?role=owner")
        assert body["navigation"]["org"]["target"] == "/app/workbench"
        assert body["permissions"]["role"] == "member"
        assert body["permissions"]["can_view_admin"] is False

    def test_workbench_returns_structured_permission_error_for_system_admin(self, seeded_enterprise, monkeypatch):
        monkeypatch.setenv("HERMES_AITEAM_WORKBENCH_ROLE", "system_admin")
        status, body = _get("/api/team/workbench")
        assert status == 403
        assert body["error"]["code"] == "PERMISSION_DENIED"
        assert body["error"]["retryable"] is False

    def test_workbench_owner_gets_org_admin_navigation_target(self, seeded_enterprise, monkeypatch):
        monkeypatch.setenv("HERMES_AITEAM_WORKBENCH_ROLE", "owner")
        _, body = _get("/api/team/workbench")
        assert body["navigation"]["org"]["target"] == "/app/org"
        assert body["permissions"]["can_view_admin"] is True


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

    def test_get_group_conversation_detail_returns_members(self, db_conn, seeded_enterprise):
        with UnitOfWork(db_conn) as uow:
            conv_id = create_group_conversation(
                uow,
                seeded_enterprise["enterprise_id"],
                "Contract Group",
                [seeded_enterprise["employee_id"], "emp_member", "emp_planner"],
                "user_test",
            )

        status, body = _get(f"/api/team/group-conversations/{conv_id}")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["conversation_type"] == "group"
        assert body["member_count"] == 3
        assert isinstance(body["members"], list)
        assert {member["employee_id"] for member in body["members"]} == {
            seeded_enterprise["employee_id"],
            "emp_member",
            "emp_planner",
        }
        assert body["default_route_hint"] == "auto"
        assert body["latest_route_decision"] is None
        assert body["timeline"] == {
            "run_id": None,
            "events_url": None,
            "stream_url": None,
            "latest_event_cursor": 0,
        }
        assert body["task_tree"] == {"run_id": None, "items": []}

    def test_group_conversation_detail_exposes_task_tree_and_timeline_handles(self, db_conn, seeded_enterprise):
        with UnitOfWork(db_conn) as uow:
            conv_id = create_group_conversation(
                uow,
                seeded_enterprise["enterprise_id"],
                "Contract Group",
                [seeded_enterprise["employee_id"], "emp_member", "emp_planner"],
                "user_test",
            )
            uow.cur.execute(
                "UPDATE conversation SET latest_run_id = %s, last_message_preview = %s WHERE id = %s",
                ("run_group_contract", "财务校验完成", conv_id),
            )
            uow.cur.execute(
                "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, planner_employee_id, result_summary_json, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)",
                (
                    "run_group_contract",
                    seeded_enterprise["enterprise_id"],
                    conv_id,
                    "group_message",
                    "kanban_orchestration",
                    "running",
                    seeded_enterprise["employee_id"],
                    "emp_planner",
                    json.dumps({
                        "route_mode": "orchestration",
                        "target_employee_ids": ["emp_member", "emp_planner"],
                        "candidate_employee_ids": ["emp_planner", "emp_member"],
                        "entry_employee_id": seeded_enterprise["employee_id"],
                        "planner_employee_id": "emp_planner",
                    }),
                    "user_test",
                ),
            )
            uow.cur.execute(
                "INSERT INTO team_task (id, run_id, parent_team_task_id, title, description, assignee_employee_id, status, sequence_no, depth, input_payload_json, output_summary_json, runtime_task_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)",
                (
                    "task_local_001",
                    "run_group_contract",
                    None,
                    "需求拆解",
                    "拆解预算问题",
                    "emp_planner",
                    "running",
                    1,
                    0,
                    json.dumps({"phase": "planner", "description": "拆解预算问题"}),
                    json.dumps({"summary": "正在拆解中"}),
                    "task_root_001",
                ),
            )
            uow.cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
                (
                    "evt_group_003",
                    seeded_enterprise["enterprise_id"],
                    "run_group_contract",
                    3,
                    "task_started",
                    "kanban_task",
                    "task_root_001",
                    "emp_planner",
                    "财务校验开始",
                    json.dumps({"phase": "planner", "parent_task_id": "task_root_000"}),
                ),
            )

        status, body = _get(f"/api/team/group-conversations/{conv_id}")
        assert status == 200, body
        assert body["latest_run"]["run_id"] == "run_group_contract"
        assert body["latest_run"]["stream_url"].endswith("/api/team/runs/run_group_contract/stream?cursor=3")
        assert body["latest_run"]["events_url"].endswith("/api/team/runs/run_group_contract/events?cursor=3")
        assert body["latest_run"]["latest_event_cursor"] == 3
        assert body["timeline"] == {
            "run_id": "run_group_contract",
            "events_url": "/api/team/runs/run_group_contract/events?cursor=0",
            "stream_url": "/api/team/runs/run_group_contract/stream?cursor=3",
            "latest_event_cursor": 3,
        }
        assert body["latest_route_decision"] == {
            "route_mode": "orchestration",
            "target_employee_ids": ["emp_member", "emp_planner"],
            "planner_employee_id": "emp_planner",
            "entry_employee_id": seeded_enterprise["employee_id"],
            "candidate_employee_ids": ["emp_planner", "emp_member"],
        }
        assert body["task_tree"]["run_id"] == "run_group_contract"
        assert body["task_tree"]["items"] == [
            {
                "task_id": "task_local_001",
                "parent_task_id": None,
                "runtime_task_id": "task_root_001",
                "title": "需求拆解",
                "description": "拆解预算问题",
                "status": "running",
                "assignee_employee_id": "emp_planner",
                "sequence_no": 1,
                "depth": 0,
                "started_at": None,
                "finished_at": None,
                "input_payload": {"phase": "planner", "description": "拆解预算问题"},
                "output_summary": {"summary": "正在拆解中"},
            }
        ]


class TestRunTimelineEndpoints:
    def test_run_events_returns_full_event_payload_and_latest_cursor(self, db_conn, seeded_enterprise):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    "run_events_contract",
                    seeded_enterprise["enterprise_id"],
                    seeded_enterprise["conversation_id"],
                    "group_message",
                    "kanban_orchestration",
                    "running",
                    seeded_enterprise["employee_id"],
                    "user_test",
                ),
            )
            cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
                (
                    "evt_run_events_001",
                    seeded_enterprise["enterprise_id"],
                    "run_events_contract",
                    1,
                    "routing_decided",
                    "session",
                    "sess_contract",
                    seeded_enterprise["employee_id"],
                    "已决定编排方式",
                    json.dumps({"route_mode": "orchestration", "candidate_employee_ids": ["emp_planner", "emp_member"]}),
                ),
            )
            cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
                (
                    "evt_run_events_002",
                    seeded_enterprise["enterprise_id"],
                    "run_events_contract",
                    2,
                    "task_started",
                    "kanban_task",
                    "task_root_001",
                    "emp_planner",
                    "财务校验开始",
                    json.dumps({"phase": "planner", "parent_task_id": "task_root_000"}),
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _get("/api/team/runs/run_events_contract/events?cursor=0&limit=1")
        assert status == 200, body
        assert body["latest_event_cursor"] == 2
        assert body["next_cursor"] == 1
        assert body["has_more"] is True
        assert body["run_status"] == "running"
        assert body["items"] == [
            {
                "event_id": "evt_run_events_001",
                "event_cursor": 1,
                "run_id": "run_events_contract",
                "event_type": "routing_decided",
                "source_type": "session",
                "source_id": "sess_contract",
                "employee_id": seeded_enterprise["employee_id"],
                "event_ts": body["items"][0]["event_ts"],
                "preview": "已决定编排方式",
                "payload": {"route_mode": "orchestration", "candidate_employee_ids": ["emp_planner", "emp_member"]},
            }
        ]

    def test_run_events_rejects_invalid_pagination(self, db_conn, seeded_enterprise):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    "run_events_invalid",
                    seeded_enterprise["enterprise_id"],
                    seeded_enterprise["conversation_id"],
                    "group_message",
                    "single_agent",
                    "running",
                    seeded_enterprise["employee_id"],
                    "user_test",
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _get("/api/team/runs/run_events_invalid/events?cursor=-1&limit=foo")
        assert status == 400
        assert body["error"] == "INVALID_PAGINATION"

    def test_run_stream_returns_timeline_frames_and_keepalive_comment(self, db_conn, seeded_enterprise):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    "run_stream_contract",
                    seeded_enterprise["enterprise_id"],
                    seeded_enterprise["conversation_id"],
                    "group_message",
                    "kanban_orchestration",
                    "running",
                    seeded_enterprise["employee_id"],
                    "user_test",
                ),
            )
            cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
                (
                    "evt_stream_001",
                    seeded_enterprise["enterprise_id"],
                    "run_stream_contract",
                    1,
                    "task_started",
                    "kanban_task",
                    "task_root_001",
                    "emp_planner",
                    "财务校验开始",
                    json.dumps({"phase": "planner", "parent_task_id": "task_root_000"}),
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        handler = _get_raw("/api/team/runs/run_stream_contract/stream?cursor=0")
        assert handler.status == 200
        assert "text/event-stream" in (_handler_content_type(handler) or "")
        text = _handler_text(handler)
        assert text.startswith("event: timeline\n")
        assert '"event_cursor": 1' in text
        assert '"event_type": "task_started"' in text
        assert text.endswith("\n\n")

    def test_run_stream_rejects_invalid_cursor(self, db_conn, seeded_enterprise):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    "run_stream_invalid",
                    seeded_enterprise["enterprise_id"],
                    seeded_enterprise["conversation_id"],
                    "group_message",
                    "single_agent",
                    "running",
                    seeded_enterprise["employee_id"],
                    "user_test",
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        handler = _get_raw("/api/team/runs/run_stream_invalid/stream?cursor=-2")
        assert handler.status == 400
        assert handler.get_json()["error"] == "INVALID_CURSOR"


class TestEmployeeList:
    """S06-T10: GET /api/team/employees."""

    def test_get_employees_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/employees?role=owner")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_employees_response_has_correct_structure(self, seeded_enterprise):
        _, body = _get("/api/team/employees?role=owner")
        assert "employees" in body
        assert "total" in body
        assert "page" in body
        assert "limit" in body
        assert isinstance(body["employees"], list)
        assert body["total"] >= 1

    def test_employee_items_have_expected_shape(self, seeded_enterprise):
        _, body = _get("/api/team/employees?role=owner")
        employees = body["employees"]
        emp = employees[0]
        for key in ("employee_id", "display_name", "role_name", "status", "presence"):
            assert key in emp, f"Missing {key} in employee: {emp}"

    def test_finance_admin_cannot_list_employees(self, seeded_enterprise):
        status, body = _get("/api/team/employees?role=finance_admin")
        assert status == 403
        assert body.get("error") == "FORBIDDEN"


class TestEmployeeDetail:
    """S06-T11: GET /api/team/employees/{id}."""

    def test_get_existing_employee_returns_200(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, body = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_get_missing_employee_returns_404(self, seeded_enterprise):
        status, body = _get("/api/team/employees/nonexistent?role=owner")
        assert status == 404
        assert body.get("error") == "EMPLOYEE_NOT_FOUND"

    def test_employee_detail_has_expected_shape(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        _, body = _get(f"/api/team/employees/{emp_id}?role=owner")
        for key in ("employee_id", "display_name", "role_name", "status", "presence",
                     "profile_config", "usage_summary", "created_at"):
            assert key in body, f"Missing {key}: {body}"


class TestGovernanceBillingAndExport:
    def test_billing_overview_requires_billing_permission(self, seeded_enterprise):
        status, body = _get("/api/team/billing/usage/overview?role=member")
        assert status == 403
        assert body.get("required_action") == "view_billing"

    def test_billing_overview_returns_real_totals(self, seeded_enterprise, db_conn):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, result_summary_json, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)",
                (
                    "run_bill_001",
                    seeded_enterprise["enterprise_id"],
                    seeded_enterprise["conversation_id"],
                    "manual_run",
                    "single_agent",
                    "succeeded",
                    seeded_enterprise["employee_id"],
                    '{"total_tokens": 42, "cost_cents": 7}',
                    "user_test",
                ),
            )
            db_conn.commit()
        finally:
            cur.close()
        status, body = _get("/api/team/billing/usage/overview?role=owner&period_start=2000-01-01&period_end=2099-12-31")
        assert status == 200
        assert body["total_tokens"] >= 42
        assert body["total_cost_cents"] >= 7

    def test_billing_alias_returns_deprecated_metadata(self, seeded_enterprise):
        status, body = _get("/api/enterprise-admin/billing/usage?role=owner")
        assert status == 200
        assert body.get("deprecated") is True
        assert body.get("canonical_path") == "/api/team/billing/usage/overview"

    def test_employees_export_returns_csv(self, seeded_enterprise):
        handler = _get_raw("/api/team/employees/export?role=owner")
        assert handler.status == 200
        ct = _handler_content_type(handler)
        assert ct is not None and "text/csv" in ct
        text = _handler_text(handler)
        assert "employee_id,display_name,role_name,status" in text
        assert "emp_test,Test Analyst" in text

    def test_billing_records_export_requires_export_permission(self, seeded_enterprise):
        handler = _get_raw("/api/team/billing/usage/records/export?role=member")
        assert handler.status == 403

    def test_audit_events_returns_employee_update(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, _ = _patch(
            f"/api/team/employees/{emp_id}?role=owner&actor_id=user_test&request_id=req_audit",
            {"display_name": "Governed Analyst"},
        )
        assert status == 200
        status, body = _get("/api/team/audit-events?role=owner&target_type=employee&target_id=emp_test")
        assert status == 200
        assert body["total"] >= 1
        assert any(item["event_type"] == "employee.updated" for item in body["items"])


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
        body = {
            "employee_id": emp_id,
            "conversation_id": seeded_enterprise["conversation_id"],
            "message": {"text": "Hello"},
        }
        _, resp = _post("/api/team/runs", body)
        for key in ("run_id", "status", "conversation_id", "stream_url", "events_url", "runtime_handle"):
            assert key in resp, f"Missing {key}: {resp}"
        assert resp["status"] == "queued"
        assert resp["runtime_handle"]["kind"] == "session"
        assert resp["runtime_handle"]["profile_name"] == emp_id
        assert resp["runtime_handle"]["session_id"].startswith("sess_")
        assert resp["run_id"] in resp["stream_url"]
        assert resp["run_id"] in resp["events_url"]

    def test_post_run_persists_runtime_binding_with_real_session_handle(self, seeded_enterprise, db_conn):
        body = {
            "employee_id": seeded_enterprise["employee_id"],
            "conversation_id": seeded_enterprise["conversation_id"],
            "message": {"text": "Need a real runtime handle"},
            "idempotency_key": f"run-{uuid.uuid4().hex[:8]}",
        }
        status, resp = _post("/api/team/runs", body)
        assert status == 201, resp
        runtime_handle = resp["runtime_handle"]
        assert runtime_handle["kind"] == "session"
        assert runtime_handle["profile_name"] == seeded_enterprise["employee_id"]
        assert runtime_handle["session_id"].startswith("sess_")

        with UnitOfWork(db_conn) as uow:
            binding = uow.runtime_bindings().get_by_owner("team_run", resp["run_id"])
            assert binding is not None
            assert binding.runtime_kind == "session"
            assert binding.profile_name == seeded_enterprise["employee_id"]
            assert binding.runtime_session_id == runtime_handle["session_id"]
            assert binding.runtime_session_id is not None


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
        body = {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}}
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
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
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

    def test_stream_resume_replays_only_events_after_cursor(self, seeded_enterprise, db_conn):
        emp_id = seeded_enterprise["employee_id"]
        enterprise_id = seeded_enterprise["enterprise_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
        run_id = run_resp["run_id"]

        cur = db_conn.cursor()
        try:
            cur.executemany(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                [
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
                    (
                        f"evt_{uuid.uuid4().hex[:8]}",
                        enterprise_id,
                        run_id,
                        2,
                        "message_delta",
                        "session",
                        "sess_test",
                        emp_id,
                        "Part 1",
                        json.dumps({"message_id": "msg_001", "delta": "Part 1"}),
                    ),
                    (
                        f"evt_{uuid.uuid4().hex[:8]}",
                        enterprise_id,
                        run_id,
                        3,
                        "message_delta",
                        "session",
                        "sess_test",
                        emp_id,
                        "Part 2",
                        json.dumps({"message_id": "msg_001", "delta": "Part 2"}),
                    ),
                ],
            )
            db_conn.commit()
        finally:
            cur.close()

        handler = _get_raw(f"/api/team/runs/{run_id}/stream?cursor=1")
        assert handler.status == 200, f"Expected 200, got {handler.status}: {_handler_text(handler)}"
        ct = _handler_content_type(handler)
        assert ct is not None and "text/event-stream" in ct

        body_text = _handler_text(handler)
        frames = [frame for frame in body_text.rstrip("\n").split("\n\n") if frame]
        payloads = [json.loads(frame.split("\n", 1)[1][len("data: "):]) for frame in frames]

        assert [payload["event_cursor"] for payload in payloads] == [2, 3]
        assert all(payload["event_cursor"] > 1 for payload in payloads)
        assert [payload["event_type"] for payload in payloads] == ["message_delta", "message_delta"]

    def test_stream_for_nonexistent_run_returns_404(self, seeded_enterprise):
        status, resp = _get("/api/team/runs/nonexistent/stream")
        assert status == 404
        assert resp.get("error") == "RUN_NOT_FOUND"

    def test_stream_filters_unknown_event_types(self, seeded_enterprise, db_conn):
        """Regression: /api/team/runs/{run_id}/stream must not leak raw/unknown
        event_type strings in northbound RunTimelineEvent payloads."""
        emp_id = seeded_enterprise["employee_id"]
        enterprise_id = seeded_enterprise["enterprise_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
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
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
        run_id = run_resp["run_id"]

        status, resp = _get(f"/api/team/runs/{run_id}/events")
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_events_response_has_cursor_pagination_shape(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
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
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner&actor_id=user_test", body)
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["display_name"] == "Updated Analyst"

    def test_patch_status_active_to_paused(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"status": "paused"}
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["status"] == "paused"

    def test_patch_invalid_status_transition_rejected(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        # active -> provisioning_failed is not a valid transition
        body = {"status": "provisioning_failed"}
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "INVALID_STATUS_TRANSITION"

    def test_patch_archived_employee_cannot_be_modified(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        # First archive the employee
        _patch(f"/api/team/employees/{emp_id}?role=owner", {"status": "archived"})
        # Now try to transition from archived to active
        body = {"status": "active"}
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        assert status == 400
        assert resp.get("error") == "INVALID_STATUS_TRANSITION"

    def test_patch_unknown_field_rejected(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"unknown_field": "value"}
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "INVALID_FIELD"

    def test_patch_nonexistent_employee_returns_404(self, seeded_enterprise):
        status, resp = _patch("/api/team/employees/nonexistent?role=owner", {"display_name": "x"})
        assert status == 404
        assert resp.get("error") == "EMPLOYEE_NOT_FOUND"

    def test_patch_response_has_expected_shape(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"display_name": "Final Name"}
        _, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        for key in ("employee_id", "display_name", "status", "updated_at"):
            assert key in resp, f"Missing {key}: {resp}"

    def test_finance_admin_cannot_patch_employee(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=finance_admin", {"display_name": "Nope"})
        assert status == 403
        assert resp["required_action"] == "manage_employees"


class TestOrgTree:
    def test_get_org_tree_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/org/tree")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["enterprise"]["enterprise_id"] == seeded_enterprise["enterprise_id"]

    def test_org_tree_has_expected_shape(self, seeded_enterprise):
        _, body = _get("/api/team/org/tree")
        for key in ("enterprise", "departments", "unassigned_members", "stats"):
            assert key in body, f"Missing {key}: {body}"
        root = body["departments"][0]
        for key in ("department_id", "name", "visibility_scope", "members", "children"):
            assert key in root, f"Missing {key}: {root}"
        member = root["members"][0]
        for key in ("assignment_id", "employee_id", "department_id", "position_title", "visibility_scope", "presence"):
            assert key in member, f"Missing {key}: {member}"

    def test_org_tree_includes_unassigned_employees(self, seeded_enterprise):
        _, body = _get("/api/team/org/tree")
        unassigned_ids = {item["employee_id"] for item in body["unassigned_members"]}
        assert "emp_member" in unassigned_ids
        assert body["stats"]["unassigned_employee_count"] >= 1


class TestOrgAssignments:
    def test_patch_org_assignment_updates_department_and_position(self, seeded_enterprise):
        assignment_id = seeded_enterprise["employee_id"]
        status, resp = _patch(
            f"/api/team/org/assignments/{assignment_id}",
            {"department_id": "dept_content", "position_title": "内容策划", "visibility_scope": "private"},
        )
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["department_id"] == "dept_content"
        assert resp["position_title"] == "内容策划"
        assert resp["visibility_scope"] == "private"

        _, tree = _get("/api/team/org/tree")
        content_group = tree["departments"][0]["children"][0]
        moved_ids = {member["employee_id"] for member in content_group["members"]}
        assert assignment_id in moved_ids

    def test_patch_org_assignment_allows_unassigned(self, seeded_enterprise):
        assignment_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/org/assignments/{assignment_id}", {"department_id": None})
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["department_id"] is None
        assert resp["department"] is None

    def test_patch_org_assignment_rejects_missing_department(self, seeded_enterprise):
        assignment_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/org/assignments/{assignment_id}", {"department_id": "dept_missing"})
        assert status == 404
        assert resp.get("error") == "DEPARTMENT_NOT_FOUND"

    def test_patch_org_assignment_rejects_invalid_field(self, seeded_enterprise):
        assignment_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/org/assignments/{assignment_id}", {"role_name": "x"})
        assert status == 400
        assert resp.get("error") == "INVALID_FIELD"
class TestSettingsAndBillingB08B09:
    def test_get_settings_returns_enterprise_and_policy_shape(self, seeded_enterprise):
        status, body = _get("/api/team/settings")
        assert status == 200, body
        assert body["enterprise_id"] == seeded_enterprise["enterprise_id"]
        assert body["name"] == "Test Corp"
        assert "invite_code" in body
        assert isinstance(body["notification_policy"], dict)
        assert isinstance(body["admin_invites"], list)

    def test_patch_settings_updates_enterprise_and_notification_policy(self, seeded_enterprise):
        status, body = _patch(
            "/api/team/settings",
            {
                "name": "Updated Corp",
                "contact_phone": "13800138000",
                "notification_policy": {"employee_task_completed": False, "system_announcements": True},
                "low_balance_threshold_cents": 8800,
            },
        )
        assert status == 200, body
        assert body["name"] == "Updated Corp"
        assert body["contact_phone"] == "13800138000"
        assert body["notification_policy"]["employee_task_completed"] is False
        assert body["low_balance_threshold_cents"] == 8800

    def test_post_admin_invite_is_created_and_idempotent(self, seeded_enterprise):
        payload = {
            "phone": "13900001111",
            "role": "enterprise_admin",
            "permissions": {"employees": "write"},
            "idempotency_key": "invite-001",
        }
        status, body = _post("/api/team/settings/admin-invites", payload)
        assert status == 201, body
        assert body["status"] == "pending"
        assert body["phone"] == payload["phone"]

        repeat_status, repeat_body = _post("/api/team/settings/admin-invites", payload)
        assert repeat_status == 200, repeat_body
        assert repeat_body["invite_id"] == body["invite_id"]

        settings_status, settings_body = _get("/api/team/settings")
        assert settings_status == 200, settings_body
        assert any(item["invite_id"] == body["invite_id"] for item in settings_body["admin_invites"])

    def test_get_balance_defaults_to_zero_and_low_balance_warning(self, seeded_enterprise):
        status, body = _get("/api/team/billing/balance")
        assert status == 200, body
        assert body["balance"] == "0.00"
        assert body["balance_cents"] == 0
        assert body["low_balance_warning"] is True

    def test_mock_recharge_updates_balance_and_recharge_history(self, seeded_enterprise):
        recharge_status, recharge_body = _post(
            "/api/team/billing/recharges",
            {"amount": 100, "payment_method": "mock_pay", "idempotency_key": "recharge-001"},
        )
        assert recharge_status == 201, recharge_body
        assert recharge_body["status"] == "succeeded"
        assert recharge_body["mock_provider"] is True
        assert recharge_body["token_credited"] > 0

        balance_status, balance_body = _get("/api/team/billing/balance")
        assert balance_status == 200, balance_body
        assert balance_body["balance_cents"] == 10000
        assert balance_body["token_balance"] == recharge_body["token_credited"]
        assert balance_body["low_balance_warning"] is False

        list_status, list_body = _get("/api/team/billing/recharges")
        assert list_status == 200, list_body
        assert list_body["total"] == 1
        assert list_body["items"][0]["recharge_id"] == recharge_body["recharge_id"]

    def test_run_creation_returns_402_when_initialized_balance_is_empty(self, seeded_enterprise):
        balance_status, _ = _get("/api/team/billing/balance")
        assert balance_status == 200
        status, body = _post(
            "/api/team/runs",
            {
                "employee_id": seeded_enterprise["employee_id"],
                "conversation_id": seeded_enterprise["conversation_id"],
                "message": {"text": "Need help reviewing the empty balance case"},
                "idempotency_key": "run-insufficient-001",
            },
        )
        assert status == 402, body
        assert body["error"] == "INSUFFICIENT_BALANCE"
        assert body["recharge_required"] is True

    def test_run_creation_succeeds_after_mock_recharge(self, seeded_enterprise):
        _post(
            "/api/team/billing/recharges",
            {"amount": 50, "payment_method": "mock_pay", "idempotency_key": "recharge-run-001"},
        )
        status, body = _post(
            "/api/team/runs",
            {
                "employee_id": seeded_enterprise["employee_id"],
                "conversation_id": seeded_enterprise["conversation_id"],
                "message": {"text": "Need help after the recharge clears"},
                "idempotency_key": "run-funded-001",
            },
        )
        assert status == 201, body
        assert body["status"] == "queued"
        assert body["run_id"].startswith("run_")


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


# ═══════════════════════════════════════════════════════════════════════════
# Batch C shared integration coverage
# ═══════════════════════════════════════════════════════════════════════════

class TestSolutionsList:
    def test_get_solutions_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/solutions")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert "solutions" in body
        assert isinstance(body["solutions"], list)
        assert "total" in body

    def test_solutions_list_reflects_apply_records_and_template_stats(self, seeded_enterprise):
        payload = {
            "mode": "append",
            "department_id": "dept_marketing",
            "idempotency_key": "solution-list-truth-001",
        }
        status, apply_body = _post(f"/api/team/solutions/{seeded_enterprise['solution_id']}/apply", payload)
        assert status == 201, apply_body

        status, body = _get("/api/team/solutions")
        assert status == 200, body
        solution = next(item for item in body["solutions"] if item["solution_id"] == seeded_enterprise["solution_id"])
        assert solution["template_ids"] == [seeded_enterprise["template_id"]]
        assert solution["template_count"] == 1
        assert solution["apply_count"] == 1
        assert solution["active_employee_count"] == 1
        assert solution["last_apply_record_id"] == apply_body["apply_record_id"]
        assert solution["last_apply_status"] == "succeeded"
        assert solution["created_employee_ids"] == apply_body["created_employee_ids"]
        assert solution["created_knowledge_base_ids"] == apply_body["created_knowledge_base_ids"]
        assert solution["solution_stats"]["apply_count"] == 1
        assert solution["solution_stats"]["active_employee_count"] == 1
        assert solution["solution_stats"]["template_count"] == 1


class TestConnectorsIntegration:
    def test_get_connectors_returns_both_lists(self, seeded_enterprise):
        status, body = _get("/api/team/connectors")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert "connectors" in body
        assert "definitions" in body
        assert isinstance(body["connectors"], list)
        assert isinstance(body["definitions"], list)

    def test_post_connector_returns_201(self, seeded_enterprise):
        status, resp = _post(
            "/api/team/connectors",
            {"name": "Test Slack", "provider_code": "slack", "type": "oauth_connector"},
        )
        assert status == 201, f"Expected 201, got {status}: {resp}"
        assert "connector_id" in resp
        assert resp["status"] == "draft"

    def test_connector_test_missing_connector_returns_404(self, seeded_enterprise):
        status, resp = _post("/api/team/connectors/nonexistent/test", {})
        assert status == 404, f"Expected 404, got {status}: {resp}"
        assert resp.get("error") == "CONNECTOR_NOT_FOUND"

    def test_connector_grants_shape_returns_200(self, seeded_enterprise):
        _, create_resp = _post(
            "/api/team/connectors",
            {"name": "Grant Test", "provider_code": "test"},
        )
        connector_id = create_resp["connector_id"]
        status, resp = _patch(
            f"/api/team/connectors/{connector_id}/grants",
            {"grant": [], "revoke": []},
        )
        assert status == 200, f"Expected 200, got {status}: {resp}"
        for key in ("granted", "revoked", "errors"):
            assert key in resp, f"Missing {key}: {resp}"

    def test_connectors_list_reflects_config_credentials_grants_and_test_state(self, seeded_enterprise, db_conn):
        status, create_resp = _post(
            "/api/team/connectors",
            {
                "name": "Refresh Truth",
                "provider_code": "slack",
                "type": "oauth_connector",
                "credential_ref": "cred://vault/slack/ent_test",
                "config": {"tenant_hint": "acme", "bot_secret": "should-mask-in-ui-only"},
            },
        )
        assert status == 201, create_resp
        connector_id = create_resp["connector_id"]

        cur = db_conn.cursor()
        try:
            cur.execute(
                "UPDATE enterprise_connector SET status='online', last_validated_at=now() WHERE id=%s",
                (connector_id,),
            )
            db_conn.commit()
        finally:
            cur.close()

        grant_status, grant_resp = _patch(
            f"/api/team/connectors/{connector_id}/grants",
            {"grant": [{"employee_ids": ["emp_member", "emp_test"], "access_mode": "invoke"}], "revoke": []},
        )
        assert grant_status == 200, grant_resp

        status, body = _get("/api/team/connectors")
        assert status == 200, body
        connector = next(item for item in body["connectors"] if item["connector_id"] == connector_id)
        assert connector["credential_ref"] == "cred://vault/slack/ent_test"
        assert connector["config"] == {"tenant_hint": "acme", "bot_secret": "should-mask-in-ui-only"}
        assert connector["status"] == "online"
        assert connector["health_status"] == "online"
        assert connector["last_test_at"]
        assert connector["grants"] == ["emp_member", "emp_test"]
        assert connector["granted_employee_ids"] == ["emp_member", "emp_test"]
        assert connector["employee_grants"] == [
            {"employee_id": "emp_member", "access_mode": "invoke", "enabled": True},
            {"employee_id": "emp_test", "access_mode": "invoke", "enabled": True},
        ]


class TestEmployeePatchExpanded:
    def test_patch_model_provider_accepted(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"model_provider": "openai"})
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_patch_model_name_accepted(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"model_name": "gpt-4o"})
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_patch_prompt_version_accepted(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"prompt_version": 3})
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_patch_capabilities_json_accepted(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"capabilities_json": '{"web": true}'})
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_patch_unknown_field_still_rejected(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"random_field": "nope"})
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "INVALID_FIELD"


class TestBatchCReworkPersistence:
    def test_employee_detail_preserves_truthful_prompt_and_memory_config(self, seeded_enterprise, db_conn):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO employee_memory_binding (id, enterprise_id, employee_id, memory_mode, provider_code, retention_days, writeback_enabled, binding_version) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                ("mem_emp_test", seeded_enterprise["enterprise_id"], seeded_enterprise["employee_id"], "builtin", "mem0", 30, True, 2),
            )
            cur.execute(
                "INSERT INTO employee_prompt (employee_id, system_prompt, behavior_rules_json, opening_message, version_no, source_template_version) VALUES (%s, %s, %s::jsonb, %s, %s, %s)",
                (seeded_enterprise["employee_id"], "Stay truthful", '{"tone": "direct"}', "Ready to help", 4, 1),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _get(f"/api/team/employees/{seeded_enterprise['employee_id']}?role=owner")
        assert status == 200, body
        assert body["profile_config"]["memory_config"] == {
            "mode": "builtin",
            "provider_code": "mem0",
            "retention_days": 30,
            "writeback_enabled": True,
        }
        assert body["prompt_config"] == {
            "system_prompt": "Stay truthful",
            "behavior_rules_json": '{"tone": "direct"}',
            "opening_message": "Ready to help",
            "version_no": 4,
        }

    def test_patch_skills_add_persists(self, seeded_enterprise):
        # ensure skill is installed so authorization passes
        _post('/api/team/skills/installs', {
            'skill_code': 'forecasting',
            'scope_mode': 'all_employees',
        })
        emp_id = seeded_enterprise["employee_id"]
        status, _ = _patch(
            f"/api/team/employees/{emp_id}?role=owner",
            {"skills_add": ["forecasting"]},
        )
        assert status == 200
        detail_status, detail_body = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert detail_status == 200
        assert "forecasting" in detail_body["profile_config"]["skills"], detail_body

    def test_connector_grants_accept_employee_ids_array(self, seeded_enterprise, db_conn):
        _, create_resp = _post("/api/team/connectors", {
            "name": "Bulk Grant Test",
            "provider_code": "test",
        })
        connector_id = create_resp["connector_id"]
        cur = db_conn.cursor()
        try:
            cur.execute(
                "UPDATE enterprise_connector SET status='online' WHERE id=%s",
                (connector_id,),
            )
            db_conn.commit()
        finally:
            cur.close()
        status, resp = _patch(
            f"/api/team/connectors/{connector_id}/grants",
            {"grant": [{"employee_ids": ["emp_test", "emp_member"], "access_mode": "invoke"}], "revoke": []},
        )
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert len(resp["granted"]) == 2, resp
