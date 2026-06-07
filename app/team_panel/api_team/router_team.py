"""Team Panel — /api/team/* router: first 12 northbound endpoints.

Connects to PostgreSQL on demand via team_panel.transactions.db.create_connection.
Uses the existing domain entities + repositories directly — no application layer yet.
"""
from __future__ import annotations

import ast
import csv
import json
import io
import os
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import psycopg2

from ..transactions.db import create_connection
from ..domain.entities import (
    AgentTemplate,
    AuditEvent,
    Conversation,
    EmployeeOrgAssignment,
    Employee,
    EmployeeConnectorBinding,
    EmployeeKnowledgeBinding,
    EmployeeMemoryBinding,
    EmployeePrompt,
    EmployeeSkillBinding,
    Enterprise,
    EnterpriseConnector,
    EnterpriseSkillInstall,
    KnowledgeDocument,
    KnowledgeIngestionJob,
    MemoryItem,
    MemoryReviewDecision,
    RecruitmentOrder,
    SolutionApplyRecord,
    TeamRun,
)
from ..domain.enums import EmployeeStatus
from ..repositories.agent_template_repo import AgentTemplateRepo
from ..repositories.audit_event_repo import AuditEventRepo
from ..repositories.connector_definition_repo import ConnectorDefinitionRepo
from ..repositories.conversation_repo import ConversationRepo
from ..repositories.employee_knowledge_binding_repo import EmployeeKnowledgeBindingRepo
from ..repositories.employee_org_assignment_repo import EmployeeOrgAssignmentRepo
from ..repositories.employee_repo import EmployeeRepo
from ..repositories.employee_connector_binding_repo import EmployeeConnectorBindingRepo
from ..repositories.enterprise_repo import EnterpriseRepo
from ..repositories.connector_repo import EnterpriseConnectorRepo
from ..repositories.department_repo import DepartmentRepo
from ..repositories.industry_solution_repo import IndustrySolutionRepo
from ..repositories.recruitment_order_repo import RecruitmentOrderRepo
from ..repositories.run_event_repo import RunEventRepo
from ..repositories.solution_apply_record_repo import SolutionApplyRecordRepo
from ..repositories.solution_template_binding_repo import SolutionTemplateBindingRepo
from ..repositories.employee_skill_binding_repo import EmployeeSkillBindingRepo
from ..repositories.employee_memory_binding_repo import EmployeeMemoryBindingRepo
from ..repositories.knowledge_base_repo import KnowledgeBaseRepo
from ..repositories.knowledge_document_repo import KnowledgeDocumentRepo
from ..repositories.knowledge_ingestion_job_repo import KnowledgeIngestionJobRepo
from ..repositories.enterprise_skill_install_repo import EnterpriseSkillInstallRepo
from ..repositories.memory_item_repo import MemoryItemRepo, MemoryReviewDecisionRepo
from ..repositories.team_run_repo import TeamRunRepo
from ..repositories.team_task_repo import TeamTaskRepo
from ..transactions.uow import UnitOfWork
from ..application.commands.conversation_service import submit_group_message
from ..application.commands.connector_grant_service import grant_connector, revoke_connector
from ..application.policies.permission_service import check_permission
from ..application.queries.billing_view_service import get_billing_view
from ..application.queries.employee_admin_view_service import get_employee_admin_view
from ..application.commands.run_command_service import create_run
from ..application.queries.office_view_service import get_office_feed, get_office_scene
from ..application.queries.workbench_view_service import (
    WorkbenchAccessError,
    get_workbench_view,
    serialize_workbench_view,
)
from ..views.schemas import compute_display_state
from ..api_team.router_team_settings_billing import (
    guard_run_creation_allowed,
    handle_get_billing_balance,
    handle_get_billing_recharges,
    handle_get_settings,
    handle_patch_settings,
    handle_post_admin_invite,
    handle_post_billing_recharge,
)

from agent_gateway.contracts import (
    RunTimelineEvent,
    TimelineEventType,
    sse_frame,
)

_ALLOWED_PATCH_FIELDS = {"display_name", "status", "skills_add", "skills_remove",
                         "model_provider", "model_name", "prompt_version",
                         "config_version", "capabilities_json", "description",
                         "prompt_system", "prompt_behavior_rules_json", "prompt_opening_message",
                         "memory_mode", "memory_provider_code", "memory_retention_days",
                         "memory_writeback_enabled", "knowledge_base_ids", "connector_ids"}
_VALID_EMPLOYEE_TRANSITIONS = {
    "active": {"paused", "archived"},
    "paused": {"active"},
    "draft": set(),
    "provisioning": set(),
    "provisioning_failed": set(),
    "archived": set(),
}

_WORKBENCH_ROLE_ENV = "HERMES_AITEAM_WORKBENCH_ROLE"


def _today_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_payload(value) -> dict:
    if not value or value == "{}":
        return {}
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        try:
            parsed = ast.literal_eval(value)
        except (SyntaxError, ValueError):
            return {}
    return parsed if isinstance(parsed, dict) else {}


def _load_json_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed]


def _parse_non_negative_int(value: str | None, *, field_name: str, default: int) -> int:
    raw = str(value or "").strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a non-negative integer") from exc
    if parsed < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")
    return parsed


def _normalize_review_status(item: MemoryItem, review: MemoryReviewDecision | None) -> str:
    if review is not None:
        return review.decision
    return "pending" if item.source_type == "extraction" else "not_required"


def _serialize_review(item: MemoryItem, review: MemoryReviewDecision | None) -> dict:
    status = _normalize_review_status(item, review)
    if review is None:
        return {
            "status": status,
            "latest_decision_id": None,
            "reviewed_at": None,
            "reviewed_by": None,
            "comment": None,
            "corrected_content": None,
        }
    return {
        "status": status,
        "latest_decision_id": review.id,
        "reviewed_at": review.created_at or None,
        "reviewed_by": review.reviewer_user_id or None,
        "comment": review.comment,
        "corrected_content": review.corrected_content,
    }


def _load_prompt_use_trace(cur, *, enterprise_id: str, memory_id: str, trace_limit: int = 20) -> list[dict]:
    cur.execute(
        "SELECT r.event_id, r.run_id, r.cursor_no, r.event_ts, r.payload_json "
        "FROM ("
        "  SELECT re.id AS event_id, re.run_id, re.cursor_no, re.created_at AS event_ts, re.payload_json "
        "  FROM run_event re "
        "  WHERE re.enterprise_id = %s AND re.event_type = 'memory_written' "
        "  ORDER BY re.cursor_no DESC LIMIT %s"
        ") r WHERE r.payload_json::jsonb ?| array['memory_id','used_memory_ids']",
        (enterprise_id, trace_limit),
    )
    traces: list[dict] = []
    for event_id, run_id, cursor_no, event_ts, payload_json in cur.fetchall():
        payload = _load_payload(payload_json)
        used_memory_ids = payload.get("used_memory_ids") or []
        if payload.get("memory_id") != memory_id and memory_id not in used_memory_ids:
            continue
        traces.append(
            {
                "run_id": payload.get("run_id") or run_id,
                "event_id": event_id,
                "event_cursor": cursor_no,
                "stage": payload.get("stage") or "prompt_injected",
                "used_at": str(event_ts) if event_ts else None,
            }
        )
    return traces


def _serialize_memory_item(
    cur,
    item: MemoryItem,
    review: MemoryReviewDecision | None,
    *,
    include_prompt_use_trace: bool = False,
    trace_limit: int = 20,
) -> dict:
    payload = {
        "memory_id": item.id,
        "employee_id": item.employee_id,
        "content": item.content,
        "category": item.category,
        "importance": item.importance,
        "source_type": item.source_type,
        "tags": _load_json_list(item.tags_json),
        "visibility_scope": item.visibility_scope,
        "runtime_ref": _load_payload(item.runtime_ref_json),
        "review": _serialize_review(item, review),
        "last_used_at": item.last_used_at,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }
    if include_prompt_use_trace:
        payload["prompt_use_trace"] = _load_prompt_use_trace(
            cur,
            enterprise_id=item.enterprise_id,
            memory_id=item.id,
            trace_limit=trace_limit,
        )
    return payload

def _record_audit_event(cur, *, enterprise_id: str, event_type: str, target_type: str, target_id: str, payload: dict) -> None:
    AuditEventRepo(cur).create(
        AuditEvent(
            id=f"audit_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            actor_type="user",
            actor_id="system",
            event_type=event_type,
            target_type=target_type,
            target_id=target_id,
            request_id=target_id,
            payload_json=json.dumps(payload, ensure_ascii=False),
            created_by="system",
        )
    )


def _mask_connector_secret(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "未配置"
    if len(raw) >= 8:
        return f"{raw[:3]}****{raw[-4:]}"
    return "已配置"


_CONNECTOR_SECRET_MARKERS = ("secret", "token", "password", "key", "credential")
_CONNECTOR_ALLOWED_CREDENTIAL_INPUT_FIELDS = {"mode", "credential_ref"}


def _is_secret_bearing_connector_key(key: object) -> bool:
    key_text = str(key).lower()
    return any(marker in key_text for marker in _CONNECTOR_SECRET_MARKERS)


def _sanitize_connector_config_value(value: object, *, parent_key: object | None = None) -> object:
    if parent_key is not None and _is_secret_bearing_connector_key(parent_key):
        return "****" if value not in (None, "") else ""
    if isinstance(value, dict):
        return {
            str(key): _sanitize_connector_config_value(child_value, parent_key=key)
            for key, child_value in value.items()
        }
    if isinstance(value, list):
        return [
            _sanitize_connector_config_value(item, parent_key=parent_key)
            for item in value
        ]
    return value


def _sanitize_connector_config(config: dict) -> dict:
    return {
        str(key): _sanitize_connector_config_value(value, parent_key=key)
        for key, value in config.items()
    }


def _normalize_connector_config_input(payload: object) -> dict:
    return _sanitize_connector_config(_load_payload(payload))


def _extract_connector_credential_ref(body: dict | None) -> tuple[str | None, dict | None]:
    payload = body or {}
    credential_input = payload.get("credential_input")
    if credential_input is None:
        return str(payload.get("credential_ref") or "").strip(), None
    if not isinstance(credential_input, dict):
        return None, {
            "error": "INVALID_CREDENTIAL_INPUT",
            "message": "credential_input must be an object with credential_ref only",
        }
    invalid_fields = sorted(set(credential_input.keys()) - _CONNECTOR_ALLOWED_CREDENTIAL_INPUT_FIELDS)
    if invalid_fields:
        return None, {
            "error": "INVALID_CREDENTIAL_INPUT",
            "message": f"credential_input field '{invalid_fields[0]}' is not allowed; use credential_ref only",
        }
    return str(credential_input.get("credential_ref") or payload.get("credential_ref") or "").strip(), None


def _normalize_scopes(payload: object) -> list[str]:
    if isinstance(payload, list):
        scopes = [str(item).strip() for item in payload if str(item).strip()]
    elif isinstance(payload, str) and payload.strip():
        scopes = [payload.strip()]
    else:
        scopes = []
    deduped: list[str] = []
    seen: set[str] = set()
    for scope in scopes:
        if scope in seen:
            continue
        seen.add(scope)
        deduped.append(scope)
    return deduped


def _default_last_test_result() -> dict:
    return {
        "result": "never_tested",
        "checked_at": None,
        "checked_by": "",
        "error_code": "",
        "message": "尚未测试",
        "log_ref": "",
    }


def _normalize_last_test_result(payload: object) -> dict:
    result = _default_last_test_result()
    parsed = _load_payload(payload)
    for key in result:
        value = parsed.get(key)
        if value is not None:
            result[key] = value
    return result


def _serialize_connector_definition(definition) -> dict:
    return {
        "definition_id": definition.id,
        "provider_code": definition.provider_code,
        "connector_type": definition.connector_type,
        "display_name": definition.display_name,
        "auth_scheme": definition.auth_scheme,
        "config_schema_json": _load_payload(definition.config_schema_json),
        "status": definition.status,
    }


def _serialize_connector_grant(binding: EmployeeConnectorBinding, employee_map: dict[str, Employee]) -> dict:
    employee = employee_map.get(binding.employee_id)
    return {
        "binding_id": binding.id,
        "employee_id": binding.employee_id,
        "employee_display_name": employee.display_name if employee else "",
        "enabled": bool(binding.enabled),
        "access_mode": binding.access_mode,
    }


def _serialize_connector(connector: EnterpriseConnector, *, grants: list[dict], definition=None, available_employees: list[dict] | None = None, audit_summary: list[dict] | None = None) -> dict:
    payload = {
        "connector_id": connector.id,
        "definition_id": connector.definition_id,
        "name": connector.name,
        "provider_code": connector.provider_code,
        "connector_type": connector.connector_type,
        "status": connector.status,
        "health_status": connector.status,
        "config": _sanitize_connector_config(_load_payload(connector.config_json)),
        "scopes": _load_json_list(connector.scopes_json),
        "credential_ref": connector.credential_ref,
        "credential_mask": connector.credential_mask,
        "credential_state": connector.credential_state,
        "rotation_version": int(connector.rotation_version or 0),
        "grants": [grant["employee_id"] for grant in grants if grant["enabled"]],
        "granted_employee_ids": [grant["employee_id"] for grant in grants if grant["enabled"]],
        "employee_grants": grants,
        "last_test_result": _normalize_last_test_result(connector.last_test_result_json),
        "last_validated_at": connector.last_validated_at,
        "last_test_at": connector.last_validated_at,
        "created_at": connector.created_at,
        "updated_at": connector.updated_at,
        "updated_by": connector.updated_by,
    }
    if definition is not None:
        payload["definition"] = _serialize_connector_definition(definition)
    if available_employees is not None:
        payload["available_employees"] = available_employees
    if audit_summary is not None:
        payload["audit_summary"] = audit_summary
    return payload


def _connector_test_outcome(connector: EnterpriseConnector, body: dict | None, actor_id: str) -> tuple[str, str, dict]:
    requested_result = str((body or {}).get("simulate_result") or "passed").strip().lower()
    if connector.credential_state == "missing":
        requested_result = "missing"

    checked_at = _today_iso()
    if requested_result == "auth_failed":
        return (
            "auth_failed",
            "invalid",
            {
                "result": "failed",
                "checked_at": checked_at,
                "checked_by": actor_id,
                "error_code": "CREDENTIAL_INVALID",
                "message": "连接测试失败：凭据认证失败",
                "log_ref": f"audit://connector-test/{connector.id}",
            },
        )
    if requested_result in {"offline", "network_failed"}:
        return (
            "offline",
            connector.credential_state if connector.credential_state != "missing" else "missing",
            {
                "result": "failed",
                "checked_at": checked_at,
                "checked_by": actor_id,
                "error_code": "CONNECTOR_UNREACHABLE",
                "message": "连接测试失败：服务不可达",
                "log_ref": f"audit://connector-test/{connector.id}",
            },
        )
    if requested_result == "missing":
        return (
            "draft",
            "missing",
            {
                "result": "failed",
                "checked_at": checked_at,
                "checked_by": actor_id,
                "error_code": "CREDENTIAL_REQUIRED",
                "message": "连接测试失败：缺少凭据引用",
                "log_ref": f"audit://connector-test/{connector.id}",
            },
        )
    return (
        "online",
        "configured" if connector.credential_state == "missing" else connector.credential_state,
        {
            "result": "passed",
            "checked_at": checked_at,
            "checked_by": actor_id,
            "error_code": "",
            "message": "最近一次连接测试通过",
            "log_ref": f"audit://connector-test/{connector.id}",
        },
    )


def _normalize_skill_scope(employee_ids: object) -> list[str]:
    if not isinstance(employee_ids, list):
        return []
    deduped: list[str] = []
    seen: set[str] = set()
    for employee_id in employee_ids:
        value = str(employee_id or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        deduped.append(value)
    return deduped


def _sync_skill_grants(cur, *, enterprise_id: str, skill_code: str, scope_mode: str, employee_ids: list[str]) -> list[dict]:
    skill_binding_repo = EmployeeSkillBindingRepo(cur)
    employee_repo = EmployeeRepo(cur)
    employees = employee_repo.list_by_enterprise(enterprise_id)
    employee_map = {employee.id: employee for employee in employees}
    if scope_mode == "all_employees":
        target_employee_ids = [employee.id for employee in employees]
    else:
        target_employee_ids = []
        for employee_id in employee_ids:
            if employee_id not in employee_map:
                raise ValueError(f"Employee {employee_id} not found")
            target_employee_ids.append(employee_id)

    existing = skill_binding_repo.list_by_skill_code(enterprise_id, skill_code)
    existing_by_employee = {binding.employee_id: binding for binding in existing}
    target_set = set(target_employee_ids)

    for employee_id, binding in existing_by_employee.items():
        if employee_id not in target_set:
            skill_binding_repo.delete(binding.id)

    grants: list[dict] = []
    for employee_id in target_employee_ids:
        binding = existing_by_employee.get(employee_id)
        if binding is None:
            binding = EmployeeSkillBinding(
                id=f"esk_{uuid.uuid4().hex[:12]}",
                enterprise_id=enterprise_id,
                employee_id=employee_id,
                skill_code=skill_code,
                source_type="manual",
            )
            skill_binding_repo.create(binding)
        elif not binding.enabled:
            binding.enabled = True
            binding.binding_version += 1
            skill_binding_repo.update(binding)
        grants.append({"skill_code": skill_code, "employee_id": employee_id, "enabled": True})
    grants.sort(key=lambda item: item["employee_id"])
    return grants


def _prune_memory_overflow(cur, *, enterprise_id: str, employee_id: str, limit: int = 1000) -> list[str]:
    repo = MemoryItemRepo(cur)
    items = repo.list_by_enterprise(
        enterprise_id,
        employee_id=employee_id,
        limit=limit + 200,
        offset=0,
        sort_by="importance",
        sort_order="desc",
    )
    if len(items) <= limit:
        return []
    overflow = items[limit:]
    deleted_ids = [item.id for item in overflow]
    repo.bulk_delete(deleted_ids, enterprise_id=enterprise_id, employee_id=employee_id)
    return deleted_ids


def _make_conn():
    return create_connection()


def _database_unavailable_response() -> tuple[int, dict]:
    return 503, {"error": "database_unavailable", "message": "Cannot connect to database"}


def _presence_for_employee(status: str) -> str:
    if status == EmployeeStatus.ACTIVE:
        return "online"
    if status in (EmployeeStatus.PAUSED, EmployeeStatus.ARCHIVED):
        return "offline"
    return "busy"


def _assignment_view(emp: Employee, assignment: EmployeeOrgAssignment | None) -> dict:
    return {
        "assignment_id": assignment.id if assignment is not None else emp.id,
        "employee_id": emp.id,
        "department_id": assignment.department_id if assignment is not None else None,
        "position_title": (assignment.position_title if assignment is not None else "") or emp.role_name or "",
        "visibility_scope": assignment.visibility_scope if assignment is not None else "department",
        "presence": _presence_for_employee(emp.status),
        "display_name": emp.display_name,
        "role_name": emp.role_name,
        "status": emp.status,
        "avatar_url": emp.avatar_url,
    }


def _build_department_node(department, children_by_parent: dict[str | None, list], members_by_department: dict[str | None, list]) -> dict:
    child_nodes = [
        _build_department_node(child, children_by_parent, members_by_department)
        for child in children_by_parent.get(department.id, [])
    ]
    members = members_by_department.get(department.id, [])
    return {
        "department_id": department.id,
        "parent_id": department.parent_id,
        "name": department.name,
        "leader_user_id": department.leader_user_id,
        "visibility_scope": department.visibility_scope,
        "member_count": len(members),
        "members": members,
        "children": child_nodes,
    }


# ── B02 skill market catalog helpers ────────────────────────────────────────

_MARKET_CATALOG: list[dict] = [
    {"skill_code": "web-search", "display_name": "Web Search", "description": "Search the web for information", "source_marketplace": "builtin", "version": "1.0.0", "latest_version": "1.0.0", "tags": ["search", "information"], "is_free": True},
    {"skill_code": "slides", "display_name": "Slides", "description": "Create presentation slides", "source_marketplace": "builtin", "version": "1.0.0", "latest_version": "1.0.0", "tags": ["presentation", "generation"], "is_free": True},
    {"skill_code": "reporting", "display_name": "Reporting", "description": "Generate structured reports", "source_marketplace": "builtin", "version": "1.0.0", "latest_version": "1.0.0", "tags": ["reporting", "analysis"], "is_free": True},
    {"skill_code": "forecasting", "display_name": "Forecasting", "description": "Time-series forecasting", "source_marketplace": "builtin", "version": "1.0.0", "latest_version": "1.0.0", "tags": ["forecasting", "prediction"], "is_free": True},
    {"skill_code": "code-analysis", "display_name": "Code Analysis", "description": "Analyze source code", "source_marketplace": "skillhub", "version": "2.0.0", "latest_version": "2.1.0", "tags": ["code", "analysis"], "is_free": False},
]


def _discover_hermes_skill_entries() -> list[dict]:
    """Return extra catalog entries discovered from local Hermes skills directories."""
    entries: list[dict] = []
    seen_codes = {e["skill_code"] for e in _MARKET_CATALOG}

    def _add(entry: dict) -> None:
        if entry["skill_code"] not in seen_codes:
            entries.append(entry)
            seen_codes.add(entry["skill_code"])

    try:
        import yaml
    except ImportError:
        yaml = None

    for candidate in [os.path.expanduser("~/.hermes/skills"), "/home/ubuntu/.hermes/skills"]:
        skills_dir = Path(candidate)
        if not skills_dir.is_dir():
            continue
        for md_file in sorted(skills_dir.rglob("SKILL.md")):
            try:
                raw = md_file.read_text()
                if not raw.startswith("---"):
                    continue
                parts = raw.split("---", 2)
                if len(parts) < 3:
                    continue
                meta_text = parts[1].strip()
                if yaml is not None:
                    meta = yaml.safe_load(meta_text)
                else:
                    meta = {}
                    for line in meta_text.splitlines():
                        if ":" in line:
                            key, val = line.split(":", 1)
                            meta[key.strip()] = val.strip()
                name = (meta.get("name") or md_file.parent.name).lower().replace(" ", "-").replace("_", "-")
                _add({
                    "skill_code": name,
                    "display_name": meta.get("name") or md_file.parent.name,
                    "description": meta.get("description", ""),
                    "source_marketplace": "builtin",
                    "version": meta.get("version", "1.0.0"),
                    "latest_version": meta.get("version", "1.0.0"),
                    "tags": [t.strip() for t in str(meta.get("tags", "")).split(",") if t.strip()],
                    "is_free": True,
                })
            except Exception:
                continue
    return entries


def _get_full_catalog() -> list[dict]:
    return _MARKET_CATALOG + _discover_hermes_skill_entries()


# ── B02 skill install handlers ───────────────────────────────────────────────

def _handle_skill_catalog(conn, path: str, query: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        install_repo = EnterpriseSkillInstallRepo(cur) if enterprise else None
        installed_map: dict[str, dict] = {}
        if enterprise and install_repo:
            for inst in install_repo.list_by_enterprise(enterprise.id):
                installed_map[inst.skill_code] = {
                    "install_id": inst.id,
                    "version": inst.version,
                    "latest_version": inst.latest_version,
                    "scope_mode": inst.scope_mode,
                    "install_status": inst.install_status,
                }
        qs = parse_qs(query)
        search_query = str(qs.get("q", [""])[0] or "").strip().lower()
        tag_filter = str(qs.get("tag", [""])[0] or "").strip().lower()
        source_filter = str(qs.get("source_marketplace", [""])[0] or "").strip().lower()
        installed_only = str(qs.get("installed_only", [""])[0] or "").strip().lower() in {"1", "true", "yes"}
        catalog = _get_full_catalog()
        items = []
        for entry in catalog:
            installed = installed_map.get(entry["skill_code"])
            active_count = install_repo.count_active_by_skill_code(entry["skill_code"]) if installed and install_repo else 0
            haystack = " ".join(
                [
                    str(entry["skill_code"]),
                    str(entry["display_name"]),
                    str(entry["description"]),
                    " ".join(str(tag) for tag in entry["tags"]),
                ]
            ).lower()
            if search_query and search_query not in haystack:
                continue
            if tag_filter and tag_filter not in {str(tag).lower() for tag in entry["tags"]}:
                continue
            if source_filter and str(entry["source_marketplace"]).lower() != source_filter:
                continue
            if installed_only and installed is None:
                continue
            items.append({
                "skill_code": entry["skill_code"],
                "display_name": entry["display_name"],
                "description": entry["description"],
                "source_marketplace": entry["source_marketplace"],
                "version": entry["version"],
                "latest_version": entry.get("latest_version", entry["version"]),
                "tags": entry["tags"],
                "is_free": entry["is_free"],
                "install_count": active_count,
                "installed": installed,
            })
        return 200, {"items": items, "total": len(items)}
    finally:
        cur.close()


def _handle_skill_installs_list(conn, path: str, query: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {"items": [], "total": 0}
        install_repo = EnterpriseSkillInstallRepo(cur)
        installs = install_repo.list_by_enterprise(enterprise.id)
        skill_repo = EmployeeSkillBindingRepo(cur)
        items = []
        for inst in installs:
            grants = skill_repo.list_by_skill_code(enterprise.id, inst.skill_code)
            cat_entry = next((e for e in _get_full_catalog() if e["skill_code"] == inst.skill_code), None)
            items.append({
                "install_id": inst.id,
                "skill_code": inst.skill_code,
                "display_name": inst.display_name,
                "description": inst.description,
                "source_marketplace": inst.source_marketplace,
                "version": inst.version,
                "latest_version": inst.latest_version,
                "scope_mode": inst.scope_mode,
                "install_status": inst.install_status,
                "tags": cat_entry["tags"] if cat_entry else [],
                "grants": [
                    {"skill_code": g.skill_code, "employee_id": g.employee_id, "enabled": g.enabled}
                    for g in grants
                ],
            })
        return 200, {"items": items, "total": len(items)}
    finally:
        cur.close()


def _handle_skill_install_post(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    skill_code = str(body.get("skill_code") or "").strip()
    if not skill_code:
        return 400, {"error": "MISSING_SKILL_CODE", "message": "skill_code is required"}
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        install_repo = EnterpriseSkillInstallRepo(cur)
        existing = install_repo.get_active_by_skill_code(enterprise.id, skill_code)
        if existing is not None:
            return 409, {"error": "SKILL_ALREADY_INSTALLED", "message": f"Skill '{skill_code}' is already installed"}

        cat_entry = next((e for e in _get_full_catalog() if e["skill_code"] == skill_code), None)
        display_name = str(body.get("display_name") or (cat_entry["display_name"] if cat_entry else skill_code))
        description = str(body.get("description") or (cat_entry["description"] if cat_entry else ""))
        source_marketplace = str(body.get("source_marketplace") or (cat_entry["source_marketplace"] if cat_entry else "custom"))
        version = str(body.get("version") or (cat_entry["version"] if cat_entry else "1.0.0"))
        latest_version = str(body.get("latest_version") or (cat_entry["latest_version"] if cat_entry else version))
        scope_mode = str(body.get("scope_mode", "selected_employees"))
        employee_ids = _normalize_skill_scope(body.get("employee_ids", []))
        if scope_mode not in {"all_employees", "selected_employees"}:
            return 400, {"error": "INVALID_SCOPE_MODE", "message": f"Unsupported scope_mode: {scope_mode}"}
        if scope_mode == "selected_employees" and not employee_ids:
            return 400, {"error": "MISSING_EMPLOYEE_SCOPE", "message": "employee_ids is required for selected_employees scope"}

        install_id = f"esi_{uuid.uuid4().hex[:12]}"
        install = EnterpriseSkillInstall(
            id=install_id,
            enterprise_id=enterprise.id,
            skill_code=skill_code,
            display_name=display_name,
            description=description,
            source_marketplace=source_marketplace,
            version=version,
            latest_version=latest_version,
            scope_mode=scope_mode,
            install_status="update_available" if latest_version != version else "active",
            manifest_json=json.dumps({"tags": cat_entry["tags"] if cat_entry else [], "employee_ids": employee_ids}, ensure_ascii=False),
            created_by="system",
            updated_by="system",
        )
        install_repo.create(install)
        try:
            grants = _sync_skill_grants(
                cur,
                enterprise_id=enterprise.id,
                skill_code=skill_code,
                scope_mode=scope_mode,
                employee_ids=employee_ids,
            )
        except ValueError as exc:
            return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": str(exc)}

        _record_audit_event(
            cur,
            enterprise_id=enterprise.id,
            event_type="skill.install",
            target_type="enterprise_skill_install",
            target_id=install_id,
            payload={
                "skill_code": skill_code,
                "scope_mode": scope_mode,
                "employee_ids": [grant["employee_id"] for grant in grants],
                "version": version,
                "latest_version": latest_version,
            },
        )
        conn.commit()
        return 201, {
            "install_id": install_id,
            "skill_code": skill_code,
            "display_name": display_name,
            "scope_mode": scope_mode,
            "install_status": install.install_status,
            "version": version,
            "latest_version": latest_version,
            "grants": grants,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_skill_install_patch(conn, path: str, install_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    cur = conn.cursor()
    try:
        install_repo = EnterpriseSkillInstallRepo(cur)
        inst = install_repo.get_by_id(install_id)
        if inst is None:
            return 404, {"error": "SKILL_INSTALL_NOT_FOUND", "message": f"Skill install {install_id} not found"}

        requested_scope_mode = str(body.get("scope_mode", inst.scope_mode))
        if requested_scope_mode not in {"all_employees", "selected_employees"}:
            return 400, {"error": "INVALID_SCOPE_MODE", "message": f"Unsupported scope_mode: {requested_scope_mode}"}
        manifest = _load_payload(inst.manifest_json)
        requested_employee_ids = _normalize_skill_scope(body.get("employee_ids", manifest.get("employee_ids", [])))
        if requested_scope_mode == "selected_employees" and not requested_employee_ids:
            return 400, {"error": "MISSING_EMPLOYEE_SCOPE", "message": "employee_ids is required for selected_employees scope"}

        if "version" in body or "latest_version" in body:
            new_version = str(body.get("version", inst.version))
            new_latest = str(body.get("latest_version", inst.latest_version))
            inst.version = new_version
            inst.latest_version = new_latest
            inst.install_status = "update_available" if new_latest != new_version else "active"
        if "scope_mode" in body:
            inst.scope_mode = requested_scope_mode
        if "install_status" in body:
            inst.install_status = str(body.get("install_status") or inst.install_status)
        if "display_name" in body:
            inst.display_name = str(body.get("display_name") or inst.display_name)
        if "description" in body:
            inst.description = str(body.get("description") or inst.description)
        if "employee_ids" in body or "scope_mode" in body:
            manifest["employee_ids"] = requested_employee_ids
            inst.manifest_json = json.dumps(manifest, ensure_ascii=False)

        try:
            grants = _sync_skill_grants(
                cur,
                enterprise_id=inst.enterprise_id,
                skill_code=inst.skill_code,
                scope_mode=inst.scope_mode,
                employee_ids=requested_employee_ids,
            )
        except ValueError as exc:
            return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": str(exc)}

        inst.updated_by = "system"
        install_repo.update(inst)
        _record_audit_event(
            cur,
            enterprise_id=inst.enterprise_id,
            event_type="skill.update",
            target_type="enterprise_skill_install",
            target_id=inst.id,
            payload={
                "skill_code": inst.skill_code,
                "scope_mode": inst.scope_mode,
                "employee_ids": [grant["employee_id"] for grant in grants],
                "install_status": inst.install_status,
                "version": inst.version,
                "latest_version": inst.latest_version,
            },
        )
        conn.commit()
        return 200, {
            "install_id": inst.id,
            "skill_code": inst.skill_code,
            "scope_mode": inst.scope_mode,
            "version": inst.version,
            "latest_version": inst.latest_version,
            "install_status": inst.install_status,
            "grants": grants,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_skill_install_delete(conn, path: str, install_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        install_repo = EnterpriseSkillInstallRepo(cur)
        inst = install_repo.get_by_id(install_id)
        if inst is None:
            return 404, {"error": "SKILL_INSTALL_NOT_FOUND", "message": f"Skill install {install_id} not found"}
        skill_code = inst.skill_code
        skill_repo = EmployeeSkillBindingRepo(cur)
        grants = [bind.employee_id for bind in skill_repo.list_by_skill_code(inst.enterprise_id, skill_code)]
        for bind in skill_repo.list_by_skill_code(inst.enterprise_id, skill_code):
            skill_repo.delete(bind.id)
        install_repo.delete(install_id)
        _record_audit_event(
            cur,
            enterprise_id=inst.enterprise_id,
            event_type="skill.uninstall",
            target_type="enterprise_skill_install",
            target_id=install_id,
            payload={"skill_code": skill_code, "employee_ids": grants},
        )
        conn.commit()
        return 200, {"install_id": install_id, "skill_code": skill_code, "status": "uninstalled"}
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()



# ── path helpers ───────────────────────────────────────────────────────────

def _match_prefix(path: str, prefix: str) -> str | None:
    """If path starts with prefix, return the remainder; else None."""
    if path.startswith(prefix):
        return path[len(prefix):]
    return None


def _match_exact(path: str, target: str) -> bool:
    return path == target or path.rstrip("/") == target


def _request_params(query: str, body: dict | None = None) -> dict:
    params = {key: values[0] for key, values in parse_qs(query, keep_blank_values=True).items() if values}
    if isinstance(body, dict):
        for key in (
            "role",
            "actor_role",
            "enterprise_role",
            "system_role",
            "actor_id",
            "request_id",
            "period_start",
            "period_end",
            "employee_id",
            "target_type",
            "target_id",
            "limit",
            "format",
        ):
            value = body.get(key)
            if value not in (None, ""):
                params[key] = value
    return params


def _request_role(query: str, body: dict | None = None) -> str:
    params = _request_params(query, body)
    for key in ("actor_role", "role", "enterprise_role", "system_role"):
        value = params.get(key)
        if value:
            return str(value)
    return "owner"


def _request_actor_id(query: str, body: dict | None = None) -> str:
    params = _request_params(query, body)
    for key in ("actor_id", "user_id", "requester_id"):
        value = params.get(key)
        if value:
            return str(value)
    return "governance_api"


def _forbidden(role: str, action: str, reason: str) -> tuple[int, dict]:
    return 403, {
        "error": "FORBIDDEN",
        "message": reason,
        "required_action": action,
        "role": role or "",
    }


def _require_permission(query: str, body: dict | None, action: str) -> tuple[str | None, tuple[int, dict] | None]:
    role = _request_role(query, body)
    allowed, reason = check_permission(role, action)
    if not allowed:
        return None, _forbidden(role, action, reason)
    return role, None


def _usage_window(query: str, body: dict | None = None) -> tuple[str, str]:
    params = _request_params(query, body)
    period_start = str(params.get("period_start") or "2000-01-01")
    period_end = str(params.get("period_end") or "2099-12-31")
    return period_start, period_end


def _parse_usage_totals(payload_json: str | dict | None) -> tuple[int, int]:
    payload = _load_payload(payload_json)
    tokens = payload.get("tokens") or payload.get("total_tokens")
    cost = payload.get("cost_cents") or payload.get("cost")
    usage_payload = payload.get("usage")
    usage = usage_payload if isinstance(usage_payload, dict) else {}
    if tokens is None:
        tokens = usage.get("total_tokens") or usage.get("tokens") or 0
    if cost is None:
        cost = usage.get("cost_cents") or usage.get("cost") or 0
    return int(tokens or 0), int(cost or 0)


def _billing_usage_overview_payload(conn, query: str) -> dict:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
    finally:
        cur.close()
    conn.rollback()

    period_start, period_end = _usage_window(query)
    if enterprise is None:
        return {
            "enterprise_id": None,
            "period_start": period_start,
            "period_end": period_end,
            "total_tokens": 0,
            "total_cost_cents": 0,
            "by_employee": [],
        }

    with UnitOfWork(conn) as uow:
        view = get_billing_view(
            uow,
            enterprise.id,
            period_start=period_start,
            period_end=period_end,
        )
    return asdict(view)


def _billing_usage_records_payload(conn, query: str) -> dict:
    params = _request_params(query)
    period_start, period_end = _usage_window(query)
    employee_filter = str(params.get("employee_id") or "").strip() or None
    limit = min(max(int(params.get("limit") or 200), 1), 500)

    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
    finally:
        cur.close()
    conn.rollback()

    if enterprise is None:
        return {
            "enterprise_id": None,
            "period_start": period_start,
            "period_end": period_end,
            "items": [],
            "total": 0,
        }

    with UnitOfWork(conn) as uow:
        ledgers = uow.usage_ledgers().list_by_enterprise(
            enterprise.id,
            period_start=f"{period_start}T00:00:00Z",
            period_end=f"{period_end}T00:00:00Z",
        )
        employees = {emp.id: emp for emp in uow.employees().list_by_enterprise(enterprise.id)}

    items: list[dict] = []
    for ledger in ledgers:
        if employee_filter and ledger.employee_id != employee_filter:
            continue
        employee = employees.get(ledger.employee_id)
        items.append(
            {
                "run_id": ledger.run_id,
                "employee_id": ledger.employee_id,
                "display_name": employee.display_name if employee else "",
                "event_id": None,
                "event_cursor": None,
                "event_ts": ledger.occurred_at or _today_iso(),
                "tokens": ledger.total_tokens,
                "cost_cents": ledger.cost_cents,
                "source": ledger.source_type,
            }
        )
    items = items[:limit]
    return {
        "enterprise_id": enterprise.id,
        "period_start": period_start,
        "period_end": period_end,
        "items": items,
        "total": len(items),
    }


def _csv_response(rows: list[dict], fieldnames: list[str]) -> tuple[int, str, str]:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({key: row.get(key, "") for key in fieldnames})
    return 200, buffer.getvalue(), "text/csv; charset=utf-8"


def _handle_billing_usage_overview(conn, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "view_billing")
    if denial is not None:
        return denial
    payload = _billing_usage_overview_payload(conn, query)
    payload["effective_role"] = role
    return 200, payload


def _handle_billing_usage_records(conn, query: str) -> tuple[int, dict] | tuple[int, str, str]:
    action = "export_data" if str(_request_params(query).get("format") or "").lower() == "csv" else "view_billing"
    role, denial = _require_permission(query, None, action)
    if denial is not None:
        return denial
    payload = _billing_usage_records_payload(conn, query)
    if str(_request_params(query).get("format") or "").lower() == "csv":
        return _csv_response(
            payload["items"],
            ["run_id", "employee_id", "display_name", "event_id", "event_cursor", "event_ts", "tokens", "cost_cents", "source"],
        )
    payload["effective_role"] = role
    return 200, payload


def _handle_employees_export(conn, query: str) -> tuple[int, str, str] | tuple[int, dict]:
    _role, denial = _require_permission(query, None, "export_data")
    if denial is not None:
        return denial
    status, payload = _handle_employee_list(conn, "/employees", query)
    if status != 200:
        return status, payload
    return _csv_response(
        payload["employees"],
        ["employee_id", "display_name", "role_name", "status", "presence", "avatar_url", "created_at", "last_active_at", "conversation_count", "run_count"],
    )


def _handle_audit_events(conn, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "view_audit_logs")
    if denial is not None:
        return denial
    params = _request_params(query)
    limit = min(max(int(params.get("limit") or 100), 1), 500)
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {"enterprise_id": None, "items": [], "total": 0, "effective_role": role}
        repo = AuditEventRepo(cur)
        target_type = str(params.get("target_type") or "").strip()
        target_id = str(params.get("target_id") or "").strip()
        if target_type and target_id:
            events = repo.list_by_target(target_type, target_id, limit=limit)
        else:
            events = repo.list_by_enterprise(enterprise.id, limit=limit)
        return 200, {
            "enterprise_id": enterprise.id,
            "items": [
                {
                    "audit_event_id": event.id,
                    "actor_type": event.actor_type,
                    "actor_id": event.actor_id,
                    "event_type": event.event_type,
                    "target_type": event.target_type,
                    "target_id": event.target_id,
                    "request_id": event.request_id,
                    "payload": _load_payload(event.payload_json),
                    "created_at": event.created_at,
                    "created_by": event.created_by,
                }
                for event in events
            ],
            "total": len(events),
            "effective_role": role,
        }
    finally:
        cur.close()


def _write_audit_event(
    cur,
    *,
    enterprise_id: str,
    query: str,
    body: dict | None,
    event_type: str,
    target_type: str,
    target_id: str,
    payload: dict,
) -> None:
    AuditEventRepo(cur).create(
        AuditEvent(
            id=f"audit_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            actor_type="user",
            actor_id=_request_actor_id(query, body),
            event_type=event_type,
            target_type=target_type,
            target_id=target_id,
            request_id=str(_request_params(query, body).get("request_id") or uuid.uuid4().hex[:12]),
            payload_json=json.dumps(payload, ensure_ascii=False),
            created_by=_request_role(query, body),
        )
    )


# ── handler helpers ────────────────────────────────────────────────────────

def _workbench_error(code: str, message: str, *, retryable: bool = False) -> dict:
    return {
        "error": {
            "code": code,
            "message": message,
            "request_id": f"req_{uuid.uuid4().hex[:8]}",
            "retryable": retryable,
        }
    }


def _resolve_workbench_role(request_context: dict | None = None) -> str:
    configured_role = str(os.environ.get(_WORKBENCH_ROLE_ENV) or "").strip()
    if configured_role:
        return configured_role

    context = request_context or {}
    if context.get("webui_authenticated"):
        return "member"
    if context.get("webui_auth_enabled") is False:
        return "member"
    return "member"


def _handle_workbench(conn, path: str, query: str, request_context: dict | None = None) -> tuple[int, dict]:
    with UnitOfWork(conn) as uow:
        enterprise = next(iter(uow.enterprises().list_all()), None)
        if enterprise is None:
            return 200, {
                "enterprise": None,
                "enterprise_id": "",
                "employees": [],
                "conversations": [],
                "groups": [],
                "my_team": {"items": [], "total": 0, "active_count": 0},
                "navigation": {
                    "talent": {"label": "人才市场", "target": "/app/marketplace", "badge_count": 0},
                    "group": {"label": "群聊协作", "target": "/app/workbench", "badge_count": 0},
                    "org": {"label": "我的团队", "target": "/app/workbench", "badge_count": 0},
                    "knowledge": {"label": "知识库", "target": "/app/knowledge", "badge_count": 0},
                    "office": {"label": "办公室动态", "target": "/app/office", "badge_count": 0},
                },
                "task_status_digest": {
                    "total": 0,
                    "planned": 0,
                    "queued": 0,
                    "running": 0,
                    "waiting_deps": 0,
                    "succeeded": 0,
                    "failed": 0,
                    "cancelled": 0,
                },
                "office_digest": {"online_employee_count": 0, "running_task_count": 0},
                "empty_state": {
                    "code": "NO_ENTERPRISE",
                    "title": "还没有企业空间",
                    "message": "当前还没有可用的企业工作台。",
                    "cta_label": "前往人才市场",
                    "cta_target": "/app/marketplace",
                },
                "permissions": {
                    "role": "member",
                    "can_view_workbench": True,
                    "can_view_admin": False,
                    "visible_nav": ["talent", "group", "org", "knowledge", "office"],
                },
                "active_employees": 0,
                "active_conversations": 0,
                "today_runs": 0,
                "today_tokens": 0,
                "recent_conversations": [],
            }

        try:
            view = get_workbench_view(uow, enterprise.id, role=_resolve_workbench_role(request_context))
        except WorkbenchAccessError:
            return 403, _workbench_error("PERMISSION_DENIED", "当前账号没有查看工作台的权限")
        return 200, serialize_workbench_view(view, enterprise_name=enterprise.name)


def _current_enterprise_id(conn) -> str | None:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        return enterprises[0].id if enterprises else None
    finally:
        cur.close()


def _handle_knowledge_bases_list(conn, _path: str) -> tuple[int, dict]:
    enterprise_id = _current_enterprise_id(conn)
    if enterprise_id is None:
        return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
    cur = conn.cursor()
    try:
        kb_repo = KnowledgeBaseRepo(cur)
        doc_repo = KnowledgeDocumentRepo(cur)
        employee_repo = EmployeeRepo(cur)
        ekb_repo = EmployeeKnowledgeBindingRepo(cur)
        employees = {e.id: e for e in employee_repo.list_by_enterprise(enterprise_id)}

        kb_list = kb_repo.list_by_enterprise(enterprise_id)
        items = []
        for kb in kb_list:
            docs = doc_repo.list_by_kb(kb.id)
            employee_ids: set[str] = set()
            for eid in employees:
                bindings = ekb_repo.list_by_employee(eid)
                for b in bindings:
                    if b.knowledge_base_id == kb.id and b.enabled:
                        employee_ids.add(eid)
            binding_list = [
                {
                    "employee_id": eid,
                    "display_name": employees[eid].display_name,
                    "role_name": employees[eid].role_name,
                    "status": employees[eid].status,
                }
                for eid in sorted(employee_ids)
                if eid in employees
            ]
            items.append(
                {
                    "knowledge_base_id": kb.id,
                    "name": kb.name,
                    "description": kb.description,
                    "status": kb.status,
                    "document_count": kb.document_count,
                    "documents": [
                        {
                            "document_id": d.id,
                            "display_name": d.display_name,
                            "file_name": d.file_name,
                            "file_type": d.file_type,
                            "file_size": d.file_size,
                            "status": d.status,
                            "ingestion_job_id": d.ingestion_job_id,
                            "rag_document_id": d.rag_document_id,
                            "error_code": d.error_code,
                            "chunk_count": d.chunk_count,
                            "created_at": d.created_at,
                        }
                        for d in docs
                    ],
                    "employee_bindings": binding_list,
                    "created_at": kb.created_at,
                }
            )
        return 200, {"knowledge_bases": items}
    finally:
        cur.close()


def _handle_knowledge_document_post(conn, _path: str, kb_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    asset_id = body.get("asset_id", "")
    if not asset_id:
        return 400, {"error": "MISSING_ASSET_ID", "message": "asset_id is required"}
    display_name = body.get("display_name") or asset_id
    cur = conn.cursor()
    try:
        kb = KnowledgeBaseRepo(cur).get_by_id(kb_id)
        if kb is None:
            return 404, {"error": "KNOWLEDGE_BASE_NOT_FOUND", "message": f"Knowledge base {kb_id} not found"}
        enterprise_id = _current_enterprise_id(conn)
        if enterprise_id is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}

        doc_repo = KnowledgeDocumentRepo(cur)
        existing = doc_repo.get_by_asset(kb_id, asset_id)
        if existing is not None:
            return 201, {
                "document_id": existing.id,
                "status": existing.status,
                "ingestion_job_id": existing.ingestion_job_id,
            }

        doc_id = f"doc_{uuid.uuid4().hex[:12]}"
        job_id = f"ing_{uuid.uuid4().hex[:12]}"
        doc = KnowledgeDocument(
            id=doc_id,
            knowledge_base_id=kb_id,
            enterprise_id=enterprise_id,
            asset_id=asset_id,
            display_name=display_name,
            file_name=body.get("file_name", ""),
            file_type=body.get("mime_type", "") or body.get("file_type", ""),
            file_size=int(body.get("size", 0) or body.get("file_size", 0)),
            storage_key=body.get("storage_key", ""),
            status="ingesting",
            ingestion_job_id=job_id,
            created_by=body.get("created_by", ""),
        )
        job = KnowledgeIngestionJob(
            id=job_id,
            knowledge_base_id=kb_id,
            enterprise_id=enterprise_id,
            document_id=doc_id,
            status="parsing",
            created_by=body.get("created_by", ""),
        )
        doc_repo.create(doc)
        KnowledgeIngestionJobRepo(cur).create(job)
        KnowledgeBaseRepo(cur).increment_document_count(kb_id, 1)
        conn.commit()
        return 201, {
            "document_id": doc_id,
            "status": doc.status,
            "ingestion_job_id": job_id,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_office_scene(conn, _path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        with UnitOfWork(conn) as uow:
            enterprises = uow.enterprises().list_all()
            if not enterprises:
                return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
            scene = get_office_scene(uow, enterprises[0].id)
        return 200, scene
    finally:
        cur.close()


def _handle_office_feed(conn, _path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        with UnitOfWork(conn) as uow:
            enterprises = uow.enterprises().list_all()
            if not enterprises:
                return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
            feed = get_office_feed(uow, enterprises[0].id)
        return 200, feed
    finally:
        cur.close()


def _handle_talent_templates(conn, path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        repo = AgentTemplateRepo(cur)
        templates = repo.list_all()
        items = [
            {
                "template_id": t.id,
                "name": t.name,
                "role": t.role_name,
                "description": t.name,
                "default_model_ref": json.loads(t.default_model_json) if t.default_model_json else {},
                "skills": [],
                "tags": [t.category_code] if t.category_code else [],
                "recruit_count": 0,
                "is_recruited": False,
            }
            for t in templates
        ]
        return 200, {
            "items": items,
            "page": 1,
            "page_size": 20,
            "total": len(items),
            "has_more": False,
        }
    finally:
        cur.close()


def _handle_talent_template_detail(conn, path: str, template_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        repo = AgentTemplateRepo(cur)
        t = repo.get_by_id(template_id)
        if t is None:
            return 404, {"error": "TEMPLATE_NOT_FOUND", "message": f"Template {template_id} not found"}
        return 200, {
            "template_id": t.id,
            "name": t.name,
            "category": t.category_code,
            "description": t.name,
            "preview_avatar_url": None,
            "default_skills": [],
            "default_memory_config": {"type": "conversation scoped", "max_tokens": 8000},
            "knowledge_bindings": [],
            "connector_requirements": [],
            "price_tier": "standard",
            "usage_stats": {"total_recruits": 0, "active_instances": 0},
        }
    finally:
        cur.close()


def _handle_recruitments_post(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    template_id = body.get("template_id", "")
    display_name = body.get("display_name", "Employee")
    idempotency_key = body.get("idempotency_key", str(uuid.uuid4()))
    cur = conn.cursor()
    try:
        enterprise_repo = EnterpriseRepo(cur)
        enterprises = enterprise_repo.list_all()
        if not enterprises:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        ent = enterprises[0]
        employee_id = f"emp_{uuid.uuid4().hex[:12]}"
        profile_name = f"{ent.slug or ent.id}-{display_name.lower().replace(' ', '-')}"[:60]
        order_id = f"recruit_{uuid.uuid4().hex[:8]}"
        order = RecruitmentOrder(
            id=order_id,
            enterprise_id=ent.id,
            template_id=template_id or None,
            status="succeeded",
            requested_by="system",
            created_employee_id=employee_id,
            idempotency_key=idempotency_key,
        )
        repo = RecruitmentOrderRepo(cur)
        repo.create(order)
        emp = Employee(
            id=employee_id,
            enterprise_id=ent.id,
            template_id=template_id or None,
            profile_name=profile_name,
            display_name=display_name,
            role_name="",
            status=EmployeeStatus.ACTIVE,
            created_from="talent_market",
        )
        emp_repo = EmployeeRepo(cur)
        emp_repo.create(emp)
        conn.commit()
        return 201, {
            "order_id": order.id,
            "status": "succeeded",
            "employee_id": employee_id,
            "profile_name": profile_name,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _slug_fragment(value: str, fallback: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in (value or "")).strip("-")
    return slug or fallback


def _next_solution_profile_name(cur, enterprise_id: str, enterprise_slug: str, solution_id: str, role_name: str) -> str:
    employee_repo = EmployeeRepo(cur)
    base = f"{_slug_fragment(enterprise_slug or enterprise_id, 'enterprise')}-{_slug_fragment(solution_id, 'solution')}-{_slug_fragment(role_name, 'employee')}"
    candidate = base[:60]
    suffix = 1
    while employee_repo.get_by_profile_name(enterprise_id, candidate) is not None:
        suffix += 1
        candidate = f"{base[:52]}-{suffix}"[:60]
    return candidate


def _extract_template_knowledge_bases(template: AgentTemplate) -> list[str]:
    bindings = _load_payload(template.default_binding_json)
    knowledge_bases = bindings.get("knowledge_bases") if isinstance(bindings, dict) else []
    if not isinstance(knowledge_bases, list):
        return []
    return [str(kb_id) for kb_id in knowledge_bases if kb_id]


def _resolve_solution_template(cur, solution_id: str) -> tuple[AgentTemplate | None, tuple[int, dict] | None]:
    solution = IndustrySolutionRepo(cur).get_by_id(solution_id)
    if solution is None or solution.deleted_at is not None:
        return None, (404, {"error": "SOLUTION_NOT_FOUND", "message": f"Solution {solution_id} not found"})
    if solution.status != "published":
        return None, (409, {"error": "SOLUTION_NOT_PUBLISHED", "message": f"Solution {solution_id} is not published"})

    bindings = [binding for binding in SolutionTemplateBindingRepo(cur).list_by_solution(solution_id) if binding.enabled]
    if not bindings:
        return None, (
            409,
            {
                "error": "SOLUTION_TEMPLATE_BINDING_MISSING",
                "message": f"Solution {solution_id} has no enabled template binding",
            },
        )

    binding = bindings[0]
    template = AgentTemplateRepo(cur).get_by_id(binding.template_id)
    if template is None or template.status != "published" or template.deleted_at is not None:
        return None, (
            409,
            {
                "error": "BOUND_TEMPLATE_UNAVAILABLE",
                "message": f"Bound template {binding.template_id} is unavailable for solution {solution_id}",
            },
        )
    return template, None


def _handle_solution_apply_post(conn, path: str, solution_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}

    idempotency_key = str(body.get("idempotency_key") or "").strip()
    if not idempotency_key:
        return 400, {"error": "MISSING_IDEMPOTENCY_KEY", "message": "idempotency_key is required"}

    mode = str(body.get("mode") or "append")
    if mode not in ("append", "replace", "reapply"):
        return 400, {"error": "UNSUPPORTED_MODE", "message": f"Mode '{mode}' is not supported; use append, replace, or reapply"}
    write_mode = "append" if mode in ("replace", "reapply") else mode

    apply_key = f"solution_apply:{solution_id}:{idempotency_key}"
    cur = conn.cursor()
    try:
        enterprise_repo = EnterpriseRepo(cur)
        enterprises = enterprise_repo.list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}

        template, error_response = _resolve_solution_template(cur, solution_id)
        if error_response is not None:
            return error_response
        if template is None:
            return 409, {"error": "BOUND_TEMPLATE_UNAVAILABLE", "message": f"No usable template bound to solution {solution_id}"}

        record_repo = SolutionApplyRecordRepo(cur)
        existing_record = record_repo.get_by_idempotency_key(enterprise.id, solution_id, idempotency_key)
        if existing_record is not None:
            return 200, {
                "apply_record_id": existing_record.id,
                "status": existing_record.status,
                "created_employee_ids": _load_json_list(existing_record.created_employee_ids_json),
                "created_knowledge_base_ids": _load_json_list(existing_record.created_knowledge_base_ids_json),
            }

        knowledge_base_ids = _extract_template_knowledge_bases(template)
        employee_id = f"emp_{uuid.uuid4().hex[:12]}"
        apply_record_id = f"sol_apply_{uuid.uuid4().hex[:8]}"
        display_name = template.role_name or template.name or "Solution Employee"
        profile_name = _next_solution_profile_name(cur, enterprise.id, enterprise.slug, solution_id, display_name)

        record_repo.create(
            SolutionApplyRecord(
                id=apply_record_id,
                enterprise_id=enterprise.id,
                solution_id=solution_id,
                idempotency_key=idempotency_key,
                mode=write_mode,
                status="succeeded",
                requested_by="solution_apply",
                department_id=str(body.get("department_id") or "") or None,
                created_employee_ids_json=json.dumps([employee_id], ensure_ascii=False),
                created_knowledge_base_ids_json=json.dumps(knowledge_base_ids, ensure_ascii=False),
                created_by="solution_apply",
                updated_by="solution_apply",
            )
        )
        EmployeeRepo(cur).create(
            Employee(
                id=employee_id,
                enterprise_id=enterprise.id,
                template_id=template.id,
                profile_name=profile_name,
                display_name=display_name,
                role_name=template.role_name,
                status=EmployeeStatus.ACTIVE,
                created_from="solution_apply",
                created_by="solution_apply",
                updated_by="solution_apply",
            )
        )
        kb_repo = EmployeeKnowledgeBindingRepo(cur)
        for knowledge_base_id in knowledge_base_ids:
            kb_repo.create(
                EmployeeKnowledgeBinding(
                    id=f"kb_{uuid.uuid4().hex[:12]}",
                    enterprise_id=enterprise.id,
                    employee_id=employee_id,
                    knowledge_base_id=knowledge_base_id,
                    scope_mode="read",
                    enabled=True,
                    binding_version=1,
                    created_by="solution_apply",
                    updated_by="solution_apply",
                )
            )
        AuditEventRepo(cur).create(
            AuditEvent(
                id=f"audit_{uuid.uuid4().hex[:12]}",
                enterprise_id=enterprise.id,
                actor_type="system",
                actor_id="solution_apply",
                event_type="solution.apply",
                target_type="solution",
                target_id=solution_id,
                request_id=apply_key,
                payload_json=json.dumps(
                    {
                        "mode": mode,
                        "department_id": body.get("department_id"),
                        "template_id": template.id,
                        "created_employee_ids": [employee_id],
                        "created_knowledge_base_ids": knowledge_base_ids,
                        "apply_record_id": apply_record_id,
                    },
                    ensure_ascii=False,
                ),
                created_by="solution_apply",
            )
        )
        conn.commit()
        return 201, {
            "apply_record_id": apply_record_id,
            "status": "succeeded",
            "created_employee_ids": [employee_id],
            "created_knowledge_base_ids": knowledge_base_ids,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_conversation_detail(conn, path: str, conv_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        repo = ConversationRepo(cur)
        conv = repo.get_by_id(conv_id)
        if conv is None:
            return 404, {"error": "CONVERSATION_NOT_FOUND", "message": f"Conversation {conv_id} not found"}
        latest_run = TeamRunRepo(cur).get_by_id(conv.latest_run_id) if conv.latest_run_id else None
        latest_event = RunEventRepo(cur).get_latest_for_run(conv.latest_run_id) if conv.latest_run_id else None
        run_status = latest_run.status if latest_run is not None else None
        has_recent_delta = latest_event is not None and latest_event.event_type == "message_delta"
        message_count = _conversation_message_count(cur, conv_id)
        if conv.type == "group":
            members = _list_group_conversation_members(cur, conv_id)
            latest_route_decision = _conversation_latest_route_decision(latest_run)
            task_items = []
            latest_event_cursor = latest_event.cursor_no if latest_event is not None else 0
            if latest_run is not None:
                task_repo = TeamTaskRepo(cur)
                task_items = [
                    _serialize_team_task_item(task)
                    for task in task_repo.list_by_run(latest_run.id)
                ]
            return 200, {
                "conversation_id": conv.id,
                "conversation_type": conv.type,
                "title": conv.title,
                "status": conv.status,
                "display_state": compute_display_state(conv.status, run_status, has_recent_delta),
                "created_at": conv.created_at or _today_iso(),
                "latest_run": {
                    "run_id": conv.latest_run_id,
                    "status": latest_run.status if latest_run is not None else "queued",
                    "started_at": (latest_run.started_at if latest_run is not None else "") or _today_iso(),
                    "stream_url": f"/api/team/runs/{latest_run.id}/stream?cursor={latest_event_cursor}",
                    "events_url": f"/api/team/runs/{latest_run.id}/events?cursor={latest_event_cursor}",
                    "latest_event_cursor": latest_event_cursor,
                } if conv.latest_run_id else None,
                "message_count": message_count,
                "member_count": len(members),
                "members": members,
                "default_route_hint": "auto",
                "latest_route_decision": latest_route_decision,
                "timeline": {
                    "run_id": latest_run.id if latest_run is not None else None,
                    "events_url": f"/api/team/runs/{latest_run.id}/events?cursor=0" if latest_run is not None else None,
                    "stream_url": f"/api/team/runs/{latest_run.id}/stream?cursor={latest_event_cursor}" if latest_run is not None else None,
                    "latest_event_cursor": latest_event_cursor,
                },
                "task_tree": {
                    "run_id": latest_run.id if latest_run is not None else None,
                    "items": task_items,
                },
                "last_message_preview": {
                    "event_cursor": latest_event.cursor_no if latest_event is not None else 0,
                    "event_ts": (latest_event.event_ts if latest_event is not None else "") or _today_iso(),
                    "preview": conv.last_message_preview or "",
                } if conv.last_message_preview else None,
            }
        return 200, {
            "conversation_id": conv.id,
            "conversation_type": conv.type,
            "employee_ref": {
                "employee_id": conv.entry_employee_id,
                "display_name": "",
            } if conv.entry_employee_id else None,
            "status": conv.status,
            "display_state": compute_display_state(conv.status, run_status, has_recent_delta),
            "created_at": conv.created_at or _today_iso(),
            "latest_run": {
                "run_id": conv.latest_run_id,
                "status": latest_run.status if latest_run is not None else "queued",
                "started_at": (latest_run.started_at if latest_run is not None else "") or _today_iso(),
            } if conv.latest_run_id else None,
            "message_count": message_count,
            "last_message_preview": {
                "event_cursor": latest_event.cursor_no if latest_event is not None else 0,
                "event_ts": (latest_event.event_ts if latest_event is not None else "") or _today_iso(),
                "preview": conv.last_message_preview or "",
            } if conv.last_message_preview else None,
        }
    finally:
        cur.close()


def _conversation_message_count(cur, conversation_id: str) -> int:
    cur.execute(
        "SELECT COUNT(*) FROM conversation_message WHERE conversation_id = %s",
        (conversation_id,),
    )
    row = cur.fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _list_group_conversation_members(cur, conversation_id: str) -> list[dict]:
    cur.execute(
        "SELECT cm.member_id, cm.member_type, cm.member_ref_id, cm.role, cm.status, "
        "cm.joined_at, cm.removed_at, COALESCE(e.display_name, ''), COALESCE(e.role_name, ''), "
        "COALESCE(e.profile_name, ''), COALESCE(e.status, '') "
        "FROM conversation_member cm "
        "LEFT JOIN employee e ON e.id = cm.member_ref_id "
        "WHERE cm.conversation_id = %s AND cm.status = 'active' "
        "ORDER BY cm.joined_at ASC, cm.member_id ASC",
        (conversation_id,),
    )
    members = []
    for row in cur.fetchall():
        members.append(
            {
                "member_id": row[0],
                "member_type": row[1],
                "member_ref_id": row[2],
                "employee_id": row[2] if row[1] == "employee" else None,
                "role": row[3],
                "status": row[4],
                "joined_at": str(row[5]) if row[5] is not None else None,
                "removed_at": str(row[6]) if row[6] is not None else None,
                "display_name": row[7] or row[2],
                "role_name": row[8] or "",
                "profile_name": row[9] or "",
                "employee_status": row[10] or None,
                "is_human": row[1] == "user",
                "is_agent": row[1] == "employee",
            }
        )
    return members


def _conversation_latest_route_decision(latest_run: TeamRun | None) -> dict | None:
    if latest_run is None or not latest_run.result_summary_json:
        return None
    payload = _load_payload(latest_run.result_summary_json)
    if not payload:
        return None
    return {
        "route_mode": payload.get("route_mode", "single_agent"),
        "target_employee_ids": payload.get("target_employee_ids") or [],
        "planner_employee_id": payload.get("planner_employee_id") or None,
        "entry_employee_id": payload.get("entry_employee_id") or latest_run.entry_employee_id,
        "candidate_employee_ids": payload.get("candidate_employee_ids") or payload.get("target_employee_ids") or [],
    }


def _serialize_run_event_item(event) -> dict:
    return {
        "event_id": event.id,
        "event_cursor": event.cursor_no,
        "run_id": event.run_id,
        "event_type": event.event_type,
        "source_type": event.source_type,
        "source_id": event.source_id,
        "employee_id": event.employee_id,
        "event_ts": event.event_ts or _today_iso(),
        "preview": event.preview_text or "",
        "payload": _load_payload(event.payload_json),
    }


def _serialize_team_task_item(task) -> dict:
    payload = _load_payload(task.input_payload_json)
    output_summary = _load_payload(task.output_summary_json)
    return {
        "task_id": task.id,
        "parent_task_id": task.parent_team_task_id,
        "runtime_task_id": task.runtime_task_id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "assignee_employee_id": task.assignee_employee_id,
        "sequence_no": task.sequence_no,
        "depth": task.depth,
        "started_at": task.started_at or None,
        "finished_at": task.finished_at or None,
        "input_payload": payload,
        "output_summary": output_summary,
    }


def _handle_group_conversation_message_post(conn, path: str, conv_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}

    message = body.get("message") or {}
    message_text = (message.get("text") or "").strip()
    if not message_text:
        return 400, {"error": "MISSING_MESSAGE_TEXT", "message": "message.text is required"}

    route_hint = body.get("route_hint", "auto")
    idempotency_key = body.get("idempotency_key", str(uuid.uuid4()))
    sender_id = body.get("sender_id") or body.get("actor_id")
    if not sender_id:
        return 400, {
            "error": "MISSING_SENDER_ID",
            "message": "sender_id is required",
        }

    uow = UnitOfWork(conn)
    try:
        with uow:
            result = submit_group_message(
                uow,
                conv_id,
                message_text,
                route_hint,
                idempotency_key,
                sender_id,
            )
        return 201, result
    except ValueError as exc:
        message = str(exc)
        if "not found" in message:
            return 404, {"error": "CONVERSATION_NOT_FOUND", "message": message}
        if "not a group conversation" in message:
            return 400, {"error": "INVALID_CONVERSATION_TYPE", "message": message}
        if "Cannot submit" in message:
            return 409, {"error": "CONVERSATION_NOT_ACTIVE", "message": message}
        if "not an active conversation member" in message:
            return 403, {"error": "SENDER_NOT_CONVERSATION_MEMBER", "message": message}
        return 400, {"error": "INVALID_REQUEST", "message": message}


def _handle_runs_post(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}

    employee_id = str(body.get("employee_id") or "").strip()
    conversation_id = str(body.get("conversation_id") or "").strip()
    message = body.get("message") or {}
    message_text = str(message.get("text") or body.get("message_text") or "").strip()
    idempotency_key = body.get("idempotency_key", str(uuid.uuid4()))

    cur = conn.cursor()
    try:
        ent_id = ""
        employee = None
        if employee_id:
            employee = EmployeeRepo(cur).get_by_id(employee_id)
            if employee is None:
                return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {employee_id} not found"}
            ent_id = employee.enterprise_id
        if conversation_id:
            conversation = ConversationRepo(cur).get_by_id(conversation_id)
            if conversation is None:
                return 404, {"error": "CONVERSATION_NOT_FOUND", "message": f"Conversation {conversation_id} not found"}
            ent_id = conversation.enterprise_id
        elif employee is not None:
            conversations = ConversationRepo(cur).list_by_enterprise(employee.enterprise_id)
            private_conv = next(
                (
                    conv for conv in conversations
                    if conv.type == "private" and conv.entry_employee_id == employee_id and not conv.deleted_at
                ),
                None,
            )
            if private_conv is not None:
                conversation_id = private_conv.id
        if not ent_id:
            enterprise_repo = EnterpriseRepo(cur)
            enterprises = enterprise_repo.list_all()
            ent_id = enterprises[0].id if enterprises else ""
        if not ent_id:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        if not conversation_id:
            return 400, {"error": "MISSING_CONVERSATION_ID", "message": "conversation_id is required"}
        if not message_text:
            return 400, {"error": "MISSING_MESSAGE_TEXT", "message": "message.text is required"}
        balance_guard = guard_run_creation_allowed(cur, ent_id)
        if balance_guard is not None:
            return balance_guard
    finally:
        cur.close()

    uow = UnitOfWork(conn)
    try:
        conn.rollback()
        with uow:
            result = create_run(
                uow,
                conversation_id,
                employee_id or None,
                message_text,
                idempotency_key,
            )
        return 201, result
    except ValueError as exc:
        message = str(exc)
        if "Conversation" in message and "not found" in message:
            return 404, {"error": "CONVERSATION_NOT_FOUND", "message": message}
        if "message.text is required" in message:
            return 400, {"error": "MISSING_MESSAGE_TEXT", "message": message}
        return 400, {"error": "INVALID_REQUEST", "message": message}


def _handle_run_stream(conn, path: str, run_id: str, query: str) -> tuple[int, str, str]:
    cur = conn.cursor()
    try:
        run_repo = TeamRunRepo(cur)
        run = run_repo.get_by_id(run_id)
        if run is None:
            return 404, json.dumps({"error": "RUN_NOT_FOUND", "message": f"Run {run_id} not found"}), "application/json"
        qs = parse_qs(query)
        try:
            cursor_val = _parse_non_negative_int(qs.get("cursor", ["0"])[0], field_name="cursor", default=0)
        except ValueError as exc:
            return 400, json.dumps({"error": "INVALID_CURSOR", "message": str(exc)}), "application/json"
        event_repo = RunEventRepo(cur)
        events = event_repo.list_by_run(run_id, after_cursor=cursor_val, limit=50)
        frames = []
        for e in events:
            try:
                event_type: TimelineEventType = TimelineEventType(e.event_type)
            except ValueError:
                continue
            tl = RunTimelineEvent(
                event_id=e.id,
                event_cursor=e.cursor_no,
                run_id=e.run_id,
                event_type=event_type,
                source_type=e.source_type,
                source_id=e.source_id,
                employee_id=e.employee_id,
                event_ts=e.event_ts or _today_iso(),
                preview=e.preview_text or "",
                payload=_load_payload(e.payload_json),
            )
            frames.append(sse_frame(tl))
        sse_body = "".join(frames)
        return 200, sse_body, "text/event-stream"
    finally:
        cur.close()


def _handle_run_events(conn, path: str, run_id: str, query: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        run_repo = TeamRunRepo(cur)
        run = run_repo.get_by_id(run_id)
        if run is None:
            return 404, {"error": "RUN_NOT_FOUND", "message": f"Run {run_id} not found"}
        qs = parse_qs(query)
        try:
            cursor_val = _parse_non_negative_int(qs.get("cursor", ["0"])[0], field_name="cursor", default=0)
            requested_limit = _parse_non_negative_int(qs.get("limit", ["100"])[0], field_name="limit", default=100)
        except ValueError as exc:
            return 400, {"error": "INVALID_PAGINATION", "message": str(exc)}
        limit_val = max(1, min(requested_limit or 100, 200))
        event_repo = RunEventRepo(cur)
        paged_events = event_repo.list_by_run(run_id, after_cursor=cursor_val, limit=limit_val + 1)
        events = paged_events[:limit_val]
        items = [_serialize_run_event_item(e) for e in events]
        next_cursor = events[-1].cursor_no if events else cursor_val
        has_more = len(paged_events) > limit_val
        return 200, {
            "items": items,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "run_status": run.status,
            "latest_event_cursor": event_repo.get_max_cursor(run_id),
        }
    finally:
        cur.close()


def _handle_org_tree(conn, path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {
                "enterprise": None,
                "departments": [],
                "unassigned_members": [],
                "stats": {"department_count": 0, "assigned_employee_count": 0, "unassigned_employee_count": 0},
            }

        departments = DepartmentRepo(cur).list_by_enterprise(enterprise.id)
        employees = EmployeeRepo(cur).list_by_enterprise(enterprise.id)
        assignments = EmployeeOrgAssignmentRepo(cur).list_by_enterprise(enterprise.id)
        assignments_by_employee = {assignment.employee_id: assignment for assignment in assignments}

        members_by_department: dict[str | None, list] = {}
        assigned_employee_count = 0
        for employee in employees:
            assignment = assignments_by_employee.get(employee.id)
            member = _assignment_view(employee, assignment)
            department_id = member["department_id"]
            if department_id is not None:
                assigned_employee_count += 1
            members_by_department.setdefault(department_id, []).append(member)

        children_by_parent: dict[str | None, list] = {}
        for department in departments:
            children_by_parent.setdefault(department.parent_id, []).append(department)

        department_nodes = [
            _build_department_node(department, children_by_parent, members_by_department)
            for department in children_by_parent.get(None, [])
        ]
        unassigned_members = members_by_department.get(None, [])
        return 200, {
            "enterprise": {
                "enterprise_id": enterprise.id,
                "name": enterprise.name,
            },
            "departments": department_nodes,
            "unassigned_members": unassigned_members,
            "stats": {
                "department_count": len(departments),
                "assigned_employee_count": assigned_employee_count,
                "unassigned_employee_count": len(unassigned_members),
            },
        }
    finally:
        cur.close()


def _handle_org_assignment_patch(conn, path: str, assignment_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}

    allowed_fields = {"department_id", "position_title", "visibility_scope"}
    for key in body:
        if key not in allowed_fields:
            return 400, {"error": "INVALID_FIELD", "message": f"Field '{key}' is not allowed for org assignment PATCH"}
    if not any(key in body for key in allowed_fields):
        return 400, {"error": "EMPTY_PATCH", "message": "At least one org assignment field is required"}

    visibility_scope = body.get("visibility_scope")
    if visibility_scope is not None and visibility_scope not in {"enterprise", "department", "private"}:
        return 400, {"error": "INVALID_VISIBILITY_SCOPE", "message": f"Unsupported visibility_scope '{visibility_scope}'"}

    cur = conn.cursor()
    try:
        assignment_repo = EmployeeOrgAssignmentRepo(cur)
        employee_repo = EmployeeRepo(cur)
        department_repo = DepartmentRepo(cur)

        assignment = assignment_repo.get_by_id(assignment_id)
        employee_id = assignment.employee_id if assignment is not None else assignment_id
        employee = employee_repo.get_by_id(employee_id)
        if employee is None:
            return 404, {"error": "ORG_ASSIGNMENT_NOT_FOUND", "message": f"Org assignment {assignment_id} not found"}

        department_id = body.get("department_id") if "department_id" in body else (assignment.department_id if assignment is not None else None)
        if department_id == "":
            department_id = None
        if department_id is not None:
            department = department_repo.get_by_id(department_id)
            if department is None or department.enterprise_id != employee.enterprise_id:
                return 404, {"error": "DEPARTMENT_NOT_FOUND", "message": f"Department {department_id} not found"}
        else:
            department = None

        updated_assignment = EmployeeOrgAssignment(
            id=assignment.id if assignment is not None else assignment_id,
            enterprise_id=employee.enterprise_id,
            employee_id=employee.id,
            department_id=department_id,
            position_title=(body.get("position_title") if "position_title" in body else (assignment.position_title if assignment is not None else "")) or "",
            visibility_scope=visibility_scope or (assignment.visibility_scope if assignment is not None else "department"),
            created_by=assignment.created_by if assignment is not None else "team_api",
            updated_by="team_api",
        )
        assignment_repo.upsert(updated_assignment)
        conn.commit()

        return 200, {
            **_assignment_view(employee, updated_assignment),
            "department": {
                "department_id": department.id,
                "name": department.name,
            } if department is not None else None,
            "updated_at": _today_iso(),
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_uploads_post(conn, path: str, body: dict | None) -> tuple[int, dict]:
    # Stub: file upload requires multipart handling in the host layer.
    # Return contract-shaped response for JSON POST body.
    asset_id = f"ast_{uuid.uuid4().hex[:8]}"
    name = (body or {}).get("name", "file.bin")
    return 201, {
        "asset_id": asset_id,
        "name": name,
        "size": (body or {}).get("size", 0),
        "mime_type": (body or {}).get("mime_type", "application/octet-stream"),
        "storage_key": f"aiteam/uploads/{asset_id}/{name}",
        "preview_url": f"/api/team/uploads/{asset_id}/preview",
    }


def _handle_memory_list(conn, path: str, query: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {"items": [], "page": 1, "page_size": 20, "total": 0, "has_more": False, "sort_by": "importance", "sort_order": "desc"}
        enterprise_id = enterprise.id
        qs = parse_qs(query)
        employee_id = qs.get("employee_id", [None])[0]
        search_query = qs.get("q", [None])[0]
        category = qs.get("category", [None])[0]
        tag = qs.get("tag", [None])[0]
        source_type = qs.get("source_type", [None])[0]
        review_status = qs.get("review_status", [None])[0]
        visibility_scope = qs.get("visibility_scope", [None])[0]
        page = max(1, int(qs.get("page", [1])[0]))
        page_size = max(1, min(100, int(qs.get("page_size", [20])[0])))
        sort_by = qs.get("sort_by", ["importance"])[0]
        sort_order = qs.get("sort_order", ["desc"])[0]
        includes = set(filter(None, ",".join(qs.get("include", [])).split(",")))
        include_prompt_use_trace = "prompt_use_trace" in includes
        trace_limit = max(1, min(50, int(qs.get("trace_limit", [20])[0])))
        start = (page - 1) * page_size

        repo = MemoryItemRepo(cur)
        page_items = repo.list_by_enterprise(
            enterprise_id,
            employee_id=employee_id,
            search_query=search_query,
            tag=tag,
            category=category,
            source_type=source_type,
            review_status=review_status,
            visibility_scope=visibility_scope,
            limit=page_size,
            offset=start,
            sort_by=sort_by,
            sort_order=sort_order,
        )
        total = repo.count_by_enterprise(
            enterprise_id,
            employee_id=employee_id,
            search_query=search_query,
            tag=tag,
            category=category,
            source_type=source_type,
            review_status=review_status,
            visibility_scope=visibility_scope,
        )
        review_repo = MemoryReviewDecisionRepo(cur)
        latest_reviews = review_repo.latest_by_memory_ids([item.id for item in page_items])
        return 200, {
            "items": [
                _serialize_memory_item(
                    cur,
                    item,
                    latest_reviews.get(item.id),
                    include_prompt_use_trace=include_prompt_use_trace,
                    trace_limit=trace_limit,
                )
                for item in page_items
            ],
            "page": page,
            "page_size": page_size,
            "total": total,
            "has_more": start + page_size < total,
            "sort_by": sort_by if sort_by in {"importance", "updated_at", "created_at"} else "importance",
            "sort_order": "asc" if str(sort_order).lower() == "asc" else "desc",
        }
    finally:
        cur.close()


def _handle_memory_post(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    employee_id = body.get("employee_id")
    content = str(body.get("content") or "").strip()
    category = body.get("category", "event")
    importance = int(body.get("importance", 3))
    tags = body.get("tags", [])
    visibility_scope = body.get("visibility_scope", "enterprise")
    if not employee_id:
        return 400, {"error": "MISSING_EMPLOYEE_ID", "message": "employee_id is required"}
    if not content:
        return 400, {"error": "MISSING_CONTENT", "message": "content is required"}
    if category not in {"preference", "habit", "decision", "event"}:
        return 400, {"error": "INVALID_CATEGORY", "message": f"Unsupported category: {category}"}
    if importance < 1 or importance > 5:
        return 400, {"error": "INVALID_IMPORTANCE", "message": "importance must be between 1 and 5"}
    if visibility_scope not in {"enterprise", "admin_only"}:
        return 400, {"error": "INVALID_VISIBILITY_SCOPE", "message": f"Unsupported visibility_scope: {visibility_scope}"}
    if not isinstance(tags, list):
        return 400, {"error": "INVALID_TAGS", "message": "tags must be a list"}

    cur = conn.cursor()
    try:
        employee = EmployeeRepo(cur).get_by_id(employee_id)
        if employee is None:
            return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {employee_id} not found"}
        memory_id = f"mem_{uuid.uuid4().hex[:12]}"
        item = MemoryItem(
            id=memory_id,
            enterprise_id=employee.enterprise_id,
            employee_id=employee_id,
            content=content,
            category=category,
            importance=importance,
            source_type="manual",
            tags_json=json.dumps([str(tag) for tag in tags], ensure_ascii=False),
            visibility_scope=visibility_scope,
            runtime_ref_json=json.dumps({}, ensure_ascii=False),
            created_by="system",
            updated_by="system",
        )
        repo = MemoryItemRepo(cur)
        repo.create(item)
        pruned_memory_ids = _prune_memory_overflow(cur, enterprise_id=employee.enterprise_id, employee_id=employee_id)
        _record_audit_event(
            cur,
            enterprise_id=employee.enterprise_id,
            event_type="memory.create",
            target_type="memory_item",
            target_id=memory_id,
            payload={
                "employee_id": employee_id,
                "category": category,
                "importance": importance,
                "tags": [str(tag) for tag in tags],
                "visibility_scope": visibility_scope,
                "pruned_memory_ids": pruned_memory_ids,
            },
        )
        conn.commit()
        created = repo.get_by_id(memory_id)
        if created is None:
            raise RuntimeError(f"Memory item {memory_id} disappeared after create")
        response = _serialize_memory_item(cur, created, None)
        if pruned_memory_ids:
            response["degradation"] = {
                "strategy": "prune_oldest_low_priority",
                "pruned_memory_ids": pruned_memory_ids,
            }
        return 201, response
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_memory_patch(conn, path: str, memory_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    cur = conn.cursor()
    try:
        repo = MemoryItemRepo(cur)
        review_repo = MemoryReviewDecisionRepo(cur)
        item = repo.get_by_id(memory_id)
        if item is None:
            return 404, {"error": "MEMORY_NOT_FOUND", "message": f"Memory {memory_id} not found"}
        if "content" in body:
            content = str(body.get("content") or "").strip()
            if not content:
                return 400, {"error": "MISSING_CONTENT", "message": "content cannot be empty"}
            item.content = content
        if "category" in body:
            category = body.get("category")
            if category not in {"preference", "habit", "decision", "event"}:
                return 400, {"error": "INVALID_CATEGORY", "message": f"Unsupported category: {category}"}
            item.category = category
        if "importance" in body:
            importance = int(body.get("importance", item.importance))
            if importance < 1 or importance > 5:
                return 400, {"error": "INVALID_IMPORTANCE", "message": "importance must be between 1 and 5"}
            item.importance = importance
        if "visibility_scope" in body:
            visibility_scope = body.get("visibility_scope")
            if visibility_scope not in {"enterprise", "admin_only"}:
                return 400, {"error": "INVALID_VISIBILITY_SCOPE", "message": f"Unsupported visibility_scope: {visibility_scope}"}
            item.visibility_scope = visibility_scope
        if "tags" in body:
            tags = body.get("tags")
            if not isinstance(tags, list):
                return 400, {"error": "INVALID_TAGS", "message": "tags must be a list"}
            item.tags_json = json.dumps([str(tag) for tag in tags], ensure_ascii=False)

        latest_review = review_repo.get_latest_by_memory_id(memory_id)
        review_payload = body.get("review")
        if review_payload is not None:
            if not isinstance(review_payload, dict):
                return 400, {"error": "INVALID_REVIEW", "message": "review must be an object"}
            decision = review_payload.get("decision")
            if decision not in {"pending", "confirmed", "rejected", "corrected"}:
                return 400, {"error": "INVALID_REVIEW_DECISION", "message": f"Unsupported review.decision: {decision}"}
            corrected_content = review_payload.get("corrected_content")
            if decision == "corrected":
                corrected_text = str(corrected_content or "").strip()
                if not corrected_text:
                    return 400, {"error": "MISSING_CORRECTED_CONTENT", "message": "corrected_content is required when decision=corrected"}
                item.content = corrected_text
                corrected_content = corrected_text
            latest_review = review_repo.create(
                MemoryReviewDecision(
                    id=f"mrd_{uuid.uuid4().hex[:12]}",
                    enterprise_id=item.enterprise_id,
                    memory_item_id=item.id,
                    reviewer_user_id=str(review_payload.get("reviewed_by") or "system"),
                    decision=decision,
                    comment=review_payload.get("comment"),
                    corrected_content=corrected_content,
                    created_by="system",
                    updated_by="system",
                )
            )

        item.updated_by = "system"
        repo.update(item)
        _record_audit_event(
            cur,
            enterprise_id=item.enterprise_id,
            event_type="memory.update",
            target_type="memory_item",
            target_id=item.id,
            payload=body,
        )
        conn.commit()
        updated = repo.get_by_id(memory_id)
        if updated is None:
            raise RuntimeError(f"Memory item {memory_id} disappeared after update")
        return 200, _serialize_memory_item(cur, updated, latest_review)
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_memory_delete(conn, path: str, memory_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        repo = MemoryItemRepo(cur)
        item = repo.get_by_id(memory_id)
        if item is None:
            return 404, {"error": "MEMORY_NOT_FOUND", "message": f"Memory {memory_id} not found"}
        repo.delete(memory_id)
        _record_audit_event(
            cur,
            enterprise_id=item.enterprise_id,
            event_type="memory.delete",
            target_type="memory_item",
            target_id=memory_id,
            payload={"employee_id": item.employee_id},
        )
        conn.commit()
        return 200, {"memory_id": memory_id, "status": "deleted"}
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_memory_bulk_delete(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    memory_ids = body.get("memory_ids")
    if not isinstance(memory_ids, list) or not memory_ids:
        return 400, {"error": "INVALID_MEMORY_IDS", "message": "memory_ids must be a non-empty list"}
    employee_id = body.get("employee_id")
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        repo = MemoryItemRepo(cur)
        normalized_ids = [str(memory_id) for memory_id in memory_ids if str(memory_id or "").strip()]
        repo.bulk_delete(normalized_ids, enterprise_id=enterprise.id, employee_id=employee_id)
        _record_audit_event(
            cur,
            enterprise_id=enterprise.id,
            event_type="memory.bulk_delete",
            target_type="memory_item",
            target_id=normalized_ids[0],
            payload={"memory_ids": normalized_ids, "employee_id": employee_id},
        )
        conn.commit()
        return 200, {"deleted_count": len(normalized_ids), "memory_ids": normalized_ids, "status": "deleted"}
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_employee_list(conn, path: str, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        enterprise_repo = EnterpriseRepo(cur)
        enterprises = enterprise_repo.list_all()
        if not enterprises:
            return 200, {"employees": [], "total": 0, "page": 1, "limit": 20, "effective_role": role}
        ent = enterprises[0]
        repo = EmployeeRepo(cur)
        employees = repo.list_by_enterprise(ent.id)
        qs = parse_qs(query)
        status_filter = qs.get("status", [None])[0]
        if status_filter:
            employees = [e for e in employees if e.status == status_filter]
        return 200, {
            "employees": [
                {
                    "employee_id": e.id,
                    "display_name": e.display_name,
                    "role_name": e.role_name,
                    "status": e.status,
                    "presence": "idle",
                    "avatar_url": e.avatar_url,
                    "created_at": e.created_at or _today_iso(),
                    "last_active_at": e.updated_at or _today_iso(),
                    "conversation_count": 0,
                    "run_count": 0,
                }
                for e in employees
            ],
            "total": len(employees),
            "page": 1,
            "limit": 20,
            "effective_role": role,
        }
    finally:
        cur.close()


def _handle_employee_detail(conn, path: str, emp_id: str, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
    conn.rollback()
    with UnitOfWork(conn) as uow:
        view = get_employee_admin_view(uow, emp_id)
    if view is None:
        return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {emp_id} not found"}
    cur = conn.cursor()
    try:
        emp = EmployeeRepo(cur).get_by_id(emp_id)
        avatar_url = emp.avatar_url if emp else None
        template_id = emp.template_id if emp else None
        profile_name = emp.profile_name if emp else ""
        created_at = emp.created_at if emp else _today_iso()
    finally:
        cur.close()
    return 200, {
        "employee_id": view.employee_id,
        "display_name": view.display_name,
        "role_name": view.role_name,
        "status": view.status,
        "presence": "idle",
        "avatar_url": avatar_url,
        "template_ref": {
            "template_id": template_id,
            "name": "",
        } if template_id else None,
        "profile_config": {
            "profile_name": profile_name,
            "skills": [
                skill["skill_code"] for skill in view.skills if skill.get("enabled", True)
            ],
            "memory_config": view.memory_config,
        },
        "connector_bindings": [
            {
                "binding_id": binding["binding_id"],
                "connector_id": binding["connector_id"],
                "access_mode": binding.get("access_mode", "invoke"),
                "enabled": binding.get("enabled", True),
            }
            for binding in view.connector_bindings
        ],
        "conversation_bindings": [],
        "usage_summary": {
            "total_runs": 0,
            "total_tokens": 0,
            "last_run_at": None,
        },
        "model_provider": view.model_provider,
        "model_name": view.model_name,
        "prompt_version": view.prompt_version,
        "prompt_config": view.prompt_config,
        "knowledge_bases": view.knowledge_bases,
        "created_at": created_at,
        "effective_role": role,
    }


# ── B06: solutions list ──

def _handle_solutions_list(conn, path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        cur.execute(
            "SELECT id, name, status, tags_json, default_kb_blueprint_json, "
            "default_skill_bundle_json, default_collaboration_template_ref, "
            "created_at, updated_at "
            "FROM industry_solution WHERE deleted_at IS NULL ORDER BY created_at DESC"
        )
        rows = cur.fetchall()
        binding_repo = SolutionTemplateBindingRepo(cur)
        apply_record_repo = SolutionApplyRecordRepo(cur)
        audit_repo = AuditEventRepo(cur)
        solution_apply_employee_counts: dict[str, int] = {}
        if enterprise is not None:
            employee_repo = EmployeeRepo(cur)
            for employee in employee_repo.list_by_enterprise(enterprise.id):
                if employee.created_from != "solution_apply" or not employee.template_id:
                    continue
                solution_apply_employee_counts[employee.template_id] = (
                    solution_apply_employee_counts.get(employee.template_id, 0) + 1
                )
        items = []
        for row in rows:
            tags = row[3] if isinstance(row[3], list) else []
            solution_id = row[0]
            template_ids = [
                binding.template_id
                for binding in binding_repo.list_by_solution(solution_id)
                if binding.enabled
            ]
            apply_records = apply_record_repo.list_by_solution(solution_id)
            latest_apply = apply_records[0] if apply_records else None
            active_employee_count = sum(
                solution_apply_employee_counts.get(template_id, 0)
                for template_id in template_ids
            )
            publish_record = None
            for audit in audit_repo.list_by_target("solution", solution_id, limit=20):
                if audit.event_type in {"solution.publish", "solution.unpublish"}:
                    publish_record = {
                        "event_type": audit.event_type,
                        "is_published": audit.event_type == "solution.publish",
                        "created_at": audit.created_at,
                    }
                    break
            items.append({
                "solution_id": solution_id,
                "name": row[1] or "",
                "status": row[2],
                "tags": tags if isinstance(tags, list) else [],
                "template_ids": template_ids,
                "template_count": len(template_ids),
                "apply_count": len(apply_records),
                "active_employee_count": active_employee_count,
                "default_kb_blueprint": _load_payload(row[4]),
                "default_skill_bundle": _load_payload(row[5]),
                "publish_record": publish_record,
                "last_apply_record_id": latest_apply.id if latest_apply is not None else "",
                "last_apply_status": latest_apply.status if latest_apply is not None else "",
                "created_employee_ids": _load_json_list(latest_apply.created_employee_ids_json) if latest_apply is not None else [],
                "created_knowledge_base_ids": _load_json_list(latest_apply.created_knowledge_base_ids_json) if latest_apply is not None else [],
                "solution_stats": {
                    "apply_count": len(apply_records),
                    "active_employee_count": active_employee_count,
                    "template_count": len(template_ids),
                },
                "created_at": str(row[7]) if row[7] else "",
            })
        return 200, {"solutions": items, "total": len(items)}
    finally:
        cur.close()


# ── B05: connectors list/create/test/grants ──

def _handle_connectors_list(conn, path: str, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_connectors")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {"items": [], "definitions": [], "effective_role": role}
        connector_repo = EnterpriseConnectorRepo(cur)
        definition_repo = ConnectorDefinitionRepo(cur)
        employee_repo = EmployeeRepo(cur)
        connectors = connector_repo.list_by_enterprise(enterprise.id)
        definitions = definition_repo.list_active()
        employees = employee_repo.list_by_enterprise(enterprise.id)
        employee_map = {employee.id: employee for employee in employees}
        binding_repo = EmployeeConnectorBindingRepo(cur)
        grants_by_connector: dict[str, list[dict]] = {}
        for connector in connectors:
            bindings = binding_repo.list_by_connector(connector.id)
            grants_by_connector[connector.id] = [
                _serialize_connector_grant(binding, employee_map)
                for binding in bindings
            ]
        definition_map = {definition.id: definition for definition in definitions}
        items = [
            _serialize_connector(
                connector,
                grants=grants_by_connector.get(connector.id, []),
                definition=definition_map.get(connector.definition_id),
            )
            for connector in connectors
            if connector.status != "archived"
        ]
        return 200, {
            "items": items,
            "connectors": items,
            "definitions": [_serialize_connector_definition(definition) for definition in definitions],
            "effective_role": role,
        }
    finally:
        cur.close()


def _handle_connector_detail(conn, path: str, connector_id: str, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_connectors")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        repo = EnterpriseConnectorRepo(cur)
        connector = repo.get_by_id(connector_id)
        if connector is None or connector.deleted_at is not None:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        definition = ConnectorDefinitionRepo(cur).get_by_id(connector.definition_id) if connector.definition_id else None
        employees = EmployeeRepo(cur).list_by_enterprise(connector.enterprise_id)
        employee_map = {employee.id: employee for employee in employees}
        bindings = EmployeeConnectorBindingRepo(cur).list_by_connector(connector_id)
        grants = [_serialize_connector_grant(binding, employee_map) for binding in bindings]
        audit_summary = [
            {
                "event_type": audit.event_type,
                "created_at": audit.created_at,
                "payload": _load_payload(audit.payload_json),
            }
            for audit in AuditEventRepo(cur).list_by_target("connector", connector_id, limit=10)
        ]
        available_employees = [
            {
                "employee_id": employee.id,
                "display_name": employee.display_name,
                "status": employee.status,
            }
            for employee in employees
        ]
        payload = _serialize_connector(
            connector,
            grants=grants,
            definition=definition,
            available_employees=available_employees,
            audit_summary=audit_summary,
        )
        payload["effective_role"] = role
        return 200, payload
    finally:
        cur.close()


def _handle_connectors_post(conn, path: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_connectors")
    if denial is not None:
        return denial
    credential_ref, credential_error = _extract_connector_credential_ref(body)
    if credential_error is not None:
        return 400, credential_error
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        credential_state = "configured" if credential_ref else "missing"
        name = str(body.get("name") or "Connector")
        provider_code = str(body.get("provider_code") or body.get("provider") or "custom")
        connector_type = str(body.get("connector_type") or body.get("type") or "api_key_connector")
        definition_id = body.get("definition_id")
        config_json = _normalize_connector_config_input(body.get("config_json", body.get("config", {})))
        scopes = _normalize_scopes(body.get("scopes") or ["invoke"])
        actor_id = _request_actor_id(query, body)
        connector_id = f"conn_{uuid.uuid4().hex[:12]}"
        connector = EnterpriseConnector(
            id=connector_id,
            enterprise_id=enterprise.id,
            definition_id=str(definition_id) if definition_id else None,
            name=name,
            provider_code=provider_code,
            connector_type=connector_type,
            credential_ref=credential_ref,
            credential_mask=_mask_connector_secret(credential_ref),
            credential_state=credential_state,
            rotation_version=0,
            status="draft",
            config_json=json.dumps(config_json, ensure_ascii=False),
            scopes_json=json.dumps(scopes, ensure_ascii=False),
            last_test_result_json=json.dumps(_default_last_test_result(), ensure_ascii=False),
            updated_by=actor_id,
        )
        EnterpriseConnectorRepo(cur).create(connector)
        _record_audit_event(
            cur,
            enterprise_id=enterprise.id,
            event_type="connector_created",
            target_type="connector",
            target_id=connector_id,
            payload={
                "connector_id": connector_id,
                "new_status": "draft",
                "new_credential_ref": credential_ref,
                "request_id": body.get("idempotency_key") or connector_id,
            },
        )
        conn.commit()
        return 201, {
            "connector_id": connector_id,
            "status": "draft",
            "credential_state": credential_state,
            "updated_at": connector.updated_at or _today_iso(),
            "effective_role": role,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_connector_patch(conn, path: str, connector_id: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_connectors")
    if denial is not None:
        return denial
    credential_ref, credential_error = _extract_connector_credential_ref(body)
    if credential_error is not None:
        return 400, credential_error
    allowed_fields = {"name", "config", "scopes", "credential_input", "archive", "unarchive"}
    invalid_fields = sorted(set(body.keys()) - allowed_fields)
    if invalid_fields:
        return 400, {"error": "INVALID_FIELD", "message": f"Field '{invalid_fields[0]}' is not allowed for PATCH"}
    cur = conn.cursor()
    try:
        repo = EnterpriseConnectorRepo(cur)
        connector = repo.get_by_id(connector_id)
        if connector is None or connector.deleted_at is not None:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        actor_id = _request_actor_id(query, body)
        previous_status = connector.status
        previous_credential_ref = connector.credential_ref
        if "name" in body:
            connector.name = str(body.get("name") or connector.name)
        if "config" in body:
            connector.config_json = json.dumps(_normalize_connector_config_input(body.get("config") or {}), ensure_ascii=False)
            if connector.status == "online":
                connector.status = "draft"
        if "scopes" in body:
            connector.scopes_json = json.dumps(_normalize_scopes(body.get("scopes")), ensure_ascii=False)
            if connector.status == "online":
                connector.status = "draft"
        if "credential_input" in body:
            new_ref = credential_ref or ""
            if new_ref != connector.credential_ref:
                connector.credential_ref = new_ref
                connector.credential_mask = _mask_connector_secret(new_ref)
                connector.rotation_version = int(connector.rotation_version or 0) + 1
                connector.credential_state = "configured" if new_ref else "missing"
                connector.status = "draft" if new_ref else "draft"
        if body.get("archive"):
            connector.status = "archived"
        if body.get("unarchive"):
            connector.status = "draft"
        connector.updated_by = actor_id
        repo.update(connector)
        event_type = "connector_updated"
        if body.get("archive"):
            event_type = "connector_archived"
        elif body.get("unarchive"):
            event_type = "connector_unarchived"
        elif previous_credential_ref != connector.credential_ref:
            event_type = "connector_credential_rotated"
        new_status = connector.status
        _record_audit_event(
            cur,
            enterprise_id=connector.enterprise_id,
            event_type=event_type,
            target_type="connector",
            target_id=connector.id,
            payload={
                "connector_id": connector.id,
                "old_status": previous_status,
                "new_status": new_status,
                "old_credential_ref": previous_credential_ref,
                "new_credential_ref": connector.credential_ref,
                "request_id": connector.id,
            },
        )
        conn.commit()
        return 200, {
            "connector_id": connector.id,
            "status": connector.status,
            "credential_state": connector.credential_state,
            "rotation_version": connector.rotation_version,
            "updated_at": connector.updated_at or _today_iso(),
            "effective_role": role,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_connector_test(conn, path: str, connector_id: str, query: str, body: dict | None) -> tuple[int, dict]:
    role, denial = _require_permission(query, body, "manage_connectors")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        repo = EnterpriseConnectorRepo(cur)
        connector = repo.get_by_id(connector_id)
        if connector is None:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        actor_id = _request_actor_id(query, body)
        previous_status = connector.status
        new_status, new_credential_state, test_result = _connector_test_outcome(connector, body, actor_id)
        connector.status = new_status
        connector.credential_state = new_credential_state
        connector.last_test_result_json = json.dumps(test_result, ensure_ascii=False)
        connector.last_validated_at = test_result["checked_at"]
        connector.updated_by = actor_id
        repo.update(connector)
        cur.execute(
            "UPDATE enterprise_connector SET last_validated_at=%s WHERE id=%s",
            (test_result["checked_at"], connector_id),
        )
        _record_audit_event(
            cur,
            enterprise_id=connector.enterprise_id,
            event_type="connector_tested",
            target_type="connector",
            target_id=connector.id,
            payload={
                "connector_id": connector.id,
                "old_status": previous_status,
                "new_status": new_status,
                "test_result": test_result["result"],
                "request_id": connector.id,
            },
        )
        conn.commit()
        return 200, {
            "connector_id": connector.id,
            "result": test_result["result"],
            "status": connector.status,
            "last_test_result": test_result,
            "effective_role": role,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_connector_status(conn, path: str, connector_id: str, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_connectors")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        connector = EnterpriseConnectorRepo(cur).get_by_id(connector_id)
        if connector is None or connector.deleted_at is not None:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        return 200, {
            "connector_id": connector.id,
            "status": connector.status,
            "credential_state": connector.credential_state,
            "last_test_result": _normalize_last_test_result(connector.last_test_result_json),
            "updated_at": connector.updated_at,
            "effective_role": role,
        }
    finally:
        cur.close()


def _handle_connector_grants_patch(conn, path: str, connector_id: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_connectors")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        connector = EnterpriseConnectorRepo(cur).get_by_id(connector_id)
        if connector is None:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        if connector.status != "online" and body.get("grant"):
            return 409, {"error": "CONNECTOR_NOT_ONLINE", "message": f"Connector {connector_id} is {connector.status}, must be online"}
        grant = body.get("grant")
        revoke = body.get("revoke")
        results = {"granted": [], "revoked": [], "errors": [], "effective_role": role}
        conn.rollback()
        with UnitOfWork(conn) as uow:
            for entry in (grant or []):
                employee_ids = entry.get("employee_ids")
                if not employee_ids:
                    employee_id = entry.get("employee_id", "")
                    employee_ids = [employee_id] if employee_id else []
                access_mode = entry.get("access_mode", "invoke")
                for employee_id in employee_ids:
                    if not employee_id:
                        continue
                    try:
                        binding_id = grant_connector(uow, enterprise.id, employee_id, connector_id, access_mode)
                        results["granted"].append({"binding_id": binding_id, "employee_id": employee_id})
                    except ValueError as exc:
                        results["errors"].append({"employee_id": employee_id, "error": str(exc)})
            for entry in (revoke or []):
                binding_id = entry.get("binding_id", "")
                try:
                    revoke_connector(uow, binding_id)
                    results["revoked"].append(binding_id)
                except ValueError as exc:
                    results["errors"].append({"binding_id": binding_id, "error": str(exc)})
        audit_cur = conn.cursor()
        try:
            for granted in results["granted"]:
                _record_audit_event(
                    audit_cur,
                    enterprise_id=enterprise.id,
                    event_type="connector_grant_created",
                    target_type="connector",
                    target_id=connector_id,
                    payload={
                        "connector_id": connector_id,
                        "employee_id": granted["employee_id"],
                        "access_mode": next((entry.get("access_mode", "invoke") for entry in (grant or []) if granted["employee_id"] in (entry.get("employee_ids") or [entry.get("employee_id")]) ), "invoke"),
                        "request_id": granted["binding_id"],
                    },
                )
            for revoked in results["revoked"]:
                _record_audit_event(
                    audit_cur,
                    enterprise_id=enterprise.id,
                    event_type="connector_grant_revoked",
                    target_type="connector",
                    target_id=connector_id,
                    payload={
                        "connector_id": connector_id,
                        "binding_id": revoked,
                        "request_id": revoked,
                    },
                )
            conn.commit()
        finally:
            audit_cur.close()
        return 200, results
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_employee_patch(conn, path: str, emp_id: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial
    try:
        conn.rollback()
        with UnitOfWork(conn) as uow:
            repo = uow.employees()
            emp = repo.get_by_id(emp_id)
            if emp is None:
                return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {emp_id} not found"}

            for key in body:
                if key not in _ALLOWED_PATCH_FIELDS:
                    return 400, {"error": "INVALID_FIELD", "message": f"Field '{key}' is not allowed for PATCH"}

            new_status = body.get("status")
            if new_status is not None:
                if emp.status not in _VALID_EMPLOYEE_TRANSITIONS:
                    return 400, {
                        "error": "INVALID_STATUS_TRANSITION",
                        "message": f"Cannot transition from {emp.status}: current status is terminal or invalid",
                    }
                if new_status not in _VALID_EMPLOYEE_TRANSITIONS.get(emp.status, set()):
                    return 400, {
                        "error": "INVALID_STATUS_TRANSITION",
                        "message": f"Cannot transition from {emp.status} to {new_status}",
                    }
                try:
                    if new_status == "active":
                        if emp.status == "paused":
                            emp.resume()
                        elif emp.status == "draft":
                            emp.activate()
                        else:
                            emp.status = new_status
                    elif new_status == "paused":
                        emp.pause()
                    elif new_status == "archived":
                        emp.archive()
                    else:
                        emp.status = new_status
                except ValueError as exc:
                    return 400, {"error": "INVALID_STATUS_TRANSITION", "message": str(exc)}

            new_display_name = body.get("display_name")
            if new_display_name is not None:
                emp.display_name = new_display_name

            for field_name in (
                "model_provider",
                "model_name",
                "prompt_version",
                "config_version",
                "capabilities_json",
                "description",
            ):
                if field_name in body:
                    setattr(emp, field_name, body.get(field_name))

            skills_add = body.get("skills_add")
            skills_remove = body.get("skills_remove")
            repo.update_status(emp)

            if skills_add:
                # B01 Phase 3 behavior change: reject unauthorized skill additions.
                for skill_code in skills_add:
                    install = uow.enterprise_skill_installs().get_active_by_skill_code(emp.enterprise_id, skill_code)
                    if not install:
                        return 403, {"error": "SKILL_NOT_AUTHORIZED", "message": f"Skill {skill_code} is not installed for this enterprise"}

                existing_skill_codes = {
                    binding.skill_code
                    for binding in uow.employee_skill_bindings().list_by_employee(emp_id)
                    if binding.enabled
                }
                for skill_code in skills_add:
                    if skill_code in existing_skill_codes:
                        continue
                    uow.employee_skill_bindings().create(
                        EmployeeSkillBinding(
                            id=f"sb_{uuid.uuid4().hex[:12]}",
                            enterprise_id=emp.enterprise_id,
                            employee_id=emp_id,
                            skill_code=skill_code,
                            enabled=True,
                            source_type="manual",
                            visibility="allow",
                        )
                    )

            if skills_remove:
                existing_bindings = uow.employee_skill_bindings().list_by_employee(emp_id)
                for skill_code in skills_remove:
                    for binding in existing_bindings:
                        if binding.skill_code == skill_code:
                            uow.employee_skill_bindings().delete(binding.id)

            if any(field in body for field in ("prompt_system", "prompt_behavior_rules_json", "prompt_opening_message")):
                existing_prompt = uow.employee_prompts().get_by_employee(emp_id)
                uow.employee_prompts().upsert(
                    EmployeePrompt(
                        employee_id=emp_id,
                        system_prompt=body.get("prompt_system", existing_prompt.system_prompt if existing_prompt else None),
                        behavior_rules_json=body.get("prompt_behavior_rules_json", existing_prompt.behavior_rules_json if existing_prompt else "{}"),
                        opening_message=body.get("prompt_opening_message", existing_prompt.opening_message if existing_prompt else None),
                        version_no=(body.get("prompt_version") or emp.prompt_version or 1),
                    )
                )

            if any(field in body for field in (
                "memory_mode",
                "memory_provider_code",
                "memory_retention_days",
                "memory_writeback_enabled",
            )):
                existing_memory = uow.employee_memory_bindings().get_by_employee(emp_id)
                uow.employee_memory_bindings().upsert(
                    EmployeeMemoryBinding(
                        id=existing_memory.id if existing_memory is not None else f"emb_{uuid.uuid4().hex[:12]}",
                        enterprise_id=emp.enterprise_id,
                        employee_id=emp_id,
                        memory_mode=body.get("memory_mode", existing_memory.memory_mode if existing_memory else "conversation_scoped"),
                        provider_code=body.get("memory_provider_code", existing_memory.provider_code if existing_memory else None),
                        retention_days=body.get("memory_retention_days", existing_memory.retention_days if existing_memory else None),
                        writeback_enabled=body.get("memory_writeback_enabled", existing_memory.writeback_enabled if existing_memory else True),
                    )
                )

            knowledge_base_ids = body.get("knowledge_base_ids")
            if knowledge_base_ids is not None:
                for binding in uow.employee_knowledge_bindings().list_by_employee(emp_id):
                    uow.employee_knowledge_bindings().delete(binding.id)
                for knowledge_base_id in knowledge_base_ids:
                    uow.employee_knowledge_bindings().create(
                        EmployeeKnowledgeBinding(
                            id=f"kb_{uuid.uuid4().hex[:12]}",
                            enterprise_id=emp.enterprise_id,
                            employee_id=emp_id,
                            knowledge_base_id=knowledge_base_id,
                            scope_mode="read",
                            enabled=True,
                        )
                    )

            connector_ids = body.get("connector_ids")
            if connector_ids is not None:
                for binding in uow.employee_connector_bindings().list_by_employee(emp_id):
                    uow.employee_connector_bindings().delete(binding.id)
                for connector_id in connector_ids:
                    uow.employee_connector_bindings().create(
                        EmployeeConnectorBinding(
                            id=f"cb_{uuid.uuid4().hex[:12]}",
                            enterprise_id=emp.enterprise_id,
                            employee_id=emp_id,
                            connector_id=connector_id,
                            enabled=True,
                            access_mode="invoke",
                        )
                    )

            _write_audit_event(
                uow.cur,
                enterprise_id=emp.enterprise_id,
                query=query,
                body=body,
                event_type="employee.updated",
                target_type="employee",
                target_id=emp.id,
                payload={"fields": sorted(body.keys()), "status": emp.status, "display_name": emp.display_name},
            )

        response = {
            "employee_id": emp.id,
            "display_name": emp.display_name,
            "status": emp.status,
            "reprovision_status": None,
            "updated_at": _today_iso(),
            "effective_role": role,
        }
        if skills_add or skills_remove:
            response["skills_updated"] = {"added": skills_add or [], "removed": skills_remove or []}
        return 200, response
    except Exception:
        conn.rollback()
        raise


# ── Main dispatch ──────────────────────────────────────────────────────────

_ROUTES = [
    # (method, path_matcher, handler_fn)
    # Ordered: most specific first
]


def handle_team_route(
    path: str,
    method: str,
    body: dict | None = None,
    request_context: dict | None = None,
) -> tuple[int, dict] | tuple[int, str, str]:
    """Main router entry point called by host dispatch.

    Returns (status_code, response_dict) for JSON responses,
    or (status_code, body_text, content_type) for non-JSON responses (e.g. SSE).
    """
    # Strip /api/team prefix — the dispatch already matched the prefix
    sub = path[len("/api/team"):] if path.startswith("/api/team") else path
    if not sub:
        sub = "/"

    # Parse query string from the sub-path (if present)
    query = ""
    if "?" in sub:
        sub, query = sub.split("?", 1)

    route_handler = None

    # ── workbench ──
    if method == "GET" and _match_exact(sub, "/workbench"):
        route_handler = lambda conn: _handle_workbench(conn, sub, query, request_context)

    # ── office scene/feed ──
    elif method == "GET" and _match_exact(sub, "/office/scene"):
        route_handler = lambda conn: _handle_office_scene(conn, sub)
    elif method == "GET" and _match_exact(sub, "/office/feed"):
        route_handler = lambda conn: _handle_office_feed(conn, sub)

    # ── org/tree ──
    elif method == "GET" and _match_exact(sub, "/org/tree"):
        route_handler = lambda conn: _handle_org_tree(conn, sub)

    # ── talent-market/templates ──
    elif method == "GET" and _match_exact(sub, "/talent-market/templates"):
        route_handler = lambda conn: _handle_talent_templates(conn, sub)

    # ── talent-market/templates/{id} ──
    else:
        tmpl_id = _match_prefix(sub, "/talent-market/templates/")
        if method == "GET" and tmpl_id is not None and "/" not in tmpl_id:
            route_handler = lambda conn, template_id=tmpl_id: _handle_talent_template_detail(conn, sub, template_id)

    # ── recruitments ──
    if route_handler is None and method == "POST" and _match_exact(sub, "/recruitments"):
        route_handler = lambda conn: _handle_recruitments_post(conn, sub, body)

    # ── org/assignments/{id} patch ──
    if route_handler is None:
        org_assignment_id = _match_prefix(sub, "/org/assignments/")
        if method == "PATCH" and org_assignment_id is not None and "/" not in org_assignment_id:
            route_handler = lambda conn, matched_assignment_id=org_assignment_id: _handle_org_assignment_patch(conn, sub, matched_assignment_id, body)

    # ── solutions/{id}/apply ──
    if route_handler is None:
        solution_apply = _match_prefix(sub, "/solutions/")
        if method == "POST" and solution_apply is not None and solution_apply.endswith("/apply"):
            solution_id = solution_apply[:-len("/apply")]
            if "/" not in solution_id:
                route_handler = lambda conn, matched_solution_id=solution_id: _handle_solution_apply_post(conn, sub, matched_solution_id, body)

    # ── conversations/{id} ──
    if route_handler is None:
        conv_id = _match_prefix(sub, "/conversations/")
        if method == "GET" and conv_id is not None and "/" not in conv_id:
            route_handler = lambda conn, conversation_id=conv_id: _handle_conversation_detail(conn, sub, conversation_id)

    # ── group-conversations/{id} GET ──
    if route_handler is None:
        group_conv_id = _match_prefix(sub, "/group-conversations/")
        if method == "GET" and group_conv_id is not None and "/" not in group_conv_id:
            route_handler = lambda conn, conversation_id=group_conv_id: _handle_conversation_detail(conn, sub, conversation_id)

    # ── group-conversations/{id}/messages ──
    if route_handler is None:
        group_message = _match_prefix(sub, "/group-conversations/")
        if method == "POST" and group_message is not None and group_message.endswith("/messages"):
            conv_id = group_message[:-len("/messages")]
            if "/" not in conv_id:
                route_handler = lambda conn, conversation_id=conv_id: _handle_group_conversation_message_post(conn, sub, conversation_id, body)

    # ── runs POST ──
    if route_handler is None and method == "POST" and _match_exact(sub, "/runs"):
        route_handler = lambda conn: _handle_runs_post(conn, sub, body)

    # ── runs/{id}/stream ──
    if route_handler is None:
        run_stream = _match_prefix(sub, "/runs/")
        if method == "GET" and run_stream is not None and run_stream.endswith("/stream"):
            run_id = run_stream[:-len("/stream")]
            route_handler = lambda conn, matched_run_id=run_id: _handle_run_stream(conn, sub, matched_run_id, query)

    # ── runs/{id}/events ──
    if route_handler is None:
        run_events = _match_prefix(sub, "/runs/")
        if method == "GET" and run_events is not None and run_events.endswith("/events"):
            run_id = run_events[:-len("/events")]
            route_handler = lambda conn, matched_run_id=run_id: _handle_run_events(conn, sub, matched_run_id, query)

    # ── uploads ──
    if route_handler is None and method == "POST" and _match_exact(sub, "/uploads"):
        route_handler = lambda conn: _handle_uploads_post(conn, sub, body)

    # ── P08 knowledge-bases ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/knowledge-bases"):
        route_handler = lambda conn: _handle_knowledge_bases_list(conn, sub)

    # ── P08 knowledge-bases/{id}/documents ──
    if route_handler is None:
        kb_doc = _match_prefix(sub, "/knowledge-bases/")
        if method == "POST" and kb_doc is not None and kb_doc.endswith("/documents"):
            kb_id = kb_doc[:-len("/documents")]
            if "/" not in kb_id:
                route_handler = lambda conn, kb_id=kb_id: _handle_knowledge_document_post(conn, sub, kb_id, body)

    # ── billing usage overview / records ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/billing/usage/overview"):
        route_handler = lambda conn: _handle_billing_usage_overview(conn, query)

    if route_handler is None and method == "GET" and _match_exact(sub, "/billing/usage/records"):
        route_handler = lambda conn: _handle_billing_usage_records(conn, query)

    if route_handler is None and method == "GET" and _match_exact(sub, "/billing/usage/records/export"):
        route_handler = lambda conn: _handle_billing_usage_records(conn, f"{query}&format=csv" if query else "format=csv")

    # ── B06 solutions list ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/solutions"):
        route_handler = lambda conn: _handle_solutions_list(conn, sub)

    # ── B05 connectors list/create/test/grants ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/connectors"):
        route_handler = lambda conn: _handle_connectors_list(conn, sub, query)

    if route_handler is None and method == "POST" and _match_exact(sub, "/connectors"):
        route_handler = lambda conn: _handle_connectors_post(conn, sub, query, body)

    if route_handler is None:
        connector_detail = _match_prefix(sub, "/connectors/")
        if method == "GET" and connector_detail is not None and "/" not in connector_detail:
            route_handler = lambda conn, matched_connector_id=connector_detail: _handle_connector_detail(conn, sub, matched_connector_id, query)

    if route_handler is None:
        connector_patch = _match_prefix(sub, "/connectors/")
        if method == "PATCH" and connector_patch is not None and "/" not in connector_patch:
            route_handler = lambda conn, matched_connector_id=connector_patch: _handle_connector_patch(conn, sub, matched_connector_id, query, body)

    if route_handler is None:
        connector_test = _match_prefix(sub, "/connectors/")
        if method == "POST" and connector_test is not None and connector_test.endswith("/test"):
            connector_id = connector_test[:-len("/test")]
            if "/" not in connector_id:
                route_handler = lambda conn, matched_connector_id=connector_id: _handle_connector_test(conn, sub, matched_connector_id, query, body)

    if route_handler is None:
        connector_status = _match_prefix(sub, "/connectors/")
        if method == "GET" and connector_status is not None and connector_status.endswith("/status"):
            connector_id = connector_status[:-len("/status")]
            if "/" not in connector_id:
                route_handler = lambda conn, matched_connector_id=connector_id: _handle_connector_status(conn, sub, matched_connector_id, query)

    if route_handler is None:
        connector_grants = _match_prefix(sub, "/connectors/")
        if method == "PATCH" and connector_grants is not None and connector_grants.endswith("/grants"):
            connector_id = connector_grants[:-len("/grants")]
            if "/" not in connector_id:
                route_handler = lambda conn, matched_connector_id=connector_id: _handle_connector_grants_patch(conn, sub, matched_connector_id, query, body)

    if route_handler is None and method == "GET" and _match_exact(sub, "/employees/export"):
        route_handler = lambda conn: _handle_employees_export(conn, query)

    if route_handler is None and method == "GET" and _match_exact(sub, "/audit-events"):
        route_handler = lambda conn: _handle_audit_events(conn, query)

    # ── memories list/create/update ──
    # ── skills catalog ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/skills/catalog"):
        route_handler = lambda conn: _handle_skill_catalog(conn, sub, query)

    # ── skills installs list/create ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/skills/installs"):
        route_handler = lambda conn: _handle_skill_installs_list(conn, sub, query)

    if route_handler is None and method == "POST" and _match_exact(sub, "/skills/installs"):
        route_handler = lambda conn: _handle_skill_install_post(conn, sub, body)

    # ── skills/installs/{id} patch ──
    if route_handler is None:
        skill_install_patch = _match_prefix(sub, "/skills/installs/")
        if method == "PATCH" and skill_install_patch is not None and "/" not in skill_install_patch:
            route_handler = lambda conn, matched=skill_install_patch: _handle_skill_install_patch(conn, sub, matched, body)

    # ── skills/installs/{id} delete ──
    if route_handler is None:
        skill_install_delete = _match_prefix(sub, "/skills/installs/")
        if method == "DELETE" and skill_install_delete is not None and "/" not in skill_install_delete:
            route_handler = lambda conn, matched=skill_install_delete: _handle_skill_install_delete(conn, sub, matched)

    # ── memories list/create/update/delete ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/memories"):
        route_handler = lambda conn: _handle_memory_list(conn, sub, query)

    if route_handler is None and method == "POST" and _match_exact(sub, "/memories"):
        route_handler = lambda conn: _handle_memory_post(conn, sub, body)

    if route_handler is None:
        memory_id_patch = _match_prefix(sub, "/memories/")
        if method == "PATCH" and memory_id_patch is not None and "/" not in memory_id_patch:
            route_handler = lambda conn, matched_memory_id=memory_id_patch: _handle_memory_patch(conn, sub, matched_memory_id, body)
    if route_handler is None and method == "POST" and _match_exact(sub, "/memories/bulk-delete"):
        route_handler = lambda conn: _handle_memory_bulk_delete(conn, sub, body)

    if route_handler is None:
        memory_id_route = _match_prefix(sub, "/memories/")
        if method == "PATCH" and memory_id_route is not None and "/" not in memory_id_route:
            route_handler = lambda conn, matched_memory_id=memory_id_route: _handle_memory_patch(conn, sub, matched_memory_id, body)
        elif method == "DELETE" and memory_id_route is not None and "/" not in memory_id_route:
            route_handler = lambda conn, matched_memory_id=memory_id_route: _handle_memory_delete(conn, sub, matched_memory_id)


    # ── employees/{id} detail ──
    if route_handler is None:
        emp_id_detail = _match_prefix(sub, "/employees/")
        if method == "GET" and emp_id_detail is not None and "/" not in emp_id_detail:
            route_handler = lambda conn, employee_id=emp_id_detail: _handle_employee_detail(conn, sub, employee_id, query)

    # ── employees/{id} patch ──
    if route_handler is None:
        emp_id_patch = _match_prefix(sub, "/employees/")
        if method == "PATCH" and emp_id_patch is not None and "/" not in emp_id_patch:
            route_handler = lambda conn, employee_id=emp_id_patch: _handle_employee_patch(conn, sub, employee_id, query, body)

    # ── employees list ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/employees"):
        route_handler = lambda conn: _handle_employee_list(conn, sub, query)

    # ── settings ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/settings"):
        route_handler = lambda conn: handle_get_settings(conn, sub)

    if route_handler is None and method == "PATCH" and _match_exact(sub, "/settings"):
        route_handler = lambda conn: handle_patch_settings(conn, sub, body)

    if route_handler is None and method == "POST" and _match_exact(sub, "/settings/admin-invites"):
        route_handler = lambda conn: handle_post_admin_invite(conn, sub, body)

    # ── billing/balance + billing/recharges ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/billing/balance"):
        route_handler = lambda conn: handle_get_billing_balance(conn, sub)

    if route_handler is None and method == "GET" and _match_exact(sub, "/billing/recharges"):
        route_handler = lambda conn: handle_get_billing_recharges(conn, sub)

    if route_handler is None and method == "POST" and _match_exact(sub, "/billing/recharges"):
        route_handler = lambda conn: handle_post_billing_recharge(conn, sub, body)

    if route_handler is None:
        return 501, {"error": "not_implemented", "message": f"Team API: {method} {path}"}

    conn = None
    try:
        conn = _make_conn()
    except Exception:
        return _database_unavailable_response()

    try:
        return route_handler(conn)
    finally:
        try:
            conn.close()
        except Exception:
            pass
