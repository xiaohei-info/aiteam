"""Team Panel — /api/team/* router: first 12 northbound endpoints.

Connects to PostgreSQL on demand via team_panel.transactions.db.create_connection.
Uses the existing domain entities + repositories directly — no application layer yet.
"""
from __future__ import annotations

import ast
import csv
import json
import io
import logging
import os
import uuid

logger = logging.getLogger(__name__)
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import psycopg2

from ..transactions.db import create_connection
from ..domain.entities import (
    AgentTemplate,
    AuditEvent,
    CollaborationTemplate,
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
    KnowledgeBase,
    KnowledgeDocument,
    KnowledgeIngestionJob,
    MemoryItem,
    MemoryReviewDecision,
    RecruitmentOrder,
    RunEvent,
    SolutionApplyRecord,
    TeamRun,
    ConversationReadState,
    WorkbenchEmployeePreference,
)
from ..domain.enums import EmployeeStatus
from ..repositories.agent_template_repo import AgentTemplateRepo
from ..repositories.audit_event_repo import AuditEventRepo
from ..repositories.connector_definition_repo import ConnectorDefinitionRepo
from ..repositories.conversation_message_repo import ConversationMessageRepo
from ..repositories.conversation_repo import ConversationRepo
from ..repositories.employee_knowledge_binding_repo import EmployeeKnowledgeBindingRepo
from ..repositories.enterprise_llm_provider_repo import (
    EnterpriseLlmModelRepo,
    EnterpriseLlmProviderRepo,
)
from ..repositories.employee_org_assignment_repo import EmployeeOrgAssignmentRepo
from ..repositories.employee_repo import EmployeeRepo
from ..repositories.employee_prompt_repo import EmployeePromptRepo
from ..repositories.enterprise_repo import EnterpriseRepo
from ..repositories.connector_repo import EnterpriseConnectorRepo
from ..repositories.department_repo import DepartmentRepo
from ..repositories.industry_solution_repo import IndustrySolutionRepo
from ..repositories.collaboration_template_repo import CollaborationTemplateRepo
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
from ..repositories.runtime_binding_repo import RuntimeBindingRepo
from ..repositories.scheduled_job_repo import ScheduledJobRepo
from ..repositories.team_task_repo import TeamTaskRepo
from ..repositories.team_run_repo import TeamRunRepo
from ..repositories.workbench_state_repo import ConversationReadStateRepo, WorkbenchEmployeePreferenceRepo
from ..transactions.uow import UnitOfWork
from ..application.commands.conversation_service import (
    add_group_member,
    archive_group_conversation,
    create_group_conversation,
    remove_group_member,
    submit_group_message,
)
from ..application.commands.connector_grant_service import grant_connector, revoke_connector
from ..application.commands.scheduled_job_service import create_scheduled_job, pause_job, resume_job
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
    handle_delete_admin_invite,
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
from agent_gateway import profile_capability

_ALLOWED_PATCH_FIELDS = {"display_name", "status", "skills_add", "skills_remove",
                         "model_provider", "model_name", "prompt_version",
                         "config_version", "capabilities_json", "description",
                         "prompt_system", "prompt_behavior_rules_json", "prompt_opening_message",
                         "memory_mode", "memory_provider_code", "memory_retention_days",
                         "memory_writeback_enabled", "knowledge_base_ids", "connector_ids",
                         "scheduled_job", "scheduled_job_action"}
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

# ── SSE live-stream sentinel ──────────────────────────────────────────────
# When _handle_run_stream detects an active EventHydrator StreamChannel,
# it returns this sentinel string as the body.  The routes.py dispatch layer
# detects it and switches to a persistent SSE long-connection mode, writing
# real-time events directly to handler.wfile instead of sending a static body.
_SSE_LIVE_SENTINEL = "__SSE_LIVE__"


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
        grants.append({
            "skill_code": skill_code,
            "employee_id": employee_id,
            "enabled": True,
            "profile_name": getattr(employee_map.get(employee_id), "profile_name", "") or "",
        })
    grants.sort(key=lambda item: item["employee_id"])
    return grants


def _install_skill_to_profiles(skill_code: str, grants: list[dict]) -> None:
    """Install a market skill into each granted employee's Hermes profile.

    Best-effort write-through: iterates granted employees, installs the skill
    into each profile's own skills dir. Skips employees without a profile_name.
    All failures are logged, never raised — the Team Panel install record is
    already committed and authoritative.
    """
    seen_profiles: set[str] = set()
    for grant in grants or []:
        profile_name = str(grant.get("profile_name") or "").strip()
        if not profile_name or profile_name in seen_profiles:
            continue
        seen_profiles.add(profile_name)
        try:
            ok, detail = profile_capability.skills_install_to_profile(profile_name, skill_code)
        except Exception as exc:  # never let a runtime hiccup break the response
            logger.warning("skill %s install to profile %s errored: %s", skill_code, profile_name, exc)
            continue
        if not ok:
            logger.warning("skill %s install to profile %s failed: %s", skill_code, profile_name, detail)


def _fire_memory_sync(cur, employee_id: str) -> None:
    """Fire-and-forget: project memory items to Hermes profile MEMORY.md.

    Only the ``builtin`` memory mode uses Hermes' built-in MEMORY.md. For
    ``external`` (a separate provider owns recall) or ``disabled`` modes we
    project an empty set, which rewrites MEMORY.md to its managed-empty form —
    skipping projection AND clearing any residue a prior builtin run left.
    """
    import threading
    try:
        employee = EmployeeRepo(cur).get_by_id(employee_id)
        if not employee or not employee.profile_name:
            return
        profile_name = employee.profile_name
        binding = EmployeeMemoryBindingRepo(cur).get_by_employee(employee_id)
        mode = (binding.memory_mode if binding is not None else "builtin") or "builtin"
        if mode == "builtin":
            items = list(MemoryItemRepo(cur).list_by_enterprise(
                employee.enterprise_id, employee_id=employee_id, limit=500
            ))
        else:
            items = []
    except Exception:
        return
    threading.Thread(
        target=profile_capability.sync_employee_memory,
        args=(profile_name, items),
        daemon=True,
    ).start()


def _fire_skill_sync(cur, employee_id: str) -> None:
    """Fire-and-forget: down-provision enabled skill bindings into the employee's
    own Hermes profile (per design §6.7). Mirrors _fire_memory_sync."""
    import threading
    try:
        employee = EmployeeRepo(cur).get_by_id(employee_id)
        if not employee or not employee.profile_name:
            return
        profile_name = employee.profile_name
        bindings = EmployeeSkillBindingRepo(cur).list_by_employee(employee_id)
        catalog = {e["skill_code"]: e for e in _MARKET_CATALOG}
        skills = []
        for b in bindings:
            if not getattr(b, "enabled", True):
                continue
            meta = catalog.get(b.skill_code, {})
            skills.append({
                "skill_code": b.skill_code,
                "display_name": meta.get("display_name") or b.skill_code,
                "description": meta.get("description") or "",
                "enabled": True,
            })
    except Exception:
        return
    threading.Thread(
        target=profile_capability.sync_employee_skills,
        args=(profile_name, skills),
        daemon=True,
    ).start()


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

from . import skill_market_client

# Builtin skills always shown first (no network needed). External market entries
# (SkillHub/ClawHub) are layered on top of these via fetch_remote_catalog().
_MARKET_CATALOG: list[dict] = [
    {"skill_code": "web-search", "display_name": "Web Search", "description": "Search the web for information", "source_marketplace": "builtin", "version": "1.0.0", "latest_version": "1.0.0", "tags": ["search", "information"], "is_free": True},
    {"skill_code": "slides", "display_name": "Slides", "description": "Create presentation slides", "source_marketplace": "builtin", "version": "1.0.0", "latest_version": "1.0.0", "tags": ["presentation", "generation"], "is_free": True},
    {"skill_code": "reporting", "display_name": "Reporting", "description": "Generate structured reports", "source_marketplace": "builtin", "version": "1.0.0", "latest_version": "1.0.0", "tags": ["reporting", "analysis"], "is_free": True},
    {"skill_code": "forecasting", "display_name": "Forecasting", "description": "Time-series forecasting", "source_marketplace": "builtin", "version": "1.0.0", "latest_version": "1.0.0", "tags": ["forecasting", "prediction"], "is_free": True},
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


def _get_full_catalog(query: str = "") -> list[dict]:
    """Builtin + remote market (SkillHub/ClawHub) + locally-discovered skills.

    Remote fetch is cached (10min TTL) and degrades to [] on failure, so the
    catalog always at least returns the builtin entries. Dedupe by skill_code:
    builtin wins over remote, remote wins over local-discovered.
    """
    entries: list[dict] = list(_MARKET_CATALOG)
    seen = {e["skill_code"] for e in entries}
    try:
        remote = skill_market_client.fetch_remote_catalog(query)
    except Exception as exc:  # never let market issues break the page
        logger.warning("remote catalog fetch error: %s", exc)
        remote = []
    for entry in remote + _discover_hermes_skill_entries():
        if entry["skill_code"] not in seen:
            entries.append(entry)
            seen.add(entry["skill_code"])
    return entries


# ── B02 skill install handlers ───────────────────────────────────────────────

def _handle_skill_catalog(conn, path: str, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
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
        try:
            page = int(str(qs.get("page", ["1"])[0] or "1"))
        except (TypeError, ValueError):
            page = 1
        try:
            page_size = int(str(qs.get("page_size", ["20"])[0] or "20"))
        except (TypeError, ValueError):
            page_size = 20
        page = max(1, page)
        page_size = max(1, min(100, page_size))

        catalog = _get_full_catalog(search_query)
        # Stage 1: search + tag filter (source-agnostic) — this is the set the
        # source tabs/facets are computed over.
        base = []
        for entry in catalog:
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
            base.append(entry)

        # Source facets (for the marketplace tabs): distinct source_marketplace
        # with counts, preserving first-seen order.
        facet_counts: dict[str, int] = {}
        facet_order: list[str] = []
        for entry in base:
            src = str(entry["source_marketplace"])
            if src not in facet_counts:
                facet_counts[src] = 0
                facet_order.append(src)
            facet_counts[src] += 1
        sources = [{"source_marketplace": s, "count": facet_counts[s]} for s in facet_order]

        # Stage 2: source + installed filter → the visible set for the active tab.
        visible = []
        for entry in base:
            installed = installed_map.get(entry["skill_code"])
            if source_filter and str(entry["source_marketplace"]).lower() != source_filter:
                continue
            if installed_only and installed is None:
                continue
            visible.append((entry, installed))

        total = len(visible)
        start = (page - 1) * page_size
        page_slice = visible[start:start + page_size]
        items = []
        for entry, installed in page_slice:
            active_count = install_repo.count_active_by_skill_code(entry["skill_code"]) if installed and install_repo else 0
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
        return 200, {"items": items, "total": total, "page": page, "page_size": page_size, "sources": sources}
    finally:
        cur.close()


def _handle_skill_installs_list(conn, path: str, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {"items": [], "total": 0}
        install_repo = EnterpriseSkillInstallRepo(cur)
        installs = install_repo.list_by_enterprise(enterprise.id)
        skill_repo = EmployeeSkillBindingRepo(cur)
        audit_repo = AuditEventRepo(cur)
        items = []
        for inst in installs:
            grants = skill_repo.list_by_skill_code(enterprise.id, inst.skill_code)
            cat_entry = next((e for e in _get_full_catalog() if e["skill_code"] == inst.skill_code), None)
            latest_audits = audit_repo.list_by_target("enterprise_skill_install", inst.id, limit=1)
            latest_audit = latest_audits[0] if latest_audits else None
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
                "audit_status": latest_audit.event_type if latest_audit else "",
                "audit_recorded_at": latest_audit.created_at if latest_audit else None,
                "tags": cat_entry["tags"] if cat_entry else [],
                "grants": [
                    {"skill_code": g.skill_code, "employee_id": g.employee_id, "enabled": g.enabled}
                    for g in grants
                ],
            })
        return 200, {"items": items, "total": len(items)}
    finally:
        cur.close()


def _handle_skill_install_post(conn, path: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial
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
        # Land the skill into each granted employee's own Hermes profile
        # (<profile>/skills/<code>/). This is the real install target — skills
        # live in the profile, not behind an MCP shim. Failures are logged but
        # don't fail the request; the Team Panel record stays authoritative.
        _install_skill_to_profiles(skill_code, grants)
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


def _handle_skill_install_patch(conn, path: str, query: str, install_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial
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


def _handle_skill_install_delete(conn, path: str, query: str, install_id: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
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
        profile_capability.skills_uninstall(skill_code)
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
    event = AuditEvent(
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
    AuditEventRepo(cur).create(event)
    return event.id


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


def _resolve_workbench_user_id(enterprise: Enterprise | None, query: str, body: dict | None = None) -> str:
    actor_id = _request_actor_id(query, body)
    if actor_id and actor_id != "governance_api":
        return actor_id
    if enterprise is not None and enterprise.owner_user_id:
        return str(enterprise.owner_user_id)
    return "owner"


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
            view = get_workbench_view(
                uow,
                enterprise.id,
                role=_resolve_workbench_role(request_context),
                user_id=_resolve_workbench_user_id(enterprise, query),
            )
        except WorkbenchAccessError:
            return 403, _workbench_error("PERMISSION_DENIED", "当前账号没有查看工作台的权限")
        return 200, serialize_workbench_view(view, enterprise_name=enterprise.name)


def _handle_workbench_state_post(conn, path: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    employee_id = str(body.get("employee_id") or "").strip()
    conversation_id = str(body.get("conversation_id") or "").strip()
    is_starred = body.get("is_starred")
    mark_read = bool(body.get("mark_read"))
    if not employee_id and not conversation_id:
        return 400, {"error": "MISSING_TARGET", "message": "employee_id or conversation_id is required"}
    if employee_id and not isinstance(is_starred, bool) and not conversation_id:
        return 400, {"error": "INVALID_STARRED", "message": "is_starred must be a boolean when employee_id is provided"}

    with UnitOfWork(conn) as uow:
        enterprise = next(iter(uow.enterprises().list_all()), None)
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        user_id = _resolve_workbench_user_id(enterprise, query, body)
        response: dict[str, object] = {
            "enterprise_id": enterprise.id,
            "user_id": user_id,
        }

        if employee_id:
            employee = uow.employees().get_by_id(employee_id)
            if employee is None or employee.enterprise_id != enterprise.id:
                return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {employee_id} not found"}
            if not isinstance(is_starred, bool):
                return 400, {"error": "INVALID_STARRED", "message": "is_starred must be a boolean"}
            uow.workbench_employee_preferences().upsert_starred(
                WorkbenchEmployeePreference(
                    enterprise_id=enterprise.id,
                    user_id=user_id,
                    employee_id=employee_id,
                    is_starred=is_starred,
                    created_by=user_id,
                    updated_by=user_id,
                )
            )
            response["employee_id"] = employee_id
            response["is_starred"] = is_starred

        if conversation_id:
            conversation = uow.conversations().get_by_id(conversation_id)
            if conversation is None or conversation.enterprise_id != enterprise.id:
                return 404, {"error": "CONVERSATION_NOT_FOUND", "message": f"Conversation {conversation_id} not found"}
            if not mark_read:
                return 400, {"error": "INVALID_READ_STATE", "message": "mark_read must be true when conversation_id is provided"}
            uow.conversation_read_states().upsert_read_state(
                ConversationReadState(
                    enterprise_id=enterprise.id,
                    user_id=user_id,
                    conversation_id=conversation_id,
                    last_read_message_id=conversation.latest_message_id,
                    last_read_at=conversation.last_message_at or _today_iso(),
                    created_by=user_id,
                    updated_by=user_id,
                )
            )
            response["conversation_id"] = conversation_id
            response["mark_read"] = True
            response["unread_count"] = 0

        return 200, response


def _current_enterprise_id(conn) -> str | None:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        return enterprises[0].id if enterprises else None
    finally:
        cur.close()


def _handle_knowledge_bases_list(conn, _path: str) -> tuple[int, dict]:
    _advance_pending_knowledge_ingestion(conn)
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
                            "asset_id": d.asset_id,
                            "display_name": d.display_name,
                            "file_name": d.file_name,
                            "file_type": d.file_type,
                            "file_size": d.file_size,
                            "status": d.status,
                            "ingestion_job_id": d.ingestion_job_id,
                            "rag_document_id": d.rag_document_id,
                            "error_code": d.error_code,
                            "error_message": d.error_message,
                            "storage_key": d.storage_key,
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


def _handle_knowledge_base_post(conn, _path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    name = str(body.get("name") or "").strip()
    if not name:
        return 400, {"error": "MISSING_NAME", "message": "name is required"}
    enterprise_id = _current_enterprise_id(conn)
    if enterprise_id is None:
        return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}

    description = str(body.get("description") or "").strip()
    kb_id = f"kb_{uuid.uuid4().hex[:12]}"
    storage_prefix = f"aiteam/{enterprise_id}/knowledge/{kb_id}"

    cur = conn.cursor()
    try:
        kb = KnowledgeBase(
            id=kb_id,
            enterprise_id=enterprise_id,
            name=name,
            description=description,
            status="active",
            document_count=0,
            storage_prefix=storage_prefix,
            created_by=str(body.get("created_by") or ""),
            updated_by=str(body.get("created_by") or ""),
        )
        KnowledgeBaseRepo(cur).create(kb)
        conn.commit()
        return 201, {
            "knowledge_base_id": kb.id,
            "name": kb.name,
            "description": kb.description,
            "status": kb.status,
            "document_count": kb.document_count,
            "storage_prefix": kb.storage_prefix,
        }
    finally:
        cur.close()


def _read_asset_text(doc) -> str:
    """Resolve the uploaded asset file for a knowledge document and read it."""
    candidates = []
    if doc.asset_id:
        candidates.append(_asset_file_path(doc.asset_id, doc.file_name or ""))
        asset_dir = _UPLOADS_ROOT / doc.asset_id
        if asset_dir.is_dir():
            candidates.extend(sorted(asset_dir.iterdir()))
    if doc.storage_key:
        # storage_key convention: aiteam/uploads/{asset_id}/{name}
        rel = str(doc.storage_key).removeprefix("aiteam/uploads/")
        candidates.append(_UPLOADS_ROOT / rel)
    for p in candidates:
        if p and p.is_file():
            from team_panel.integration.document_parser import extract_text
            return extract_text(p)
    raise FileNotFoundError(
        f"asset file not found for document {doc.id} (asset_id={doc.asset_id})"
    )


def _resolve_enterprise_llm_provider(cur, enterprise_id: str) -> dict | None:
    """Build the default LLM provider dict for LightRAG from the config 中心 (D6).

    Returns ``{provider_key, base_url, api_key, default_model}`` for the
    enterprise's default/first enabled provider, or None (vector-only).
    """
    if not enterprise_id:
        return None
    providers = [p for p in EnterpriseLlmProviderRepo(cur).list_by_enterprise(enterprise_id)
                 if getattr(p, "enabled", True)]
    if not providers:
        return None
    provider = providers[0]
    models = [m for m in EnterpriseLlmModelRepo(cur).list_by_enterprise(enterprise_id)
              if getattr(m, "enabled", True) and m.provider_id == provider.id]
    default_model = next((m.model_id for m in models if m.is_default),
                         models[0].model_id if models else "")
    return {
        "provider_key": provider.provider_key,
        "base_url": provider.base_url,
        "api_key": provider.api_key,
        "default_model": default_model,
    }


def _advance_pending_knowledge_ingestion(conn, kb_id: str | None = None) -> int:
    """Run real LightRAG ingestion (chunk + embed) for pending jobs."""
    from team_panel.integration import lightrag_service

    cur = conn.cursor()
    advanced = 0
    try:
        doc_repo = KnowledgeDocumentRepo(cur)
        job_repo = KnowledgeIngestionJobRepo(cur)
        for job in job_repo.list_pending():
            if kb_id and job.knowledge_base_id != kb_id:
                continue
            doc = doc_repo.get_by_id(job.document_id)
            if doc is None or doc.status != "ingesting":
                continue
            rag_document_id = doc.rag_document_id or f"rag_{doc.id}"
            try:
                text = _read_asset_text(doc)
                llm_provider = _resolve_enterprise_llm_provider(cur, job.enterprise_id)
                chunk_count = lightrag_service.ingest_document(
                    job.knowledge_base_id, rag_document_id, text,
                    file_name=doc.file_name or doc.display_name or doc.id,
                    llm_provider=llm_provider,
                )
            except Exception as exc:  # noqa: BLE001 — ingest failure is a doc state
                logger.warning("[kb] ingestion failed for %s: %s", doc.id, exc)
                job_repo.update_state(job.id, status="failed")
                doc_repo.update_state(
                    doc.id,
                    status="error",
                    ingestion_job_id=job.id,
                    rag_document_id=rag_document_id,
                    error_code="INGESTION_FAILED",
                    error_message=str(exc)[:500],
                    chunk_count=0,
                )
                advanced += 1
                continue
            job_repo.update_state(
                job.id,
                status="completed",
                rag_document_id=rag_document_id,
                chunk_count=chunk_count,
            )
            doc_repo.update_state(
                doc.id,
                status="ready",
                ingestion_job_id=job.id,
                rag_document_id=rag_document_id,
                error_code=None,
                error_message=None,
                chunk_count=chunk_count,
            )
            advanced += 1
        if advanced:
            conn.commit()
    finally:
        cur.close()
    return advanced


def _handle_knowledge_search(conn, _path: str, kb_id: str, query: str) -> tuple[int, dict]:
    _advance_pending_knowledge_ingestion(conn, kb_id)
    params = _request_params(query)
    query_text = str(params.get("q") or "").strip()
    if not query_text:
        return 400, {"error": "MISSING_QUERY", "message": "q is required"}

    cur = conn.cursor()
    try:
        kb_repo = KnowledgeBaseRepo(cur)
        doc_repo = KnowledgeDocumentRepo(cur)
        kb = kb_repo.get_by_id(kb_id)
        if kb is None:
            return 404, {"error": "KNOWLEDGE_BASE_NOT_FOUND", "message": f"Knowledge base {kb_id} not found"}

        # Real semantic retrieval via LightRAG (vector index over chunks).
        from team_panel.integration import lightrag_service

        ready_docs = doc_repo.list_by_kb(kb_id, status="ready")
        docs_by_rag_id = {
            (doc.rag_document_id or f"rag_{doc.id}"): doc for doc in ready_docs
        }
        try:
            result = lightrag_service.query(kb_id, query_text, top_k=5)
        except Exception as exc:  # noqa: BLE001 — engine error surfaces as 502
            logger.warning("[kb] lightrag query failed for %s: %s", kb_id, exc)
            return 502, {
                "error": "RETRIEVAL_FAILED",
                "message": f"知识检索引擎异常: {str(exc)[:200]}",
            }

        items: list[dict] = []
        citations: list[dict] = []
        seen_docs: set[str] = set()
        for chunk in result.get("chunks", []):
            rag_doc_id = chunk.get("doc_id") or ""
            doc = docs_by_rag_id.get(rag_doc_id)
            title = (
                (doc.display_name or doc.file_name or doc.id)
                if doc else (chunk.get("file_name") or rag_doc_id or "未知文档")
            )
            document_id = doc.id if doc else rag_doc_id
            items.append(
                {
                    "document_id": document_id,
                    "title": title,
                    "snippet": chunk.get("content") or "",
                    "score": round(float(chunk.get("score") or 0.0), 4),
                }
            )
            if document_id not in seen_docs:
                seen_docs.add(document_id)
                citations.append(
                    {
                        "title": title,
                        "document_id": document_id,
                        "knowledge_base_id": kb.id,
                        "source_type": "knowledge_document",
                    }
                )

        answer = str(result.get("answer") or "").strip()
        if not answer:
            answer = (
                f"已检索到 {len(items)} 段相关内容，最相关:「{items[0]['snippet'][:120]}…」"
                if items else f"未找到与“{query_text}”相关的已就绪知识。"
            )
        return 200, {
            "knowledge_base_id": kb.id,
            "query": query_text,
            "answer": answer,
            "citations": citations,
            "items": items,
        }
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
            if body.get("retry") and existing.status == "error":
                job_id = f"ing_{uuid.uuid4().hex[:12]}"
                existing.status = "uploaded"
                existing.ingestion_job_id = None
                existing.error_code = None
                existing.error_message = None
                existing.start_ingesting(job_id)
                doc_repo.update_state(
                    existing.id,
                    status=existing.status,
                    ingestion_job_id=job_id,
                    error_code=None,
                    error_message=None,
                    chunk_count=0,
                )
                KnowledgeIngestionJobRepo(cur).create(
                    KnowledgeIngestionJob(
                        id=job_id,
                        knowledge_base_id=kb_id,
                        enterprise_id=enterprise_id,
                        document_id=existing.id,
                        status="parsing",
                        created_by=body.get("created_by", ""),
                    )
                )
                conn.commit()
                return 201, {
                    "document_id": existing.id,
                    "status": existing.status,
                    "ingestion_job_id": job_id,
                }
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


def _load_json_object(value) -> dict:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        try:
            parsed = ast.literal_eval(value)
        except (SyntaxError, ValueError):
            return {}
    return parsed if isinstance(parsed, dict) else {}


def _publish_scope_allows(scope_json: str | dict | None, enterprise_id: str | None) -> bool:
    """Whether a publish scope makes the item visible to *enterprise_id*.

    Fail-open: any malformed / unknown scope defaults to visible (mode=all),
    so existing published content stays visible after the scope field was added.
    """
    scope = scope_json
    if isinstance(scope, str):
        try:
            scope = json.loads(scope) if scope else {}
        except (TypeError, ValueError):
            return True
    if not isinstance(scope, dict):
        return True
    if scope.get("mode") != "selected":
        return True
    if not enterprise_id:
        return False
    enterprise_ids = scope.get("enterprise_ids")
    if not isinstance(enterprise_ids, (list, tuple)):
        return False
    return str(enterprise_id) in {str(eid) for eid in enterprise_ids}


def _template_default_bindings(template: AgentTemplate) -> dict:
    return _load_json_object(template.default_binding_json)


def _template_prompt_pack(template: AgentTemplate) -> dict:
    return _load_json_object(template.prompt_pack_json)


def _template_model_ref(template: AgentTemplate) -> dict:
    return _load_json_object(template.default_model_json)


def _template_knowledge_bindings(template: AgentTemplate) -> list[dict]:
    bindings = _template_default_bindings(template)
    items = bindings.get("knowledge_bindings")
    if isinstance(items, list):
        normalized = []
        for item in items:
            if isinstance(item, dict):
                normalized.append(
                    {
                        "knowledge_id": str(item.get("knowledge_id") or item.get("id") or ""),
                        "scope": str(item.get("scope") or item.get("scope_mode") or "enterprise"),
                    }
                )
            elif item:
                normalized.append({"knowledge_id": str(item), "scope": "enterprise"})
        return [item for item in normalized if item["knowledge_id"]]
    legacy = bindings.get("knowledge_bases")
    if isinstance(legacy, list):
        return [{"knowledge_id": str(item), "scope": "enterprise"} for item in legacy if item]
    return []


def _template_connector_requirements(template: AgentTemplate) -> list[dict]:
    bindings = _template_default_bindings(template)
    items = bindings.get("connector_requirements")
    if not isinstance(items, list):
        return []
    normalized = []
    for item in items:
        if isinstance(item, dict):
            normalized.append(
                {
                    "connector_type": str(item.get("connector_type") or item.get("type") or ""),
                    "required": bool(item.get("required", False)),
                }
            )
        elif item:
            normalized.append({"connector_type": str(item), "required": False})
    return [item for item in normalized if item["connector_type"]]


def _template_memory_config(template: AgentTemplate) -> dict:
    bindings = _template_default_bindings(template)
    memory = bindings.get("memory_config") or bindings.get("memory")
    if isinstance(memory, dict):
        return memory
    return {"type": "conversation scoped", "max_tokens": 8000}

def _template_tags(template: AgentTemplate) -> list[str]:
    prompt_pack = _template_prompt_pack(template)
    tags = prompt_pack.get("tags")
    if isinstance(tags, list):
        normalized = [str(tag).strip() for tag in tags if str(tag or "").strip()]
        if normalized:
            return normalized
    return [template.category_code] if template.category_code else []


def _handle_talent_templates(conn, path: str, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        repo = AgentTemplateRepo(cur)
        qs = parse_qs(query)
        category = str(qs.get("category", [""])[0] or "").strip() or None
        keyword = str(qs.get("q", [""])[0] or "").strip() or None
        tag = str(qs.get("tag", [""])[0] or "").strip() or None
        sort_by = str(qs.get("sort_by", ["popularity"])[0] or "popularity").strip().lower()
        sort_order = str(qs.get("sort_order", ["desc"])[0] or "desc").strip().lower()
        try:
            page = max(1, int(qs.get("page", [1])[0]))
        except (TypeError, ValueError):
            page = 1
        try:
            page_size = max(1, min(100, int(qs.get("page_size", [20])[0])))
        except (TypeError, ValueError):
            page_size = 20
        offset = (page - 1) * page_size
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        templates, total = repo.list_filtered(
            status="published",
            category_code=category,
            keyword=keyword,
            tag=tag,
            sort_by=sort_by,
            sort_order=sort_order,
            limit=page_size,
            offset=offset,
            visible_to_enterprise_id=enterprise.id if enterprise is not None else None,
        )
        employee_counts: dict[str, int] = {}
        recruit_counts: dict[str, int] = {}
        if enterprise is not None:
            for employee in EmployeeRepo(cur).list_by_enterprise(enterprise.id):
                if employee.template_id:
                    employee_counts[employee.template_id] = employee_counts.get(employee.template_id, 0) + 1
            for order in RecruitmentOrderRepo(cur).list_by_enterprise(enterprise.id):
                if order.template_id:
                    recruit_counts[order.template_id] = recruit_counts.get(order.template_id, 0) + 1
        items = [
            {
                "template_id": t.id,
                "name": t.name,
                "role": t.role_name,
                "category": t.category_code,
                "description": (_template_prompt_pack(t).get("description") or t.name),
                "default_model_ref": _template_model_ref(t),
                "skills": list(_template_default_bindings(t).get("skills") or []),
                "tags": _template_tags(t),
                "recruit_count": recruit_counts.get(t.id, 0),
                "is_recruited": employee_counts.get(t.id, 0) > 0,
            }
            for t in templates
        ]
        return 200, {
            "items": items,
            "page": page,
            "page_size": page_size,
            "total": total,
            "has_more": offset + page_size < total,
            "sort_by": sort_by if sort_by in {"created_at", "name", "popularity", "recruit_count"} else "popularity",
            "sort_order": "asc" if sort_order == "asc" else "desc",
        }
    finally:
        cur.close()


def _handle_talent_template_detail(conn, path: str, query: str, template_id: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        repo = AgentTemplateRepo(cur)
        t = repo.get_by_id(template_id)
        if t is None or t.status != "published" or t.deleted_at is not None:
            return 404, {"error": "TEMPLATE_NOT_FOUND", "message": f"Template {template_id} not found"}
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        total_recruits = 0
        active_instances = 0
        if enterprise is not None:
            total_recruits = sum(1 for order in RecruitmentOrderRepo(cur).list_by_enterprise(enterprise.id) if order.template_id == t.id)
            active_instances = sum(1 for employee in EmployeeRepo(cur).list_by_enterprise(enterprise.id) if employee.template_id == t.id and employee.status == "active")
        prompt_pack = _template_prompt_pack(t)
        return 200, {
            "template_id": t.id,
            "name": t.name,
            "category": t.category_code,
            "description": prompt_pack.get("description") or t.name,
            "preview_avatar_url": prompt_pack.get("preview_avatar_url"),
            "default_model_ref": _template_model_ref(t),
            "default_skills": list(_template_default_bindings(t).get("skills") or []),
            "default_memory_config": _template_memory_config(t),
            "knowledge_bindings": _template_knowledge_bindings(t),
            "connector_requirements": _template_connector_requirements(t),
            "tags": _template_tags(t),
            "price_tier": prompt_pack.get("price_tier") or "standard",
            "usage_stats": {"total_recruits": total_recruits, "active_instances": active_instances},
        }
    finally:
        cur.close()


def _resolve_employee_model(cur, enterprise_id: str, template,
                            body: dict | None) -> tuple[str, str]:
    """Resolve (model_provider, model_id) for a new employee.

    Priority: explicit body selection (validated against the enterprise's
    enabled models) -> template default_model -> empty (runtime falls back to
    the root config default). Returns ("","") when nothing is configured.
    """
    body = body or {}
    sel_provider = (body.get("model_provider") or "").strip()
    sel_model = (body.get("model_name") or body.get("model_id") or "").strip()
    if sel_provider and sel_model:
        return sel_provider, sel_model
    # A model_uid from the /llm-models picker resolves to provider_key + model_id.
    model_uid = (body.get("model_uid") or "").strip()
    if model_uid:
        from ..transactions.uow import UnitOfWork
        with UnitOfWork(cur.connection) as uow:
            m = uow.llm_models().get_by_id(model_uid)
            if m is not None and m.enterprise_id == enterprise_id and m.enabled:
                p = uow.llm_providers().get_by_id(m.provider_id)
                if p is not None and p.enabled:
                    return p.provider_key, m.model_id
    if template is not None:
        ref = _template_model_ref(template)
        prov = (ref.get("provider") or "").strip()
        mod = (ref.get("model") or ref.get("model_name") or ref.get("name") or "").strip()
        if prov or mod:
            return prov, mod
    return "", ""


def _seed_employee_capabilities(cur, enterprise_id: str, employee_id: str,
                                profile_name: str, template,
                                *, source_template_version=None,
                                system_prompt_override: str | None = None) -> str:
    """Seed prompt/skill/KB/memory bindings from a template and provision the
    employee's Hermes profile (SOUL + config). Returns the seeded system_prompt.

    Idempotent-ish: callers create the Employee first, then call this to fill in
    the capability layer the design requires at creation time. Profile writes are
    best-effort — failures are logged but never abort recruitment (the run path
    re-provisions on demand).

    system_prompt_override: when the admin provides a system prompt at creation
    time (the 新建员工 dialog), it wins over the template default persona.
    """
    system_prompt = ""
    behavior_rules: dict = {}
    opening = None
    if template is not None:
        pack = _template_prompt_pack(template)
        system_prompt = pack.get("system_prompt", "") or ""
        behavior_rules = pack.get("behavior_rules", {}) or {}
        opening = pack.get("opening_message")
    if system_prompt_override is not None and str(system_prompt_override).strip():
        system_prompt = str(system_prompt_override).strip()

    # EmployeePrompt — SOUL source.
    EmployeePromptRepo(cur).upsert(EmployeePrompt(
        employee_id=employee_id,
        system_prompt=system_prompt,
        behavior_rules_json=json.dumps(behavior_rules, ensure_ascii=False),
        opening_message=opening,
        version_no=1,
        source_template_version=source_template_version,
    ))

    if template is not None:
        skill_repo = EmployeeSkillBindingRepo(cur)
        for skill_code in (_template_default_bindings(template).get("skills") or []):
            if not skill_code:
                continue
            skill_repo.create(EmployeeSkillBinding(
                id=f"sb_{uuid.uuid4().hex[:12]}",
                enterprise_id=enterprise_id,
                employee_id=employee_id,
                skill_code=str(skill_code),
                enabled=True,
                source_type="template_default",
            ))

        kb_repo = EmployeeKnowledgeBindingRepo(cur)
        for kb in _template_knowledge_bindings(template):
            kb_repo.create(EmployeeKnowledgeBinding(
                id=f"kb_{uuid.uuid4().hex[:12]}",
                enterprise_id=enterprise_id,
                employee_id=employee_id,
                knowledge_base_id=kb["knowledge_id"],
                scope_mode="read",
                enabled=True,
            ))

        mem = _template_memory_config(template)
        EmployeeMemoryBindingRepo(cur).upsert(EmployeeMemoryBinding(
            id=f"mb_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            memory_mode=str(mem.get("mode") or "builtin"),
            provider_code=mem.get("provider_code"),
            retention_days=mem.get("retention_days"),
            writeback_enabled=bool(mem.get("writeback_enabled", True)),
        ))

    return system_prompt


def _provision_employee_profile(profile_name: str, system_prompt: str,
                                model_provider: str, model_name: str) -> None:
    """Create the employee's Hermes profile, write SOUL, and pin the chosen
    model into the profile config.yaml. Best-effort; never raises."""
    try:
        from agent_gateway.runtime_executor import _provision_profile, _profile_home
        from agent_gateway.profile_provisioner import set_profile_model
    except Exception:  # noqa: BLE001
        return
    try:
        _provision_profile(profile_name, system_prompt or "")
    except Exception:  # noqa: BLE001
        return
    if model_provider and model_name:
        try:
            set_profile_model(_profile_home(profile_name), model_provider, model_name)
        except Exception:  # noqa: BLE001
            pass


def _reconcile_employee_profile(cur, employee, *, system_prompt: str | None = None) -> None:
    """Push an employee's current DB config down into its Hermes profile:
    persona (SOUL), model (config.yaml), skills, and memory.

    Single shared assembly entry used by BOTH employee creation and update, so
    the two paths cannot drift. Previously model + prompt only reached the
    profile at creation and were never re-applied on update — editing an
    employee's model/persona changed the DB but not the runtime profile.

    Reads bindings via the passed cursor synchronously (skill/memory sync then
    hand off to filesystem threads), so callers must invoke this while their
    cursor/UoW is still open. Best-effort: never raises.
    """
    if employee is None or not getattr(employee, "profile_name", ""):
        return
    # Persona/prompt: prefer the freshly-built prompt from the create path;
    # otherwise reload the persisted EmployeePrompt (the update path).
    if system_prompt is None:
        try:
            prompt = EmployeePromptRepo(cur).get_by_employee(employee.id)
            system_prompt = (prompt.system_prompt if prompt is not None else "") or ""
        except Exception:  # noqa: BLE001
            system_prompt = ""
    _provision_employee_profile(
        employee.profile_name, system_prompt,
        employee.model_provider or "", employee.model_name or "",
    )
    _fire_skill_sync(cur, employee.id)
    _fire_memory_sync(cur, employee.id)


def _create_employee_with_profile(conn, cur, ent, *, display_name: str,
                                  template_id: str, body: dict,
                                  created_from: str, employee_id: str | None = None,
                                  status=EmployeeStatus.ACTIVE) -> dict:
    """Create an employee, seed its capability layer, open its private conversation,
    and provision the Hermes profile. Commits on success and returns the new ids.

    Shared by the recruitment path and direct employee creation so the two can
    never drift (one place owns profile-name slugging, capability seeding and
    profile provisioning).
    """
    employee_id = employee_id or f"emp_{uuid.uuid4().hex[:12]}"
    # profile_name must be a valid runtime profile id (ASCII slug); see
    # _slug_fragment for why a raw CJK display_name cannot be used verbatim.
    _ent_frag = _slug_fragment(ent.slug or ent.id, "enterprise")
    _name_frag = _slug_fragment(display_name, employee_id.replace("_", "-"))
    profile_name = f"{_ent_frag}-{_name_frag}"[:60]
    template = AgentTemplateRepo(cur).get_by_id(template_id) if template_id else None
    model_provider, model_name = _resolve_employee_model(cur, ent.id, template, body)
    role_name = str(body.get("role_name") or (template.role_name if template is not None else "") or "")
    emp = Employee(
        id=employee_id,
        enterprise_id=ent.id,
        template_id=template_id or None,
        profile_name=profile_name,
        display_name=display_name,
        role_name=role_name,
        status=status,
        created_from=created_from,
        model_provider=model_provider,
        model_name=model_name,
    )
    EmployeeRepo(cur).create(emp)
    # Seed prompt/skill/KB/memory at creation time so the employee is functional
    # without a later PATCH.
    system_prompt = _seed_employee_capabilities(
        cur, ent.id, employee_id, profile_name, template,
        source_template_version=(template.version_no if template is not None else None),
        system_prompt_override=body.get("system_prompt"),
    )
    conversation_id = f"conv_{uuid.uuid4().hex[:12]}"
    conv = Conversation(
        id=conversation_id,
        enterprise_id=ent.id,
        type="private",
        status="active",
        title=display_name,
        entry_employee_id=employee_id,
        created_by="system",
    )
    ConversationRepo(cur).create(conv)
    conn.commit()
    # Filesystem side-effects after the DB commit: push the full persona + model
    # + skills + memory into the new Hermes profile via the shared reconcile
    # entry (the same one the update path uses, so the two can't drift).
    _reconcile_employee_profile(cur, emp, system_prompt=system_prompt)
    return {
        "employee_id": employee_id,
        "profile_name": profile_name,
        "conversation_id": conversation_id,
        "model_provider": model_provider,
        "model_name": model_name,
        "role_name": role_name,
    }


def _handle_employees_post(conn, path: str, query: str, body: dict | None) -> tuple[int, dict]:
    """Directly create a digital employee (admin '新建员工'), parallel to recruiting
    from a template. Reuses the same creation+provisioning path as recruitment."""
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial
    display_name = str(body.get("display_name") or "").strip()
    if not display_name:
        return 400, {"error": "MISSING_DISPLAY_NAME", "message": "display_name is required"}
    template_id = body.get("template_id", "")
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        if not enterprises:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        ent = enterprises[0]
        created = _create_employee_with_profile(
            conn, cur, ent,
            display_name=display_name,
            template_id=template_id,
            body=body,
            created_from="manual",
        )
        return 201, {
            "employee_id": created["employee_id"],
            "profile_name": created["profile_name"],
            "conversation_id": created["conversation_id"],
            "display_name": display_name,
            "role_name": created["role_name"],
            "status": "active",
            "navigation": {
                "employee_admin": f"/app/admin/employees/{created['employee_id']}",
                "chat": f"/app/chat/{created['conversation_id']}",
            },
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_employee_delete(conn, path: str, employee_id: str, query: str) -> tuple[int, dict]:
    """Soft-delete an employee (sets deleted_at). The employee then disappears
    from list/detail (both filter deleted_at IS NULL)."""
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        repo = EmployeeRepo(cur)
        emp = repo.get_by_id(employee_id)
        if emp is None:
            return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {employee_id} not found"}
        repo.delete(employee_id)
        conn.commit()
        return 200, {"employee_id": employee_id, "status": "deleted"}
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_recruitments_post(conn, path: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial
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
        repo = RecruitmentOrderRepo(cur)
        existing_order = repo.get_by_idempotency_key(ent.id, idempotency_key)
        if existing_order is not None and existing_order.created_employee_id:
            existing_employee = EmployeeRepo(cur).get_by_id(existing_order.created_employee_id)
            conversations = ConversationRepo(cur).list_by_enterprise(ent.id)
            existing_conversation = next(
                (
                    conv for conv in conversations
                    if conv.type == "private"
                    and conv.entry_employee_id == existing_order.created_employee_id
                    and not conv.deleted_at
                ),
                None,
            )
            conversation_id = existing_conversation.id if existing_conversation is not None else ""
            return 200, {
                "order_id": existing_order.id,
                "status": existing_order.status,
                "employee_id": existing_order.created_employee_id,
                "profile_name": existing_employee.profile_name if existing_employee is not None else "",
                "conversation_id": conversation_id,
                "navigation": {
                    "workbench": "/app/workbench",
                    "employee_admin": f"/app/admin/employees/{existing_order.created_employee_id}",
                    "chat": f"/app/chat/{conversation_id}" if conversation_id else "",
                },
            }
        employee_id = f"emp_{uuid.uuid4().hex[:12]}"
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
        RecruitmentOrderRepo(cur).create(order)
        created = _create_employee_with_profile(
            conn, cur, ent,
            display_name=display_name,
            template_id=template_id,
            body=body,
            created_from="talent_market",
            employee_id=employee_id,
        )
        return 201, {
            "order_id": order.id,
            "status": "succeeded",
            "employee_id": created["employee_id"],
            "profile_name": created["profile_name"],
            "conversation_id": created["conversation_id"],
            "navigation": {
                "workbench": "/app/workbench",
                "employee_admin": f"/app/admin/employees/{created['employee_id']}",
                "chat": f"/app/chat/{created['conversation_id']}",
            },
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _slug_fragment(value: str, fallback: str) -> str:
    # ASCII-only: profile names must satisfy the runtime's profile-id regex
    # ^[a-z0-9][a-z0-9_-]{0,63}$. Note str.isalnum() is True for CJK and other
    # Unicode letters, so a naive isalnum() check would keep "产品顾问" verbatim
    # and the WebUI chat chain would reject the profile with "invalid profile".
    slug = "".join(
        ch.lower() if (ch.isascii() and ch.isalnum()) else "-"
        for ch in (value or "")
    ).strip("-")
    # Collapse runs of "-" left by stripped non-ASCII spans for readability.
    while "--" in slug:
        slug = slug.replace("--", "-")
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
    if not isinstance(bindings, dict):
        return []

    knowledge_ids: list[str] = []
    seen: set[str] = set()

    binding_items = bindings.get("knowledge_bindings")
    if isinstance(binding_items, list):
        for item in binding_items:
            if not isinstance(item, dict):
                continue
            knowledge_id = str(item.get("knowledge_id") or "").strip()
            if not knowledge_id or knowledge_id in seen:
                continue
            seen.add(knowledge_id)
            knowledge_ids.append(knowledge_id)

    legacy_items = bindings.get("knowledge_bases")
    if isinstance(legacy_items, list):
        for item in legacy_items:
            knowledge_id = str(item or "").strip()
            if not knowledge_id or knowledge_id in seen:
                continue
            seen.add(knowledge_id)
            knowledge_ids.append(knowledge_id)

    return knowledge_ids


def _resolve_solution_templates(cur, solution_id: str) -> tuple[list[AgentTemplate] | None, tuple[int, dict] | None]:
    """Return all enabled, published template bindings for a solution.
    Returns (templates_list, None) on success, or (None, error_response) on failure."""
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

    templates = []
    for binding in bindings:
        template = AgentTemplateRepo(cur).get_by_id(binding.template_id)
        if template is None or template.status != "published" or template.deleted_at is not None:
            continue  # skip unavailable bindings rather than failing entirely
        templates.append(template)
    if not templates:
        return None, (
            409,
            {
                "error": "BOUND_TEMPLATE_UNAVAILABLE",
                "message": f"No usable published templates bound to solution {solution_id}",
            },
        )
    return templates, None


def _resolve_solution_template(cur, solution_id: str) -> tuple[AgentTemplate | None, tuple[int, dict] | None]:
    """Legacy wrapper: returns the first enabled template only.
    Kept for backward compatibility; new code should use _resolve_solution_templates."""
    templates, error = _resolve_solution_templates(cur, solution_id)
    if error is not None:
        return None, error
    if templates is None or not templates:
        return None, (409, {"error": "BOUND_TEMPLATE_UNAVAILABLE", "message": f"No usable template for solution {solution_id}"})
    return templates[0], None


def _seed_collaboration_from_solution(cur, enterprise_id: str, solution, mode: str) -> None:
    """Push a solution's bundled orchestration prompts down into the enterprise's
    default ``collaboration_template`` so the runtime (``resolve_templates``) uses
    them — the solution "自带协作模板", the enterprise just consumes it.

    Semantics: replace/reapply overwrite the enterprise template; append only
    seeds when the enterprise has none yet. A solution with no orchestration
    prompts leaves the enterprise template untouched. Best-effort within the
    apply transaction; never raises.
    """
    if solution is None:
        return
    planner = (getattr(solution, "planner_prompt", "") or "").strip()
    subtask = (getattr(solution, "subtask_prompt", "") or "").strip()
    aggregate = (getattr(solution, "aggregate_prompt", "") or "").strip()
    if not (planner or subtask or aggregate):
        return
    repo = CollaborationTemplateRepo(cur)
    existing = repo.get_default(enterprise_id)
    if existing is not None and mode == "append":
        return
    if existing is not None:
        existing.name = existing.name or "行业方案编排"
        existing.planner_prompt = planner
        existing.subtask_prompt = subtask
        existing.aggregate_prompt = aggregate
        repo.update(existing)
    else:
        repo.create(CollaborationTemplate(
            id=f"collab_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            name="行业方案编排",
            planner_prompt=planner,
            subtask_prompt=subtask,
            aggregate_prompt=aggregate,
            is_default=True,
            enabled=True,
            created_by="solution_apply",
        ))


def _handle_solution_apply_preview(conn, path: str, solution_id: str, body: dict | None) -> tuple[int, dict]:
    """Preview endpoint: return each agent in the solution with conflict markers.
    A conflict means the enterprise already has an active employee from the same template."""
    cur = conn.cursor()
    try:
        enterprise_repo = EnterpriseRepo(cur)
        enterprises = enterprise_repo.list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}

        templates, error_response = _resolve_solution_templates(cur, solution_id)
        if error_response is not None:
            return error_response
        if templates is None:
            return 409, {"error": "BOUND_TEMPLATE_UNAVAILABLE", "message": f"No usable templates for solution {solution_id}"}

        employee_repo = EmployeeRepo(cur)
        agents = []
        for template in templates:
            existing_employees = employee_repo.list_active_by_template(enterprise.id, template.id)
            conflict = len(existing_employees) > 0
            existing_employee_id = existing_employees[0].id if conflict else None
            agents.append({
                "template_id": template.id,
                "role_name": template.role_name or template.name,
                "display_name": template.role_name or template.name,
                "conflict": conflict,
                "existing_employee_id": existing_employee_id,
            })
        return 200, {"solution_id": solution_id, "agents": agents}
    finally:
        cur.close()


def _handle_solution_apply_post(conn, path: str, solution_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}

    idempotency_key = str(body.get("idempotency_key") or "").strip()
    if not idempotency_key:
        return 400, {"error": "MISSING_IDEMPOTENCY_KEY", "message": "idempotency_key is required"}

    mode = str(body.get("mode") or "append")
    if mode not in ("append", "replace", "reapply"):
        return 400, {"error": "UNSUPPORTED_MODE", "message": f"Mode '{mode}' is not supported; use append, replace, or reapply"}

    agent_decisions = body.get("agent_decisions") or []
    agent_conflict_policy = str(body.get("agent_conflict_policy") or "overwrite")

    cur = conn.cursor()
    try:
        enterprise_repo = EnterpriseRepo(cur)
        enterprises = enterprise_repo.list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}

        user_id = _resolve_workbench_user_id(enterprise, path, body)

        templates, error_response = _resolve_solution_templates(cur, solution_id)
        if error_response is not None:
            return error_response
        if templates is None:
            return 409, {"error": "BOUND_TEMPLATE_UNAVAILABLE", "message": f"No usable templates for solution {solution_id}"}

        record_repo = SolutionApplyRecordRepo(cur)
        existing_record = record_repo.get_by_idempotency_key(enterprise.id, solution_id, idempotency_key)
        if existing_record is not None:
            return 200, {
                "apply_record_id": existing_record.id,
                "mode": existing_record.mode,
                "status": existing_record.status,
                "created_employee_ids": _load_json_list(existing_record.created_employee_ids_json),
                "created_knowledge_base_ids": _load_json_list(existing_record.created_knowledge_base_ids_json),
                "conversation_id": existing_record.conversation_id,
            }

        previous_records = [
            record
            for record in record_repo.list_by_solution(solution_id)
            if record.enterprise_id == enterprise.id and record.status == "succeeded"
        ]
        previous_employee_ids: list[str] = []
        seen_employee_ids: set[str] = set()
        for record in previous_records:
            for previous_employee_id in _load_json_list(record.created_employee_ids_json):
                if previous_employee_id in seen_employee_ids:
                    continue
                seen_employee_ids.add(previous_employee_id)
                previous_employee_ids.append(previous_employee_id)

        replaced_employee_ids: list[str] = []
        employee_repo = EmployeeRepo(cur)
        kb_repo = EmployeeKnowledgeBindingRepo(cur)

        if mode == "replace":
            for previous_employee_id in previous_employee_ids:
                previous_employee = employee_repo.get_by_id(previous_employee_id)
                if previous_employee is None or previous_employee.enterprise_id != enterprise.id:
                    continue
                if previous_employee.status != EmployeeStatus.ARCHIVED:
                    previous_employee.archive("solution replaced")
                    previous_employee.updated_by = user_id
                    employee_repo.update_status(previous_employee)
                for binding in kb_repo.list_by_employee(previous_employee_id):
                    kb_repo.delete(binding.id)
                replaced_employee_ids.append(previous_employee_id)

        all_employee_ids: list[str] = []
        employee_details: list[dict] = []
        knowledge_base_ids_all: list[str] = []

        for template in templates:
            conflict_employees = employee_repo.list_active_by_template(enterprise.id, template.id)
            has_conflict = len(conflict_employees) > 0

            decision_action = agent_conflict_policy
            for decision in agent_decisions:
                if decision.get("template_id") == template.id:
                    decision_action = str(decision.get("action") or agent_conflict_policy)
                    break

            knowledge_base_ids = _extract_template_knowledge_bases(template)
            knowledge_base_repo = KnowledgeBaseRepo(cur)
            for kb_id in knowledge_base_ids:
                if knowledge_base_repo.get_by_id(kb_id) is None:
                    knowledge_base_repo.create(KnowledgeBase(
                        id=kb_id,
                        enterprise_id=enterprise.id,
                        name=f"{template.role_name or template.name or '方案'}知识库",
                        description=f"由行业方案 {solution_id} 一键应用自动创建",
                        status="active",
                        storage_prefix=f"aiteam/{enterprise.id}/knowledge/{kb_id}",
                        created_by=user_id,
                        updated_by=user_id,
                    ))
            knowledge_base_ids_all.extend(knowledge_base_ids)

            if has_conflict and decision_action == "overwrite":
                existing_employee = conflict_employees[0]
                employee_id = existing_employee.id

                sol_model_provider, sol_model_name = _resolve_employee_model(
                    cur, enterprise.id, template, body)
                existing_employee.model_provider = sol_model_provider
                existing_employee.model_name = sol_model_name
                existing_employee.display_name = template.role_name or template.name or existing_employee.display_name
                existing_employee.description = template.role_name or template.name
                existing_employee.updated_by = user_id
                employee_repo.update_status(existing_employee)

                sol_pack = _template_prompt_pack(template)
                sol_system_prompt = sol_pack.get("system_prompt", "") or ""
                EmployeePromptRepo(cur).upsert(EmployeePrompt(
                    employee_id=employee_id,
                    system_prompt=sol_system_prompt,
                    behavior_rules_json=json.dumps(sol_pack.get("behavior_rules", {}) or {}, ensure_ascii=False),
                    opening_message=sol_pack.get("opening_message"),
                    version_no=1,
                    source_template_version=template.version_no,
                ))

                skill_repo = EmployeeSkillBindingRepo(cur)
                for old_binding in skill_repo.list_by_employee(employee_id):
                    if old_binding.source_type == "template_default":
                        skill_repo.delete(old_binding.id)
                for _sc in (_template_default_bindings(template).get("skills") or []):
                    if _sc:
                        skill_repo.create(EmployeeSkillBinding(
                            id=f"sb_{uuid.uuid4().hex[:12]}",
                            enterprise_id=enterprise.id,
                            employee_id=employee_id,
                            skill_code=str(_sc),
                            enabled=True,
                            source_type="template_default",
                        ))

                for old_kb in kb_repo.list_by_employee(employee_id):
                    kb_repo.delete(old_kb.id)
                for kb_id in knowledge_base_ids:
                    kb_repo.create(EmployeeKnowledgeBinding(
                        id=f"kb_{uuid.uuid4().hex[:12]}",
                        enterprise_id=enterprise.id,
                        employee_id=employee_id,
                        knowledge_base_id=kb_id,
                        scope_mode="read",
                        enabled=True,
                        binding_version=1,
                        created_by=user_id,
                        updated_by=user_id,
                    ))

                _sol_mem = _template_memory_config(template)
                EmployeeMemoryBindingRepo(cur).upsert(EmployeeMemoryBinding(
                    id=f"mb_{uuid.uuid4().hex[:12]}",
                    enterprise_id=enterprise.id,
                    employee_id=employee_id,
                    memory_mode=str(_sol_mem.get("mode") or "builtin"),
                    provider_code=_sol_mem.get("provider_code"),
                    retention_days=_sol_mem.get("retention_days"),
                    writeback_enabled=bool(_sol_mem.get("writeback_enabled", True)),
                ))

                profile_name = existing_employee.profile_name or existing_employee.id
                _provision_employee_profile(profile_name, sol_system_prompt,
                                            sol_model_provider, sol_model_name)
                _fire_skill_sync(cur, employee_id)

                all_employee_ids.append(employee_id)
                employee_details.append({
                    "employee_id": employee_id,
                    "template_id": template.id,
                    "action": "overwrite",
                    "display_name": existing_employee.display_name,
                    "role_name": existing_employee.role_name,
                })

            elif has_conflict and decision_action == "new":
                display_name = template.role_name or template.name or "Solution Employee"
                profile_name = _next_solution_profile_name(cur, enterprise.id, enterprise.slug, solution_id, display_name)
                employee_id = f"emp_{uuid.uuid4().hex[:12]}"
                sol_model_provider, sol_model_name = _resolve_employee_model(
                    cur, enterprise.id, template, body)

                employee_repo.create(Employee(
                    id=employee_id,
                    enterprise_id=enterprise.id,
                    template_id=template.id,
                    profile_name=profile_name,
                    display_name=display_name,
                    role_name=template.role_name,
                    status=EmployeeStatus.ACTIVE,
                    created_from="solution_apply",
                    description=template.role_name or template.name,
                    created_by=user_id,
                    updated_by=user_id,
                    model_provider=sol_model_provider,
                    model_name=sol_model_name,
                ))

                sol_pack = _template_prompt_pack(template)
                sol_system_prompt = sol_pack.get("system_prompt", "") or ""
                EmployeePromptRepo(cur).upsert(EmployeePrompt(
                    employee_id=employee_id,
                    system_prompt=sol_system_prompt,
                    behavior_rules_json=json.dumps(sol_pack.get("behavior_rules", {}) or {}, ensure_ascii=False),
                    opening_message=sol_pack.get("opening_message"),
                    version_no=1,
                    source_template_version=template.version_no,
                ))
                for _sc in (_template_default_bindings(template).get("skills") or []):
                    if _sc:
                        EmployeeSkillBindingRepo(cur).create(EmployeeSkillBinding(
                            id=f"sb_{uuid.uuid4().hex[:12]}",
                            enterprise_id=enterprise.id,
                            employee_id=employee_id,
                            skill_code=str(_sc),
                            enabled=True,
                            source_type="template_default",
                        ))
                _sol_mem = _template_memory_config(template)
                EmployeeMemoryBindingRepo(cur).upsert(EmployeeMemoryBinding(
                    id=f"mb_{uuid.uuid4().hex[:12]}",
                    enterprise_id=enterprise.id,
                    employee_id=employee_id,
                    memory_mode=str(_sol_mem.get("mode") or "builtin"),
                    provider_code=_sol_mem.get("provider_code"),
                    retention_days=_sol_mem.get("retention_days"),
                    writeback_enabled=bool(_sol_mem.get("writeback_enabled", True)),
                ))
                for kb_id in knowledge_base_ids:
                    kb_repo.create(EmployeeKnowledgeBinding(
                        id=f"kb_{uuid.uuid4().hex[:12]}",
                        enterprise_id=enterprise.id,
                        employee_id=employee_id,
                        knowledge_base_id=kb_id,
                        scope_mode="read",
                        enabled=True,
                        binding_version=1,
                        created_by=user_id,
                        updated_by=user_id,
                    ))

                _provision_employee_profile(profile_name, sol_system_prompt,
                                            sol_model_provider, sol_model_name)
                _fire_skill_sync(cur, employee_id)

                all_employee_ids.append(employee_id)
                employee_details.append({
                    "employee_id": employee_id,
                    "template_id": template.id,
                    "action": "new",
                    "display_name": display_name,
                    "role_name": template.role_name or "",
                })

            else:
                display_name = template.role_name or template.name or "Solution Employee"
                profile_name = _next_solution_profile_name(cur, enterprise.id, enterprise.slug, solution_id, display_name)
                employee_id = f"emp_{uuid.uuid4().hex[:12]}"
                sol_model_provider, sol_model_name = _resolve_employee_model(
                    cur, enterprise.id, template, body)

                employee_repo.create(Employee(
                    id=employee_id,
                    enterprise_id=enterprise.id,
                    template_id=template.id,
                    profile_name=profile_name,
                    display_name=display_name,
                    role_name=template.role_name,
                    status=EmployeeStatus.ACTIVE,
                    created_from="solution_apply",
                    description=template.role_name or template.name,
                    created_by=user_id,
                    updated_by=user_id,
                    model_provider=sol_model_provider,
                    model_name=sol_model_name,
                ))

                sol_pack = _template_prompt_pack(template)
                sol_system_prompt = sol_pack.get("system_prompt", "") or ""
                EmployeePromptRepo(cur).upsert(EmployeePrompt(
                    employee_id=employee_id,
                    system_prompt=sol_system_prompt,
                    behavior_rules_json=json.dumps(sol_pack.get("behavior_rules", {}) or {}, ensure_ascii=False),
                    opening_message=sol_pack.get("opening_message"),
                    version_no=1,
                    source_template_version=template.version_no,
                ))
                for _sc in (_template_default_bindings(template).get("skills") or []):
                    if _sc:
                        EmployeeSkillBindingRepo(cur).create(EmployeeSkillBinding(
                            id=f"sb_{uuid.uuid4().hex[:12]}",
                            enterprise_id=enterprise.id,
                            employee_id=employee_id,
                            skill_code=str(_sc),
                            enabled=True,
                            source_type="template_default",
                        ))
                _sol_mem = _template_memory_config(template)
                EmployeeMemoryBindingRepo(cur).upsert(EmployeeMemoryBinding(
                    id=f"mb_{uuid.uuid4().hex[:12]}",
                    enterprise_id=enterprise.id,
                    employee_id=employee_id,
                    memory_mode=str(_sol_mem.get("mode") or "builtin"),
                    provider_code=_sol_mem.get("provider_code"),
                    retention_days=_sol_mem.get("retention_days"),
                    writeback_enabled=bool(_sol_mem.get("writeback_enabled", True)),
                ))
                for kb_id in knowledge_base_ids:
                    kb_repo.create(EmployeeKnowledgeBinding(
                        id=f"kb_{uuid.uuid4().hex[:12]}",
                        enterprise_id=enterprise.id,
                        employee_id=employee_id,
                        knowledge_base_id=kb_id,
                        scope_mode="read",
                        enabled=True,
                        binding_version=1,
                        created_by=user_id,
                        updated_by=user_id,
                    ))

                _provision_employee_profile(profile_name, sol_system_prompt,
                                            sol_model_provider, sol_model_name)
                _fire_skill_sync(cur, employee_id)

                all_employee_ids.append(employee_id)
                employee_details.append({
                    "employee_id": employee_id,
                    "template_id": template.id,
                    "action": "create",
                    "display_name": display_name,
                    "role_name": template.role_name or "",
                })

        # ── 创建 apply_record ──
        apply_record_id = f"sol_apply_{uuid.uuid4().hex[:8]}"
        apply_key = f"solution_apply:{solution_id}:{idempotency_key}"
        record_repo.create(
            SolutionApplyRecord(
                id=apply_record_id,
                enterprise_id=enterprise.id,
                solution_id=solution_id,
                idempotency_key=idempotency_key,
                mode=mode,
                status="succeeded",
                requested_by=user_id,
                department_id=str(body.get("department_id") or "") or None,
                conversation_id=None,
                created_employee_ids_json=json.dumps(all_employee_ids, ensure_ascii=False),
                created_knowledge_base_ids_json=json.dumps(knowledge_base_ids_all, ensure_ascii=False),
                created_by=user_id,
                updated_by=user_id,
            )
        )

        AuditEventRepo(cur).create(
            AuditEvent(
                id=f"audit_{uuid.uuid4().hex[:12]}",
                enterprise_id=enterprise.id,
                actor_type="user",
                actor_id=user_id,
                event_type="solution.apply",
                target_type="solution",
                target_id=solution_id,
                request_id=apply_key,
                payload_json=json.dumps(
                    {
                        "mode": mode,
                        "department_id": body.get("department_id"),
                        "employee_details": employee_details,
                        "replaced_employee_ids": replaced_employee_ids,
                        "reapplied_from_employee_ids": previous_employee_ids if mode == "reapply" else [],
                        "created_employee_ids": all_employee_ids,
                        "created_knowledge_base_ids": knowledge_base_ids_all,
                        "apply_record_id": apply_record_id,
                        "agent_conflict_policy": agent_conflict_policy,
                    },
                    ensure_ascii=False,
                ),
                created_by=user_id,
            )
        )

        _seed_collaboration_from_solution(
            cur, enterprise.id, IndustrySolutionRepo(cur).get_by_id(solution_id), mode)

        # ── 自动建群 / 复用+刷新 ──
        conversation_id = None
        latest_record = record_repo.get_latest_successful(enterprise.id, solution_id)
        # Skip the just-created record (same idempotency_key) — look at earlier ones
        if latest_record is not None and latest_record.id != apply_record_id and latest_record.conversation_id:
            candidate_conv_id = latest_record.conversation_id
            conv_repo = ConversationRepo(cur)
            conv = conv_repo.get_by_id(candidate_conv_id)
            if conv is not None and conv.status == "active" and conv.type == "group":
                conversation_id = candidate_conv_id
                for emp_id in all_employee_ids:
                    cur.execute(
                        "SELECT member_id FROM conversation_member "
                        "WHERE conversation_id = %s AND member_type = 'employee' AND member_ref_id = %s AND status = 'active'",
                        (conversation_id, emp_id),
                    )
                    if cur.fetchone() is None:
                        cur.execute(
                            "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id, role, status) "
                            "VALUES (%s, %s, 'employee', %s, 'participant', 'active')",
                            (f"mem_{uuid.uuid4().hex[:12]}", conversation_id, emp_id),
                        )
                cur.execute(
                    "SELECT member_id FROM conversation_member "
                    "WHERE conversation_id = %s AND member_type = 'user' AND member_ref_id = %s AND status = 'active'",
                    (conversation_id, user_id),
                )
                if cur.fetchone() is None:
                    cur.execute(
                        "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id, role, status) "
                        "VALUES (%s, %s, 'user', %s, 'owner', 'active')",
                        (f"mem_{uuid.uuid4().hex[:12]}", conversation_id, user_id),
                    )
                solution = IndustrySolutionRepo(cur).get_by_id(solution_id)
                cur.execute(
                    "UPDATE conversation SET title = %s, updated_at = now(), updated_by = %s WHERE id = %s",
                    (solution.name if solution else "", user_id, conversation_id),
                )

        if conversation_id is None:
            solution = IndustrySolutionRepo(cur).get_by_id(solution_id)
            group_title = solution.name if solution else f"方案协作 {solution_id}"
            conversation_id = _create_solution_group_conversation(
                cur, enterprise.id, group_title, all_employee_ids, user_id)

        record_repo.update_conversation_id(apply_record_id, conversation_id)

        conn.commit()

        return 201, {
            "apply_record_id": apply_record_id,
            "mode": mode,
            "status": "succeeded",
            "replaced_employee_ids": replaced_employee_ids,
            "reapplied_from_employee_ids": previous_employee_ids if mode == "reapply" else [],
            "created_employee_ids": all_employee_ids,
            "created_knowledge_base_ids": knowledge_base_ids_all,
            "conversation_id": conversation_id,
            "employee_details": employee_details,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _create_solution_group_conversation(cur, enterprise_id: str, title: str,
                                        member_employee_ids: list[str],
                                        user_id: str) -> str:
    """Create a group conversation for a solution apply, with employees as participants
    and the applying user as owner. Returns the conversation_id."""
    conv_id = f"conv_{uuid.uuid4().hex[:12]}"
    cur.execute(
        "INSERT INTO conversation (id, enterprise_id, type, status, title, created_by, updated_by) "
        "VALUES (%s, %s, 'group', 'active', %s, %s, %s)",
        (conv_id, enterprise_id, title, user_id, user_id),
    )
    for emp_id in member_employee_ids:
        cur.execute(
            "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id, role, status) "
            "VALUES (%s, %s, 'employee', %s, 'participant', 'active')",
            (f"mem_{uuid.uuid4().hex[:12]}", conv_id, emp_id),
        )
    cur.execute(
        "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id, role, status) "
        "VALUES (%s, %s, 'user', %s, 'owner', 'active')",
        (f"mem_{uuid.uuid4().hex[:12]}", conv_id, user_id),
    )
    return conv_id


def _serialize_private_history(
    cur,
    conversation_id: str,
    *,
    cursor: int,
    limit: int,
) -> tuple[list[dict], int, int, bool]:
    message_repo = ConversationMessageRepo(cur)
    run_repo = TeamRunRepo(cur)
    event_repo = RunEventRepo(cur)

    persisted_messages = message_repo.list_by_conversation(conversation_id)
    persisted_by_run: dict[str, list] = {}
    for msg in persisted_messages:
        if msg.run_id:
            persisted_by_run.setdefault(msg.run_id, []).append(msg)

    envelopes: list[dict] = []
    runs = sorted(run_repo.list_by_conversation(conversation_id), key=lambda item: item.created_at or "")
    for run in runs:
        input_payload = _load_payload(run.input_message_json)
        run_messages = persisted_by_run.get(run.id, [])
        user_message = next((msg for msg in run_messages if msg.sender_type == "user"), None)
        user_payload = _load_payload(user_message.message_json) if user_message is not None else input_payload
        user_text = (
            (user_message.message_text if user_message is not None else "")
            or str(input_payload.get("message_text") or "")
        ).strip()
        if user_text or user_payload.get("attachments") or _message_quote_id(user_payload):
            envelopes.append(
                {
                    "message_id": user_message.id if user_message is not None else f"msg_{run.id}_user",
                    "cursor": 0,
                    "__sort_cursor": 0,
                    "run_id": run.id,
                    "role": "user",
                    "sender_type": "user",
                    "sender_id": user_message.sender_id if user_message is not None else "",
                    "status": "submitted",
                    "created_at": (user_message.created_at if user_message is not None else run.created_at) or _today_iso(),
                    "text": user_text,
                    "quote": None,
                    "attachments": _normalize_attachment_refs(user_payload.get("attachments")),
                    "citations": [],
                    "metadata": {
                        key: user_payload[key]
                        for key in ("quote_message_id", "reference_message_id", "reply_to_message_id")
                        if user_payload.get(key)
                    },
                }
            )

        terminal_event = event_repo.get_latest_for_run(run.id)
        assistant_payload = _load_payload(run.result_summary_json)
        terminal_event_type = None
        if terminal_event is not None and terminal_event.event_type in {"run_succeeded", "run_failed", "run_cancelled"}:
            assistant_payload = _load_payload(terminal_event.payload_json) or assistant_payload
            assistant_preview = terminal_event.preview_text or _run_summary_text(run, assistant_payload)
            assistant_created_at = terminal_event.event_ts or run.finished_at or run.updated_at or run.created_at or _today_iso()
            terminal_event_type = terminal_event.event_type
        else:
            assistant_preview = _run_summary_text(run, assistant_payload)
            assistant_created_at = run.finished_at or run.updated_at or run.created_at or _today_iso()

        if assistant_preview:
            has_knowledge_citations = bool(
                assistant_payload.get("citations") or assistant_payload.get("references")
            )
            envelopes.append(
                {
                    "message_id": f"msg_{run.id}_assistant",
                    "cursor": 0,
                    "__sort_cursor": 1_000_000,
                    "run_id": run.id,
                    "role": "assistant" if run.status == "succeeded" or has_knowledge_citations else "system",
                    "sender_type": "employee" if run.status == "succeeded" or has_knowledge_citations else "system",
                    "sender_id": run.entry_employee_id or "",
                    "status": run.status,
                    "created_at": assistant_created_at,
                    "text": assistant_preview,
                    "quote": None,
                    "attachments": _normalize_attachment_refs(
                        assistant_payload.get("attachments") or assistant_payload.get("asset_refs")
                    ),
                    "citations": _normalize_citations(
                        assistant_payload.get("citations") or assistant_payload.get("references")
                    ),
                    "metadata": {
                        key: assistant_payload[key]
                        for key in ("summary", "error_summary", "cancel_summary", "usage")
                        if assistant_payload.get(key) is not None
                    },
                    "event_type": terminal_event_type,
                }
            )

        # Inject process timeline events so the frontend can render execution
        # details in conversation history without duplicating final text deltas.
        run_events = event_repo.list_by_run(run.id, after_cursor=0, limit=200)
        for ev in run_events:
            payload = _load_payload(ev.payload_json)
            timeline_kind = None
            if ev.event_type == "message_delta" and payload.get("kind") == "reasoning":
                timeline_kind = "reasoning"
            elif ev.event_type == "tool_call":
                timeline_kind = "tool_complete" if payload.get("done") is True else "tool_call"
            if timeline_kind:
                envelopes.append(
                    {
                        "message_id": f"msg_{run.id}_evt_{ev.cursor_no}",
                        "cursor": 0,
                        "__sort_cursor": ev.cursor_no,
                        "run_id": run.id,
                        "role": "system",
                        "sender_type": "system",
                        "sender_id": "",
                        "status": "completed",
                        "created_at": ev.event_ts or assistant_created_at,
                        "text": "",
                        "quote": None,
                        "attachments": [],
                        "citations": [],
                        "metadata": {},
                        "event_type": ev.event_type,
                        "__timeline_item": {
                            "kind": timeline_kind,
                            "payload": payload,
                        },
                    }
                )

    synthetic_by_id = {item["message_id"]: item for item in envelopes}
    for item in envelopes:
        quote_id = _message_quote_id(item.get("metadata") or {})
        if quote_id:
            item["quote"] = _resolve_quote_preview(quote_id, synthetic_by_id, message_repo)

    envelopes.sort(key=lambda item: (item.get("created_at") or "", item.get("__sort_cursor") or 0, item.get("message_id") or ""))
    for index, item in enumerate(envelopes, start=1):
        item["cursor"] = index
        item.pop("__sort_cursor", None)

    page = [item for item in envelopes if item["cursor"] > cursor][:limit]
    next_cursor = page[-1]["cursor"] if page else cursor
    has_more = any(item["cursor"] > next_cursor for item in envelopes)
    return page, len(envelopes), next_cursor, has_more


def _run_summary_text(run: TeamRun, payload: dict) -> str:
    for key in ("summary", "error_summary", "cancel_summary"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    if run.error_message:
        return run.error_message
    return ""


def _message_quote_id(payload: dict) -> str | None:
    for key in ("quote_message_id", "reference_message_id", "reply_to_message_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _resolve_quote_preview(message_id: str, synthetic_by_id: dict[str, dict], message_repo: ConversationMessageRepo) -> dict:
    synthetic = synthetic_by_id.get(message_id)
    if synthetic is not None:
        return {
            "message_id": message_id,
            "preview": synthetic.get("text") or "",
        }
    persisted = message_repo.get_by_id(message_id)
    if persisted is not None:
        return {
            "message_id": message_id,
            "preview": persisted.message_text or "",
        }
    return {
        "message_id": message_id,
        "preview": "",
    }


def _normalize_attachment_refs(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _normalize_citations(value) -> list[dict]:
    if not isinstance(value, list):
        return []
    citations: list[dict] = []
    for item in value:
        if isinstance(item, dict):
            citations.append(item)
        elif item not in (None, ""):
            citations.append({"title": str(item)})
    return citations


def _build_employee_summary(conn, employee_id: str | None) -> dict | None:
    if not employee_id:
        return None
    conn.rollback()
    with UnitOfWork(conn) as uow:
        view = get_employee_admin_view(uow, employee_id)
    if view is None:
        return None

    cur = conn.cursor()
    try:
        employee = EmployeeRepo(cur).get_by_id(employee_id)
        enterprise_runs = TeamRunRepo(cur).list_by_enterprise(employee.enterprise_id) if employee is not None else []
        memory_items = (
            MemoryItemRepo(cur).list_by_enterprise(
                employee.enterprise_id,
                employee_id=employee_id,
                limit=3,
                offset=0,
                sort_by="importance",
                sort_order="desc",
            )
            if employee is not None
            else []
        )
    finally:
        cur.close()

    employee_runs = [run for run in enterprise_runs if run.entry_employee_id == employee_id]
    last_run_at = max(
        (
            run.finished_at or run.started_at or run.updated_at or run.created_at
            for run in employee_runs
            if run.finished_at or run.started_at or run.updated_at or run.created_at
        ),
        default=None,
    )
    status_counts: dict[str, int] = {}
    for run in employee_runs:
        status_counts[run.status] = status_counts.get(run.status, 0) + 1

    return {
        "employee_id": view.employee_id,
        "display_name": view.display_name,
        "role_name": view.role_name,
        "status": view.status,
        "model_provider": view.model_provider,
        "model_name": view.model_name,
        "skills": [skill["skill_code"] for skill in view.skills if skill.get("enabled", True)],
        "knowledge_bases": [item["knowledge_base_id"] for item in view.knowledge_bases if item.get("enabled", True)],
        "memories": [
            {"memory_id": item.id, "text": item.content, "category": item.category}
            for item in memory_items
        ],
        "usage_summary": {
            "total_runs": len(employee_runs),
            "last_run_at": last_run_at,
            "status_counts": status_counts,
        },
    }


def _handle_conversation_detail(conn, path: str, conv_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        qs = parse_qs(urlparse(path).query)
        cursor_val = max(0, int(qs.get("cursor", ["0"])[0]))
        limit_val = max(1, min(100, int(qs.get("limit", ["20"])[0])))
        repo = ConversationRepo(cur)
        conv = repo.get_by_id(conv_id)
        if conv is None:
            return 404, {"error": "CONVERSATION_NOT_FOUND", "message": f"Conversation {conv_id} not found"}
        employee = EmployeeRepo(cur).get_by_id(conv.entry_employee_id) if conv.entry_employee_id else None
        latest_run = TeamRunRepo(cur).get_by_id(conv.latest_run_id) if conv.latest_run_id else None
        latest_event = RunEventRepo(cur).get_latest_for_run(conv.latest_run_id) if conv.latest_run_id else None
        run_status = latest_run.status if latest_run is not None else None
        has_recent_delta = latest_event is not None and latest_event.event_type == "message_delta"
        messages, message_count, next_cursor, has_more = _serialize_private_history(
            cur,
            conv.id,
            cursor=cursor_val,
            limit=limit_val,
        )
        employee_summary = _build_employee_summary(conn, conv.entry_employee_id)
        return 200, {
            "conversation_id": conv.id,
            "conversation_type": conv.type,
            "employee_ref": {
                "employee_id": conv.entry_employee_id,
                "display_name": employee.display_name if employee is not None else "",
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
            "messages": {
                "items": messages,
                "next_cursor": next_cursor,
                "has_more": has_more,
            },
            "employee_summary": employee_summary,
        }
    finally:
        cur.close()


def _load_group_members(cur, conversation_id: str) -> list[dict]:
    cur.execute(
        "SELECT cm.member_id, cm.member_type, cm.member_ref_id, cm.role, cm.status, "
        "e.id, e.display_name, e.role_name, e.profile_name, e.status "
        "FROM conversation_member cm "
        "LEFT JOIN employee e ON e.id = cm.member_ref_id "
        "WHERE cm.conversation_id = %s AND cm.status <> 'removed' "
        "ORDER BY cm.created_at ASC",
        (conversation_id,),
    )
    rows = cur.fetchall()
    return [
        {
            "member_id": row[0],
            "member_type": row[1],
            "member_ref_id": row[2],
            "role": row[3] or "",
            "status": row[4] or "",
            "employee_id": row[5] or row[2],
            "display_name": row[6] or "",
            "role_name": row[7] or "",
            "profile_name": row[8] or "",
            "employee_status": row[9] or row[4] or "",
        }
        for row in rows
    ]


def _load_group_route_decision(run: TeamRun | None) -> dict | None:
    if run is None or not run.result_summary_json:
        return None
    payload = _load_payload(run.result_summary_json)
    if not isinstance(payload, dict):
        return None
    route_mode = str(payload.get("route_mode") or "").strip()
    if not route_mode:
        return None
    return {
        "route_mode": route_mode,
        "target_employee_ids": list(payload.get("target_employee_ids") or []),
        "candidate_employee_ids": list(payload.get("candidate_employee_ids") or []),
        "planner_employee_id": payload.get("planner_employee_id") or "",
        "entry_employee_id": payload.get("entry_employee_id") or "",
    }


def _serialize_group_task_tree(cur, run_id: str | None, route_mode: str) -> dict:
    if not run_id:
        return {"items": []}
    tasks = TeamTaskRepo(cur).list_by_run(run_id)
    items = []
    for task in tasks:
        items.append(
            {
                "task_id": task.id,
                "parent_task_id": task.parent_team_task_id,
                "title": task.title or "",
                "description": task.description or "",
                "status": task.status,
                "sequence_no": task.sequence_no,
                "depth": task.depth,
                "assignee_employee_id": task.assignee_employee_id,
                "runtime_task_id": task.runtime_task_id,
                "input_payload": _load_payload(task.input_payload_json),
                "output_summary": _load_payload(task.output_summary_json),
                "route_mode": route_mode,
            }
        )
    return {"items": items}


def _handle_group_conversation_detail(conn, path: str, conv_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        conv = ConversationRepo(cur).get_by_id(conv_id)
        if conv is None:
            return 404, {"error": "CONVERSATION_NOT_FOUND", "message": f"Conversation {conv_id} not found"}
        if conv.type != "group":
            return 400, {"error": "INVALID_CONVERSATION_TYPE", "message": f"Conversation {conv_id} is not a group conversation"}

        members = _load_group_members(cur, conv.id)
        latest_run = TeamRunRepo(cur).list_by_conversation(conv.id)
        run = latest_run[0] if latest_run else None
        latest_event = RunEventRepo(cur).get_latest_for_run(run.id) if run is not None else None
        latest_cursor = RunEventRepo(cur).get_max_cursor(run.id) if run is not None else 0
        binding = RuntimeBindingRepo(cur).get_by_owner("team_run", run.id) if run is not None else None
        latest_route_decision = _load_group_route_decision(run)
        route_mode = (latest_route_decision or {}).get("route_mode") or "auto"
        task_tree = _serialize_group_task_tree(cur, run.id if run is not None else None, route_mode)
        display_state = compute_display_state(
            conv.status,
            run.status if run is not None else None,
            has_recent_delta=latest_event is not None and latest_event.event_type == "message_delta",
        )
        latest_run_payload = None
        latest_run_summary = None
        if run is not None:
            latest_run_summary = _load_payload(run.result_summary_json)
            latest_run_payload = {
                "run_id": run.id,
                "status": run.status,
                "execution_mode": run.execution_mode,
                "trigger_type": run.trigger_type,
                "latest_event_cursor": latest_cursor,
                "runtime_handle": {
                    "kind": binding.runtime_kind if binding else None,
                    "session_id": binding.runtime_session_id if binding else None,
                    "task_id": binding.runtime_task_id if binding else None,
                },
            }
        return 200, {
            "conversation_id": conv.id,
            "conversation_type": conv.type,
            "title": conv.title or "",
            "status": conv.status,
            "display_state": display_state,
            "default_route_hint": "auto",
            "member_count": len(members),
            "members": members,
            "latest_run": latest_run_payload,
            "timeline": {
                "run_id": run.id if run is not None else None,
                "latest_event_cursor": latest_cursor,
                "events_url": f"/api/team/runs/{run.id}/events?cursor=0" if run is not None else "",
                "refresh_hint_ms": 3000,
            },
            "latest_run_summary": {
                "summary": latest_run_summary.get("summary", ""),
                "citations": _normalize_citations(
                    latest_run_summary.get("citations") or latest_run_summary.get("references")
                ),
            } if latest_run_summary else None,
            "latest_route_decision": latest_route_decision,
            "task_tree": task_tree,
            "last_message_preview": {
                "event_cursor": latest_event.cursor_no if latest_event is not None else 0,
                "event_ts": latest_event.event_ts if latest_event is not None else "",
                "preview": conv.last_message_preview or "",
            } if conv.last_message_preview or latest_event is not None else None,
            "created_at": conv.created_at or _today_iso(),
        }
    finally:
        cur.close()


def _handle_group_conversation_create(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    title = str(body.get("title") or "").strip()
    member_employee_ids = [str(item).strip() for item in (body.get("member_employee_ids") or []) if str(item).strip()]
    if not title:
        return 400, {"error": "MISSING_TITLE", "message": "title is required"}
    if not member_employee_ids:
        return 400, {"error": "MISSING_MEMBERS", "message": "member_employee_ids is required"}
    with UnitOfWork(conn) as uow:
        enterprises = EnterpriseRepo(uow.cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        conv_id = create_group_conversation(
            uow,
            enterprise.id,
            title,
            member_employee_ids,
            created_by=str(body.get("created_by") or "team_panel"),
        )
        return 201, {
            "conversation_id": conv_id,
            "title": title,
            "member_count": len(member_employee_ids),
            "status": "active",
            "navigation": {"conversation": f"/app/group/{conv_id}"},
        }


def _handle_group_member_add(conn, path: str, conv_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    employee_id = str(body.get("employee_id") or "").strip()
    if not employee_id:
        return 400, {"error": "MISSING_EMPLOYEE_ID", "message": "employee_id is required"}
    try:
        with UnitOfWork(conn) as uow:
            result = add_group_member(uow, conv_id, employee_id)
            return 200, result
    except ValueError as exc:
        message = str(exc)
        if "not a group conversation" in message:
            return 400, {"error": "INVALID_CONVERSATION_TYPE", "message": message}
        if "not found" in message:
            return 404, {"error": "GROUP_MEMBER_TARGET_NOT_FOUND", "message": message}
        return 409, {"error": "GROUP_MEMBER_ADD_FAILED", "message": message}


def _handle_group_member_remove(conn, path: str, conv_id: str, member_id: str) -> tuple[int, dict]:
    try:
        with UnitOfWork(conn) as uow:
            result = remove_group_member(uow, conv_id, member_id)
            return 200, result
    except ValueError as exc:
        message = str(exc)
        if "not a group conversation" in message:
            return 400, {"error": "INVALID_CONVERSATION_TYPE", "message": message}
        if "not found" in message:
            return 404, {"error": "GROUP_MEMBER_NOT_FOUND", "message": message}
        return 409, {"error": "GROUP_MEMBER_REMOVE_FAILED", "message": message}


def _handle_group_conversation_archive(conn, path: str, conv_id: str) -> tuple[int, dict]:
    try:
        with UnitOfWork(conn) as uow:
            result = archive_group_conversation(uow, conv_id)
            return 200, result
    except ValueError as exc:
        message = str(exc)
        if "not a group conversation" in message:
            return 400, {"error": "INVALID_CONVERSATION_TYPE", "message": message}
        if "not found" in message:
            return 404, {"error": "CONVERSATION_NOT_FOUND", "message": message}
        return 409, {"error": "GROUP_CONVERSATION_ARCHIVE_FAILED", "message": message}


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
        # 群聊 single_agent 与 orchestration 均进入真实执行; execute_run_async
        # 内部按 execution_mode 分流: kanban_orchestration → orchestration_executor
        # (多员工拆解/并行/汇总), 其余 → 单 agent 路径。
        from agent_gateway.runtime_executor import execute_run_async
        if result.get("run_id"):
            execute_run_async(result["run_id"])
        return 201, result
    except ValueError as exc:
        message = str(exc)
        if "not found" in message:
            return 404, {"error": "CONVERSATION_NOT_FOUND", "message": message}
        if "not a group conversation" in message:
            return 400, {"error": "INVALID_CONVERSATION_TYPE", "message": message}
        if "Cannot submit" in message:
            return 409, {"error": "CONVERSATION_NOT_ACTIVE", "message": message}
        return 400, {"error": "INVALID_REQUEST", "message": message}


def _handle_runs_post(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}

    employee_id = str(body.get("employee_id") or "").strip()
    conversation_id = str(body.get("conversation_id") or "").strip()
    message = body.get("message") or {}
    message_text = str(message.get("text") or body.get("message_text") or "").strip()
    idempotency_key = body.get("idempotency_key", str(uuid.uuid4()))
    message_payload = {
        "attachments": message.get("attachments") or body.get("attachments") or [],
        "quote_message_id": message.get("quote_message_id") or body.get("quote_message_id"),
        "reference_message_id": message.get("reference_message_id") or body.get("reference_message_id"),
        "reply_to_message_id": message.get("reply_to_message_id") or body.get("reply_to_message_id"),
    }

    cur = conn.cursor()
    try:
        ent_id = ""
        employee = None
        if employee_id:
            employee = EmployeeRepo(cur).get_by_id(employee_id)
            if employee is None:
                return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {employee_id} not found"}
            ent_id = employee.enterprise_id
        create_private_for_employee = False
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
            else:
                # First message to an employee that has no private conversation yet:
                # lazy-create one so chatting from a draft (/app/chat/emp_xxx) just works.
                create_private_for_employee = True
        if not ent_id:
            enterprise_repo = EnterpriseRepo(cur)
            enterprises = enterprise_repo.list_all()
            ent_id = enterprises[0].id if enterprises else ""
        if not ent_id:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        if not conversation_id and not create_private_for_employee:
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
            if create_private_for_employee:
                from team_panel.application.commands.conversation_service import (
                    create_private_conversation,
                )
                conversation_id = create_private_conversation(
                    uow, ent_id, employee_id, created_by="system"
                )
            result = create_run(
                uow,
                conversation_id,
                employee_id or None,
                message_text,
                idempotency_key,
                message_payload=message_payload,
            )
        # 结果回流主链: 提交后触发真实 Hermes 执行 (executor 对非 queued run 幂等跳过)
        from agent_gateway.runtime_executor import execute_run_async
        execute_run_async(result["run_id"])
        return 201, result
    except ValueError as exc:
        message = str(exc)
        if "Conversation" in message and "not found" in message:
            return 404, {"error": "CONVERSATION_NOT_FOUND", "message": message}
        if "message.text is required" in message:
            return 400, {"error": "MISSING_MESSAGE_TEXT", "message": message}
        return 400, {"error": "INVALID_REQUEST", "message": message}


def _handle_run_stream(conn, path: str, run_id: str, query: str) -> tuple[int, str, str]:
    """Northbound SSE endpoint for run events.

    Two modes:
    1. Active stream (run is currently executing): subscribe to the
       EventHydrator StreamChannel and hold a persistent SSE long-connection
       with 15-second heartbeats, terminating on stream_end / terminal event.
    2. Inactive stream (run already finished): pull history from run_event
       table and return as a single SSE response body (short-pull fallback).
    """
    from agent_gateway.event_hydrator import get_hydrator
    hydrator = get_hydrator()

    # ── Active stream mode: persistent SSE long-connection ──
    if hydrator.has_active_stream(run_id):
        return 200, _SSE_LIVE_SENTINEL, "text/event-stream"

    # ── Inactive stream mode: short-pull from DB ──
    cur = conn.cursor()
    try:
        run_repo = TeamRunRepo(cur)
        run = run_repo.get_by_id(run_id)
        if run is None:
            return 404, json.dumps({"error": "RUN_NOT_FOUND", "message": f"Run {run_id} not found"}), "application/json"
        qs = parse_qs(query)
        cursor_val = int(qs.get("cursor", ["0"])[0])
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
        cursor_val = int(qs.get("cursor", ["0"])[0])
        limit_val = min(int(qs.get("limit", ["100"])[0]), 200)
        event_repo = RunEventRepo(cur)
        events = event_repo.list_by_run(run_id, after_cursor=cursor_val, limit=limit_val)
        items = [
            {
                "event_id": e.id,
                "event_cursor": e.cursor_no,
                "event_type": e.event_type,
                "preview": e.preview_text,
                "payload": _load_payload(e.payload_json) or {},
            }
            for e in events
        ]
        next_cursor = events[-1].cursor_no if events else cursor_val
        has_more = len(events) >= limit_val
        return 200, {
            "items": items,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "run_status": run.status,
        }
    finally:
        cur.close()


def _handle_run_retry_post(conn, path: str, run_id: str, body: dict | None) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        run = TeamRunRepo(cur).get_by_id(run_id)
        if run is None:
            return 404, {"error": "RUN_NOT_FOUND", "message": f"Run {run_id} not found"}
        if not run.conversation_id:
            return 409, {"error": "RUN_NOT_RETRYABLE", "message": f"Run {run_id} has no conversation context"}

        message_payload = _load_payload(run.input_message_json)
        message_text = str(
            (body or {}).get("message_text")
            or ((body or {}).get("message") or {}).get("text")
            or message_payload.get("message_text")
            or ""
        ).strip()
        if not message_text:
            return 409, {"error": "RUN_NOT_RETRYABLE", "message": f"Run {run_id} has no retryable message"}

        next_idempotency_key = str((body or {}).get("idempotency_key") or uuid.uuid4())
        message_payload["retry_of_run_id"] = run.id
        message_payload.setdefault("retry_count", 0)
        try:
            message_payload["retry_count"] = int(message_payload.get("retry_count") or 0) + 1
        except (TypeError, ValueError):
            message_payload["retry_count"] = 1
        message_payload["message_text"] = message_text
    finally:
        cur.close()

    uow = UnitOfWork(conn)
    try:
        conn.rollback()
        with uow:
            result = create_run(
                uow,
                run.conversation_id,
                run.entry_employee_id,
                message_text,
                next_idempotency_key,
                message_payload=message_payload,
            )
        result["retry_of_run_id"] = run.id
        from agent_gateway.runtime_executor import execute_run_async
        execute_run_async(result["run_id"])
        return 201, result
    except ValueError as exc:
        message = str(exc)
        if "Conversation" in message and "not found" in message:
            return 404, {"error": "CONVERSATION_NOT_FOUND", "message": message}
        if "message.text is required" in message:
            return 400, {"error": "MISSING_MESSAGE_TEXT", "message": message}
        return 400, {"error": "INVALID_REQUEST", "message": message}


def _handle_run_abort_post(conn, path: str, run_id: str, body: dict | None) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        run_repo = TeamRunRepo(cur)
        run = run_repo.get_by_id(run_id)
        if run is None:
            return 404, {"error": "RUN_NOT_FOUND", "message": f"Run {run_id} not found"}
        if run.is_terminal():
            return 200, {
                "run_id": run.id,
                "status": run.status,
                "aborted": run.status == "cancelled",
                "already_terminal": True,
            }
    finally:
        cur.close()

    binding = None
    next_cursor = 0
    try:
        conn.rollback()
        with UnitOfWork(conn) as uow:
            run = uow.team_runs().get_by_id(run_id)
            if run is None:
                return 404, {"error": "RUN_NOT_FOUND", "message": f"Run {run_id} not found"}
            if run.is_terminal():
                return 200, {
                    "run_id": run.id,
                    "status": run.status,
                    "aborted": run.status == "cancelled",
                    "already_terminal": True,
                }

            binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
            next_cursor = uow.run_events().get_max_cursor(run_id) + 1
            payload = {
                "cancel_summary": str((body or {}).get("reason") or "Run cancelled by user").strip() or "Run cancelled by user",
                "cancelled_by": str((body or {}).get("actor_id") or "user").strip() or "user",
            }
            event = RunEvent(
                id=f"evt_{uuid.uuid4().hex[:12]}",
                enterprise_id=run.enterprise_id,
                run_id=run.id,
                cursor_no=next_cursor,
                event_type="run_cancelled",
                source_type="session",
                source_id=(binding.runtime_session_id if binding is not None and binding.runtime_session_id else run.id),
                employee_id=run.entry_employee_id,
                event_ts=_today_iso(),
                preview_text=payload["cancel_summary"],
                payload_json=json.dumps(payload, ensure_ascii=False),
            )
            uow.run_events().create(event)
            run.cancel()
            run.result_summary_json = json.dumps(payload, ensure_ascii=False)
            if not run.finished_at:
                run.finished_at = event.event_ts
            uow.team_runs().update_status(run)
            if run.conversation_id:
                conv = uow.conversations().get_by_id(run.conversation_id)
                if conv is not None:
                    uow.conversations().update_latest_run(
                        run.conversation_id,
                        run.id,
                        None,
                        payload["cancel_summary"],
                    )
            if binding is not None:
                if next_cursor > binding.event_cursor:
                    binding.event_cursor = next_cursor
                binding.mark_synced()
                uow.runtime_bindings().update_sync(binding)

        return 200, {
            "run_id": run.id,
            "status": run.status,
            "aborted": True,
            "event_cursor": binding.event_cursor if binding is not None else next_cursor,
        }
    except ValueError as exc:
        return 409, {"error": "RUN_ABORT_CONFLICT", "message": str(exc)}


def _handle_org_tree(conn, path: str, query: str) -> tuple[int, dict]:
    _role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
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


def _handle_org_assignment_patch(conn, path: str, assignment_id: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    _role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial

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


_UPLOADS_ROOT = Path(__file__).resolve().parents[2] / ".state" / "uploads"


def _asset_file_path(asset_id: str, name: str) -> Path:
    safe_name = Path(name or "file.bin").name  # strip any path components
    return _UPLOADS_ROOT / asset_id / safe_name


def _handle_uploads_post(conn, path: str, body: dict | None) -> tuple[int, dict]:
    """Persist uploaded content to local asset storage.

    JSON contract: accepts ``content_text`` (UTF-8 text) or ``content_base64``;
    the stored file is what knowledge ingestion later feeds into LightRAG.
    """
    body = body or {}
    asset_id = f"ast_{uuid.uuid4().hex[:8]}"
    name = str(body.get("name") or "file.bin")

    content_text = body.get("content_text")
    content_b64 = body.get("content_base64")
    if content_text is None and content_b64 is None:
        return 400, {
            "error": "MISSING_CONTENT",
            "message": "content_text or content_base64 is required",
        }
    if content_text is not None:
        data = str(content_text).encode("utf-8")
    else:
        import base64
        try:
            data = base64.b64decode(str(content_b64), validate=True)
        except Exception:
            return 400, {"error": "INVALID_BASE64", "message": "content_base64 is not valid base64"}

    file_path = _asset_file_path(asset_id, name)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(data)

    return 201, {
        "asset_id": asset_id,
        "name": file_path.name,
        "size": len(data),
        "mime_type": body.get("mime_type", "application/octet-stream"),
        "storage_key": f"aiteam/uploads/{asset_id}/{file_path.name}",
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
        _fire_memory_sync(cur, employee_id)
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
        _fire_memory_sync(cur, item.employee_id)
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
        _fire_memory_sync(cur, item.employee_id)
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
        if emp is None or emp.deleted_at:
            # Soft-deleted (or vanished) employee. get_by_id does not filter
            # deleted_at, so check it explicitly here to stay consistent with the
            # (deleted-filtered) employee list.
            return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {emp_id} not found"}
        avatar_url = emp.avatar_url if emp else None
        template_id = emp.template_id if emp else None
        profile_name = emp.profile_name if emp else ""
        created_at = emp.created_at if emp else _today_iso()
        # Presence is derived from the live employee status, not a hardcoded
        # placeholder: active→online, paused/archived→offline, else busy.
        presence = _presence_for_employee(emp.status) if emp else "offline"
        template_name = ""
        if template_id:
            tmpl = AgentTemplateRepo(cur).get_by_id(template_id)
            template_name = tmpl.name if tmpl is not None else ""
        # Join enterprise_connector so each binding carries the connector's real
        # type/status/name, not just the binding row's own fields.
        connector_meta: dict = {}
        if emp is not None:
            conn_repo = EnterpriseConnectorRepo(cur)
            for binding in view.connector_bindings:
                cid = binding.get("connector_id")
                if not cid or cid in connector_meta:
                    continue
                c = conn_repo.get_by_id(cid)
                if c is not None:
                    connector_meta[cid] = {
                        "name": c.name,
                        "provider_code": c.provider_code,
                        "connector_type": c.connector_type,
                        "status": c.status,
                    }
        conversation_bindings = []
        if emp is not None:
            for conv in ConversationRepo(cur).list_by_enterprise(emp.enterprise_id):
                if conv.entry_employee_id == emp_id and not conv.deleted_at:
                    conversation_bindings.append({
                        "conversation_id": conv.id,
                        "type": conv.type,
                        "title": conv.title,
                        "status": conv.status,
                    })
        audit_repo = AuditEventRepo(cur)
        audit_events = list(audit_repo.list_by_target("employee", emp_id, limit=20))
        for job in ScheduledJobRepo(cur).list_by_employee(emp_id):
            scheduled_job_id = str(job.id or "").strip()
            if not scheduled_job_id:
                continue
            audit_events.extend(audit_repo.list_by_target("scheduled_job", scheduled_job_id, limit=10))
        audit_events.sort(key=lambda event: event.created_at or "", reverse=True)
    finally:
        cur.close()
    active_skill_codes = [
        skill["skill_code"] for skill in view.skills if skill.get("enabled", True)
    ]
    active_knowledge_ids = [
        item["knowledge_base_id"] for item in view.knowledge_bases if item.get("enabled", True)
    ]
    active_connector_bindings = [
        {
            "connector_id": binding["connector_id"],
            "access_mode": binding.get("access_mode", "invoke"),
            "enabled": binding.get("enabled", True),
        }
        for binding in view.connector_bindings
        if binding.get("enabled", True)
    ]
    usage_summary = {
        "total_runs": int(view.run_summary.get("total_runs") or 0),
        "total_tokens": int(view.run_summary.get("total_tokens") or 0),
        "last_run_at": view.run_summary.get("last_run_at"),
    }
    return 200, {
        "employee_id": view.employee_id,
        "display_name": view.display_name,
        "role_name": view.role_name,
        "status": view.status,
        "presence": presence,
        "avatar_url": avatar_url,
        "template_ref": {
            "template_id": template_id,
            "name": template_name,
        } if template_id else None,
        "profile_config": {
            "profile_name": profile_name,
            "skills": active_skill_codes,
            "knowledge": active_knowledge_ids,
            "connectors": active_connector_bindings,
            "memory_config": view.memory_config,
        },
        "connector_bindings": [
            {
                "binding_id": binding["binding_id"],
                "connector_id": binding["connector_id"],
                "access_mode": binding.get("access_mode", "invoke"),
                "enabled": binding.get("enabled", True),
                "connector_name": connector_meta.get(binding["connector_id"], {}).get("name", ""),
                "provider_code": connector_meta.get(binding["connector_id"], {}).get("provider_code", ""),
                "connector_type": connector_meta.get(binding["connector_id"], {}).get("connector_type", ""),
                "connector_status": connector_meta.get(binding["connector_id"], {}).get("status", ""),
            }
            for binding in view.connector_bindings
        ],
        "conversation_bindings": conversation_bindings,
        "usage_summary": usage_summary,
        "model_provider": view.model_provider,
        "model_name": view.model_name,
        "prompt_version": view.prompt_version,
        "prompt_config": view.prompt_config,
        "knowledge_bases": view.knowledge_bases,
        "bindings_summary": view.bindings_summary,
        "scheduled_jobs": view.scheduled_jobs,
        "run_summary": view.run_summary,
        "recent_audit_events": [
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
            for event in audit_events
        ],
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
            "created_at, updated_at, publish_scope_json "
            "FROM industry_solution WHERE deleted_at IS NULL ORDER BY created_at DESC"
        )
        rows = cur.fetchall()
        binding_repo = SolutionTemplateBindingRepo(cur)
        template_repo = AgentTemplateRepo(cur)
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
            if row[2] != "published":
                continue
            if not _publish_scope_allows(row[9], enterprise.id if enterprise is not None else None):
                continue
            tags = row[3] if isinstance(row[3], list) else []
            solution_id = row[0]
            template_ids = [
                binding.template_id
                for binding in binding_repo.list_by_solution(solution_id)
                if binding.enabled
            ]
            template_summaries = []
            for template_id in template_ids:
                template = template_repo.get_by_id(template_id)
                if template is None:
                    continue
                template_summaries.append({
                    "template_id": template.id,
                    "name": template.name,
                    "role_name": template.role_name,
                    "default_model_ref": _template_model_ref(template),
                })
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
                "template_summaries": template_summaries,
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

def _connector_grants_by_connector(cur, enterprise_id: str) -> dict[str, list[dict]]:
    cur.execute(
        "SELECT connector_id, employee_id, access_mode, enabled "
        "FROM employee_connector_binding "
        "WHERE enterprise_id = %s AND deleted_at IS NULL "
        "ORDER BY connector_id, employee_id",
        (enterprise_id,),
    )
    grants: dict[str, list[dict]] = {}
    for connector_id, employee_id, access_mode, enabled in cur.fetchall():
        grants.setdefault(connector_id, []).append(
            {
                "employee_id": employee_id,
                "access_mode": access_mode,
                "enabled": bool(enabled),
            }
        )
    return grants


def _serialize_connector(connector, grants_by_connector: dict[str, list[dict]]) -> dict:
    grants = grants_by_connector.get(connector.id, [])
    return {
        "connector_id": connector.id,
        "definition_id": connector.definition_id,
        "name": connector.name,
        "provider_code": connector.provider_code,
        "connector_type": connector.connector_type,
        "status": connector.status,
        "health_status": connector.status,
        "credential_ref": connector.credential_ref,
        "credential_mask": connector.credential_mask,
        "credential_state": connector.credential_state,
        "rotation_version": connector.rotation_version,
        "config": _load_payload(connector.config_json),
        "grants": [grant["employee_id"] for grant in grants if grant["enabled"]],
        "employee_grants": grants,
        "granted_employee_ids": [grant["employee_id"] for grant in grants if grant["enabled"]],
        "last_test_result": _load_payload(connector.last_test_result_json),
        "last_validated_at": connector.last_validated_at,
        "last_test_at": connector.last_validated_at,
        "created_at": connector.created_at,
        "updated_at": connector.updated_at,
        "updated_by": connector.updated_by,
    }


def _handle_connector_detail(conn, path: str, connector_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        repo = EnterpriseConnectorRepo(cur)
        connector = repo.get_by_id(connector_id)
        if connector is None or connector.enterprise_id != enterprise.id:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        return 200, _serialize_connector(connector, _connector_grants_by_connector(cur, enterprise.id))
    finally:
        cur.close()


def _handle_connector_patch(conn, path: str, connector_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        repo = EnterpriseConnectorRepo(cur)
        connector = repo.get_by_id(connector_id)
        if connector is None or connector.enterprise_id != enterprise.id:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}

        if "name" in body:
            connector.name = str(body.get("name") or connector.name)
        config_payload = body.get("config_json", body.get("config"))
        if config_payload is not None:
            connector.config_json = json.dumps(config_payload, ensure_ascii=False) if isinstance(config_payload, dict) else str(config_payload)

        next_credential_ref = ""
        credential_input = body.get("credential_input")
        if isinstance(credential_input, dict):
            next_credential_ref = str(credential_input.get("credential_ref") or "").strip()
        elif body.get("credential_ref") is not None:
            next_credential_ref = str(body.get("credential_ref") or "").strip()
        if next_credential_ref:
            if next_credential_ref != connector.credential_ref:
                connector.rotation_version = int(connector.rotation_version or 0) + 1
                connector.credential_state = "rotated"
                connector.credential_mask = "已轮换"
                connector.status = "draft"
                connector.last_test_result_json = json.dumps(
                    {
                        "result": "never_tested",
                        "checked_at": "",
                        "checked_by": "",
                        "error_code": "",
                        "message": "等待复测",
                        "log_ref": "",
                    },
                    ensure_ascii=False,
                )
            connector.credential_ref = next_credential_ref

        connector.updated_by = _request_actor_id("", body)
        repo.update(connector)
        conn.commit()
        return 200, {
            "connector_id": connector.id,
            "status": connector.status,
            "credential_state": connector.credential_state,
            "rotation_version": connector.rotation_version,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


# ── LLM provider/model catalog (enterprise-configured, DB source of truth) ──

def _llm_enterprise_id(conn) -> str | None:
    """Resolve the active enterprise id within a self-contained transaction.

    Handlers must NOT open a bare cursor before entering a UnitOfWork: a stray
    SELECT leaves the connection mid-transaction and UoW's autocommit toggle
    then raises 'set_session cannot be used inside a transaction'.
    """
    from ..transactions.uow import UnitOfWork
    with UnitOfWork(conn) as uow:
        enterprises = EnterpriseRepo(uow.cur).list_all()
        return enterprises[0].id if enterprises else None


def _serialize_llm_provider(p, models):
    return {
        "provider_id": p.id,
        "provider_key": p.provider_key,
        "display_name": p.display_name,
        "base_url": p.base_url,
        "api_key_mask": "已配置" if p.api_key else "未配置",
        "transport": p.transport,
        "enabled": p.enabled,
        "models": [
            {
                "model_uid": m.id,
                "model_id": m.model_id,
                "label": m.label,
                "context_length": m.context_length,
                "enabled": m.enabled,
                "is_default": m.is_default,
            }
            for m in models
        ],
    }


def _handle_llm_providers_list(conn, path: str) -> tuple[int, dict]:
    from ..transactions.uow import UnitOfWork
    with UnitOfWork(conn) as uow:
        enterprises = EnterpriseRepo(uow.cur).list_all()
        if not enterprises:
            return 200, {"providers": []}
        enterprise_id = enterprises[0].id
        providers = uow.llm_providers().list_by_enterprise(enterprise_id)
        models_by_provider: dict[str, list] = {}
        for m in uow.llm_models().list_by_enterprise(enterprise_id):
            models_by_provider.setdefault(m.provider_id, []).append(m)
    return 200, {
        "providers": [
            _serialize_llm_provider(p, models_by_provider.get(p.id, []))
            for p in providers
        ]
    }


def _handle_llm_providers_post(conn, path: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial
    if not (body.get("provider_key") or "").strip():
        return 400, {"error": "MISSING_PROVIDER_KEY", "message": "provider_key is required"}
    enterprise_id = _llm_enterprise_id(conn)
    if enterprise_id is None:
        return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
    from ..application.commands import llm_provider_service
    provider_id = llm_provider_service.create_provider(conn, enterprise_id, body, created_by=role or "")
    return 201, {"provider_id": provider_id, "status": "created"}


def _handle_llm_provider_patch(conn, path: str, query: str, provider_id: str, body: dict | None) -> tuple[int, dict]:
    role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial
    enterprise_id = _llm_enterprise_id(conn)
    if enterprise_id is None:
        return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
    from ..application.commands import llm_provider_service
    ok = llm_provider_service.update_provider(conn, enterprise_id, provider_id, body or {})
    if not ok:
        return 404, {"error": "PROVIDER_NOT_FOUND", "message": f"Provider {provider_id} not found"}
    return 200, {"provider_id": provider_id, "status": "updated"}


def _handle_llm_provider_delete(conn, path: str, query: str, provider_id: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
    enterprise_id = _llm_enterprise_id(conn)
    if enterprise_id is None:
        return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
    from ..application.commands import llm_provider_service
    ok = llm_provider_service.delete_provider(conn, enterprise_id, provider_id)
    if not ok:
        return 404, {"error": "PROVIDER_NOT_FOUND", "message": f"Provider {provider_id} not found"}
    return 200, {"provider_id": provider_id, "status": "deleted"}


def _handle_llm_models_post(conn, path: str, query: str, provider_id: str, body: dict | None) -> tuple[int, dict]:
    if not body or not (body.get("model_id") or "").strip():
        return 400, {"error": "MISSING_MODEL_ID", "message": "model_id is required"}
    role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial
    enterprise_id = _llm_enterprise_id(conn)
    if enterprise_id is None:
        return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
    from ..application.commands import llm_provider_service
    model_uid = llm_provider_service.add_model(conn, enterprise_id, provider_id, body)
    if model_uid is None:
        return 404, {"error": "PROVIDER_NOT_FOUND", "message": f"Provider {provider_id} not found"}
    return 201, {"model_uid": model_uid, "status": "created"}


def _handle_llm_model_delete(conn, path: str, query: str, model_uid: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
    enterprise_id = _llm_enterprise_id(conn)
    if enterprise_id is None:
        return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
    from ..application.commands import llm_provider_service
    ok = llm_provider_service.delete_model(conn, enterprise_id, model_uid)
    if not ok:
        return 404, {"error": "MODEL_NOT_FOUND", "message": f"Model {model_uid} not found"}
    return 200, {"model_uid": model_uid, "status": "deleted"}


def _handle_llm_models_flat(conn, path: str) -> tuple[int, dict]:
    enterprise_id = _llm_enterprise_id(conn)
    if enterprise_id is None:
        return 200, {"models": []}
    from ..application.commands import llm_provider_service
    return 200, {"models": llm_provider_service.list_models_flat(conn, enterprise_id)}


# ── Collaboration (orchestration prompt) template ──

def _handle_collab_template_get(conn, path: str) -> tuple[int, dict]:
    from agent_gateway.orchestration_templates import (
        DEFAULT_AGGREGATE_PROMPT, DEFAULT_PLANNER_PROMPT, DEFAULT_SUBTASK_PROMPT,
    )
    enterprise_id = _llm_enterprise_id(conn)
    defaults = {
        "planner_prompt": DEFAULT_PLANNER_PROMPT,
        "subtask_prompt": DEFAULT_SUBTASK_PROMPT,
        "aggregate_prompt": DEFAULT_AGGREGATE_PROMPT,
    }
    current = None
    if enterprise_id is not None:
        from ..transactions.uow import UnitOfWork
        with UnitOfWork(conn) as uow:
            current = uow.collaboration_templates().get_default(enterprise_id)
    payload = {
        "defaults": defaults,
        "placeholders": {
            "planner_prompt": ["{roster}", "{message_text}", "{max_subtasks}"],
            "subtask_prompt": ["{message_text}", "{task_title}", "{task_desc}", "{dep_block}"],
            "aggregate_prompt": ["{message_text}", "{subtask_results}"],
        },
        "prompt_config_hint": {
            "planner_prompt": {"editable": True, "description": "方案编排规则（planner 拆解派单）"},
            "subtask_prompt": {"editable": False, "description": "运行时内置默认，不建议编辑"},
            "aggregate_prompt": {"editable": False, "description": "运行时内置默认，不建议编辑"},
        },
    }
    if current is not None:
        payload["template"] = {
            "template_id": current.id,
            "name": current.name,
            "planner_prompt": current.planner_prompt,
            "subtask_prompt": current.subtask_prompt,
            "aggregate_prompt": current.aggregate_prompt,
            "enabled": current.enabled,
        }
    else:
        payload["template"] = None
    return 200, payload


def _handle_collab_template_put(conn, path: str, query: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    role, denial = _require_permission(query, body, "manage_employees")
    if denial is not None:
        return denial
    enterprise_id = _llm_enterprise_id(conn)
    if enterprise_id is None:
        return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
    from ..transactions.uow import UnitOfWork
    with UnitOfWork(conn) as uow:
        repo = uow.collaboration_templates()
        current = repo.get_default(enterprise_id)
        if current is None:
            current = CollaborationTemplate(
                id=f"collab_{uuid.uuid4().hex[:12]}",
                enterprise_id=enterprise_id,
                name=body.get("name") or "默认协作模板",
                planner_prompt=body.get("planner_prompt") or "",
                subtask_prompt=body.get("subtask_prompt") or "",
                aggregate_prompt=body.get("aggregate_prompt") or "",
                is_default=True,
                enabled=True,
                created_by=role or "",
            )
            repo.create(current)
        else:
            if "name" in body:
                current.name = body.get("name") or current.name
            if "planner_prompt" in body:
                current.planner_prompt = body.get("planner_prompt") or ""
            if "subtask_prompt" in body:
                current.subtask_prompt = body.get("subtask_prompt") or ""
            if "aggregate_prompt" in body:
                current.aggregate_prompt = body.get("aggregate_prompt") or ""
            if "enabled" in body:
                current.enabled = bool(body.get("enabled"))
            repo.update(current)
        template_id = current.id
    return 200, {"template_id": template_id, "status": "saved"}


def _handle_connector_delete(conn, path: str, connector_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        repo = EnterpriseConnectorRepo(cur)
        connector = repo.get_by_id(connector_id)
        if connector is None or connector.enterprise_id != enterprise.id or connector.deleted_at:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        repo.delete(connector_id)
        conn.commit()
        return 200, {"connector_id": connector_id, "status": "archived"}
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_connector_status(conn, path: str, connector_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        connector = EnterpriseConnectorRepo(cur).get_by_id(connector_id)
        if connector is None:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        return 200, {
            "connector_id": connector.id,
            "status": connector.status,
            "credential_state": connector.credential_state,
            "updated_at": connector.updated_at,
            "last_test_result": _load_payload(connector.last_test_result_json),
        }
    finally:
        cur.close()


def _handle_connectors_list(conn, path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {"connectors": [], "definitions": []}
        connector_repo = EnterpriseConnectorRepo(cur)
        definition_repo = ConnectorDefinitionRepo(cur)
        connectors = connector_repo.list_by_enterprise(enterprise.id)
        definitions = definition_repo.list_active()
        grants_by_connector = _connector_grants_by_connector(cur, enterprise.id)
        return 200, {
            "connectors": [
                _serialize_connector(connector, grants_by_connector)
                for connector in connectors
            ],
            "definitions": [
                {
                    "definition_id": definition.id,
                    "provider_code": definition.provider_code,
                    "connector_type": definition.connector_type,
                    "display_name": definition.display_name,
                    "auth_scheme": definition.auth_scheme,
                    "config_schema_json": definition.config_schema_json,
                    "status": definition.status,
                }
                for definition in definitions
            ],
        }
    finally:
        cur.close()


def _handle_connectors_post(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        name = body.get("name", "Connector")
        provider_code = body.get("provider_code", body.get("provider", "custom"))
        connector_type = body.get("connector_type", body.get("type", "api_key_connector"))
        credential_ref = body.get("credential_ref", f"cred://{enterprise.id}/{uuid.uuid4().hex[:8]}")
        config_json = body.get("config_json", body.get("config", {}))
        connector_id = f"conn_{uuid.uuid4().hex[:12]}"
        connector = EnterpriseConnector(
            id=connector_id,
            enterprise_id=enterprise.id,
            name=name,
            provider_code=provider_code,
            connector_type=connector_type,
            credential_ref=credential_ref,
            credential_mask="已配置" if credential_ref else "未配置",
            credential_state="configured" if credential_ref else "missing",
            rotation_version=0,
            status="draft",
            config_json=json.dumps(config_json) if isinstance(config_json, dict) else str(config_json),
        )
        EnterpriseConnectorRepo(cur).create(connector)
        conn.commit()
        return 201, {
            "connector_id": connector_id,
            "status": "draft",
            "name": name,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_connector_test(conn, path: str, connector_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        repo = EnterpriseConnectorRepo(cur)
        connector = repo.get_by_id(connector_id)
        if connector is None:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        if connector.connector_type == "mcp_server":
            ok, detail = profile_capability.mcp_test(connector.name)
        else:
            # API-key / OAuth connectors: the test validates that credentials
            # are configured, not that the connector is already online — the
            # previous `ok = status == "online"` was circular (status only
            # becomes online via a passing test), so a freshly-created
            # connector could never pass and could never be granted.
            ok = connector.credential_state in ("configured", "rotated") and bool(connector.credential_ref)
            detail = "凭证已配置，连接测试通过" if ok else "凭证未配置，无法连接"
        result_str = "passed" if ok else "failed"
        new_status = "online" if ok else "offline"
        cur.execute(
            "UPDATE enterprise_connector SET status=%s, last_validated_at=now(), last_test_result_json=%s::jsonb WHERE id=%s",
            (
                new_status,
                json.dumps(
                    {"result": result_str, "checked_at": _today_iso(), "checked_by": "system", "message": detail},
                    ensure_ascii=False,
                ),
                connector_id,
            ),
        )
        conn.commit()
        return 200, {
            "connector_id": connector_id,
            "ok": ok,
            "status": new_status,
            "result": result_str,
            "checked_at": _today_iso(),
            "message": detail,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_connector_grants_patch(conn, path: str, connector_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        connector = EnterpriseConnectorRepo(cur).get_by_id(connector_id)
        if connector is None:
            return 404, {"error": "CONNECTOR_NOT_FOUND", "message": f"Connector {connector_id} not found"}
        grant = body.get("grant")
        revoke = body.get("revoke")
        results = {"granted": [], "revoked": [], "errors": []}
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
            audit_event_ids: list[str] = []

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

            memory_binding_changed = any(field in body for field in (
                "memory_mode",
                "memory_provider_code",
                "memory_retention_days",
                "memory_writeback_enabled",
            ))
            if memory_binding_changed:
                existing_memory = uow.employee_memory_bindings().get_by_employee(emp_id)
                uow.employee_memory_bindings().upsert(
                    EmployeeMemoryBinding(
                        id=existing_memory.id if existing_memory is not None else f"emb_{uuid.uuid4().hex[:12]}",
                        enterprise_id=emp.enterprise_id,
                        employee_id=emp_id,
                        memory_mode=body.get("memory_mode", existing_memory.memory_mode if existing_memory else "builtin"),
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

            scheduled_job_payload = body.get("scheduled_job")
            scheduled_job_action = str(body.get("scheduled_job_action") or "").strip()
            if scheduled_job_payload is not None:
                if not isinstance(scheduled_job_payload, dict):
                    return 400, {"error": "INVALID_SCHEDULED_JOB", "message": "scheduled_job must be an object"}
                if scheduled_job_action:
                    scheduled_job_id = str(scheduled_job_payload.get("scheduled_job_id") or "").strip()
                    if not scheduled_job_id:
                        return 400, {"error": "MISSING_SCHEDULED_JOB_ID", "message": "scheduled_job_id is required"}
                    job = uow.scheduled_jobs().get_by_id(scheduled_job_id)
                    if job is None or job.employee_id != emp_id:
                        return 404, {"error": "SCHEDULED_JOB_NOT_FOUND", "message": f"ScheduledJob {scheduled_job_id} not found"}
                    if scheduled_job_action == "pause":
                        pause_job(uow, scheduled_job_id)
                        event_type = "scheduled_job.pause"
                    elif scheduled_job_action == "resume":
                        resume_job(uow, scheduled_job_id)
                        event_type = "scheduled_job.resume"
                    elif scheduled_job_action == "archive":
                        job.archive()
                        uow.scheduled_jobs().update(job)
                        event_type = "scheduled_job.archive"
                    else:
                        return 400, {"error": "INVALID_SCHEDULED_JOB_ACTION", "message": f"Unsupported scheduled_job_action: {scheduled_job_action}"}
                    audit_event_ids.append(
                        _write_audit_event(
                            uow.cur,
                            enterprise_id=emp.enterprise_id,
                            query=query,
                            body=body,
                            event_type=event_type,
                            target_type="scheduled_job",
                            target_id=scheduled_job_id,
                            payload={"employee_id": emp_id, "scheduled_job_id": scheduled_job_id},
                        )
                    )
                else:
                    schedule_expr = str(scheduled_job_payload.get("schedule_expr") or "").strip()
                    if not schedule_expr:
                        return 400, {"error": "MISSING_SCHEDULE_EXPR", "message": "scheduled_job.schedule_expr is required"}
                    job_config = {
                        "name": str(scheduled_job_payload.get("name") or "Scheduled Job"),
                        "goal": str(scheduled_job_payload.get("goal") or ""),
                        "auto_enable": str(scheduled_job_payload.get("status") or "enabled") == "enabled",
                        "max_consecutive_failures": int(scheduled_job_payload.get("max_consecutive_failures") or 3),
                        "notification_policy": scheduled_job_payload.get("notification_policy") or {},
                        "created_by": _request_actor_id(query, body),
                    }
                    scheduled_job_id = create_scheduled_job(
                        uow,
                        emp.enterprise_id,
                        emp_id,
                        schedule_expr,
                        job_config,
                    )
                    audit_event_ids.append(
                        _write_audit_event(
                            uow.cur,
                            enterprise_id=emp.enterprise_id,
                            query=query,
                            body=body,
                            event_type="scheduled_job.create",
                            target_type="scheduled_job",
                            target_id=scheduled_job_id,
                            payload={"employee_id": emp_id, "scheduled_job_id": scheduled_job_id, "schedule_expr": schedule_expr},
                        )
                    )

            audit_event_ids.append(
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
            )

            # Reconcile the FULL profile (persona + model + skills + memory) from
            # the just-updated DB state via the shared entry, so model/persona
            # edits actually reach the runtime profile — not just skills/memory.
            # Must run INSIDE the UoW block: it reads bindings via the still-open
            # cursor (sees this transaction's writes) and hands off to filesystem
            # threads. After the block the cursor is closed (uow.cur raises).
            _reconcile_employee_profile(uow.cur, emp)

        response = {
            "employee_id": emp.id,
            "display_name": emp.display_name,
            "status": emp.status,
            "reprovision_status": "reconciled",
            "updated_at": _today_iso(),
            "effective_role": role,
            "audit_event_id": audit_event_ids[-1] if audit_event_ids else "",
            "audit_event_ids": audit_event_ids,
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
    elif method == "POST" and _match_exact(sub, "/workbench/state"):
        route_handler = lambda conn: _handle_workbench_state_post(conn, sub, query, body)

    # ── office scene/feed ──
    elif method == "GET" and _match_exact(sub, "/office/scene"):
        route_handler = lambda conn: _handle_office_scene(conn, sub)
    elif method == "GET" and _match_exact(sub, "/office/feed"):
        route_handler = lambda conn: _handle_office_feed(conn, sub)

    # ── org/tree ──
    elif method == "GET" and _match_exact(sub, "/org/tree"):
        route_handler = lambda conn: _handle_org_tree(conn, sub, query)

    # ── enterprise admin templates alias + talent-market/templates ──
    elif method == "GET" and (_match_exact(sub, "/templates") or _match_exact(sub, "/talent-market/templates")):
        route_handler = lambda conn: _handle_talent_templates(conn, sub, query)

    # ── enterprise admin templates alias + talent-market/templates/{id} ──
    else:
        admin_tmpl_id = _match_prefix(sub, "/templates/")
        tmpl_id = _match_prefix(sub, "/talent-market/templates/")
        if method == "GET" and admin_tmpl_id is not None and "/" not in admin_tmpl_id:
            route_handler = lambda conn, template_id=admin_tmpl_id: _handle_talent_template_detail(conn, sub, query, template_id)
        elif method == "GET" and tmpl_id is not None and "/" not in tmpl_id:
            route_handler = lambda conn, template_id=tmpl_id: _handle_talent_template_detail(conn, sub, query, template_id)

    # ── recruitments ──
    if route_handler is None and method == "POST" and _match_exact(sub, "/recruitments"):
        route_handler = lambda conn: _handle_recruitments_post(conn, sub, query, body)

    # ── org/assignments/{id} patch ──
    if route_handler is None:
        org_assignment_id = _match_prefix(sub, "/org/assignments/")
        if method == "PATCH" and org_assignment_id is not None and "/" not in org_assignment_id:
            route_handler = lambda conn, matched_assignment_id=org_assignment_id: _handle_org_assignment_patch(conn, sub, matched_assignment_id, query, body)

    # ── solutions/{id}/apply/preview (must be checked before /apply) ──
    if route_handler is None:
        solution_preview = _match_prefix(sub, "/solutions/")
        if method == "POST" and solution_preview is not None and solution_preview.endswith("/apply/preview"):
            solution_id = solution_preview[:-len("/apply/preview")]
            if "/" not in solution_id:
                route_handler = lambda conn, matched_solution_id=solution_id: _handle_solution_apply_preview(conn, sub, matched_solution_id, body)

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
            route_handler = lambda conn, conversation_id=conv_id: _handle_conversation_detail(conn, f"{sub}?{query}" if query else sub, conversation_id)

    # ── group-conversations create ──
    if route_handler is None and method == "POST" and _match_exact(sub, "/group-conversations"):
        route_handler = lambda conn: _handle_group_conversation_create(conn, sub, body)

    # ── group-conversations/{id}/members/{member_id} delete ──
    if route_handler is None:
        group_member_delete = _match_prefix(sub, "/group-conversations/")
        if method == "DELETE" and group_member_delete is not None and "/members/" in group_member_delete:
            conv_id, member_id = group_member_delete.split("/members/", 1)
            if conv_id and member_id and "/" not in member_id:
                route_handler = lambda conn, conversation_id=conv_id, matched_member_id=member_id: _handle_group_member_remove(conn, sub, conversation_id, matched_member_id)

    # ── group-conversations/{id}/members create ──
    if route_handler is None:
        group_member_create = _match_prefix(sub, "/group-conversations/")
        if method == "POST" and group_member_create is not None and group_member_create.endswith("/members"):
            conv_id = group_member_create[:-len("/members")]
            if conv_id and "/" not in conv_id:
                route_handler = lambda conn, conversation_id=conv_id: _handle_group_member_add(conn, sub, conversation_id, body)

    # ── group-conversations/{id}/messages ──
    if route_handler is None:
        group_message = _match_prefix(sub, "/group-conversations/")
        if method == "POST" and group_message is not None and group_message.endswith("/messages"):
            conv_id = group_message[:-len("/messages")]
            if "/" not in conv_id:
                route_handler = lambda conn, conversation_id=conv_id: _handle_group_conversation_message_post(conn, sub, conversation_id, body)

    # ── group-conversations/{id} ──
    if route_handler is None:
        group_detail = _match_prefix(sub, "/group-conversations/")
        if method == "DELETE" and group_detail is not None and "/" not in group_detail:
            route_handler = lambda conn, conversation_id=group_detail: _handle_group_conversation_archive(conn, sub, conversation_id)
        if method == "GET" and group_detail is not None and "/" not in group_detail:
            route_handler = lambda conn, conversation_id=group_detail: _handle_group_conversation_detail(conn, sub, conversation_id)

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

    # ── runs/{id}/retry ──
    if route_handler is None:
        run_retry = _match_prefix(sub, "/runs/")
        if method == "POST" and run_retry is not None and run_retry.endswith("/retry"):
            run_id = run_retry[:-len("/retry")]
            route_handler = lambda conn, matched_run_id=run_id: _handle_run_retry_post(conn, sub, matched_run_id, body)

    # ── runs/{id}/abort ──
    if route_handler is None:
        run_abort = _match_prefix(sub, "/runs/")
        if method == "POST" and run_abort is not None and run_abort.endswith("/abort"):
            run_id = run_abort[:-len("/abort")]
            route_handler = lambda conn, matched_run_id=run_id: _handle_run_abort_post(conn, sub, matched_run_id, body)

    # ── uploads ──
    if route_handler is None and method == "POST" and _match_exact(sub, "/uploads"):
        route_handler = lambda conn: _handle_uploads_post(conn, sub, body)

    # ── P08 knowledge-bases ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/knowledge-bases"):
        route_handler = lambda conn: _handle_knowledge_bases_list(conn, sub)

    if route_handler is None and method == "POST" and _match_exact(sub, "/knowledge-bases"):
        route_handler = lambda conn: _handle_knowledge_base_post(conn, sub, body)

    if route_handler is None:
        kb_search = _match_prefix(sub, "/knowledge-bases/")
        if method == "GET" and kb_search is not None and kb_search.endswith("/search"):
            kb_id = kb_search[:-len("/search")]
            if "/" not in kb_id:
                route_handler = lambda conn, kb_id=kb_id: _handle_knowledge_search(conn, sub, kb_id, query)

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

    # ── LLM provider/model catalog ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/llm-providers"):
        route_handler = lambda conn: _handle_llm_providers_list(conn, sub)

    if route_handler is None and method == "POST" and _match_exact(sub, "/llm-providers"):
        route_handler = lambda conn: _handle_llm_providers_post(conn, sub, query, body)

    if route_handler is None and method == "GET" and _match_exact(sub, "/llm-models"):
        route_handler = lambda conn: _handle_llm_models_flat(conn, sub)

    # ── Collaboration (orchestration prompt) template ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/collaboration-template"):
        route_handler = lambda conn: _handle_collab_template_get(conn, sub)

    if route_handler is None and method in ("PUT", "POST", "PATCH") and _match_exact(sub, "/collaboration-template"):
        route_handler = lambda conn: _handle_collab_template_put(conn, sub, query, body)

    if route_handler is None:
        llm_model_del = _match_prefix(sub, "/llm-models/")
        if method == "DELETE" and llm_model_del is not None and "/" not in llm_model_del:
            route_handler = lambda conn, mid=llm_model_del: _handle_llm_model_delete(conn, sub, query, mid)

    if route_handler is None:
        llm_models_add = _match_prefix(sub, "/llm-providers/")
        if method == "POST" and llm_models_add is not None and llm_models_add.endswith("/models"):
            pid = llm_models_add[:-len("/models")]
            if "/" not in pid:
                route_handler = lambda conn, matched_pid=pid: _handle_llm_models_post(conn, sub, query, matched_pid, body)

    if route_handler is None:
        llm_provider_detail = _match_prefix(sub, "/llm-providers/")
        if llm_provider_detail is not None and "/" not in llm_provider_detail:
            if method == "PATCH":
                route_handler = lambda conn, matched_pid=llm_provider_detail: _handle_llm_provider_patch(conn, sub, query, matched_pid, body)
            elif method == "DELETE":
                route_handler = lambda conn, matched_pid=llm_provider_detail: _handle_llm_provider_delete(conn, sub, query, matched_pid)

    # ── B05 connectors list/create/test/grants ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/connectors"):
        route_handler = lambda conn: _handle_connectors_list(conn, sub)

    if route_handler is None and method == "POST" and _match_exact(sub, "/connectors"):
        route_handler = lambda conn: _handle_connectors_post(conn, sub, body)

    if route_handler is None:
        connector_status = _match_prefix(sub, "/connectors/")
        if method == "GET" and connector_status is not None and connector_status.endswith("/status"):
            connector_id = connector_status[:-len("/status")]
            if "/" not in connector_id:
                route_handler = lambda conn, matched_connector_id=connector_id: _handle_connector_status(conn, sub, matched_connector_id)

    if route_handler is None:
        connector_test = _match_prefix(sub, "/connectors/")
        if method == "POST" and connector_test is not None and connector_test.endswith("/test"):
            connector_id = connector_test[:-len("/test")]
            if "/" not in connector_id:
                route_handler = lambda conn, matched_connector_id=connector_id: _handle_connector_test(conn, sub, matched_connector_id)

    if route_handler is None:
        connector_detail = _match_prefix(sub, "/connectors/")
        if connector_detail is not None and "/" not in connector_detail:
            if method == "GET":
                route_handler = lambda conn, matched_connector_id=connector_detail: _handle_connector_detail(conn, sub, matched_connector_id)
            elif method == "PATCH":
                route_handler = lambda conn, matched_connector_id=connector_detail: _handle_connector_patch(conn, sub, matched_connector_id, body)
            elif method == "DELETE":
                route_handler = lambda conn, matched_connector_id=connector_detail: _handle_connector_delete(conn, sub, matched_connector_id)

    if route_handler is None:
        connector_grants = _match_prefix(sub, "/connectors/")
        if method == "PATCH" and connector_grants is not None and connector_grants.endswith("/grants"):
            connector_id = connector_grants[:-len("/grants")]
            if "/" not in connector_id:
                route_handler = lambda conn, matched_connector_id=connector_id: _handle_connector_grants_patch(conn, sub, matched_connector_id, body)

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
        route_handler = lambda conn: _handle_skill_install_post(conn, sub, query, body)

    # ── skills/installs/{id} patch ──
    if route_handler is None:
        skill_install_patch = _match_prefix(sub, "/skills/installs/")
        if method == "PATCH" and skill_install_patch is not None and "/" not in skill_install_patch:
            route_handler = lambda conn, matched=skill_install_patch: _handle_skill_install_patch(conn, sub, query, matched, body)

    # ── skills/installs/{id} delete ──
    if route_handler is None:
        skill_install_delete = _match_prefix(sub, "/skills/installs/")
        if method == "DELETE" and skill_install_delete is not None and "/" not in skill_install_delete:
            route_handler = lambda conn, matched=skill_install_delete: _handle_skill_install_delete(conn, sub, query, matched)

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

    # ── employees/{id} delete (soft) ──
    if route_handler is None:
        emp_id_delete = _match_prefix(sub, "/employees/")
        if method == "DELETE" and emp_id_delete is not None and "/" not in emp_id_delete:
            route_handler = lambda conn, employee_id=emp_id_delete: _handle_employee_delete(conn, sub, employee_id, query)

    # ── employees create (direct) ──
    if route_handler is None and method == "POST" and _match_exact(sub, "/employees"):
        route_handler = lambda conn: _handle_employees_post(conn, sub, query, body)

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

    if route_handler is None:
        admin_invite_id = _match_prefix(sub, "/settings/admin-invites/")
        if method == "DELETE" and admin_invite_id is not None and "/" not in admin_invite_id:
            route_handler = lambda conn, matched_invite_id=admin_invite_id: handle_delete_admin_invite(conn, sub, matched_invite_id)

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
