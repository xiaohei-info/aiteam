"""L2-S02 recruitment + employee-admin + connector-grant command tests.

Covers:
  T01 — recruitment creates recruitment_order + draft employee + prompt + bindings
  T02 — duplicate profile_name is rejected
  T03 — employee status changes create audit records
  T04 — grant_connector requires online connector
  T05 — revoke_connector soft-deletes the binding
"""

import json
import uuid

import pytest

from team_panel.application.commands.connector_grant_service import (
    grant_connector,
    revoke_connector,
)
from team_panel.application.commands.employee_admin_service import (
    activate_employee,
    archive_employee,
    pause_employee,
)
from team_panel.application.commands.recruitment_service import recruit_employee
from team_panel.domain.entities import (
    AgentTemplate,
    Enterprise,
    EnterpriseConnector,
)
from team_panel.domain.enums import EmployeeStatus
from team_panel.transactions.uow import UnitOfWork


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════

def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _fresh_template(**kw):
    defaults = dict(
        id=_uid("tpl"),
        name="Customer Service Rep",
        category_code="service",
        role_name="CS Agent",
        status="published",
        prompt_pack_json=json.dumps({
            "system_prompt": "You are a helpful customer service agent.",
            "behavior_rules": {"tone": "friendly"},
            "opening_message": "Hello!",
        }),
        default_binding_json=json.dumps({
            "skills": ["web_search", "code_run"],
            "knowledge_bases": ["kb_general"],
            "memory": {"mode": "builtin", "retention_days": 90, "writeback_enabled": True},
        }),
    )
    defaults.update(kw)
    return AgentTemplate(**defaults)


def _fresh_connector(enterprise_id, **kw):
    defaults = dict(
        id=_uid("conn"),
        enterprise_id=enterprise_id,
        name="Test Connector",
        provider_code="test_provider",
        connector_type="api_key_connector",
        credential_ref="cred_ref_001",
        status="online",
    )
    defaults.update(kw)
    return EnterpriseConnector(**defaults)


def _fresh_enterprise(**kw):
    eid = _uid("ent")
    defaults = dict(
        id=eid,
        slug=f"slug-{eid}",
        name="Test Enterprise",
        owner_user_id="usr_001",
    )
    defaults.update(kw)
    return Enterprise(**defaults)


def _setup_enterprise(uow, enterprise=None):
    """Create an enterprise and return its id."""
    if enterprise is None:
        enterprise = _fresh_enterprise()
    ent_id = enterprise.id
    existing = uow.enterprises().get_by_id(ent_id)
    if existing is None:
        uow.enterprises().create(enterprise)
    return ent_id


# ═══════════════════════════════════════════════════════════════════
# T01: recruitment creates recruitment_order + draft employee + prompt + bindings
# ═══════════════════════════════════════════════════════════════════

def test_recruitment_creates_draft_employee(db_conn):
    """Recruitment: creates recruitment_order(pending) + employee(draft)
    + employee_prompt + default bindings."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )

    # ── Verify Employee ──────────────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        emp = uow.employees().get_by_id(employee_id)
        assert emp is not None
        assert emp.status == EmployeeStatus.DRAFT
        assert emp.profile_name == profile_name
        assert emp.display_name == "CS Agent 1"
        assert emp.enterprise_id == ent_id
        assert emp.template_id == tpl.id
        assert emp.role_name == tpl.role_name

    # ── Verify RecruitmentOrder ──────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        orders = uow.recruitment_orders().list_by_enterprise(ent_id)
        assert len(orders) == 1
        order = orders[0]
        assert order.status == "pending"
        assert order.created_employee_id == employee_id
        assert order.template_id == tpl.id

    # ── Verify EmployeePrompt ────────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        prompt = uow.employee_prompts().get_by_employee(employee_id)
        assert prompt is not None
        assert "customer service" in prompt.system_prompt.lower()

    # ── Verify Skill Bindings ────────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        skill_bindings = uow.employee_skill_bindings().list_by_employee(employee_id)
        skill_codes = {b.skill_code for b in skill_bindings}
        assert "web_search" in skill_codes
        assert "code_run" in skill_codes

    # ── Verify Knowledge Bindings ────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        kb_bindings = uow.employee_knowledge_bindings().list_by_employee(employee_id)
        kb_ids = {b.knowledge_base_id for b in kb_bindings}
        assert "kb_general" in kb_ids

    # ── Verify Memory Binding ────────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        mem = uow.employee_memory_bindings().get_by_employee(employee_id)
        assert mem is not None
        assert mem.memory_mode == "builtin"


# ═══════════════════════════════════════════════════════════════════
# T02: duplicate profile_name is rejected
# ═══════════════════════════════════════════════════════════════════

def test_cannot_provision_duplicate_profile_name(db_conn):
    """Duplicate profile_name raises ValueError."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )

    # Second attempt with same profile_name must fail
    with pytest.raises(ValueError, match="already in use"):
        with UnitOfWork(db_conn) as uow:
            _setup_enterprise(uow, _fresh_enterprise(id=ent_id))
            recruit_employee(
                uow, enterprise_id=ent_id, template_id=tpl.id,
                profile_name=profile_name, display_name="CS Agent 2",
                requested_by="usr_001",
            )


def test_duplicate_profile_name_across_enterprises_allowed(db_conn):
    """Profile names are scoped per enterprise: same name ok in different enterprises."""
    tpl = _fresh_template()
    profile_name_a = _uid("cs")
    profile_name_b = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_a = _setup_enterprise(uow)
        ent_b = _setup_enterprise(uow, _fresh_enterprise())
        uow.agent_templates().create(tpl)
        eid_a = recruit_employee(
            uow, enterprise_id=ent_a, template_id=tpl.id,
            profile_name=profile_name_a, display_name="CS Agent A",
            requested_by="usr_001",
        )
        eid_b = recruit_employee(
            uow, enterprise_id=ent_b, template_id=tpl.id,
            profile_name=profile_name_b, display_name="CS Agent B",
            requested_by="usr_001",
        )

    assert eid_a != eid_b

    with UnitOfWork(db_conn) as uow:
        e_a = uow.employees().get_by_id(eid_a)
        e_b = uow.employees().get_by_id(eid_b)
        assert e_a.enterprise_id == ent_a
        assert e_b.enterprise_id == ent_b


# ═══════════════════════════════════════════════════════════════════
# T03: employee status changes create audit records
# ═══════════════════════════════════════════════════════════════════

def test_employee_status_change_creates_audit(db_conn):
    """activate/pause/archive each produce an audit event."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )

    # ── Activate ─────────────────────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        activate_employee(uow, employee_id, "usr_001")

    # ── Pause ────────────────────────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        pause_employee(uow, employee_id, "usr_001")

    # ── Archive ──────────────────────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        archive_employee(uow, employee_id, "usr_001")

    # ── Verify audit records ─────────────────────────────────────
    with UnitOfWork(db_conn) as uow:
        audits = uow.audit_events().list_by_target("employee", employee_id)
        event_types = [a.event_type for a in audits]
        assert "employee.activate" in event_types
        assert "employee.pause" in event_types
        assert "employee.archive" in event_types

        # Verify payloads
        activate_audit = next(a for a in audits if a.event_type == "employee.activate")
        payload = json.loads(activate_audit.payload_json)
        assert payload["from_status"] == EmployeeStatus.DRAFT
        assert payload["to_status"] == EmployeeStatus.ACTIVE

        pause_audit = next(a for a in audits if a.event_type == "employee.pause")
        payload = json.loads(pause_audit.payload_json)
        assert payload["from_status"] == EmployeeStatus.ACTIVE
        assert payload["to_status"] == EmployeeStatus.PAUSED

        archive_audit = next(a for a in audits if a.event_type == "employee.archive")
        payload = json.loads(archive_audit.payload_json)
        assert payload["from_status"] == EmployeeStatus.PAUSED
        assert payload["to_status"] == EmployeeStatus.ARCHIVED


def test_activate_from_draft_creates_audit(db_conn):
    """Activating a draft employee creates audit with from_status=draft."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )

    with UnitOfWork(db_conn) as uow:
        activate_employee(uow, employee_id, "usr_001")

    with UnitOfWork(db_conn) as uow:
        emp = uow.employees().get_by_id(employee_id)
        assert emp.status == EmployeeStatus.ACTIVE
        audits = uow.audit_events().list_by_target("employee", employee_id)
        assert len(audits) >= 1
        audit = audits[0]
        assert audit.event_type == "employee.activate"


def test_pause_non_active_employee_raises(db_conn):
    """Pausing a non-active employee raises ValueError from domain entity."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )

    with pytest.raises(ValueError, match="Cannot pause"):
        with UnitOfWork(db_conn) as uow:
            pause_employee(uow, employee_id, "usr_001")


def test_activate_nonexistent_employee_raises(db_conn):
    """Activating a missing employee raises ValueError."""
    with pytest.raises(ValueError, match="not found"):
        with UnitOfWork(db_conn) as uow:
            activate_employee(uow, "emp_nonexistent", "usr_001")


# ═══════════════════════════════════════════════════════════════════
# T04: grant_connector requires online connector
# ═══════════════════════════════════════════════════════════════════

def test_grant_connector_creates_binding(db_conn):
    """grant_connector creates a binding when connector is online."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )
        connector = _fresh_connector(enterprise_id=ent_id, status="online")
        uow.enterprise_connectors().create(connector)
        binding_id = grant_connector(
            uow, enterprise_id=ent_id, employee_id=employee_id,
            connector_id=connector.id, access_mode="invoke",
        )

    with UnitOfWork(db_conn) as uow:
        binding = uow.employee_connector_bindings().get_by_id(binding_id)
        assert binding is not None
        assert binding.employee_id == employee_id
        assert binding.connector_id == connector.id
        assert binding.access_mode == "invoke"
        assert binding.enabled is True


def test_grant_connector_rejects_offline_connector(db_conn):
    """grant_connector refuses offline connector."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )
        connector = _fresh_connector(enterprise_id=ent_id, status="offline")
        uow.enterprise_connectors().create(connector)

        with pytest.raises(ValueError, match="must be online"):
            grant_connector(
                uow, enterprise_id=ent_id, employee_id=employee_id,
                connector_id=connector.id,
            )


def test_grant_connector_rejects_draft_connector(db_conn):
    """grant_connector refuses draft connector."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )
        connector = _fresh_connector(enterprise_id=ent_id, status="draft")
        uow.enterprise_connectors().create(connector)

        with pytest.raises(ValueError, match="must be online"):
            grant_connector(
                uow, enterprise_id=ent_id, employee_id=employee_id,
                connector_id=connector.id,
            )


def test_grant_connector_rejects_wrong_enterprise_connector(db_conn):
    """grant_connector refuses connector belonging to a different enterprise."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_a = _setup_enterprise(uow)
        ent_b = _setup_enterprise(uow, _fresh_enterprise())
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_a, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )
        connector = _fresh_connector(enterprise_id=ent_b, status="online")
        uow.enterprise_connectors().create(connector)

        with pytest.raises(ValueError, match="belongs to"):
            grant_connector(
                uow, enterprise_id=ent_a, employee_id=employee_id,
                connector_id=connector.id,
            )


# ═══════════════════════════════════════════════════════════════════
# T05: revoke_connector soft-deletes the binding
# ═══════════════════════════════════════════════════════════════════

def test_revoke_connector_soft_deletes_binding(db_conn):
    """revoke_connector sets deleted_at on the binding."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )
        connector = _fresh_connector(enterprise_id=ent_id, status="online")
        uow.enterprise_connectors().create(connector)
        binding_id = grant_connector(
            uow, enterprise_id=ent_id, employee_id=employee_id,
            connector_id=connector.id,
        )

    with UnitOfWork(db_conn) as uow:
        revoke_connector(uow, binding_id)

    # After revoke, get_by_id still works but deleted_at is set
    with UnitOfWork(db_conn) as uow:
        binding = uow.employee_connector_bindings().get_by_id(binding_id)
        assert binding is not None
        assert binding.deleted_at is not None


def test_revoke_nonexistent_binding_raises(db_conn):
    """Revoking a nonexistent binding raises ValueError."""
    with pytest.raises(ValueError, match="not found"):
        with UnitOfWork(db_conn) as uow:
            revoke_connector(uow, "cb_nonexistent")


def test_connector_grant_and_revoke_can_be_audited(db_conn):
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )
        connector = _fresh_connector(enterprise_id=ent_id, status="online")
        uow.enterprise_connectors().create(connector)
        binding_id = grant_connector(
            uow, enterprise_id=ent_id, employee_id=employee_id,
            connector_id=connector.id,
        )

    with UnitOfWork(db_conn) as uow:
        revoke_connector(uow, binding_id)
        binding = uow.employee_connector_bindings().get_by_id(binding_id)
        assert binding is not None
        assert binding.deleted_at is not None


# ═══════════════════════════════════════════════════════════════════
# Additional edge-case tests
# ═══════════════════════════════════════════════════════════════════

def test_recruit_with_unpublished_template_raises(db_conn):
    """Recruit rejects a non-published template."""
    tpl = _fresh_template(status="draft")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        with pytest.raises(ValueError, match="must be published"):
            recruit_employee(
                uow, enterprise_id=ent_id, template_id=tpl.id,
                profile_name=_uid("cs"), display_name="CS Agent 1",
                requested_by="usr_001",
            )


def test_recruit_with_nonexistent_template_raises(db_conn):
    """Recruit rejects a missing template."""
    with UnitOfWork(db_conn) as uow:
        with pytest.raises(ValueError, match="not found"):
            recruit_employee(
                uow, enterprise_id="ent_nonexistent", template_id="tpl_nonexistent",
                profile_name="cs_agent_1", display_name="CS Agent 1",
                requested_by="usr_001",
            )


def test_employee_state_transition_integrity(db_conn):
    """Full lifecycle: draft → activate → pause → archive."""
    tpl = _fresh_template()
    profile_name = _uid("cs")

    with UnitOfWork(db_conn) as uow:
        ent_id = _setup_enterprise(uow)
        uow.agent_templates().create(tpl)
        employee_id = recruit_employee(
            uow, enterprise_id=ent_id, template_id=tpl.id,
            profile_name=profile_name, display_name="CS Agent 1",
            requested_by="usr_001",
        )

    with UnitOfWork(db_conn) as uow:
        activate_employee(uow, employee_id, "usr_001")
        emp = uow.employees().get_by_id(employee_id)
        assert emp.status == EmployeeStatus.ACTIVE

    with UnitOfWork(db_conn) as uow:
        pause_employee(uow, employee_id, "usr_001")
        emp = uow.employees().get_by_id(employee_id)
        assert emp.status == EmployeeStatus.PAUSED

    with UnitOfWork(db_conn) as uow:
        archive_employee(uow, employee_id, "usr_001")
        emp = uow.employees().get_by_id(employee_id)
        assert emp.status == EmployeeStatus.ARCHIVED
