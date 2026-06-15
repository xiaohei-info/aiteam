"""Employee admin view service — employee detail view (real persistence).

Loads actual persisted config surfaces available in this repo slice:
model, prompt, skills, KB, memory, connectors, loop and recent run summary.
"""

from __future__ import annotations

import json


def _load_jsonish(value):
    if not value:
        return {}
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        try:
            import ast
            parsed = ast.literal_eval(value)
            return parsed if isinstance(parsed, dict) else {}
        except (SyntaxError, ValueError):
            return {}

from ...transactions.uow import UnitOfWork
from ...views.schemas import EmployeeAdminView


def get_employee_admin_view(
    uow: UnitOfWork, employee_id: str
) -> EmployeeAdminView | None:
    """Build employee admin detail view from real persisted data.

    Reads from employee table + binding repos so the configurable drawer
    sees what is actually stored, not stub placeholders.
    """
    emp = uow.employees().get_by_id(employee_id)
    if emp is None:
        return None

    # ── skills ────────────────────────────────────────────────────
    skill_bindings = uow.employee_skill_bindings().list_by_employee(employee_id)
    skills = [
        {"skill_code": sb.skill_code, "enabled": sb.enabled,
         "source_type": sb.source_type, "visibility": sb.visibility}
        for sb in skill_bindings
    ]

    # ── knowledge bases ───────────────────────────────────────────
    kb_bindings = uow.employee_knowledge_bindings().list_by_employee(employee_id)
    knowledge_bases = [
        {"knowledge_base_id": kb.knowledge_base_id, "scope_mode": kb.scope_mode,
         "enabled": kb.enabled}
        for kb in kb_bindings
    ]

    # ── memory config ─────────────────────────────────────────────
    mem = uow.employee_memory_bindings().get_by_employee(employee_id)
    memory_config = {
        "mode": "builtin",
        "provider_code": None,
        "retention_days": None,
        "writeback_enabled": True,
    }
    if mem is not None:
        memory_config = {
            "mode": mem.memory_mode,
            "provider_code": mem.provider_code,
            "retention_days": mem.retention_days,
            "writeback_enabled": mem.writeback_enabled,
        }

    # ── prompt ────────────────────────────────────────────────────
    prompt = uow.employee_prompts().get_by_employee(employee_id)
    prompt_config = None
    if prompt is not None:
        behavior_rules = prompt.behavior_rules_json
        try:
            behavior_rules = json.dumps(json.loads(prompt.behavior_rules_json), ensure_ascii=False)
        except (TypeError, ValueError):
            try:
                import ast
                parsed_rules = ast.literal_eval(prompt.behavior_rules_json)
                if isinstance(parsed_rules, (dict, list)):
                    behavior_rules = json.dumps(parsed_rules, ensure_ascii=False)
            except (SyntaxError, ValueError):
                pass
        prompt_config = {
            "system_prompt": prompt.system_prompt,
            "behavior_rules_json": behavior_rules,
            "opening_message": prompt.opening_message,
            "version_no": prompt.version_no,
        }

    # ── connectors ────────────────────────────────────────────────
    conn_bindings = uow.employee_connector_bindings().list_by_employee(employee_id)
    connector_bindings = [
        {
            "binding_id": cb.id,
            "connector_id": cb.connector_id,
            "access_mode": cb.access_mode,
            "enabled": cb.enabled,
        }
        for cb in conn_bindings
    ]

    # ── loop / scheduled jobs ─────────────────────────────────────
    scheduled_jobs = [
        {
            "scheduled_job_id": job.id,
            "name": job.name,
            "goal": job.goal,
            "schedule_expr": job.schedule_expr,
            "status": job.status,
            "max_consecutive_failures": job.max_consecutive_failures,
            "consecutive_failures": job.consecutive_failures,
            "last_run_status": job.last_run_status,
            "last_run_at": job.last_run_at or None,
            "last_success_at": job.last_success_at or None,
            "runtime_job_id": job.runtime_job_id,
            "notification_policy": _load_jsonish(job.notification_policy_json),
        }
        for job in uow.scheduled_jobs().list_by_employee(employee_id)
        if job.deleted_at is None and job.status != "archived"
    ]

    # ── recent run / usage summary ────────────────────────────────
    team_runs = [
        run for run in uow.team_runs().list_by_enterprise(emp.enterprise_id)
        if run.entry_employee_id == employee_id and run.deleted_at is None
    ]
    usage_ledgers = [
        ledger for ledger in uow.usage_ledgers().list_by_enterprise(emp.enterprise_id)
        if ledger.employee_id == employee_id and ledger.deleted_at is None
    ]
    latest_run = team_runs[0] if team_runs else None
    total_tokens = sum(int(ledger.total_tokens or 0) for ledger in usage_ledgers)
    total_cost_cents = sum(int(ledger.cost_cents or 0) for ledger in usage_ledgers)
    last_run_at = latest_run.created_at if latest_run and latest_run.created_at else None
    run_summary = {
        "latest_run_id": latest_run.id if latest_run else None,
        "latest_status": latest_run.status if latest_run else None,
        "latest_trigger_type": latest_run.trigger_type if latest_run else None,
        "latest_finished_at": latest_run.finished_at if latest_run and latest_run.finished_at else None,
        "total_runs": len(team_runs),
        "total_tokens": total_tokens,
        "total_cost_cents": total_cost_cents,
        "last_run_at": last_run_at,
    }

    bindings_summary = [
        {"binding_type": "model", "count": 1 if (emp.model_provider or emp.model_name) else 0},
        {"binding_type": "prompt", "count": 1 if prompt is not None else 0},
        {"binding_type": "skills", "count": len(skills)},
        {"binding_type": "knowledge_bases", "count": len(knowledge_bases)},
        {"binding_type": "memory", "count": 1 if mem is not None else 0},
        {"binding_type": "connectors", "count": len(connector_bindings)},
        {"binding_type": "loop", "count": len(scheduled_jobs)},
    ]

    return EmployeeAdminView(
        employee_id=emp.id,
        display_name=emp.display_name,
        status=emp.status,
        role_name=emp.role_name,
        model_provider=emp.model_provider,
        model_name=emp.model_name,
        temperature=emp.temperature,
        max_tokens=emp.max_tokens,
        prompt_version=emp.prompt_version or 1,
        config_version=emp.config_version or 1,
        capabilities_json=emp.capabilities_json,
        description=emp.description or "",
        skills=skills,
        knowledge_bases=knowledge_bases,
        memory_config=memory_config,
        prompt_config=prompt_config,
        connector_bindings=connector_bindings,
        bindings_summary=bindings_summary,
        scheduled_jobs=scheduled_jobs,
        run_summary=run_summary,
    )
