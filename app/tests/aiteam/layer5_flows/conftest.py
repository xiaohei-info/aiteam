"""Layer5 flow fixtures for end-to-end business stitching tests."""

import pytest

from team_panel.integration.event_ingest_service import ingest_timeline_event
from team_panel.transactions.uow import UnitOfWork

from tests.aiteam.layer0_contracts.test_host_routing import _post


@pytest.fixture
def seeded_private_chat(seeded_enterprise, db_conn):
    body = {
        "employee_id": seeded_enterprise["employee_id"],
        "conversation_id": seeded_enterprise["conversation_id"],
        "message_text": "请基于企业知识库总结入职流程。",
        "idempotency_key": "idem_l5_seeded_private_chat",
    }
    status, response = _post("/api/team/runs", body)
    assert status == 201, response

    run_id = response["run_id"]
    enterprise_id = seeded_enterprise["enterprise_id"]

    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_private_1",
                "enterprise_id": enterprise_id,
                "run_id": run_id,
                "cursor_no": 1,
                "event_type": "message_delta",
                "source_type": "session",
                "source_id": "sess_l5_private",
                "employee_id": seeded_enterprise["employee_id"],
                "preview_text": "需要先查知识库。",
                "payload_json": {"delta": "需要先查知识库。", "kind": "reasoning"},
            },
        )
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_private_2",
                "enterprise_id": enterprise_id,
                "run_id": run_id,
                "cursor_no": 2,
                "event_type": "tool_call",
                "source_type": "session",
                "source_id": "sess_l5_private",
                "employee_id": seeded_enterprise["employee_id"],
                "preview_text": "调用工具 knowledge_search",
                "payload_json": {
                    "tool": "knowledge_search",
                    "args": {"query": "入职流程"},
                    "tid": "tool_l5_private",
                    "done": False,
                },
            },
        )
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_private_3",
                "enterprise_id": enterprise_id,
                "run_id": run_id,
                "cursor_no": 3,
                "event_type": "tool_call",
                "source_type": "session",
                "source_id": "sess_l5_private",
                "employee_id": seeded_enterprise["employee_id"],
                "preview_text": "工具 knowledge_search 完成",
                "payload_json": {
                    "tool": "knowledge_search",
                    "args": {"query": "入职流程"},
                    "tid": "tool_l5_private",
                    "done": True,
                    "result_snippet": "入职流程包含账号激活、制度学习。",
                    "is_error": False,
                },
            },
        )
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_private_4",
                "enterprise_id": enterprise_id,
                "run_id": run_id,
                "cursor_no": 4,
                "event_type": "message_delta",
                "source_type": "session",
                "source_id": "sess_l5_private",
                "employee_id": seeded_enterprise["employee_id"],
                "preview_text": "正在检索企业知识库中的入职说明…",
                "payload_json": {"delta": "正在检索企业知识库中的入职说明…"},
            },
        )
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_private_5",
                "enterprise_id": enterprise_id,
                "run_id": run_id,
                "cursor_no": 5,
                "event_type": "run_succeeded",
                "source_type": "session",
                "source_id": "sess_l5_private",
                "employee_id": seeded_enterprise["employee_id"],
                "preview_text": "已根据企业知识库整理出入职流程。",
                "payload_json": {
                    "summary": "已根据企业知识库整理出入职流程。",
                    "usage": {"total_tokens": 128},
                    "citations": [
                        {
                            "title": "入职手册",
                            "source_type": "knowledge_document",
                            "snippet": "第一天请先完成账号激活与制度学习。",
                        }
                    ],
                },
            },
        )

    return {
        **seeded_enterprise,
        "run_id": run_id,
    }
