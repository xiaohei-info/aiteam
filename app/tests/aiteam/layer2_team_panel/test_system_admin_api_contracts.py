"""Layer2 system-admin northbound API contract tests."""
from __future__ import annotations

import json
import uuid

from team_panel.domain.entities import TeamRun
from team_panel.transactions.uow import UnitOfWork

from tests.aiteam.layer0_contracts.test_host_routing import _get, _patch, _post


def _system_admin_path(path: str) -> str:
    separator = "&" if "?" in path else "?"
    return f"{path}{separator}role=system_admin"


def _seed_usage(db_conn, *, enterprise_id: str, employee_id: str, summary_tokens: int, summary_cost: int, event_tokens: int, event_cost: int) -> None:
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
                idempotency_key=f"finance-{run_id}",
                result_summary_json=None,
            )
        )
        uow.cur.execute(
            "UPDATE team_run SET result_summary_json = %s::jsonb WHERE id = %s",
            (json.dumps({"usage": {"total_tokens": summary_tokens, "cost_cents": summary_cost}}), run_id),
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
                "finance_seed",
                employee_id,
                json.dumps({"usage": {"total_tokens": event_tokens, "cost_cents": event_cost}}),
            ),
        )


def _seed_second_enterprise(db_conn, *, template_id: str) -> dict:
    enterprise_id = f"ent_{uuid.uuid4().hex[:8]}"
    employee_id = f"emp_{uuid.uuid4().hex[:8]}"
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO enterprise (id, slug, name, status, owner_user_id) VALUES (%s, %s, %s, %s, %s)",
            (enterprise_id, f"slug-{enterprise_id}", "Second Corp", "active", "owner_second"),
        )
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, template_id, profile_name, display_name, role_name, status, created_from) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (employee_id, enterprise_id, template_id, f"pf-{employee_id}", "Finance Bot", "财务", "active", "manual"),
        )
        db_conn.commit()
    finally:
        cur.close()
    return {"enterprise_id": enterprise_id, "employee_id": employee_id}


class TestSystemTemplates:
    def test_get_templates_returns_seeded_template(self, seeded_enterprise):
        status, body = _get(_system_admin_path("/api/system-admin/templates"))
        assert status == 200, body
        assert body["total"] >= 1
        seeded = next(item for item in body["items"] if item["template_id"] == seeded_enterprise["template_id"])
        assert seeded["name"] == "Marketing Analyst"
        assert seeded["status"] == "published"
        assert seeded["recruit_count"] >= 3
        assert "publish_record" in seeded

    def test_post_template_then_patch_publish(self, seeded_enterprise):
        status, created = _post(
            "/api/system-admin/templates?role=system_admin",
            {
                "name": "Ops Specialist",
                "role_name": "运营专家",
                "category_code": "ops",
                "default_model_ref": {"provider": "openai", "model": "gpt-4o-mini"},
            },
        )
        assert status == 201, created
        assert created["status"] == "draft"
        template_id = created["template_id"]

        patch_status, patched = _patch(
            f"/api/system-admin/templates/{template_id}?role=system_admin",
            {"publish_action": "publish", "name": "Ops Specialist v2"},
        )
        assert patch_status == 200, patched
        assert patched["status"] == "published"
        assert patched["name"] == "Ops Specialist v2"
        assert patched["publish_record"]["is_published"] is True

    def test_system_template_projection_exposes_preview_fields(self, seeded_enterprise):
        status, body = _get(_system_admin_path("/api/system-admin/templates"))
        assert status == 200, body
        seeded = next(item for item in body["items"] if item["template_id"] == seeded_enterprise["template_id"])
        assert seeded["description"]
        assert seeded["default_model"] or seeded["default_model_ref"]


class TestSystemSolutions:
    def test_get_solutions_returns_seeded_solution(self, seeded_enterprise):
        status, body = _get(_system_admin_path("/api/system-admin/solutions"))
        assert status == 200, body
        seeded = next(item for item in body["items"] if item["solution_id"] == seeded_enterprise["solution_id"])
        assert seeded["template_ids"] == [seeded_enterprise["template_id"]]
        assert seeded["solution_stats"]["template_count"] == 1

    def test_system_solution_projection_flattens_apply_stats(self, seeded_enterprise):
        status, body = _get(_system_admin_path("/api/system-admin/solutions"))
        assert status == 200, body
        seeded = next(item for item in body["items"] if item["solution_id"] == seeded_enterprise["solution_id"])
        assert seeded["solution_stats"]["template_count"] == len(seeded["template_ids"])
        assert "publish_record" in seeded

    def test_post_solution_then_patch_publish(self, seeded_enterprise):
        status, created = _post(
            "/api/system-admin/solutions?role=system_admin",
            {
                "name": "Retail Ops Pack",
                "tags": ["retail", "ops"],
                "template_ids": [seeded_enterprise["template_id"]],
            },
        )
        assert status == 201, created
        assert created["status"] == "draft"
        solution_id = created["solution_id"]

        patch_status, patched = _patch(
            f"/api/system-admin/solutions/{solution_id}?role=system_admin",
            {"publish_action": "publish", "tags": ["retail", "ops", "published"]},
        )
        assert patch_status == 200, patched
        assert patched["status"] == "published"
        assert patched["solution_stats"]["template_count"] == 1
        assert patched["publish_record"]["is_published"] is True


class TestSystemFinance:
    def test_finance_overview_and_reports_are_reproducible(self, db_conn, seeded_enterprise):
        _seed_usage(
            db_conn,
            enterprise_id=seeded_enterprise["enterprise_id"],
            employee_id=seeded_enterprise["employee_id"],
            summary_tokens=21,
            summary_cost=5,
            event_tokens=13,
            event_cost=2,
        )
        second = _seed_second_enterprise(db_conn, template_id=seeded_enterprise["template_id"])
        _seed_usage(
            db_conn,
            enterprise_id=second["enterprise_id"],
            employee_id=second["employee_id"],
            summary_tokens=10,
            summary_cost=3,
            event_tokens=5,
            event_cost=1,
        )

        status, overview = _get(
            _system_admin_path("/api/system-admin/finance/overview?period_start=2000-01-01&period_end=2099-12-31")
        )
        assert status == 200, overview
        assert overview["total_tokens"] == 49
        assert overview["total_revenue_cents"] == 11
        assert overview["total_cost_cents"] == 11
        assert overview["total_profit_cents"] == 0
        assert overview["enterprise_count"] == 2
        assert len(overview["top_enterprises"]) == 2
        assert overview["top_enterprises"][0]["cost_cents"] >= overview["top_enterprises"][1]["cost_cents"]

        report_status, reports = _get(
            _system_admin_path("/api/system-admin/finance/reports?period_start=2000-01-01&period_end=2099-12-31")
        )
        assert report_status == 200, reports
        assert len(reports["trends"]) >= 1
        trend_total = sum(item["cost_cents"] for item in reports["trends"])
        enterprise_total = sum(item["cost_cents"] for item in reports["enterprises"])
        assert trend_total == 11
        assert enterprise_total == 11
        assert reports["enterprises"][0]["cost_cents"] >= reports["enterprises"][1]["cost_cents"]
