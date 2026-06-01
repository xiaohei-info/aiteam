"""L5 flow tests for solution apply and governance read models."""
from __future__ import annotations

import json
import uuid

from team_panel.domain.entities import TeamRun
from team_panel.transactions.uow import UnitOfWork

from tests.aiteam.layer0_contracts.test_host_routing import _get, _post

pytest_plugins = ["tests.aiteam.layer2_team_panel.conftest"]


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
