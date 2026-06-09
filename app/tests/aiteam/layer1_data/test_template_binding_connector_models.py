"""L1-S02b AgentTemplate / RecruitmentOrder / Prompt / Binding / Connector tests.

Covers T01-T16 per the L1 plan:
  T01 - agent_template status valid values
  T02 - recruitment_order status lifecycle pending→provisioning→succeeded/failed/cancelled
  T03 - employee_prompt 1:1 per employee, version_no monotonic
  T04 - employee_skill_binding unique (employee_id, skill_code)
  T05 - employee_knowledge_binding unique (employee_id, knowledge_base_id)
  T06 - employee_memory_binding unique employee, memory_mode valid
  T07 - enterprise_connector status valid + credential_ref not stored as plaintext
  T08 - employee_connector_binding unique (employee_id, connector_id) + access_mode valid
  T09-T11 - migration DDL tables exist with check constraints
  T12-T15 - repo persistence
"""

import pytest

from team_panel.domain.entities import (
    AgentTemplate,
    RecruitmentOrder,
    EmployeePrompt,
    EmployeeSkillBinding,
    EmployeeKnowledgeBinding,
    EmployeeMemoryBinding,
    EnterpriseConnector,
    EmployeeConnectorBinding,
)


# ═══════════════════════════════════════════════════════════════════
# T01: agent_template status valid values
# ═══════════════════════════════════════════════════════════════════

def test_agent_template_status_valid():
    """agent_template status must be one of draft/published/retired."""
    valid_statuses = {"draft", "published", "retired"}
    # entity default
    tpl = AgentTemplate(id="tpl_001", name="Customer Service")
    assert tpl.status == "draft"
    assert tpl.status in valid_statuses

    for st in valid_statuses:
        tpl = AgentTemplate(id="tpl_001", name="Test", status=st)
        assert tpl.status == st
        assert tpl.status in valid_statuses


def test_agent_template_publish_transition():
    tpl = AgentTemplate(id="tpl_001", name="Test", status="draft")
    tpl.publish()
    assert tpl.status == "published"


def test_agent_template_cannot_publish_from_published():
    tpl = AgentTemplate(id="tpl_001", name="Test", status="published")
    with pytest.raises(ValueError, match="Cannot publish"):
        tpl.publish()


def test_agent_template_retire():
    tpl = AgentTemplate(id="tpl_001", name="Test", status="published")
    tpl.retire()
    assert tpl.status == "retired"


def test_agent_template_source_type_default():
    tpl = AgentTemplate(id="tpl_001", name="Test")
    assert tpl.source_type == "system"


# ═══════════════════════════════════════════════════════════════════
# T02: recruitment_order status lifecycle
# ═══════════════════════════════════════════════════════════════════

def _make_recruitment_order(status="pending"):
    return RecruitmentOrder(
        id="ro_001", enterprise_id="ent_001",
        template_id="tpl_001", idempotency_key="ik_001",
        status=status,
    )


def test_recruitment_order_default_status_is_pending():
    ro = RecruitmentOrder(id="ro_001", enterprise_id="ent_001", idempotency_key="ik_001")
    assert ro.status == "pending"


def test_recruitment_order_pending_to_provisioning():
    ro = _make_recruitment_order("pending")
    ro.start_provisioning()
    assert ro.status == "provisioning"


def test_recruitment_order_provisioning_to_succeeded():
    ro = _make_recruitment_order("provisioning")
    ro.mark_succeeded("emp_001")
    assert ro.status == "succeeded"
    assert ro.created_employee_id == "emp_001"


def test_recruitment_order_provisioning_to_failed():
    ro = _make_recruitment_order("provisioning")
    ro.mark_failed("PROV_ERR", "Provision timed out")
    assert ro.status == "failed"
    assert ro.error_code == "PROV_ERR"
    assert ro.error_message == "Provision timed out"


def test_recruitment_order_cannot_mark_succeeded_from_pending():
    ro = _make_recruitment_order("pending")
    with pytest.raises(ValueError, match="Cannot mark succeeded"):
        ro.mark_succeeded("emp_001")


def test_recruitment_order_cannot_mark_failed_from_pending():
    ro = _make_recruitment_order("pending")
    with pytest.raises(ValueError, match="Cannot mark failed"):
        ro.mark_failed("PROV_ERR", "Provision timed out")


def test_recruitment_order_cancel_from_pending():
    ro = _make_recruitment_order("pending")
    ro.cancel()
    assert ro.status == "cancelled"


def test_recruitment_order_cancel_from_provisioning():
    ro = _make_recruitment_order("provisioning")
    ro.cancel()
    assert ro.status == "cancelled"


def test_recruitment_order_cannot_cancel_succeeded():
    ro = _make_recruitment_order("succeeded")
    with pytest.raises(ValueError, match="Cannot cancel"):
        ro.cancel()


def test_recruitment_order_cannot_cancel_already_cancelled():
    ro = _make_recruitment_order("cancelled")
    with pytest.raises(ValueError, match="Cannot cancel"):
        ro.cancel()


def test_recruitment_order_cannot_provision_from_succeeded():
    ro = _make_recruitment_order("succeeded")
    with pytest.raises(ValueError, match="Cannot provision"):
        ro.start_provisioning()


def test_recruitment_order_cannot_provision_from_failed():
    ro = _make_recruitment_order("failed")
    with pytest.raises(ValueError, match="Cannot provision"):
        ro.start_provisioning()


def test_recruitment_order_cannot_provision_from_cancelled():
    ro = _make_recruitment_order("cancelled")
    with pytest.raises(ValueError, match="Cannot provision"):
        ro.start_provisioning()


# ═══════════════════════════════════════════════════════════════════
# T03: employee_prompt 1:1 per employee, version_no monotonic
# ═══════════════════════════════════════════════════════════════════

def test_employee_prompt_default_version_is_one():
    ep = EmployeePrompt(employee_id="emp_001")
    assert ep.version_no == 1
    assert ep.system_prompt == ""
    assert ep.behavior_rules_json == "{}"


def test_employee_prompt_version_tracks_changes():
    ep = EmployeePrompt(employee_id="emp_001", system_prompt="v1", version_no=1)
    ep.system_prompt = "v2"
    ep.version_no = 2
    assert ep.version_no == 2
    assert ep.system_prompt == "v2"


# ═══════════════════════════════════════════════════════════════════
# T04: employee_skill_binding unique (employee_id, skill_code)
# ═══════════════════════════════════════════════════════════════════

def test_skill_binding_unique_employee_skill():
    """Entity allows creation; DB constraint enforces uniqueness at repo level."""
    binding = EmployeeSkillBinding(
        id="sb_001", enterprise_id="ent_001",
        employee_id="emp_001", skill_code="code_review",
    )
    assert binding.employee_id == "emp_001"
    assert binding.skill_code == "code_review"
    assert binding.enabled is True
    assert binding.source_type == "template_default"
    assert binding.visibility == "allow"


def test_skill_binding_enabled_disabled():
    binding = EmployeeSkillBinding(
        id="sb_001", enterprise_id="ent_001",
        employee_id="emp_001", skill_code="coding",
    )
    binding.enabled = False
    assert binding.enabled is False


def test_skill_binding_visibility_deny():
    binding = EmployeeSkillBinding(
        id="sb_001", enterprise_id="ent_001",
        employee_id="emp_001", skill_code="coding",
        visibility="deny",
    )
    assert binding.visibility == "deny"


# ═══════════════════════════════════════════════════════════════════
# T05: employee_knowledge_binding unique (employee_id, knowledge_base_id)
# ═══════════════════════════════════════════════════════════════════

def test_knowledge_binding_unique():
    kb = EmployeeKnowledgeBinding(
        id="kb_001", enterprise_id="ent_001",
        employee_id="emp_001", knowledge_base_id="kb_prod_docs",
    )
    assert kb.employee_id == "emp_001"
    assert kb.knowledge_base_id == "kb_prod_docs"
    assert kb.scope_mode == "read"
    assert kb.enabled is True


def test_knowledge_binding_scope_mode():
    kb = EmployeeKnowledgeBinding(
        id="kb_001", enterprise_id="ent_001",
        employee_id="emp_001", knowledge_base_id="kb_prod_docs",
        scope_mode="read_write_metadata",
    )
    assert kb.scope_mode == "read_write_metadata"


# ═══════════════════════════════════════════════════════════════════
# T06: employee_memory_binding unique per employee, memory_mode valid
# ═══════════════════════════════════════════════════════════════════

def test_memory_binding_unique_and_mode_valid():
    """Entity creates with valid mode; unique per employee enforced at DB layer."""
    mb = EmployeeMemoryBinding(
        id="mb_001", enterprise_id="ent_001",
        employee_id="emp_001", memory_mode="builtin",
    )
    assert mb.employee_id == "emp_001"
    assert mb.memory_mode == "builtin"
    assert mb.writeback_enabled is True

    for mode in ("builtin", "external", "disabled"):
        mb = EmployeeMemoryBinding(
            id="mb_001", enterprise_id="ent_001",
            employee_id="emp_001", memory_mode=mode,
        )
        assert mb.memory_mode == mode


# ═══════════════════════════════════════════════════════════════════
# T07: enterprise_connector status valid + credential_ref opaque
# ═══════════════════════════════════════════════════════════════════

def test_connector_status_and_credential_ref():
    """credential_ref is opaque reference — no plaintext secrets in the DB."""
    valid_statuses = {"draft", "online", "offline", "auth_failed", "archived"}

    for st in valid_statuses:
        ec = EnterpriseConnector(
            id="ec_001", enterprise_id="ent_001",
            name="Slack Workspace", provider_code="slack",
            connector_type="oauth_connector",
            credential_ref="cred://vault/slack/ent_001",
            status=st,
        )
        assert ec.status == st
        assert ec.credential_ref == "cred://vault/slack/ent_001"
        # credential_ref must be a reference, not a raw secret
        assert "sk-" not in ec.credential_ref
        assert "Bearer" not in ec.credential_ref


def test_connector_types():
    for ct in ("oauth_connector", "api_key_connector", "mcp_server", "webhook_target"):
        ec = EnterpriseConnector(
            id="ec_001", enterprise_id="ent_001",
            name="Test", provider_code="test",
            connector_type=ct, credential_ref="cred://vault/test",
        )
        assert ec.connector_type == ct


def test_connector_rotation_version_default():
    ec = EnterpriseConnector(
        id="ec_001", enterprise_id="ent_001",
        name="Test", provider_code="test",
        credential_ref="cred://vault/test",
    )
    assert ec.rotation_version == 1


# ═══════════════════════════════════════════════════════════════════
# T08: employee_connector_binding unique (employee_id, connector_id) + access_mode
# ═══════════════════════════════════════════════════════════════════

def test_connector_binding_unique_and_access_mode():
    """Entity creates with access_mode; unique (emp, conn) enforced at DB layer."""
    ecb = EmployeeConnectorBinding(
        id="ecb_001", enterprise_id="ent_001",
        employee_id="emp_001", connector_id="ec_001",
        access_mode="invoke",
    )
    assert ecb.employee_id == "emp_001"
    assert ecb.connector_id == "ec_001"
    assert ecb.access_mode == "invoke"
    assert ecb.enabled is True

    ecb2 = EmployeeConnectorBinding(
        id="ecb_002", enterprise_id="ent_001",
        employee_id="emp_001", connector_id="ec_001",
        access_mode="invoke_and_writeback",
    )
    assert ecb2.access_mode == "invoke_and_writeback"


# ═══════════════════════════════════════════════════════════════════
# T09-T15: Repository persistence tests (require PG)
# ═══════════════════════════════════════════════════════════════════

def _seed_enterprise(cur):
    from team_panel.domain.entities import Enterprise
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    EnterpriseRepo(cur).create(
        Enterprise(id="ent_001", slug="test", name="Test Enterprise",
                   status="active", owner_user_id="u1"))


def _seed_employee(cur):
    from team_panel.domain.entities import Employee
    from team_panel.repositories.employee_repo import EmployeeRepo
    EmployeeRepo(cur).create(
        Employee(id="emp_001", enterprise_id="ent_001",
                 profile_name="ent001-test-001", display_name="Test Agent",
                 status="active"))


# ── agent_template repo ──

def test_agent_template_repo_create_and_get(db_conn):
    from team_panel.repositories.agent_template_repo import AgentTemplateRepo
    _seed_enterprise(db_conn.cursor())

    repo = AgentTemplateRepo(db_conn.cursor())
    tpl = AgentTemplate(id="tpl_001", name="Customer Service",
                        category_code="support", role_name="Support Agent",
                        status="draft", source_type="system")
    repo.create(tpl)

    loaded = repo.get_by_id("tpl_001")
    assert loaded is not None
    assert loaded.id == "tpl_001"
    assert loaded.name == "Customer Service"
    assert loaded.status == "draft"
    assert loaded.version_no == 1


def test_agent_template_repo_list_by_status(db_conn):
    from team_panel.repositories.agent_template_repo import AgentTemplateRepo
    _seed_enterprise(db_conn.cursor())

    repo = AgentTemplateRepo(db_conn.cursor())
    repo.create(AgentTemplate(id="tpl_a", name="A", status="draft", source_type="system"))
    repo.create(AgentTemplate(id="tpl_b", name="B", status="published", source_type="system"))

    drafts = repo.list_by_status("draft")
    assert len(drafts) == 1
    assert drafts[0].id == "tpl_a"


def test_agent_template_repo_delete(db_conn):
    from team_panel.repositories.agent_template_repo import AgentTemplateRepo
    _seed_enterprise(db_conn.cursor())

    repo = AgentTemplateRepo(db_conn.cursor())
    repo.create(AgentTemplate(id="tpl_del", name="Del", status="draft", source_type="system"))
    repo.delete("tpl_del")
    loaded = repo.get_by_id("tpl_del")
    assert loaded is not None
    assert loaded.deleted_at is not None


# ── recruitment_order repo ──

def test_recruitment_order_repo_create_and_get(db_conn):
    from team_panel.repositories.recruitment_order_repo import RecruitmentOrderRepo
    _seed_enterprise(db_conn.cursor())

    repo = RecruitmentOrderRepo(db_conn.cursor())
    ro = RecruitmentOrder(id="ro_001", enterprise_id="ent_001",
                          status="pending", idempotency_key="ik_repo_001")
    repo.create(ro)

    loaded = repo.get_by_id("ro_001")
    assert loaded is not None
    assert loaded.id == "ro_001"
    assert loaded.enterprise_id == "ent_001"
    assert loaded.status == "pending"
    assert loaded.idempotency_key == "ik_repo_001"


def test_recruitment_order_idempotency_key_unique_violation(db_conn):
    """Duplicate (enterprise_id, idempotency_key) raises DB error."""
    import psycopg2
    from team_panel.repositories.recruitment_order_repo import RecruitmentOrderRepo
    _seed_enterprise(db_conn.cursor())

    repo = RecruitmentOrderRepo(db_conn.cursor())
    ro1 = RecruitmentOrder(id="ro_a", enterprise_id="ent_001",
                           status="pending", idempotency_key="ik_dup")
    repo.create(ro1)
    ro2 = RecruitmentOrder(id="ro_b", enterprise_id="ent_001",
                           status="pending", idempotency_key="ik_dup")
    with pytest.raises(psycopg2.errors.UniqueViolation):
        repo.create(ro2)


# ── employee_prompt repo ──

def test_employee_prompt_repo_create_and_get(db_conn):
    from team_panel.repositories.employee_prompt_repo import EmployeePromptRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = EmployeePromptRepo(db_conn.cursor())
    ep = EmployeePrompt(employee_id="emp_001", system_prompt="You are helpful.",
                         version_no=1)
    repo.create(ep)

    loaded = repo.get_by_id("emp_001")
    assert loaded is not None
    assert loaded.employee_id == "emp_001"
    assert loaded.system_prompt == "You are helpful."
    assert loaded.version_no == 1


def test_employee_prompt_repo_update_version(db_conn):
    from team_panel.repositories.employee_prompt_repo import EmployeePromptRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = EmployeePromptRepo(db_conn.cursor())
    ep = EmployeePrompt(employee_id="emp_001", system_prompt="v1", version_no=1)
    repo.create(ep)

    ep.system_prompt = "v2"
    ep.version_no = 2
    repo.update(ep)

    loaded = repo.get_by_id("emp_001")
    assert loaded.system_prompt == "v2"
    assert loaded.version_no == 2


def test_employee_prompt_one_to_one_employee():
    """Entity represents 1:1 per employee; PK enforced at DB DDL (employee_id)."""
    ep1 = EmployeePrompt(employee_id="emp_001", system_prompt="v1")
    ep2 = EmployeePrompt(employee_id="emp_002", system_prompt="v2")
    assert ep1.employee_id != ep2.employee_id


# ── employee_skill_binding repo ──

def test_skill_binding_repo_create_and_get(db_conn):
    from team_panel.repositories.employee_skill_binding_repo import EmployeeSkillBindingRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = EmployeeSkillBindingRepo(db_conn.cursor())
    sb = EmployeeSkillBinding(id="sb_001", enterprise_id="ent_001",
                              employee_id="emp_001", skill_code="code_review",
                              source_type="manual", visibility="allow")
    repo.create(sb)

    loaded = repo.get_by_id("sb_001")
    assert loaded is not None
    assert loaded.skill_code == "code_review"
    assert loaded.enabled is True


def test_skill_binding_unique_employee_skill_db(db_conn):
    """Duplicate (employee_id, skill_code) raises DB error via unique index."""
    import psycopg2
    from team_panel.repositories.employee_skill_binding_repo import EmployeeSkillBindingRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = EmployeeSkillBindingRepo(db_conn.cursor())
    sb1 = EmployeeSkillBinding(id="sb_a", enterprise_id="ent_001",
                               employee_id="emp_001", skill_code="same_skill")
    repo.create(sb1)
    sb2 = EmployeeSkillBinding(id="sb_b", enterprise_id="ent_001",
                               employee_id="emp_001", skill_code="same_skill")
    with pytest.raises(psycopg2.errors.UniqueViolation):
        repo.create(sb2)


# ── employee_knowledge_binding repo ──

def test_knowledge_binding_repo_create_and_get(db_conn):
    from team_panel.repositories.employee_knowledge_binding_repo import EmployeeKnowledgeBindingRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = EmployeeKnowledgeBindingRepo(db_conn.cursor())
    kb = EmployeeKnowledgeBinding(id="kb_001", enterprise_id="ent_001",
                                  employee_id="emp_001",
                                  knowledge_base_id="kb_prod_docs",
                                  scope_mode="read")
    repo.create(kb)

    loaded = repo.get_by_id("kb_001")
    assert loaded is not None
    assert loaded.knowledge_base_id == "kb_prod_docs"
    assert loaded.scope_mode == "read"


def test_knowledge_binding_unique_db(db_conn):
    import psycopg2
    from team_panel.repositories.employee_knowledge_binding_repo import EmployeeKnowledgeBindingRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = EmployeeKnowledgeBindingRepo(db_conn.cursor())
    repo.create(EmployeeKnowledgeBinding(id="kb_a", enterprise_id="ent_001",
                                          employee_id="emp_001",
                                          knowledge_base_id="kb_dup"))
    with pytest.raises(psycopg2.errors.UniqueViolation):
        repo.create(EmployeeKnowledgeBinding(id="kb_b", enterprise_id="ent_001",
                                              employee_id="emp_001",
                                              knowledge_base_id="kb_dup"))


# ── employee_memory_binding repo ──

def test_memory_binding_repo_create_and_get(db_conn):
    from team_panel.repositories.employee_memory_binding_repo import EmployeeMemoryBindingRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = EmployeeMemoryBindingRepo(db_conn.cursor())
    mb = EmployeeMemoryBinding(id="mb_001", enterprise_id="ent_001",
                               employee_id="emp_001", memory_mode="builtin")
    repo.create(mb)

    loaded = repo.get_by_id("mb_001")
    assert loaded is not None
    assert loaded.employee_id == "emp_001"
    assert loaded.memory_mode == "builtin"


def test_memory_binding_unique_employee_db(db_conn):
    import psycopg2
    from team_panel.repositories.employee_memory_binding_repo import EmployeeMemoryBindingRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())

    repo = EmployeeMemoryBindingRepo(db_conn.cursor())
    repo.create(EmployeeMemoryBinding(id="mb_a", enterprise_id="ent_001",
                                      employee_id="emp_001", memory_mode="builtin"))
    with pytest.raises(psycopg2.errors.UniqueViolation):
        repo.create(EmployeeMemoryBinding(id="mb_b", enterprise_id="ent_001",
                                          employee_id="emp_001", memory_mode="external"))


# ── enterprise_connector repo ──

def test_connector_repo_create_and_get(db_conn):
    from team_panel.repositories.connector_repo import EnterpriseConnectorRepo
    _seed_enterprise(db_conn.cursor())

    repo = EnterpriseConnectorRepo(db_conn.cursor())
    ec = EnterpriseConnector(id="ec_001", enterprise_id="ent_001",
                              name="Slack", provider_code="slack",
                              connector_type="oauth_connector",
                              credential_ref="cred://vault/slack/ent_001",
                              status="draft")
    repo.create(ec)

    loaded = repo.get_by_id("ec_001")
    assert loaded is not None
    assert loaded.name == "Slack"
    assert loaded.provider_code == "slack"
    assert loaded.credential_ref == "cred://vault/slack/ent_001"
    assert loaded.status == "draft"


def test_connector_status_auth_failed(db_conn):
    from team_panel.repositories.connector_repo import EnterpriseConnectorRepo
    _seed_enterprise(db_conn.cursor())

    repo = EnterpriseConnectorRepo(db_conn.cursor())
    ec = EnterpriseConnector(id="ec_002", enterprise_id="ent_001",
                              name="BadConn", provider_code="test",
                              connector_type="api_key_connector",
                              credential_ref="cred://vault/test",
                              status="auth_failed")
    repo.create(ec)
    loaded = repo.get_by_id("ec_002")
    assert loaded.status == "auth_failed"


# ── employee_connector_binding repo ──

def test_connector_binding_repo_create_and_get(db_conn):
    from team_panel.repositories.connector_repo import EnterpriseConnectorRepo
    from team_panel.repositories.employee_connector_binding_repo import EmployeeConnectorBindingRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())
    EnterpriseConnectorRepo(db_conn.cursor()).create(
        EnterpriseConnector(id="ec_001", enterprise_id="ent_001",
                            name="Slack", provider_code="slack",
                            connector_type="oauth_connector",
                            credential_ref="cred://vault/slack/ent_001",
                            status="online"))

    repo = EmployeeConnectorBindingRepo(db_conn.cursor())
    ecb = EmployeeConnectorBinding(id="ecb_001", enterprise_id="ent_001",
                                    employee_id="emp_001", connector_id="ec_001",
                                    access_mode="invoke")
    repo.create(ecb)

    loaded = repo.get_by_id("ecb_001")
    assert loaded is not None
    assert loaded.employee_id == "emp_001"
    assert loaded.connector_id == "ec_001"
    assert loaded.access_mode == "invoke"
    assert loaded.enabled is True


def test_connector_binding_unique_db(db_conn):
    import psycopg2
    from team_panel.repositories.connector_repo import EnterpriseConnectorRepo
    from team_panel.repositories.employee_connector_binding_repo import EmployeeConnectorBindingRepo
    _seed_enterprise(db_conn.cursor())
    _seed_employee(db_conn.cursor())
    EnterpriseConnectorRepo(db_conn.cursor()).create(
        EnterpriseConnector(id="ec_001", enterprise_id="ent_001",
                            name="Slack", provider_code="slack",
                            connector_type="oauth_connector",
                            credential_ref="cred://vault/slack/ent_001",
                            status="online"))

    repo = EmployeeConnectorBindingRepo(db_conn.cursor())
    repo.create(EmployeeConnectorBinding(id="ecb_a", enterprise_id="ent_001",
                                          employee_id="emp_001", connector_id="ec_001",
                                          access_mode="invoke"))
    with pytest.raises(psycopg2.errors.UniqueViolation):
        repo.create(EmployeeConnectorBinding(id="ecb_b", enterprise_id="ent_001",
                                              employee_id="emp_001", connector_id="ec_001",
                                              access_mode="invoke_and_writeback"))


# ═══════════════════════════════════════════════════════════════════
# T09-T11: Migration DDL tests (verify tables exist with constraints)
# ═══════════════════════════════════════════════════════════════════

def test_migration_s02b_tables_exist(db_conn):
    """Verify all S02b DDL tables exist in the DB after migration."""
    cur = db_conn.cursor()
    try:
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN (
                'agent_template', 'recruitment_order', 'employee_prompt',
                'employee_skill_binding', 'employee_knowledge_binding',
                'employee_memory_binding', 'enterprise_connector',
                'employee_connector_binding'
              )
            ORDER BY table_name
        """)
        rows = cur.fetchall()
        tables = {r[0] for r in rows}
        expected = {
            'agent_template', 'recruitment_order', 'employee_prompt',
            'employee_skill_binding', 'employee_knowledge_binding',
            'employee_memory_binding', 'enterprise_connector',
            'employee_connector_binding',
        }
        assert tables == expected, f"Missing tables: {expected - tables}"
    finally:
        cur.close()


def test_migration_s02b_agent_template_check_constraint(db_conn):
    """agent_template CHECK constraints reject invalid status/source_type."""
    import psycopg2
    _seed_enterprise(db_conn.cursor())
    cur = db_conn.cursor()
    try:
        with pytest.raises(psycopg2.errors.CheckViolation):
            cur.execute(
                """INSERT INTO agent_template (id, name, status)
                   VALUES ('tpl_bad', 'Bad', 'invalid_status')""")
    finally:
        cur.close()


def test_migration_s02b_recruitment_order_check_constraint(db_conn):
    """recruitment_order CHECK constraint rejects invalid status."""
    import psycopg2
    _seed_enterprise(db_conn.cursor())
    cur = db_conn.cursor()
    try:
        with pytest.raises(psycopg2.errors.CheckViolation):
            cur.execute(
                """INSERT INTO recruitment_order (id, enterprise_id, idempotency_key, status)
                   VALUES ('ro_bad', 'ent_001', 'ik_bad', 'invalid')""")
    finally:
        cur.close()


def test_migration_s02b_enterprise_connector_check_constraint(db_conn):
    """enterprise_connector CHECK constraint rejects invalid status/connector_type."""
    import psycopg2
    _seed_enterprise(db_conn.cursor())
    cur = db_conn.cursor()
    try:
        with pytest.raises(psycopg2.errors.CheckViolation):
            cur.execute(
                """INSERT INTO enterprise_connector (id, enterprise_id, name, provider_code,
                   connector_type, credential_ref, status)
                   VALUES ('ec_bad', 'ent_001', 'Bad', 'test', 'bad_type', 'ref', 'draft')""")
    finally:
        cur.close()
