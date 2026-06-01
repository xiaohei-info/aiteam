"""Recruitment service — creates draft employees from talent templates.

Writes: recruitment_order(pending) + employee(draft) + employee_prompt +
default bindings from template.  Returns employee_id.
"""

import json
import uuid

from ...domain.entities import (
    AgentTemplate,
    Employee,
    EmployeeKnowledgeBinding,
    EmployeeMemoryBinding,
    EmployeePrompt,
    EmployeeSkillBinding,
    RecruitmentOrder,
)
from ...domain.enums import CreatedFrom, EmployeeStatus


def recruit_employee(uow, enterprise_id: str, template_id: str,
                     profile_name: str, display_name: str,
                     *, created_from: str = CreatedFrom.TALENT_MARKET,
                     requested_by: str = "") -> str:
    """Create a draft Employee from a talent template.

    Raises:
        ValueError: template not found, not published, or profile_name already exists.
    """
    # ── Validate template ──────────────────────────────────────────
    template: AgentTemplate = uow.agent_templates().get_by_id(template_id)
    if template is None:
        raise ValueError(f"AgentTemplate {template_id} not found")
    if template.status != "published":
        raise ValueError(
            f"AgentTemplate {template_id} is {template.status}, must be published"
        )

    # ── Validate profile_name uniqueness ───────────────────────────
    existing = uow.employees().get_by_profile_name(enterprise_id, profile_name)
    if existing is not None:
        raise ValueError(
            f"profile_name '{profile_name}' already in use by employee {existing.id}"
        )

    # ── Parse template bindings ────────────────────────────────────
    try:
        default_bindings = json.loads(template.default_binding_json or "{}")
    except json.JSONDecodeError:
        default_bindings = {}

    # ── Create Employee (draft) ────────────────────────────────────
    employee_id = f"emp_{uuid.uuid4().hex[:12]}"
    emp = Employee(
        id=employee_id,
        enterprise_id=enterprise_id,
        template_id=template_id,
        profile_name=profile_name,
        display_name=display_name or template.role_name,
        role_name=template.role_name,
        status=EmployeeStatus.DRAFT,
        created_from=created_from,
        model_provider="",
        model_name="",
    )
    uow.employees().create(emp)

    # ── Create RecruitmentOrder (pending) ──────────────────────────
    order_id = f"ro_{uuid.uuid4().hex[:12]}"
    order = RecruitmentOrder(
        id=order_id,
        enterprise_id=enterprise_id,
        template_id=template_id,
        status="pending",
        requested_by=requested_by,
        created_employee_id=employee_id,
        idempotency_key=f"recruit_{employee_id}",
        created_by=requested_by,
    )
    uow.recruitment_orders().create(order)

    # ── Create EmployeePrompt ──────────────────────────────────────
    try:
        prompt_pack = json.loads(template.prompt_pack_json or "{}")
    except json.JSONDecodeError:
        prompt_pack = {}
    system_prompt = prompt_pack.get("system_prompt", "")
    behavior_rules = prompt_pack.get("behavior_rules", {})
    opening = prompt_pack.get("opening_message")
    prompt = EmployeePrompt(
        employee_id=employee_id,
        system_prompt=system_prompt,
        behavior_rules_json=json.dumps(behavior_rules, ensure_ascii=False),
        opening_message=opening,
        version_no=1,
        source_template_version=template.version_no,
    )
    uow.employee_prompts().create(prompt)

    # ── Create default bindings from template ──────────────────────
    skills = default_bindings.get("skills", [])
    for skill_code in skills:
        bind = EmployeeSkillBinding(
            id=f"sb_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            skill_code=skill_code,
            enabled=True,
            source_type="template_default",
        )
        uow.employee_skill_bindings().create(bind)

    knowledge_bases = default_bindings.get("knowledge_bases", [])
    for kb_id in knowledge_bases:
        bind = EmployeeKnowledgeBinding(
            id=f"kb_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            knowledge_base_id=kb_id,
            scope_mode="read",
            enabled=True,
        )
        uow.employee_knowledge_bindings().create(bind)

    memory_config = default_bindings.get("memory", {})
    if memory_config:
        mem_bind = EmployeeMemoryBinding(
            id=f"mb_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            memory_mode=memory_config.get("mode", "builtin"),
            provider_code=memory_config.get("provider_code"),
            retention_days=memory_config.get("retention_days"),
            writeback_enabled=memory_config.get("writeback_enabled", True),
        )
        uow.employee_memory_bindings().create(mem_bind)

    return employee_id
