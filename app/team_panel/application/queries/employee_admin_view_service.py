"""Employee admin view service — employee detail view (real persistence).

Loads actual persisted config surfaces available in this repo slice:
model, prompt, skills, KB, memory, connectors.
"""

from __future__ import annotations

import json

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

    return EmployeeAdminView(
        employee_id=emp.id,
        display_name=emp.display_name,
        status=emp.status,
        role_name=emp.role_name,
        model_provider=emp.model_provider,
        model_name=emp.model_name,
        prompt_version=emp.prompt_version or 1,
        config_version=emp.config_version or 1,
        capabilities_json=emp.capabilities_json,
        description=emp.description or "",
        skills=skills,
        knowledge_bases=knowledge_bases,
        memory_config=memory_config,
        prompt_config=prompt_config,
        connector_bindings=connector_bindings,
    )
