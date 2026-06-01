-- 001: Core enterprise / membership / employee tables
-- PostgreSQL syntax (V1 control plane database)
-- L1-S02 slice per domain model detailed design §6.1–§6.5

CREATE TABLE IF NOT EXISTS enterprise (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','suspended','archived')),
    owner_user_id TEXT NOT NULL,
    default_workspace_id TEXT,
    archive_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_enterprise_owner ON enterprise(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_status ON enterprise(status);

CREATE TABLE IF NOT EXISTS membership (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','enterprise_admin','finance_admin','member')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','invited','disabled','removed')),
    permissions_json JSONB DEFAULT '{}',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ,
    UNIQUE(enterprise_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_membership_enterprise ON membership(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_membership_enterprise_role ON membership(enterprise_id, role);
CREATE INDEX IF NOT EXISTS idx_membership_status ON membership(status);

CREATE TABLE IF NOT EXISTS employee (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    template_id TEXT,
    profile_name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    role_name TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','provisioning','active','paused','provisioning_failed','archived')),
    created_from TEXT CHECK(created_from IN ('talent_market','manual','solution_apply','admin_seed')),
    model_provider TEXT,
    model_name TEXT,
    prompt_version INTEGER DEFAULT 1,
    config_version INTEGER DEFAULT 1,
    avatar_url TEXT,
    description TEXT,
    archive_reason TEXT,
    last_provisioned_at TIMESTAMPTZ,
    capabilities_json JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_employee_enterprise ON employee(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_employee_enterprise_status ON employee(enterprise_id, status);
CREATE INDEX IF NOT EXISTS idx_employee_enterprise_role ON employee(enterprise_id, role_name);
CREATE INDEX IF NOT EXISTS idx_employee_profile ON employee(profile_name);
CREATE INDEX IF NOT EXISTS idx_employee_template ON employee(template_id);

-- §6.3 agent_template: 模板市场与行业方案引用基础
CREATE TABLE IF NOT EXISTS agent_template (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category_code TEXT DEFAULT '',
    role_name TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','published','retired')),
    prompt_pack_json JSONB DEFAULT '{}',
    default_model_json JSONB DEFAULT '{}',
    default_binding_json JSONB DEFAULT '{}',
    version_no INTEGER DEFAULT 1,
    source_type TEXT NOT NULL DEFAULT 'system'
        CHECK(source_type IN ('system','enterprise_custom')),
    owner_enterprise_id TEXT REFERENCES enterprise(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_template_owner_name_version ON agent_template(owner_enterprise_id, name, version_no);
CREATE INDEX IF NOT EXISTS idx_template_category_status ON agent_template(category_code, status);
CREATE INDEX IF NOT EXISTS idx_template_source ON agent_template(source_type);

-- §6.4 recruitment_order: 招募幂等流水与失败重试
CREATE TABLE IF NOT EXISTS recruitment_order (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    template_id TEXT REFERENCES agent_template(id),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','provisioning','succeeded','failed','cancelled')),
    requested_by TEXT,
    created_employee_id TEXT,
    error_code TEXT,
    error_message TEXT,
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_recruitment_enterprise_idempotency ON recruitment_order(enterprise_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_recruitment_enterprise_status ON recruitment_order(enterprise_id, status);
CREATE INDEX IF NOT EXISTS idx_recruitment_template ON recruitment_order(template_id);

-- §6.6 employee_prompt: 管理可编辑 Prompt 与行为约束版本
CREATE TABLE IF NOT EXISTS employee_prompt (
    employee_id TEXT PRIMARY KEY REFERENCES employee(id),
    system_prompt TEXT NOT NULL DEFAULT '',
    behavior_rules_json JSONB DEFAULT '{}',
    opening_message TEXT,
    version_no INTEGER DEFAULT 1,
    source_template_version INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_employee_prompt_version ON employee_prompt(version_no);

-- §6.7 employee_skill_binding
CREATE TABLE IF NOT EXISTS employee_skill_binding (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    employee_id TEXT NOT NULL REFERENCES employee(id),
    skill_code TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    source_type TEXT NOT NULL DEFAULT 'template_default'
        CHECK(source_type IN ('template_default','manual','solution_apply','system_policy')),
    binding_version INTEGER DEFAULT 1,
    visibility TEXT NOT NULL DEFAULT 'allow'
        CHECK(visibility IN ('allow','deny')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_emp_skill ON employee_skill_binding(employee_id, skill_code);
CREATE INDEX IF NOT EXISTS idx_emp_skill_enterprise ON employee_skill_binding(employee_id, enabled);
CREATE INDEX IF NOT EXISTS idx_emp_skill_code ON employee_skill_binding(skill_code);

-- §6.8 employee_knowledge_binding
CREATE TABLE IF NOT EXISTS employee_knowledge_binding (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    employee_id TEXT NOT NULL REFERENCES employee(id),
    knowledge_base_id TEXT NOT NULL,
    scope_mode TEXT NOT NULL DEFAULT 'read'
        CHECK(scope_mode IN ('read','read_write_metadata')),
    enabled BOOLEAN DEFAULT TRUE,
    binding_version INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_emp_kb ON employee_knowledge_binding(employee_id, knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_emp_kb_employee ON employee_knowledge_binding(employee_id, enabled);
CREATE INDEX IF NOT EXISTS idx_emp_kb_kb ON employee_knowledge_binding(knowledge_base_id);

-- §6.9 employee_memory_binding
CREATE TABLE IF NOT EXISTS employee_memory_binding (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    employee_id TEXT NOT NULL REFERENCES employee(id),
    memory_mode TEXT NOT NULL DEFAULT 'builtin'
        CHECK(memory_mode IN ('builtin','external','disabled')),
    provider_code TEXT,
    retention_days INTEGER,
    writeback_enabled BOOLEAN DEFAULT TRUE,
    binding_version INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_emp_memory ON employee_memory_binding(employee_id);
CREATE INDEX IF NOT EXISTS idx_emp_memory_mode ON employee_memory_binding(memory_mode);

-- §6.10 enterprise_connector: 企业连接器主数据
CREATE TABLE IF NOT EXISTS enterprise_connector (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    name TEXT NOT NULL,
    provider_code TEXT NOT NULL,
    connector_type TEXT NOT NULL
        CHECK(connector_type IN ('oauth_connector','api_key_connector','mcp_server','webhook_target')),
    credential_ref TEXT NOT NULL,
    rotation_version INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','online','offline','auth_failed','archived')),
    config_json JSONB DEFAULT '{}',
    last_validated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_connector_enterprise_name ON enterprise_connector(enterprise_id, name);
CREATE INDEX IF NOT EXISTS idx_connector_enterprise_status ON enterprise_connector(enterprise_id, status);
CREATE INDEX IF NOT EXISTS idx_connector_provider ON enterprise_connector(provider_code);
CREATE INDEX IF NOT EXISTS idx_connector_credential_ref ON enterprise_connector(credential_ref);

-- §6.11 employee_connector_binding
CREATE TABLE IF NOT EXISTS employee_connector_binding (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    employee_id TEXT NOT NULL REFERENCES employee(id),
    connector_id TEXT NOT NULL REFERENCES enterprise_connector(id),
    enabled BOOLEAN DEFAULT TRUE,
    access_mode TEXT NOT NULL DEFAULT 'invoke'
        CHECK(access_mode IN ('invoke','invoke_and_writeback')),
    binding_version INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_emp_connector ON employee_connector_binding(employee_id, connector_id);
CREATE INDEX IF NOT EXISTS idx_emp_connector_employee ON employee_connector_binding(employee_id, enabled);
CREATE INDEX IF NOT EXISTS idx_emp_connector_connector ON employee_connector_binding(connector_id);

-- L1-S03: Conversation / TeamRun / TeamTask aggregates (§6.12–§6.15)

CREATE TABLE IF NOT EXISTS conversation (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    type TEXT NOT NULL CHECK(type IN ('private','group')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','active','paused','muted','archived')),
    title TEXT DEFAULT '',
    entry_employee_id TEXT REFERENCES employee(id),
    latest_run_id TEXT,
    last_message_preview TEXT,
    last_message_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
-- Constraints:
-- type=private → entry_employee_id NOT NULL (enforced at application layer)
-- type=group → entry_employee_id IS NULL (enforced at application layer)
CREATE UNIQUE INDEX IF NOT EXISTS uk_private_conversation ON conversation(enterprise_id, type, entry_employee_id, created_by, deleted_at)
    WHERE type = 'private' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_enterprise_status ON conversation(enterprise_id, status);
CREATE INDEX IF NOT EXISTS idx_conversation_latest_run ON conversation(latest_run_id);
CREATE INDEX IF NOT EXISTS idx_conversation_last_message ON conversation(last_message_at);

CREATE TABLE IF NOT EXISTS conversation_member (
    member_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id),
    member_type TEXT NOT NULL CHECK(member_type IN ('employee','user')),
    member_ref_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'participant'
        CHECK(role IN ('owner','participant','observer')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','removed')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_conv_member ON conversation_member(conversation_id, member_type, member_ref_id);
CREATE INDEX IF NOT EXISTS idx_conv_member_conversation ON conversation_member(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_conv_member_ref ON conversation_member(member_type, member_ref_id);

CREATE TABLE IF NOT EXISTS team_run (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    conversation_id TEXT REFERENCES conversation(id),
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('private_message','group_message','manual_run','scheduled_job','api_call')),
    execution_mode TEXT NOT NULL DEFAULT 'single_agent'
        CHECK(execution_mode IN ('single_agent','kanban_orchestration','cron_single_agent')),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','routing','submitting','running','waiting_human','succeeded','failed','cancelled')),
    entry_employee_id TEXT,
    planner_employee_id TEXT,
    root_team_task_id TEXT,
    scheduled_job_id TEXT,
    idempotency_key TEXT,
    input_message_json JSONB DEFAULT '{}',
    result_summary_json JSONB,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_run_idempotency ON team_run(idempotency_key)
    WHERE idempotency_key IS NOT NULL AND idempotency_key != '';
CREATE INDEX IF NOT EXISTS idx_run_enterprise_status ON team_run(enterprise_id, status);
CREATE INDEX IF NOT EXISTS idx_run_conversation ON team_run(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_employee ON team_run(entry_employee_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_job ON team_run(scheduled_job_id, created_at);

CREATE TABLE IF NOT EXISTS team_task (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES team_run(id),
    parent_team_task_id TEXT REFERENCES team_task(id),
    title TEXT DEFAULT '',
    description TEXT,
    assignee_employee_id TEXT REFERENCES employee(id),
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK(status IN ('planned','queued','running','waiting_deps','succeeded','failed','cancelled')),
    sequence_no INTEGER DEFAULT 0,
    depth INTEGER DEFAULT 0,
    input_payload_json JSONB,
    output_summary_json JSONB,
    runtime_task_id TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_team_task_run ON team_task(run_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_team_task_parent ON team_task(parent_team_task_id);
CREATE INDEX IF NOT EXISTS idx_team_task_assignee ON team_task(assignee_employee_id, status);
CREATE INDEX IF NOT EXISTS idx_team_task_runtime ON team_task(runtime_task_id);

-- L1-S04: ScheduledJob / RuntimeBinding / RunEvent / AuditEvent aggregates (§6.16–§6.19)

CREATE TABLE IF NOT EXISTS scheduled_job (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    employee_id TEXT NOT NULL REFERENCES employee(id),
    name TEXT NOT NULL DEFAULT '',
    goal TEXT DEFAULT '',
    schedule_expr TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','enabled','paused','error','archived')),
    max_consecutive_failures INTEGER DEFAULT 3,
    consecutive_failures INTEGER DEFAULT 0,
    last_run_status TEXT CHECK(last_run_status IN ('succeeded','failed','cancelled')),
    last_run_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    runtime_job_id TEXT,
    notification_policy_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_job_employee_name ON scheduled_job(employee_id, name);
CREATE INDEX IF NOT EXISTS idx_job_enterprise_status ON scheduled_job(enterprise_id, status);
CREATE INDEX IF NOT EXISTS idx_job_employee ON scheduled_job(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_job_runtime ON scheduled_job(runtime_job_id);

CREATE TABLE IF NOT EXISTS runtime_binding (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    owner_type TEXT NOT NULL CHECK(owner_type IN ('employee','team_run','team_task','scheduled_job')),
    owner_id TEXT NOT NULL,
    profile_name TEXT NOT NULL,
    runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('profile','session','kanban_task','cron_job')),
    runtime_session_id TEXT,
    runtime_task_id TEXT,
    runtime_job_id TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(sync_status IN ('pending','synced','dirty','failed','orphaned')),
    event_cursor INTEGER DEFAULT 0,
    runtime_source_cursor TEXT,
    last_synced_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT,
    updated_by TEXT,
    deleted_at TIMESTAMPTZ
);
-- 注：runtime_kind 是数据库层枚举（含 profile），不同于 Gateway RuntimeHandle.kind（含 composite）。
CREATE UNIQUE INDEX IF NOT EXISTS uk_runtime_binding_owner ON runtime_binding(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_runtime_binding_profile ON runtime_binding(profile_name);
CREATE INDEX IF NOT EXISTS idx_runtime_binding_task ON runtime_binding(runtime_task_id);
CREATE INDEX IF NOT EXISTS idx_runtime_binding_job ON runtime_binding(runtime_job_id);
CREATE INDEX IF NOT EXISTS idx_runtime_binding_session ON runtime_binding(runtime_session_id);
CREATE INDEX IF NOT EXISTS idx_runtime_binding_sync ON runtime_binding(sync_status);

CREATE TABLE IF NOT EXISTS run_event (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id),
    run_id TEXT NOT NULL REFERENCES team_run(id),
    team_task_id TEXT REFERENCES team_task(id),
    cursor_no BIGINT NOT NULL,
    event_type TEXT NOT NULL
        CHECK(event_type IN ('run_created','routing_decided','run_started','message_delta','tool_call','task_created','task_started','task_completed','task_failed','run_waiting_human','result_merged','memory_written','usage_recorded','run_succeeded','run_failed','run_cancelled','heartbeat','error')),
    source_type TEXT NOT NULL
        CHECK(source_type IN ('session','kanban_task','cron_job','gateway','system')),
    source_id TEXT NOT NULL,
    employee_id TEXT,
    event_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    preview_text TEXT,
    payload_json JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_run_event_run_cursor ON run_event(run_id, cursor_no);
CREATE INDEX IF NOT EXISTS idx_run_event_run_ts ON run_event(run_id, event_ts);
CREATE INDEX IF NOT EXISTS idx_run_event_type ON run_event(event_type);
CREATE INDEX IF NOT EXISTS idx_run_event_source ON run_event(source_type, source_id);

CREATE TABLE IF NOT EXISTS audit_event (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('user','employee','system','gateway')),
    actor_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    request_id TEXT,
    payload_json JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_enterprise_created ON audit_event(enterprise_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_event(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_event(event_type);
