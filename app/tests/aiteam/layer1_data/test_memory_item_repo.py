from __future__ import annotations

import json

from team_panel.domain.entities import MemoryItem, MemoryReviewDecision
from team_panel.repositories.memory_item_repo import MemoryItemRepo, MemoryReviewDecisionRepo


def _seed_enterprise_and_employee(db_conn):
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO enterprise (id, slug, name, status, owner_user_id) VALUES (%s, %s, %s, %s, %s)",
            ("ent_mem", "ent-mem", "Memory Corp", "active", "usr_mem"),
        )
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, template_id, profile_name, display_name, role_name, status, created_from) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            ("emp_mem", "ent_mem", None, "emp-mem", "Memory Employee", "Support", "active", "manual"),
        )
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, template_id, profile_name, display_name, role_name, status, created_from) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            ("emp_mem_2", "ent_mem", None, "emp-mem-2", "Memory Employee 2", "Support", "active", "manual"),
        )
        db_conn.commit()
    finally:
        cur.close()


def test_memory_item_repo_crud_and_review_filtering(db_conn, clean_tables):
    _seed_enterprise_and_employee(db_conn)
    cur = db_conn.cursor()
    repo = MemoryItemRepo(cur)
    review_repo = MemoryReviewDecisionRepo(cur)

    item = MemoryItem(
        id="mem_repo_1",
        enterprise_id="ent_mem",
        employee_id="emp_mem",
        content="Customer prefers markdown summaries",
        category="preference",
        importance=4,
        source_type="extraction",
        tags_json='["vip", "reporting"]',
        visibility_scope="enterprise",
        runtime_ref_json='{"source_kind":"run_event","run_id":"run_001"}',
    )
    admin_only = MemoryItem(
        id="mem_repo_2",
        enterprise_id="ent_mem",
        employee_id="emp_mem_2",
        content="Admin only note",
        category="decision",
        importance=2,
        source_type="manual",
        tags_json='["sensitive"]',
        visibility_scope="admin_only",
        runtime_ref_json='{}',
    )
    repo.create(item)
    repo.create(admin_only)
    db_conn.commit()

    loaded = repo.get_by_id("mem_repo_1")
    assert loaded is not None
    assert loaded.category == "preference"
    assert loaded.visibility_scope == "enterprise"
    assert json.loads(loaded.runtime_ref_json) == {"source_kind": "run_event", "run_id": "run_001"}

    items = repo.list_by_enterprise("ent_mem", employee_id="emp_mem", search_query="markdown", tag="vip")
    assert [entry.id for entry in items] == ["mem_repo_1"]
    assert repo.count_by_enterprise("ent_mem", visibility_scope="admin_only") == 1

    review_repo.create(
        MemoryReviewDecision(
            id="mrd_repo_1",
            enterprise_id="ent_mem",
            memory_item_id="mem_repo_1",
            reviewer_user_id="usr_reviewer",
            decision="corrected",
            corrected_content="Customer prefers concise markdown summaries",
        )
    )
    db_conn.commit()

    latest = review_repo.get_latest_by_memory_id("mem_repo_1")
    assert latest is not None
    assert latest.decision == "corrected"
    assert latest.corrected_content == "Customer prefers concise markdown summaries"

    loaded.content = latest.corrected_content
    loaded.importance = 5
    loaded.tags_json = '["vip", "updated"]'
    loaded.updated_by = "usr_reviewer"
    repo.update(loaded)
    db_conn.commit()

    updated = repo.get_by_id("mem_repo_1")
    assert updated is not None
    assert updated.content == "Customer prefers concise markdown summaries"
    assert updated.importance == 5
    assert updated.tags_json == '["vip", "updated"]'

    review_repo.create(
        MemoryReviewDecision(
            id="mrd_repo_2",
            enterprise_id="ent_mem",
            memory_item_id="mem_repo_1",
            reviewer_user_id="usr_reviewer",
            decision="rejected",
        )
    )
    db_conn.commit()

    assert repo.list_by_enterprise("ent_mem", employee_id="emp_mem") == []
    assert [entry.id for entry in repo.list_by_enterprise("ent_mem", review_status="rejected")] == ["mem_repo_1"]

    repo.bulk_delete(["mem_repo_2"], enterprise_id="ent_mem", employee_id="emp_mem_2")
    repo.delete("mem_repo_1")
    db_conn.commit()
    assert repo.get_by_id("mem_repo_1") is None
    assert repo.get_by_id("mem_repo_2") is None
    cur.close()
