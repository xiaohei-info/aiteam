"""L5 flow tests for solution apply and governance read models."""
from __future__ import annotations

import json
import uuid

from team_panel.domain.entities import TeamRun
from team_panel.transactions.uow import UnitOfWork

from tests.aiteam.layer0_contracts.test_host_routing import _get, _post


def _seed_usage_for_employee(db_conn, *, enterprise_id: str, employee_id: str) -> str:
    run_id = f"run_{uuid.uuid4().hex[:10]}"
    with UnitOfWork(db_conn) as uow:
        uow.team_runs().create(
            TeamRun(
                id=run_id,
                enterprise_id=enterprise_id,
                trigger_type="manual_run",
                execution_mode="single_agent",
                status="succeeded",
                entry_employee_id=employee_id,
                idempotency_key=f"billing-{run_id}",
                result_summary_json=None,
            )
        )
        uow.cur.execute(
            "UPDATE team_run SET result_summary_json = %s::jsonb WHERE id = %s",
            (json.dumps({"usage": {"total_tokens": 21, "cost_cents": 5}}), run_id),
        )
        uow.cur.execute(
            "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, payload_json) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)",
            (
                f"evt_{uuid.uuid4().hex[:10]}",
                enterprise_id,
                run_id,
                1,
                "usage_recorded",
                "system",
                "billing_seed",
                employee_id,
                json.dumps({"usage": {"total_tokens": 13, "cost_cents": 2}}),
            ),
        )
        uow.cur.execute("SELECT created_at::date FROM team_run WHERE id = %s", (run_id,))
        row = uow.cur.fetchone()
        assert row is not None
        run_day = str(row[0])
    return run_id


def test_solution_apply_governance_flow(db_conn, seeded_enterprise):
    payload = {
        "mode": "append",
        "department_id": "dept_retail",
        "idempotency_key": "solution-apply-001",
    }

    status, body = _post(f"/api/team/solutions/{seeded_enterprise['solution_id']}/apply", payload)
    assert status == 201, body
    assert body["status"] == "succeeded"
    assert body["apply_record_id"].startswith("sol_apply_")
    assert len(body["created_employee_ids"]) == 1

    created_employee_id = body["created_employee_ids"][0]

    with UnitOfWork(db_conn) as uow:
        employee = uow.employees().get_by_id(created_employee_id)
        assert employee is not None
        assert employee.created_from == "solution_apply"
        audits = uow.audit_events().list_by_enterprise(seeded_enterprise["enterprise_id"])
        solution_audits = [audit for audit in audits if audit.event_type == "solution.apply"]
        assert solution_audits, "solution apply should create an audit event"
        latest_audit = solution_audits[0]
        assert latest_audit.target_type == "solution"
        assert latest_audit.target_id == seeded_enterprise["solution_id"]
        assert latest_audit.request_id == f"solution_apply:{seeded_enterprise['solution_id']}:solution-apply-001"

    replay_status, replay_body = _post(f"/api/team/solutions/{seeded_enterprise['solution_id']}/apply", payload)
    assert replay_status == 200, replay_body
    assert replay_body["apply_record_id"] == body["apply_record_id"]
    assert replay_body["created_employee_ids"] == body["created_employee_ids"]

    employees_status, employees_body = _get("/api/enterprise-admin/employees")
    assert employees_status == 200, employees_body
    assert employees_body["total"] >= 1
    created_employee = next(emp for emp in employees_body["employees"] if emp["employee_id"] == created_employee_id)
    assert created_employee["status"] == "active"
    assert created_employee["created_from"] == "solution_apply"

    _seed_usage_for_employee(
        db_conn,
        enterprise_id=seeded_enterprise["enterprise_id"],
        employee_id=created_employee_id,
    )

    billing_status, billing_body = _get("/api/enterprise-admin/billing/usage")
    assert billing_status == 200, billing_body
    assert billing_body["enterprise_id"] == seeded_enterprise["enterprise_id"]
    assert billing_body["total_tokens"] == 34
    assert billing_body["total_cost_cents"] == 7
    employee_usage = next(item for item in billing_body["by_employee"] if item["employee_id"] == created_employee_id)
    assert employee_usage["tokens"] == 34
    assert employee_usage["cost_cents"] == 7

    health_status, health_body = _get("/api/system-admin/health")
    assert health_status == 200, health_body
    assert health_body["status"] in {"ok", "partial", "unavailable"}
    assert "checked_at" in health_body
    assert "cpu" in health_body
    assert "memory" in health_body
    assert "disk" in health_body


def test_solution_apply_requires_bound_solution_template(db_conn, seeded_enterprise):
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO industry_solution (id, name, status, tags_json, default_kb_blueprint_json, default_skill_bundle_json, default_collaboration_template_ref) VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s)",
            (
                "sol_unbound",
                "Unbound Solution",
                "published",
                '["retail"]',
                "{}",
                "{}",
                None,
            ),
        )
        db_conn.commit()
    finally:
        cur.close()

    status, body = _post(
        "/api/team/solutions/sol_unbound/apply",
        {
            "mode": "append",
            "department_id": "dept_retail",
            "idempotency_key": "solution-apply-unbound",
        },
    )
    assert status == 409, body
    assert body["error"] == "SOLUTION_TEMPLATE_BINDING_MISSING"


def test_solution_apply_replace_archives_previous_solution_employees(db_conn, seeded_enterprise):
    append_payload = {
        "mode": "append",
        "department_id": "dept_retail",
        "idempotency_key": f"solution-apply-append-{uuid.uuid4().hex[:6]}",
    }
    append_status, append_body = _post(
        f"/api/team/solutions/{seeded_enterprise['solution_id']}/apply",
        append_payload,
    )
    assert append_status == 201, append_body
    previous_employee_id = append_body["created_employee_ids"][0]

    replace_payload = {
        "mode": "replace",
        "department_id": "dept_retail",
        "idempotency_key": f"solution-apply-replace-{uuid.uuid4().hex[:6]}",
    }
    replace_status, replace_body = _post(
        f"/api/team/solutions/{seeded_enterprise['solution_id']}/apply",
        replace_payload,
    )
    assert replace_status == 201, replace_body
    replacement_employee_id = replace_body["created_employee_ids"][0]
    assert replacement_employee_id != previous_employee_id
    assert replace_body["mode"] == "replace"

    with UnitOfWork(db_conn) as uow:
        previous_employee = uow.employees().get_by_id(previous_employee_id)
        replacement_employee = uow.employees().get_by_id(replacement_employee_id)
        previous_bindings = uow.employee_knowledge_bindings().list_by_employee(previous_employee_id)
        replacement_bindings = uow.employee_knowledge_bindings().list_by_employee(replacement_employee_id)
        apply_records = uow.solution_apply_records().list_by_solution(seeded_enterprise["solution_id"])

        assert previous_employee is not None
        assert previous_employee.status == "archived"
        assert replacement_employee is not None
        assert replacement_employee.status == "active"
        assert previous_bindings == []
        assert len(replacement_bindings) == 1
        latest_record = next(record for record in apply_records if record.id == replace_body["apply_record_id"])
        assert latest_record.mode == "replace"


def test_solution_apply_reapply_keeps_previous_solution_employees_and_adds_new_batch(db_conn, seeded_enterprise):
    append_payload = {
        "mode": "append",
        "department_id": "dept_retail",
        "idempotency_key": f"solution-apply-append-{uuid.uuid4().hex[:6]}",
    }
    append_status, append_body = _post(
        f"/api/team/solutions/{seeded_enterprise['solution_id']}/apply",
        append_payload,
    )
    assert append_status == 201, append_body
    previous_employee_id = append_body["created_employee_ids"][0]

    reapply_payload = {
        "mode": "reapply",
        "department_id": "dept_retail",
        "idempotency_key": f"solution-apply-reapply-{uuid.uuid4().hex[:6]}",
    }
    reapply_status, reapply_body = _post(
        f"/api/team/solutions/{seeded_enterprise['solution_id']}/apply",
        reapply_payload,
    )
    assert reapply_status == 201, reapply_body
    reapplied_employee_id = reapply_body["created_employee_ids"][0]
    assert reapplied_employee_id != previous_employee_id
    assert reapply_body["mode"] == "reapply"

    with UnitOfWork(db_conn) as uow:
        previous_employee = uow.employees().get_by_id(previous_employee_id)
        reapplied_employee = uow.employees().get_by_id(reapplied_employee_id)
        previous_bindings = uow.employee_knowledge_bindings().list_by_employee(previous_employee_id)
        reapplied_bindings = uow.employee_knowledge_bindings().list_by_employee(reapplied_employee_id)
        apply_records = uow.solution_apply_records().list_by_solution(seeded_enterprise["solution_id"])

        assert previous_employee is not None
        assert previous_employee.status == "active"
        assert reapplied_employee is not None
        assert reapplied_employee.status == "active"
        assert len(previous_bindings) == 1
        assert len(reapplied_bindings) == 1
        latest_record = next(record for record in apply_records if record.id == reapply_body["apply_record_id"])
        assert latest_record.mode == "reapply"
