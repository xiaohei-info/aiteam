"""System-admin query services for templates, solutions, and finance."""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from ...views.assemblers import _parse_cost_cents_from_json, _parse_tokens_from_json


def _parse_json(value: str | dict | None, fallback):
    if value in (None, "", "{}", "[]"):
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def list_templates(uow) -> dict[str, Any]:
    templates = [t for t in uow.agent_templates().list_all() if t.deleted_at is None]
    recruit_counts = _count_employee_templates(uow)
    items = []
    for template in templates:
        audits = uow.audit_events().list_by_target("template", template.id, limit=20)
        publish_record = _latest_publish_record(audits)
        items.append(
            {
                "template_id": template.id,
                "name": template.name,
                "category_code": template.category_code,
                "role_name": template.role_name,
                "status": template.status,
                "version_no": template.version_no,
                "source_type": template.source_type,
                "prompt_pack": _parse_json(template.prompt_pack_json, {}),
                "default_model_ref": _parse_json(template.default_model_json, {}),
                "default_binding": _parse_json(template.default_binding_json, {}),
                "publish_record": publish_record,
                "recruit_count": recruit_counts.get(template.id, 0),
                "created_at": template.created_at,
                "updated_at": template.updated_at,
            }
        )
    return {"items": items, "total": len(items)}


def list_solutions(uow) -> dict[str, Any]:
    solutions = [s for s in uow.industry_solutions().list_all() if s.deleted_at is None]
    template_bindings = _all_solution_bindings(uow)
    employee_template_counts = _count_solution_apply_employees_by_template(uow)
    items = []
    for solution in solutions:
        template_ids = [binding.template_id for binding in template_bindings.get(solution.id, []) if binding.enabled]
        apply_count = _count_solution_applies(uow, solution.id)
        active_employee_count = sum(employee_template_counts.get(template_id, 0) for template_id in template_ids)
        items.append(
            {
                "solution_id": solution.id,
                "name": solution.name,
                "status": solution.status,
                "tags": _parse_json(solution.tags_json, []),
                "template_ids": template_ids,
                "default_kb_blueprint": _parse_json(solution.default_kb_blueprint_json, {}),
                "default_skill_bundle": _parse_json(solution.default_skill_bundle_json, {}),
                "default_collaboration_template_ref": solution.default_collaboration_template_ref,
                "solution_stats": {
                    "apply_count": apply_count,
                    "active_employee_count": active_employee_count,
                    "template_count": len(template_ids),
                },
                "publish_record": _latest_publish_record(uow.audit_events().list_by_target("solution", solution.id, limit=20)),
                "created_at": solution.created_at,
                "updated_at": solution.updated_at,
            }
        )
    return {"items": items, "total": len(items)}


def get_platform_finance_overview(
    uow,
    *,
    period_start: str | None = None,
    period_end: str | None = None,
) -> dict[str, Any]:
    start, end = _resolve_window(period_start, period_end)
    enterprise_map = {enterprise.id: enterprise for enterprise in uow.enterprises().list_all()}
    aggregate = _aggregate_finance(uow, enterprise_map=enterprise_map, period_start=start, period_end=end)
    top_enterprises = sorted(
        aggregate["enterprise_rows"], key=lambda item: (-item["cost_cents"], item["enterprise_id"])
    )[:5]
    return {
        "period_start": start,
        "period_end": end,
        "total_tokens": aggregate["total_tokens"],
        "total_revenue_cents": aggregate["total_cost_cents"],
        "total_cost_cents": aggregate["total_cost_cents"],
        "total_profit_cents": 0,
        "enterprise_count": len(aggregate["enterprise_rows"]),
        "top_enterprises": [
            {
                "enterprise_id": row["enterprise_id"],
                "enterprise_name": row["enterprise_name"],
                "tokens": row["tokens"],
                "revenue_cents": row["cost_cents"],
                "cost_cents": row["cost_cents"],
                "profit_cents": 0,
                "run_count": row["run_count"],
            }
            for row in top_enterprises
        ],
    }


def get_platform_finance_reports(
    uow,
    *,
    period_start: str | None = None,
    period_end: str | None = None,
) -> dict[str, Any]:
    start, end = _resolve_window(period_start, period_end)
    enterprise_map = {enterprise.id: enterprise for enterprise in uow.enterprises().list_all()}
    aggregate = _aggregate_finance(uow, enterprise_map=enterprise_map, period_start=start, period_end=end)
    return {
        "period_start": start,
        "period_end": end,
        "trends": aggregate["trend_rows"],
        "enterprises": sorted(
            [
                {
                    "enterprise_id": row["enterprise_id"],
                    "enterprise_name": row["enterprise_name"],
                    "tokens": row["tokens"],
                    "revenue_cents": row["cost_cents"],
                    "cost_cents": row["cost_cents"],
                    "profit_cents": 0,
                    "run_count": row["run_count"],
                }
                for row in aggregate["enterprise_rows"]
            ],
            key=lambda item: (-item["cost_cents"], item["enterprise_id"]),
        ),
    }


def _resolve_window(period_start: str | None, period_end: str | None) -> tuple[str, str]:
    today = date.today()
    start = period_start or str(today.replace(day=1))
    if period_end:
        return start, period_end
    start_day = datetime.strptime(start, "%Y-%m-%d").date()
    return start, str(start_day + timedelta(days=31))


def _aggregate_finance(uow, *, enterprise_map, period_start: str, period_end: str) -> dict[str, Any]:
    enterprise_rows: dict[str, dict[str, Any]] = {}
    trend_rows: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "date": "",
        "tokens": 0,
        "revenue_cents": 0,
        "cost_cents": 0,
        "profit_cents": 0,
        "run_count": 0,
    })
    total_tokens = 0
    total_cost_cents = 0

    for enterprise_id, enterprise in enterprise_map.items():
        runs = [
            run for run in uow.team_runs().list_by_enterprise(enterprise_id)
            if period_start <= (run.created_at or "")[:10] < period_end
        ]
        if not runs:
            continue
        employee_events = {
            run.id: uow.run_events().list_by_run(run.id, after_cursor=0, limit=500)
            for run in runs
        }
        row = enterprise_rows.setdefault(
            enterprise_id,
            {
                "enterprise_id": enterprise_id,
                "enterprise_name": enterprise.name,
                "tokens": 0,
                "cost_cents": 0,
                "run_count": 0,
            },
        )
        for run in runs:
            tokens = _parse_tokens_from_json(run.result_summary_json)
            cost_cents = _parse_cost_cents_from_json(run.result_summary_json)
            for event in employee_events[run.id]:
                if event.event_type == "usage_recorded":
                    tokens += _parse_tokens_from_json(event.payload_json)
                    cost_cents += _parse_cost_cents_from_json(event.payload_json)
            row["tokens"] += tokens
            row["cost_cents"] += cost_cents
            row["run_count"] += 1
            total_tokens += tokens
            total_cost_cents += cost_cents
            day = (run.created_at or "")[:10]
            trend = trend_rows[day]
            trend["date"] = day
            trend["tokens"] += tokens
            trend["revenue_cents"] += cost_cents
            trend["cost_cents"] += cost_cents
            trend["run_count"] += 1

    return {
        "total_tokens": total_tokens,
        "total_cost_cents": total_cost_cents,
        "enterprise_rows": list(enterprise_rows.values()),
        "trend_rows": sorted(trend_rows.values(), key=lambda item: item["date"]),
    }


def _count_employee_templates(uow) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for enterprise in uow.enterprises().list_all():
        for employee in uow.employees().list_by_enterprise(enterprise.id):
            if employee.template_id:
                counts[employee.template_id] += 1
    return counts


def _count_solution_apply_employees_by_template(uow) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for enterprise in uow.enterprises().list_all():
        for employee in uow.employees().list_by_enterprise(enterprise.id):
            if employee.created_from == "solution_apply" and employee.template_id:
                counts[employee.template_id] += 1
    return counts


def _all_solution_bindings(uow):
    mapping = defaultdict(list)
    for solution in uow.industry_solutions().list_all():
        mapping[solution.id] = uow.solution_template_bindings().list_by_solution(solution.id)
    return mapping


def _count_solution_applies(uow, solution_id: str) -> int:
    audits = uow.audit_events().list_by_target("solution", solution_id, limit=500)
    return sum(1 for audit in audits if audit.event_type == "solution.apply")


def _latest_publish_record(audits) -> dict[str, Any]:
    for audit in audits:
        if audit.event_type in {"template.publish", "template.unpublish", "solution.publish", "solution.unpublish"}:
            return {
                "is_published": audit.event_type.endswith("publish") and not audit.event_type.endswith("unpublish"),
                "event_type": audit.event_type,
                "recorded_at": audit.created_at,
            }
    return {"is_published": False, "event_type": None, "recorded_at": None}
