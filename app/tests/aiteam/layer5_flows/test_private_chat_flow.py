"""Layer5 private-chat business flow tests.

Covers the first flow slice from the Layer5 stitching plan:
- seeded enterprise/employees can start a private-chat run through the Team API
- timeline events can be consumed by run-events API and conversation detail display_state
- an employee knowledge binding does not break the chat run path
"""

from team_panel.domain.entities import EmployeeKnowledgeBinding
from team_panel.transactions.uow import UnitOfWork

from tests.aiteam.layer0_contracts.test_host_routing import _get, _post


def test_recruit_then_private_chat_run(seeded_enterprise, db_conn):
    status, workbench = _get("/api/team/workbench")
    assert status == 200, workbench
    assert workbench["enterprise"]["enterprise_id"] == seeded_enterprise["enterprise_id"]

    status, employees = _get("/api/team/employees")
    assert status == 200, employees
    assert employees["total"] >= 3
    employee_ids = {item["employee_id"] for item in employees["employees"]}
    assert {"emp_test", "emp_member", "emp_planner"}.issubset(employee_ids)

    status, body = _post(
        "/api/team/runs",
        {
            "employee_id": seeded_enterprise["employee_id"],
            "conversation_id": seeded_enterprise["conversation_id"],
            "message_text": "请基于企业知识库总结入职流程。",
            "idempotency_key": "idem_l5_private_chat_run",
        },
    )
    assert status == 201, body
    assert body["run_id"].startswith("run_")
    assert body["status"] == "queued"
    assert body["conversation_id"] == seeded_enterprise["conversation_id"]
    assert body["stream_url"].endswith("?cursor=0")
    assert body["events_url"].endswith("?cursor=0")
    assert body["runtime_handle"]["kind"] == "session"
    assert body["runtime_handle"]["profile_name"] == seeded_enterprise["employee_id"]
    assert body["runtime_handle"]["session_id"].startswith("sess_")

    with UnitOfWork(db_conn) as uow:
        binding = uow.runtime_bindings().get_by_owner("team_run", body["run_id"])
        assert binding is not None
        assert binding.runtime_kind == "session"
        assert binding.profile_name == seeded_enterprise["employee_id"]
        assert binding.runtime_session_id == body["runtime_handle"]["session_id"]


def test_timeline_events_consumable_by_conversation_view(seeded_private_chat):
    run_id = seeded_private_chat["run_id"]
    conv_id = seeded_private_chat["conversation_id"]

    status, events = _get(f"/api/team/runs/{run_id}/events?cursor=0")
    assert status == 200, events
    assert [item["event_type"] for item in events["items"]] == ["message_delta", "run_succeeded"]
    assert events["next_cursor"] == 2
    assert events["run_status"] == "succeeded"

    status, conv = _get(f"/api/team/conversations/{conv_id}")
    assert status == 200, conv
    assert conv["conversation_id"] == conv_id
    assert conv["status"] == "active"
    assert conv["display_state"] == "resolved"
    assert conv["latest_run"]["run_id"] == run_id
    assert conv["latest_run"]["status"] == "succeeded"
    assert conv["last_message_preview"]["event_cursor"] == 2
    assert conv["last_message_preview"]["preview"] == "已根据企业知识库整理出入职流程。"


def test_knowledge_binding_does_not_break_chat(seeded_enterprise, db_conn):
    with UnitOfWork(db_conn) as uow:
        uow.employee_knowledge_bindings().create(
            EmployeeKnowledgeBinding(
                id="kb_bind_l5_private_chat",
                enterprise_id=seeded_enterprise["enterprise_id"],
                employee_id=seeded_enterprise["employee_id"],
                knowledge_base_id="kb_onboarding_docs",
            )
        )

    status, body = _post(
        "/api/team/runs",
        {
            "employee_id": seeded_enterprise["employee_id"],
            "conversation_id": seeded_enterprise["conversation_id"],
            "message_text": "企业知识库里怎么写入职流程？",
            "idempotency_key": "idem_l5_knowledge_binding",
        },
    )
    assert status == 201, body
    assert body["status"] == "queued"
    assert body["run_id"].startswith("run_")
    assert body.get("error") is None
