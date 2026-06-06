"""Canonical B07 shared memory regression tests."""
from __future__ import annotations

import json

from team_panel.domain.entities import AuditEvent, MemoryItem, MemoryReviewDecision
from team_panel.transactions.uow import UnitOfWork


def test_memory_items_use_canonical_contract_fields(db_conn, seeded_enterprise):
    item = MemoryItem(
        id="mem_shared_1",
        enterprise_id="ent_test",
        employee_id="emp_test",
        source_type="extraction",
        content="客户偏好每周一上午收到简明周报",
        category="preference",
        importance=5,
        tags_json='["vip","reporting"]',
        visibility_scope="enterprise",
        runtime_ref_json=json.dumps({"source_kind": "run_event", "run_id": "run_001"}, ensure_ascii=False),
    )
    with UnitOfWork(db_conn) as uow:
        uow.memory_items().create(item)

    with UnitOfWork(db_conn) as uow:
        reloaded = uow.memory_items().get_by_id(item.id)
        assert reloaded is not None
        assert reloaded.category == "preference"
        assert reloaded.importance == 5
        assert reloaded.source_type == "extraction"
        assert reloaded.visibility_scope == "enterprise"
        assert json.loads(reloaded.runtime_ref_json)["run_id"] == "run_001"


def test_latest_review_decision_is_the_projection_source(db_conn, seeded_enterprise):
    item = MemoryItem(
        id="mem_shared_2",
        enterprise_id="ent_test",
        employee_id="emp_test",
        source_type="extraction",
        content="原始自动提取内容",
        category="event",
        importance=3,
        tags_json='["pending"]',
    )
    with UnitOfWork(db_conn) as uow:
        uow.memory_items().create(item)
        uow.memory_review_decisions().create(
            MemoryReviewDecision(
                id="mrd_shared_1",
                enterprise_id="ent_test",
                memory_item_id=item.id,
                reviewer_user_id="usr_admin",
                decision="pending",
            )
        )
        uow.memory_review_decisions().create(
            MemoryReviewDecision(
                id="mrd_shared_2",
                enterprise_id="ent_test",
                memory_item_id=item.id,
                reviewer_user_id="usr_admin",
                decision="corrected",
                corrected_content="修正后的最终内容",
            )
        )

    with UnitOfWork(db_conn) as uow:
        latest = uow.memory_review_decisions().get_latest_by_memory_id(item.id)
        assert latest is not None
        assert latest.decision == "corrected"
        assert latest.corrected_content == "修正后的最终内容"
        reloaded = uow.memory_items().get_by_id(item.id)
        assert reloaded is not None
        reloaded.content = latest.corrected_content
        reloaded.updated_by = "usr_admin"
        uow.memory_items().update(reloaded)

    with UnitOfWork(db_conn) as uow:
        reloaded = uow.memory_items().get_by_id(item.id)
        assert reloaded is not None
        assert reloaded.content == "修正后的最终内容"


def test_default_search_excludes_rejected_but_keeps_pending(db_conn, seeded_enterprise):
    approved = MemoryItem(
        id="mem_shared_3",
        enterprise_id="ent_test",
        employee_id="emp_test",
        source_type="manual",
        content="人工新增偏好",
        category="preference",
        importance=4,
    )
    rejected = MemoryItem(
        id="mem_shared_4",
        enterprise_id="ent_test",
        employee_id="emp_test",
        source_type="extraction",
        content="应被拒绝的自动提取内容",
        category="event",
        importance=2,
    )
    pending = MemoryItem(
        id="mem_shared_5",
        enterprise_id="ent_test",
        employee_id="emp_test",
        source_type="extraction",
        content="仍应可见的待审核内容",
        category="event",
        importance=3,
    )
    with UnitOfWork(db_conn) as uow:
        uow.memory_items().create(approved)
        uow.memory_items().create(rejected)
        uow.memory_items().create(pending)
        uow.memory_review_decisions().create(
            MemoryReviewDecision(
                id="mrd_shared_3",
                enterprise_id="ent_test",
                memory_item_id=rejected.id,
                reviewer_user_id="usr_admin",
                decision="rejected",
            )
        )

    with UnitOfWork(db_conn) as uow:
        visible_ids = [item.id for item in uow.memory_items().list_by_enterprise("ent_test", employee_id="emp_test")]
        assert approved.id in visible_ids
        assert pending.id in visible_ids
        assert rejected.id not in visible_ids


def test_extraction_failure_uses_audit_event_not_partial_memory_rows(db_conn, seeded_enterprise):
    with UnitOfWork(db_conn) as uow:
        uow.audit_events().create(
            AuditEvent(
                id="audit_memory_failure",
                enterprise_id="ent_test",
                actor_type="system",
                actor_id="hermes_gateway",
                event_type="memory.extraction_failed",
                target_type="memory",
                target_id="emp_test",
                payload_json=json.dumps(
                    {
                        "employee_id": "emp_test",
                        "run_id": "run_fail_001",
                        "error_code": "WRITEBACK_TIMEOUT",
                        "error_message": "Hermes memory writeback timeout",
                    },
                    ensure_ascii=False,
                ),
                created_by="system",
            )
        )

    with UnitOfWork(db_conn) as uow:
        audits = uow.audit_events().list_by_target("memory", "emp_test")
        failures = [event for event in audits if event.event_type == "memory.extraction_failed"]
        assert len(failures) == 1
        payload = json.loads(failures[0].payload_json)
        assert payload["error_code"] == "WRITEBACK_TIMEOUT"
        assert uow.memory_items().list_by_enterprise("ent_test", employee_id="emp_test") == []
