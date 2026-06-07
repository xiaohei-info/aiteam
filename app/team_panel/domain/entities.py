"""Team Panel domain entities — mutable, identity by ID.

Enterprise / Membership / Employee aggregate per L1-S02 plan.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from .enums import EmployeeStatus, EnterpriseRole


@dataclass
class AgentTemplate:
    id: str
    name: str = ""
    category_code: str = ""
    role_name: str = ""
    status: str = "draft"  # draft | published | retired
    prompt_pack_json: str = "{}"
    default_model_json: str = "{}"
    default_binding_json: str = "{}"
    version_no: int = 1
    source_type: str = "system"  # system | enterprise_custom
    owner_enterprise_id: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    def publish(self):
        if self.status != "draft":
            raise ValueError(f"Cannot publish from {self.status}")
        self.status = "published"

    def retire(self):
        self.status = "retired"


@dataclass
class IndustrySolution:
    id: str
    name: str = ""
    status: str = "draft"  # draft | published | retired
    tags_json: str = "[]"
    default_kb_blueprint_json: str = "{}"
    default_skill_bundle_json: str = "{}"
    default_collaboration_template_ref: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class SolutionTemplateBinding:
    id: str
    solution_id: str
    template_id: str
    sequence_no: int = 1
    enabled: bool = True
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class RecruitmentOrder:
    id: str
    enterprise_id: str
    template_id: Optional[str] = None
    status: str = "pending"  # pending | provisioning | succeeded | failed | cancelled
    requested_by: str = ""
    created_employee_id: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    idempotency_key: str = ""
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    def start_provisioning(self):
        if self.status != "pending":
            raise ValueError(f"Cannot provision from {self.status}")
        self.status = "provisioning"

    def mark_succeeded(self, employee_id: str):
        if self.status != "provisioning":
            raise ValueError(f"Cannot mark succeeded from {self.status}")
        self.status = "succeeded"
        self.created_employee_id = employee_id

    def mark_failed(self, error_code: str, error_message: str):
        if self.status != "provisioning":
            raise ValueError(f"Cannot mark failed from {self.status}")
        self.status = "failed"
        self.error_code = error_code
        self.error_message = error_message

    def cancel(self):
        if self.status in ("succeeded", "cancelled"):
            raise ValueError(f"Cannot cancel from {self.status}")
        self.status = "cancelled"


@dataclass
class EmployeePrompt:
    employee_id: str
    system_prompt: str = ""
    behavior_rules_json: str = "{}"
    opening_message: Optional[str] = None
    version_no: int = 1
    source_template_version: Optional[int] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class EmployeeSkillBinding:
    id: str
    enterprise_id: str
    employee_id: str
    skill_code: str
    enabled: bool = True
    source_type: str = "template_default"  # template_default | manual | solution_apply | system_policy
    binding_version: int = 1
    visibility: str = "allow"  # allow | deny
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class EmployeeKnowledgeBinding:
    id: str
    enterprise_id: str
    employee_id: str
    knowledge_base_id: str
    scope_mode: str = "read"  # read | read_write_metadata
    enabled: bool = True
    binding_version: int = 1
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class EmployeeMemoryBinding:
    id: str
    enterprise_id: str
    employee_id: str
    memory_mode: str = "builtin"  # builtin | external | disabled
    provider_code: Optional[str] = None
    retention_days: Optional[int] = None
    writeback_enabled: bool = True
    binding_version: int = 1
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class ConnectorDefinition:
    id: str
    provider_code: str
    connector_type: str
    display_name: str = ""
    auth_scheme: str = "opaque_ref"  # oauth2 | api_key | mcp | webhook | opaque_ref
    config_schema_json: str = "{}"
    status: str = "active"  # active | deprecated | hidden
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class EnterpriseSkillInstall:
    id: str
    enterprise_id: str
    skill_code: str
    display_name: str = ""
    description: str = ""
    source_marketplace: str = "custom"  # clawhub | skillhub | custom | builtin
    version: str = "1.0.0"
    latest_version: str = "1.0.0"
    scope_mode: str = "selected_employees"  # all_employees | selected_employees
    install_status: str = "active"  # active | update_available | uninstalled
    manifest_json: str = "{}"
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class MemoryItem:
    id: str
    enterprise_id: str
    employee_id: str
    content: str
    category: str = "event"  # preference | habit | decision | event
    importance: int = 3
    source_type: str = "manual"  # manual | extraction | system_policy
    tags_json: str = "[]"
    visibility_scope: str = "enterprise"  # enterprise | admin_only
    runtime_ref_json: str = "{}"
    last_used_at: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class MemoryReviewDecision:
    id: str
    enterprise_id: str
    memory_item_id: str
    reviewer_user_id: str = ""
    decision: str = "pending"  # pending | confirmed | rejected | corrected
    comment: Optional[str] = None
    corrected_content: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class EnterpriseConnector:
    id: str
    enterprise_id: str
    definition_id: Optional[str] = None
    name: str = ""
    provider_code: str = ""
    connector_type: str = "api_key_connector"  # oauth_connector | api_key_connector | mcp_server | webhook_target
    credential_ref: str = ""
    credential_mask: str = "未配置"
    credential_state: str = "missing"  # missing | configured | rotated | invalid | revoked
    rotation_version: int = 1
    status: str = "draft"  # draft | online | offline | auth_failed | archived
    config_json: str = "{}"
    scopes_json: str = "[]"
    last_test_result_json: str = '{"result": "never_tested"}'
    last_validated_at: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class EmployeeConnectorBinding:
    id: str
    enterprise_id: str
    employee_id: str
    connector_id: str
    enabled: bool = True
    access_mode: str = "invoke"  # invoke | invoke_and_writeback
    binding_version: int = 1
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


# ═══════════════════════════════════════════════════════════════════
# L1-S03: Conversation / TeamRun / TeamTask aggregates
# ═══════════════════════════════════════════════════════════════════

@dataclass
class Conversation:
    """私聊/群聊会话 (§6.1)."""
    id: str
    enterprise_id: str
    type: str = "private"           # "private" | "group"
    status: str = "draft"            # draft|active|paused|muted|archived
    title: str = ""
    entry_employee_id: Optional[str] = None
    latest_run_id: Optional[str] = None
    latest_message_id: Optional[str] = None
    last_message_preview: Optional[str] = None
    last_message_at: str = ""
    created_by: str = ""
    archived_at: str = ""
    created_at: str = ""
    updated_at: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    def activate(self) -> None:
        if self.status == "archived":
            raise ValueError(f"Cannot activate from {self.status}")
        self.status = "active"

    def pause(self) -> None:
        if self.status != "active":
            raise ValueError(f"Cannot pause from {self.status}; must be active")
        self.status = "paused"

    def resume(self) -> None:
        if self.status != "paused":
            raise ValueError(f"Cannot resume from {self.status}; must be paused")
        self.status = "active"

    def mute(self) -> None:
        if self.status != "active":
            raise ValueError(f"Cannot mute from {self.status}; must be active")
        self.status = "muted"

    def unmute(self) -> None:
        if self.status != "muted":
            raise ValueError(f"Cannot unmute from {self.status}; must be muted")
        self.status = "active"

    def archive(self) -> None:
        if self.status == "archived":
            raise ValueError("Already archived")
        self.status = "archived"

    def is_private(self) -> bool:
        return self.type == "private"

    def is_group(self) -> bool:
        return self.type == "group"


@dataclass
class ConversationMember:
    """会话成员关系 (§6.2)."""
    member_id: str
    conversation_id: str
    member_type: str = "employee"    # "employee" | "user"
    member_ref_id: str = ""
    role: str = "participant"        # "owner" | "participant" | "observer"
    status: str = "active"           # "active" | "removed"
    joined_at: str = ""
    removed_at: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""

    def remove(self) -> None:
        if self.status == "removed":
            raise ValueError("Already removed")
        self.status = "removed"


@dataclass
class ConversationMessage:
    """会话消息业务物件 — 群消息提交产生的持久化消息 artifact (§5.4)."""
    id: str
    conversation_id: str
    sender_id: str = ""
    sender_type: str = "user"       # "employee" | "user"
    message_text: str = ""
    message_json: str = "{}"
    run_id: Optional[str] = None
    created_at: str = ""


@dataclass
class TeamRun:
    """单次执行/编排运行 (§6.3)."""
    id: str
    enterprise_id: str
    conversation_id: Optional[str] = None
    trigger_type: str = ""           # private_message|group_message|manual_run|scheduled_job|api_call
    execution_mode: str = "single_agent"  # single_agent|kanban_orchestration|cron_single_agent
    status: str = "queued"           # queued|routing|submitting|running|waiting_human|succeeded|failed|cancelled
    entry_employee_id: Optional[str] = None
    planner_employee_id: Optional[str] = None
    root_team_task_id: Optional[str] = None
    scheduled_job_id: Optional[str] = None
    idempotency_key: str = ""
    input_message_json: str = "{}"
    result_summary_json: Optional[str] = None
    started_at: str = ""
    finished_at: str = ""
    error_code: str = ""
    error_message: str = ""
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    # ── Lifecycle transitions (§6.3) ────────────────────────────────

    _TERMINAL = frozenset({"succeeded", "failed", "cancelled"})

    def start_routing(self) -> None:
        if self.status != "queued":
            raise ValueError(f"Cannot start routing from {self.status}; must be queued")
        self.status = "routing"

    def submit(self) -> None:
        if self.status != "routing":
            raise ValueError(f"Cannot submit from {self.status}; must be routing")
        self.status = "submitting"

    def start_running(self) -> None:
        if self.status not in ("submitting", "waiting_human"):
            raise ValueError(f"Cannot start running from {self.status}; must be submitting or waiting_human")
        self.status = "running"

    def wait_for_human(self) -> None:
        if self.status != "running":
            raise ValueError(f"Cannot wait_for_human from {self.status}; must be running")
        self.status = "waiting_human"

    def mark_succeeded(self) -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot mark succeeded from {self.status}; already terminal")
        self.status = "succeeded"

    def mark_failed(self, error_code: str = "", error_message: str = "") -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot mark failed from {self.status}; already terminal")
        self.status = "failed"
        self.error_code = error_code
        self.error_message = error_message

    def cancel(self) -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot cancel from {self.status}; already terminal")
        self.status = "cancelled"

    def is_terminal(self) -> bool:
        return self.status in self._TERMINAL

    def is_runnable(self) -> bool:
        return self.status not in self._TERMINAL and self.status != "cancelled"


@dataclass
class TeamTask:
    """编排任务树节点 (§6.4)."""
    id: str
    run_id: str
    parent_team_task_id: Optional[str] = None
    title: str = ""
    description: Optional[str] = None
    assignee_employee_id: Optional[str] = None
    status: str = "planned"          # planned|queued|running|waiting_deps|succeeded|failed|cancelled
    sequence_no: int = 0
    depth: int = 0
    input_payload_json: Optional[str] = None
    output_summary_json: Optional[str] = None
    runtime_task_id: Optional[str] = None
    started_at: str = ""
    finished_at: str = ""
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    # ── Lifecycle transitions (§6.4) ────────────────────────────────

    _TERMINAL = frozenset({"succeeded", "failed", "cancelled"})

    def queue(self) -> None:
        if self.status != "planned":
            raise ValueError(f"Cannot queue from {self.status}; must be planned")
        self.status = "queued"

    def start_running(self) -> None:
        if self.status not in ("queued", "waiting_deps"):
            raise ValueError(f"Cannot start running from {self.status}; must be queued or waiting_deps")
        self.status = "running"

    def wait_for_deps(self) -> None:
        if self.status != "running":
            raise ValueError(f"Cannot wait_for_deps from {self.status}; must be running")
        self.status = "waiting_deps"

    def mark_succeeded(self) -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot mark succeeded from {self.status}; already terminal")
        self.status = "succeeded"

    def mark_failed(self) -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot mark failed from {self.status}; already terminal")
        self.status = "failed"

    def cancel(self) -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot cancel from {self.status}; already terminal")
        self.status = "cancelled"

    def is_terminal(self) -> bool:
        return self.status in self._TERMINAL


# ═══════════════════════════════════════════════════════════════════
# End L1-S03
# ═══════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════
# L1-S04: ScheduledJob / RuntimeBinding / RunEvent / AuditEvent aggregates
# ═══════════════════════════════════════════════════════════════════

@dataclass
class ScheduledJob:
    """员工级周期任务控制面 (§6.16). running 不属于该对象的长期主状态。"""
    id: str
    enterprise_id: str
    employee_id: str
    name: str = ""
    goal: str = ""
    schedule_expr: str = ""
    status: str = "draft"               # draft|enabled|paused|error|archived
    max_consecutive_failures: int = 3
    consecutive_failures: int = 0
    last_run_status: Optional[str] = None  # succeeded|failed|cancelled
    last_run_at: str = ""
    last_success_at: str = ""
    runtime_job_id: Optional[str] = None
    notification_policy_json: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    _VALID_STATUSES = frozenset({"draft", "enabled", "paused", "error", "archived"})
    _TERMINAL = frozenset({"archived"})

    def enable(self) -> None:
        """Validate and enable the job (draft→enabled or paused→enabled)."""
        if self.status not in ("draft", "paused"):
            raise ValueError(f"Cannot enable from {self.status}; must be draft or paused")
        if not self.name.strip():
            raise ValueError("Cannot enable job with empty name")
        self.status = "enabled"

    def pause(self) -> None:
        """Pause an enabled job (enabled→paused)."""
        if self.status != "enabled":
            raise ValueError(f"Cannot pause from {self.status}; must be enabled")
        self.status = "paused"

    def mark_error(self) -> None:
        """Mark the job in error state after too many consecutive failures."""
        if self.status != "enabled":
            raise ValueError(f"Cannot mark error from {self.status}; must be enabled")
        self.status = "error"

    def clear_error(self) -> None:
        """Move from error back to draft for re-validation."""
        if self.status != "error":
            raise ValueError(f"Cannot clear error from {self.status}; must be error")
        self.status = "draft"

    def archive(self) -> None:
        """Terminal archive — job cannot be recovered."""
        if self.status == "archived":
            raise ValueError("Already archived")
        self.status = "archived"

    def record_failure(self) -> None:
        """Increment consecutive_failures; auto-transition to error if threshold exceeded."""
        self.consecutive_failures += 1
        if self.consecutive_failures >= self.max_consecutive_failures and self.status == "enabled":
            self.status = "error"

    def record_success(self) -> None:
        """Reset consecutive_failures on a successful tick."""
        self.consecutive_failures = 0

    def is_terminal(self) -> bool:
        return self.status in self._TERMINAL


@dataclass
class RuntimeBinding:
    """统一运行句柄与同步状态表 (§6.17).
    runtime_kind 含 profile，不同于 Gateway RuntimeHandle.kind（含 composite）。
    """
    id: str
    enterprise_id: str
    owner_type: str                      # employee|team_run|team_task|scheduled_job
    owner_id: str
    profile_name: str
    runtime_kind: str                    # profile|session|kanban_task|cron_job
    runtime_session_id: Optional[str] = None
    runtime_task_id: Optional[str] = None
    runtime_job_id: Optional[str] = None
    sync_status: str = "pending"         # pending|synced|dirty|failed|orphaned
    event_cursor: int = 0
    runtime_source_cursor: Optional[str] = None
    last_synced_at: str = ""
    last_error: str = ""
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    def mark_synced(self) -> None:
        """Mark binding as synced after successful event ingestion."""
        if self.sync_status in ("orphaned",):
            raise ValueError(f"Cannot mark synced from {self.sync_status}")
        self.sync_status = "synced"

    def mark_dirty(self) -> None:
        """Mark binding as dirty — needs re-sync."""
        if self.sync_status in ("orphaned", "pending"):
            raise ValueError(f"Cannot mark dirty from {self.sync_status}")
        self.sync_status = "dirty"

    def mark_failed(self, error: str = "") -> None:
        """Mark binding as failed with optional error message."""
        self.sync_status = "failed"
        if error:
            self.last_error = error

    def mark_orphaned(self) -> None:
        """Mark binding as orphaned — upstream runtime entity no longer exists."""
        self.sync_status = "orphaned"

    def advance_cursor(self, cursor_no: int) -> None:
        """Advance event_cursor to the given value (must be greater)."""
        if cursor_no <= self.event_cursor:
            raise ValueError(
                f"Cursor must advance: current={self.event_cursor}, attempted={cursor_no}"
            )
        self.event_cursor = cursor_no


@dataclass
class RunEvent:
    """时间线事件流的业务镜像 (§6.18). cursor_no 是北向暴露的 numeric cursor."""
    id: str
    enterprise_id: str
    run_id: str
    cursor_no: int
    event_type: str
    source_type: str                     # session|kanban_task|cron_job|gateway|system
    source_id: str
    team_task_id: Optional[str] = None
    employee_id: Optional[str] = None
    event_ts: str = ""
    preview_text: str = ""
    payload_json: str = "{}"
    created_at: str = ""
    updated_at: str = ""


@dataclass
class AuditEvent:
    """控制面审计事件 (§6.19). 不可变写入，仅追加。"""
    id: str
    enterprise_id: str
    actor_type: str                      # user|employee|system|gateway
    actor_id: str
    event_type: str
    target_type: str
    target_id: str
    request_id: Optional[str] = None
    payload_json: str = "{}"
    created_at: str = ""
    created_by: str = ""


# ═══════════════════════════════════════════════════════════════════
# End L1-S04
# ═══════════════════════════════════════════════════════════════════

@dataclass
class SolutionApplyRecord:
    id: str
    enterprise_id: str
    solution_id: str
    idempotency_key: str
    mode: str = "append"
    status: str = "succeeded"  # pending | succeeded | failed | cancelled
    requested_by: str = ""
    department_id: Optional[str] = None
    created_employee_ids_json: str = "[]"
    created_knowledge_base_ids_json: str = "[]"
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class UsageLedger:
    id: str
    enterprise_id: str
    employee_id: str
    run_id: str
    conversation_id: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost_cents: int = 0
    source_type: str = "run_summary"  # run_summary | usage_event | backfill
    occurred_at: str = ""
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class Enterprise:
    """企业空间，Team Panel 多租户边界 (§4.1)."""
    id: str
    slug: str = ""
    name: str = ""
    status: str = "active"           # active | suspended | archived
    owner_user_id: str = ""
    default_workspace_id: Optional[str] = None
    archive_reason: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    def can_add_employee(self) -> bool:
        return self.status == "active"

    def suspend(self, reason: str = "") -> None:
        if self.status == "archived":
            raise ValueError("Cannot suspend archived enterprise")
        self.status = "suspended"
        self.archive_reason = reason or self.archive_reason

    def archive(self, reason: str = "") -> None:
        self.status = "archived"
        self.archive_reason = reason or self.archive_reason

    def reactivate(self) -> None:
        if self.status not in ("suspended",):
            raise ValueError(f"Cannot reactivate from {self.status}")
        self.status = "active"


@dataclass
class Membership:
    """企业成员关系，不映射到 Hermes Profile (§4.2)."""
    id: str
    enterprise_id: str
    user_id: str
    role: str = EnterpriseRole.MEMBER    # owner|enterprise_admin|finance_admin|member
    status: str = "active"                # active|invited|disabled|removed
    joined_at: str = ""

    def is_admin(self) -> bool:
        return self.role in (EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN)


@dataclass
class Employee:
    """数字员工的业务主对象 (§4.5)."""
    id: str
    enterprise_id: str
    template_id: Optional[str] = None
    profile_name: str = ""
    display_name: str = ""
    role_name: str = ""
    status: str = EmployeeStatus.DRAFT
    created_from: str = ""                # talent_market|manual|solution_apply|admin_seed
    model_provider: str = ""
    model_name: str = ""
    prompt_version: int = 1
    config_version: int = 1
    avatar_url: Optional[str] = None
    description: Optional[str] = None
    archive_reason: Optional[str] = None
    last_provisioned_at: Optional[str] = None
    capabilities_json: str = "{}"
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    # ── Lifecycle transitions (§5.1) ─────────────────────────────────

    def provision(self) -> None:
        """Transition to provisioning — submit to Gateway."""
        if self.status != EmployeeStatus.DRAFT:
            raise ValueError(f"Cannot provision from {self.status}; must be draft")
        self.status = EmployeeStatus.PROVISIONING

    def activate(self) -> None:
        """Provision succeeded — employee is ready for work."""
        if self.status not in (EmployeeStatus.DRAFT, EmployeeStatus.PROVISIONING):
            raise ValueError(f"Cannot activate from {self.status}; must be draft or provisioning")
        self.status = EmployeeStatus.ACTIVE

    def mark_provisioning_failed(self) -> None:
        """Provision failed — retain config, allow retry via provision()."""
        if self.status != EmployeeStatus.PROVISIONING:
            raise ValueError(f"Cannot mark provisioning_failed from {self.status}; must be provisioning")
        self.status = EmployeeStatus.PROVISIONING_FAILED

    def retry_provision(self) -> None:
        """Retry provisioning from provisioning_failed state (§5.1: 允许重试)."""
        if self.status != EmployeeStatus.PROVISIONING_FAILED:
            raise ValueError(f"Cannot retry provision from {self.status}; must be provisioning_failed")
        self.status = EmployeeStatus.PROVISIONING

    def pause(self) -> None:
        """Pause employee — retain config, block new runs."""
        if self.status != EmployeeStatus.ACTIVE:
            raise ValueError(f"Cannot pause from {self.status}; must be active")
        self.status = EmployeeStatus.PAUSED

    def resume(self) -> None:
        """Resume paused employee back to active."""
        if self.status != EmployeeStatus.PAUSED:
            raise ValueError(f"Cannot resume from {self.status}; must be paused")
        self.status = EmployeeStatus.ACTIVE

    def archive(self, reason: str = "") -> None:
        """Archive employee — terminal state for historical trace only."""
        if self.status == EmployeeStatus.ARCHIVED:
            raise ValueError("Already archived")
        self.status = EmployeeStatus.ARCHIVED
        self.archive_reason = reason or self.archive_reason

    # ── Convenience predicates ───────────────────────────────────────

    def is_runnable(self) -> bool:
        """Whether this employee can accept new runs/tasks/jobs."""
        return self.status == EmployeeStatus.ACTIVE

    def is_provisionable(self) -> bool:
        """Whether a provision attempt is allowed."""
        return self.status in (EmployeeStatus.DRAFT, EmployeeStatus.PROVISIONING_FAILED)


@dataclass
class Department:
    """Enterprise org department for P07 organization tree."""
    id: str
    enterprise_id: str
    name: str
    parent_id: Optional[str] = None
    leader_user_id: Optional[str] = None
    visibility_scope: str = "enterprise"
    sort_order: int = 0
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


@dataclass
class EmployeeOrgAssignment:
    """Employee-to-department placement plus org presentation fields."""
    id: str
    enterprise_id: str
    employee_id: str
    department_id: Optional[str] = None
    position_title: str = ""
    visibility_scope: str = "department"
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None


def _now_str() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class KnowledgeBase:
    """P08 knowledge base aggregate root."""

    id: str
    enterprise_id: str
    name: str = ""
    description: str = ""
    status: str = "active"  # active | archived
    document_count: int = 0
    storage_prefix: str = ""
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    def archive(self) -> None:
        if self.status != "active":
            raise ValueError(f"Cannot archive from {self.status}")
        self.status = "archived"


@dataclass
class KnowledgeDocument:
    """Durable document state for upload -> ingestion -> retrieval."""

    id: str
    knowledge_base_id: str
    enterprise_id: str
    asset_id: str = ""
    display_name: str = ""
    file_name: str = ""
    file_type: str = ""
    file_size: int = 0
    storage_key: str = ""
    status: str = "uploaded"  # uploaded | ingesting | ready | error
    ingestion_job_id: Optional[str] = None
    rag_document_id: str = ""
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    chunk_count: int = 0
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    def start_ingesting(self, ingestion_job_id: str) -> None:
        if self.status not in ("uploaded", "error"):
            raise ValueError(f"Cannot start ingesting from {self.status}")
        self.status = "ingesting"
        self.ingestion_job_id = ingestion_job_id
        self.error_code = None
        self.error_message = None

    def mark_ready(self, *, rag_document_id: str = "", chunk_count: int = 0) -> None:
        if self.status != "ingesting":
            raise ValueError(f"Cannot mark ready from {self.status}")
        self.status = "ready"
        self.rag_document_id = rag_document_id
        self.chunk_count = chunk_count
        self.error_code = None
        self.error_message = None

    def mark_error(self, error_code: str, error_message: str) -> None:
        if self.status != "ingesting":
            raise ValueError(f"Cannot mark error from {self.status}")
        self.status = "error"
        self.error_code = error_code
        self.error_message = error_message

    def reset_for_retry(self) -> None:
        if self.status != "error":
            raise ValueError(f"Cannot reset retry from {self.status}")
        self.status = "uploaded"
        self.ingestion_job_id = None
        self.error_code = None
        self.error_message = None


@dataclass
class KnowledgeIndexBinding:
    """Employee-facing retrieval binding to a LightRAG index/document."""

    id: str
    enterprise_id: str
    employee_id: str
    knowledge_base_id: str
    employee_knowledge_binding_id: Optional[str] = None
    document_id: Optional[str] = None
    rag_index_id: str = ""
    rag_document_id: str = ""
    scope_mode: str = "read"  # read | read_write_metadata
    status: str = "pending"  # pending | ready | error | disabled
    error_message: Optional[str] = None
    last_synced_at: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    def mark_ready(self, *, rag_document_id: str = "") -> None:
        if self.status not in ("pending", "error"):
            raise ValueError(f"Cannot mark ready from {self.status}")
        self.status = "ready"
        self.rag_document_id = rag_document_id or self.rag_document_id
        self.error_message = None
        self.last_synced_at = _now_str()

    def mark_error(self, error_message: str) -> None:
        if self.status not in ("pending", "ready"):
            raise ValueError(f"Cannot mark error from {self.status}")
        self.status = "error"
        self.error_message = error_message
        self.last_synced_at = _now_str()

    def disable(self) -> None:
        if self.status == "disabled":
            raise ValueError("Knowledge index binding already disabled")
        self.status = "disabled"
        self.last_synced_at = _now_str()


@dataclass
class KnowledgeIngestionJob:
    """Async ingestion tracker for document parsing + LightRAG indexing."""

    id: str
    knowledge_base_id: str
    enterprise_id: str
    document_id: str
    status: str = "pending"  # pending | parsing | inserting | completed | failed
    rag_document_id: str = ""
    error_message: Optional[str] = None
    chunk_count: int = 0
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None

    def start(self) -> None:
        if self.status != "pending":
            raise ValueError(f"Cannot start from {self.status}")
        self.status = "parsing"
        self.started_at = _now_str()

    def start_inserting(self) -> None:
        if self.status != "parsing":
            raise ValueError(f"Cannot start inserting from {self.status}")
        self.status = "inserting"

    def complete(self, *, rag_document_id: str = "", chunk_count: int = 0) -> None:
        if self.status not in ("parsing", "inserting"):
            raise ValueError(f"Cannot complete from {self.status}")
        self.status = "completed"
        self.rag_document_id = rag_document_id
        self.chunk_count = chunk_count
        self.completed_at = _now_str()

    def fail(self, error_message: str) -> None:
        if self.status not in ("pending", "parsing", "inserting"):
            raise ValueError(f"Cannot fail from {self.status}")
        self.status = "failed"
        self.error_message = error_message
        self.completed_at = _now_str()
