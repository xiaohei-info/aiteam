"""L5 flow tests for group-conversation message submission."""

from __future__ import annotations

import json
from urllib.parse import urlparse

try:
    from tests.aiteam.layer0_contracts.test_host_routing import _get, _post
except ImportError:
    class _FakeHandler:
        def __init__(self):
            self.status: int | None = None
            self.sent_headers: list[tuple[str, str]] = []
            self.body = bytearray()
            self.wfile = self
            self.rfile: object | None = None
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

    def _post(parsed_path: str, body: dict | None = None) -> tuple[int, dict]:
        from api.routes import handle_post

        handler = _FakeHandler()
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            handler.headers["Content-Length"] = str(len(raw))
            handler.rfile = type("_BytesIO", (), {"read": lambda n: raw})()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_post(handler, parsed)
        assert handler.status is not None
        return handler.status, handler.get_json()

    def _get(parsed_path: str) -> tuple[int, dict]:
        from api.routes import handle_get

        handler = _FakeHandler()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_get(handler, parsed)
        assert handler.status is not None
        return handler.status, handler.get_json()

from team_panel.application.commands.conversation_service import create_group_conversation
from team_panel.domain.entities import Employee
from team_panel.domain.enums import EmployeeStatus


def test_group_message_flow_single_agent(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow,
            "ent_test",
            "L5 Single-Agent Group",
            ["emp_test", "emp_member"],
            "user_test",
        )

    status, body = _post(
        f"/api/team/group-conversations/{conv_id}/messages",
        {
            "message": {"text": "Please answer this directly", "attachments": []},
            "route_hint": "single_agent",
            "idempotency_key": "l5-single-agent-001",
            "sender_id": "emp_test",
        },
    )

    assert status == 201, body
    assert body["message_id"].startswith("msg_")
    assert body["run_id"].startswith("run_")
    assert body["route_decision"]["route_mode"] == "single_agent"
    assert body["stream_url"].endswith("cursor=0")
    assert body["events_url"].endswith("cursor=0")
    assert body["runtime_handle"]["kind"] == "session"
    assert body["runtime_handle"]["session_id"] is not None
    assert body["runtime_handle"]["task_id"] is None

    with uow:
        run = uow.team_runs().get_by_id(body["run_id"])
        binding = uow.runtime_bindings().get_by_owner("team_run", body["run_id"])
        assert run is not None
        assert run.execution_mode == "single_agent"
        assert binding is not None
        assert binding.runtime_kind == "session"
        assert binding.runtime_session_id is not None
        assert binding.runtime_task_id is None


def test_group_message_flow_orchestration(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow,
            "ent_test",
            "L5 Orchestration Group",
            ["emp_test", "emp_member", "emp_planner"],
            "user_test",
        )

    status, body = _post(
        f"/api/team/group-conversations/{conv_id}/messages",
        {
            "message": {"text": "emp_test emp_member please collaborate", "attachments": []},
            "route_hint": "orchestration",
            "idempotency_key": "l5-orchestration-001",
            "sender_id": "emp_test",
        },
    )

    assert status == 201, body
    assert body["message_id"].startswith("msg_")
    assert body["route_decision"]["route_mode"] == "orchestration"
    assert set(body["route_decision"]["target_employee_ids"]) == {"emp_member", "emp_planner", "emp_test"}
    assert body["runtime_handle"]["kind"] == "kanban_task"
    assert body["runtime_handle"]["session_id"] is None
    assert body["runtime_handle"]["task_id"] is not None

    with uow:
        run = uow.team_runs().get_by_id(body["run_id"])
        binding = uow.runtime_bindings().get_by_owner("team_run", body["run_id"])
        assert run is not None
        assert run.execution_mode == "kanban_orchestration"
        assert binding is not None
        assert binding.runtime_kind == "kanban_task"
        assert binding.runtime_task_id is not None
        assert binding.runtime_session_id is None

    detail_status, detail = _get(f"/api/team/group-conversations/{conv_id}")
    assert detail_status == 200, detail
    assert detail["conversation_id"] == conv_id
    assert detail["latest_run"]["run_id"] == body["run_id"]
    assert detail["latest_route_decision"]["route_mode"] == "orchestration"
    assert sorted(detail["latest_route_decision"]["candidate_employee_ids"]) == ["emp_member", "emp_planner", "emp_test"]
    assert detail["task_tree"]["items"] == []


def test_group_message_flow_idempotency_preserves_first_result(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow,
            "ent_test",
            "L5 Idempotent Group",
            ["emp_test", "emp_member"],
            "user_test",
        )

    payload = {
        "message": {"text": "First delivery", "attachments": []},
        "route_hint": "single_agent",
        "idempotency_key": "l5-idem-001",
        "sender_id": "emp_test",
    }
    status1, body1 = _post(f"/api/team/group-conversations/{conv_id}/messages", payload)
    status2, body2 = _post(
        f"/api/team/group-conversations/{conv_id}/messages",
        {
            **payload,
            "message": {"text": "Second delivery should reuse first run", "attachments": []},
            "route_hint": "orchestration",
        },
    )

    assert status1 == 201, body1
    assert status2 == 201, body2
    assert body2["message_id"] == body1["message_id"]
    assert body2["run_id"] == body1["run_id"]
    assert body2["route_decision"] == body1["route_decision"]
    assert body2["runtime_handle"] == body1["runtime_handle"]

    with uow:
        uow.cur.execute(
            "SELECT COUNT(*) FROM conversation_message WHERE run_id = %s",
            (body1["run_id"],),
        )
        assert uow.cur.fetchone()[0] == 1


def test_group_message_flow_caps_orchestration_candidates_at_three(uow, clean_tables_with_enterprise):
    with uow:
        uow.employees().create(Employee(
            id="emp_4",
            enterprise_id="ent_test",
            profile_name="p-emp-4",
            display_name="Drew",
            role_name="分析师",
            status=EmployeeStatus.ACTIVE,
        ))
        conv_id = create_group_conversation(
            uow,
            "ent_test",
            "L5 Capped Group",
            ["emp_test", "emp_member", "emp_planner", "emp_4"],
            "user_test",
        )

    status, body = _post(
        f"/api/team/group-conversations/{conv_id}/messages",
        {
            "message": {"text": "请大家一起协作产出周报", "attachments": []},
            "route_hint": "orchestration",
            "idempotency_key": "l5-cap-001",
            "sender_id": "emp_test",
        },
    )

    assert status == 201, body
    assert body["route_decision"]["route_mode"] == "orchestration"
    assert len(body["route_decision"]["candidate_employee_ids"]) == 3
    assert len(body["route_decision"]["target_employee_ids"]) == 4
    assert "emp_planner" in body["route_decision"]["candidate_employee_ids"]
    assert "emp_planner" in body["route_decision"]["target_employee_ids"]

    detail_status, detail = _get(f"/api/team/group-conversations/{conv_id}")
    assert detail_status == 200, detail
    assert len(detail["latest_route_decision"]["candidate_employee_ids"]) == 3


def test_group_message_flow_accepts_actor_id_alias(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow,
            "ent_test",
            "L5 Actor Alias Group",
            ["emp_test", "emp_member"],
            "user_test",
        )

    status, body = _post(
        f"/api/team/group-conversations/{conv_id}/messages",
        {
            "message": {"text": "Alias path should still work", "attachments": []},
            "route_hint": "single_agent",
            "idempotency_key": "l5-actor-alias-001",
            "actor_id": "emp_test",
        },
    )

    assert status == 201, body
    assert body["runtime_handle"]["kind"] == "session"
    assert body["runtime_handle"]["session_id"] is not None
    assert body["runtime_handle"]["task_id"] is None


def test_group_message_flow_requires_sender_identity(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow,
            "ent_test",
            "L5 Missing Sender Group",
            ["emp_test", "emp_member"],
            "user_test",
        )

    status, body = _post(
        f"/api/team/group-conversations/{conv_id}/messages",
        {
            "message": {"text": "No sender should be rejected", "attachments": []},
            "route_hint": "single_agent",
            "idempotency_key": "l5-missing-sender-001",
        },
    )

    assert status == 400
    assert body == {
        "error": "MISSING_SENDER_ID",
        "message": "sender_id is required",
    }


def test_group_message_flow_inactive_conversation_returns_409(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow,
            "ent_test",
            "L5 Inactive Group",
            ["emp_test", "emp_member"],
            "user_test",
        )
        conv = uow.conversations().get_by_id(conv_id)
        conv.archive()
        uow.conversations().update_status(conv)

    status, body = _post(
        f"/api/team/group-conversations/{conv_id}/messages",
        {
            "message": {"text": "Archived conversation should reject", "attachments": []},
            "route_hint": "single_agent",
            "idempotency_key": "l5-inactive-001",
            "sender_id": "emp_test",
        },
    )

    assert status == 409
    assert body["error"] == "CONVERSATION_NOT_ACTIVE"
    assert "Cannot submit" in body["message"]
