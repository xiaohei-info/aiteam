"""Team Panel — /api/team/* router: first 12 northbound endpoints.

Connects to PostgreSQL on demand via team_panel.transactions.db.create_connection.
Uses the existing domain entities + repositories directly — no application layer yet.
"""
from __future__ import annotations

import ast
import json
import os
import uuid
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

import psycopg2

from ..transactions.db import create_connection
from ..domain.entities import (
    AgentTemplate,
    AuditEvent,
    Conversation,
    Employee,
    EmployeeKnowledgeBinding,
    Enterprise,
    RecruitmentOrder,
    TeamRun,
)
from ..domain.enums import EmployeeStatus
from ..repositories.agent_template_repo import AgentTemplateRepo
from ..repositories.audit_event_repo import AuditEventRepo
from ..repositories.conversation_repo import ConversationRepo
from ..repositories.employee_knowledge_binding_repo import EmployeeKnowledgeBindingRepo
from ..repositories.employee_repo import EmployeeRepo
from ..repositories.enterprise_repo import EnterpriseRepo
from ..repositories.industry_solution_repo import IndustrySolutionRepo
from ..repositories.recruitment_order_repo import RecruitmentOrderRepo
from ..repositories.run_event_repo import RunEventRepo
from ..repositories.solution_template_binding_repo import SolutionTemplateBindingRepo
from ..repositories.team_run_repo import TeamRunRepo
from ..transactions.uow import UnitOfWork
from ..application.commands.conversation_service import submit_group_message
from ..views.schemas import compute_display_state

from agent_gateway.contracts import (
    RunTimelineEvent,
    TimelineEventType,
    sse_frame,
)

_ALLOWED_PATCH_FIELDS = {"display_name", "status", "skills_add", "skills_remove"}
_VALID_EMPLOYEE_TRANSITIONS = {
    "active": {"paused", "archived"},
    "paused": {"active"},
    "draft": set(),
    "provisioning": set(),
    "provisioning_failed": set(),
    "archived": set(),
}


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


def _make_conn():
    return create_connection()


# ── path helpers ───────────────────────────────────────────────────────────

def _match_prefix(path: str, prefix: str) -> str | None:
    """If path starts with prefix, return the remainder; else None."""
    if path.startswith(prefix):
        return path[len(prefix):]
    return None


def _match_exact(path: str, target: str) -> bool:
    return path == target or path.rstrip("/") == target


# ── handler helpers ────────────────────────────────────────────────────────

def _handle_workbench(conn, path: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprise_repo = EnterpriseRepo(cur)
        employee_repo = EmployeeRepo(cur)
        enterprises = enterprise_repo.list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {
                "enterprise": None,
                "employees": [],
                "groups": [],
                "office_digest": {"online_employee_count": 0, "running_task_count": 0},
            }
        employees = employee_repo.list_by_enterprise(enterprise.id)
        return 200, {
            "enterprise": {
                "enterprise_id": enterprise.id,
                "name": enterprise.name,
                "plan_tier": "mvp",
            },
            "employees": [
                {
                    "employee_id": e.id,
                    "display_name": e.display_name,
                    "role_name": e.role_name,
                    "status": e.status,
                    "presence": "idle",
                    "avatar_url": e.avatar_url,
                    "last_message_preview": None,
                    "unread_count": 0,
                    "pinned": False,
                    "conversation_id": None,
                }
                for e in employees
            ],
            "groups": [],
            "office_digest": {
                "online_employee_count": len(employees),
                "running_task_count": 0,
            },
        }
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
    if mode != "append":
        return 400, {"error": "UNSUPPORTED_MODE", "message": "Only append mode is supported"}

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

        order_repo = RecruitmentOrderRepo(cur)
        existing_orders = [
            order for order in order_repo.list_by_enterprise(enterprise.id)
            if order.idempotency_key == apply_key and order.created_employee_id
        ]
        if existing_orders:
            first_order = existing_orders[0]
            knowledge_base_ids = _extract_template_knowledge_bases(template)
            return 200, {
                "apply_record_id": first_order.id,
                "status": "succeeded",
                "created_employee_ids": [order.created_employee_id for order in existing_orders if order.created_employee_id],
                "created_knowledge_base_ids": knowledge_base_ids,
            }

        knowledge_base_ids = _extract_template_knowledge_bases(template)
        employee_id = f"emp_{uuid.uuid4().hex[:12]}"
        apply_record_id = f"sol_apply_{uuid.uuid4().hex[:8]}"
        display_name = template.role_name or template.name or "Solution Employee"
        profile_name = _next_solution_profile_name(cur, enterprise.id, enterprise.slug, solution_id, display_name)

        order_repo.create(
            RecruitmentOrder(
                id=apply_record_id,
                enterprise_id=enterprise.id,
                template_id=template.id,
                status="succeeded",
                requested_by="solution_apply",
                created_employee_id=employee_id,
                idempotency_key=apply_key,
                created_by="solution_apply",
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
            "message_count": 0,
            "last_message_preview": {
                "event_cursor": latest_event.cursor_no if latest_event is not None else 0,
                "event_ts": (latest_event.event_ts if latest_event is not None else "") or _today_iso(),
                "preview": conv.last_message_preview or "",
            } if conv.last_message_preview else None,
        }
    finally:
        cur.close()


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
        return 400, {"error": "INVALID_REQUEST", "message": message}


def _handle_runs_post(conn, path: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    employee_id = body.get("employee_id", "")
    conversation_id = body.get("conversation_id", "")
    idempotency_key = body.get("idempotency_key", str(uuid.uuid4()))
    cur = conn.cursor()
    try:
        run_id = f"run_{uuid.uuid4().hex[:12]}"
        ent_id = ""
        if employee_id:
            employee = EmployeeRepo(cur).get_by_id(employee_id)
            if employee is None:
                return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {employee_id} not found"}
            ent_id = employee.enterprise_id
        elif conversation_id:
            conversation = ConversationRepo(cur).get_by_id(conversation_id)
            if conversation is None:
                return 404, {"error": "CONVERSATION_NOT_FOUND", "message": f"Conversation {conversation_id} not found"}
            ent_id = conversation.enterprise_id
        else:
            enterprise_repo = EnterpriseRepo(cur)
            enterprises = enterprise_repo.list_all()
            ent_id = enterprises[0].id if enterprises else ""
        if not ent_id:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}
        run = TeamRun(
            id=run_id,
            enterprise_id=ent_id,
            conversation_id=conversation_id or None,
            trigger_type="manual_run",
            execution_mode="single_agent",
            status="queued",
            entry_employee_id=employee_id or None,
            idempotency_key=idempotency_key,
        )
        repo = TeamRunRepo(cur)
        repo.create(run)
        conn.commit()
        return 201, {
            "run_id": run.id,
            "status": "queued",
            "conversation_id": conversation_id,
            "stream_url": f"/api/team/runs/{run.id}/stream?cursor=0",
            "events_url": f"/api/team/runs/{run.id}/events?cursor=0",
            "runtime_handle": {
                "kind": "session",
                "profile_name": employee_id,
                "session_id": None,
            },
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _handle_run_stream(conn, path: str, run_id: str) -> tuple[int, str, str]:
    cur = conn.cursor()
    try:
        run_repo = TeamRunRepo(cur)
        run = run_repo.get_by_id(run_id)
        if run is None:
            return 404, json.dumps({"error": "RUN_NOT_FOUND", "message": f"Run {run_id} not found"}), "application/json"
        event_repo = RunEventRepo(cur)
        events = event_repo.list_by_run(run_id, after_cursor=0, limit=50)
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


def _handle_employee_list(conn, path: str, query: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprise_repo = EnterpriseRepo(cur)
        enterprises = enterprise_repo.list_all()
        if not enterprises:
            return 200, {"employees": [], "total": 0, "page": 1, "limit": 20}
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
        }
    finally:
        cur.close()


def _handle_employee_detail(conn, path: str, emp_id: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        repo = EmployeeRepo(cur)
        emp = repo.get_by_id(emp_id)
        if emp is None:
            return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {emp_id} not found"}
        return 200, {
            "employee_id": emp.id,
            "display_name": emp.display_name,
            "role_name": emp.role_name,
            "status": emp.status,
            "presence": "idle",
            "avatar_url": emp.avatar_url,
            "template_ref": {
                "template_id": emp.template_id,
                "name": "",
            } if emp.template_id else None,
            "profile_config": {
                "profile_name": emp.profile_name,
                "skills": [],
                "memory_config": {"type": "conversation scoped", "max_tokens": 8000},
            },
            "connector_bindings": [],
            "conversation_bindings": [],
            "usage_summary": {
                "total_runs": 0,
                "total_tokens": 0,
                "last_run_at": None,
            },
            "created_at": emp.created_at or _today_iso(),
        }
    finally:
        cur.close()


def _handle_employee_patch(conn, path: str, emp_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}
    cur = conn.cursor()
    try:
        repo = EmployeeRepo(cur)
        emp = repo.get_by_id(emp_id)
        if emp is None:
            return 404, {"error": "EMPLOYEE_NOT_FOUND", "message": f"Employee {emp_id} not found"}

        # Validate allowed fields
        for key in body:
            if key not in _ALLOWED_PATCH_FIELDS:
                return 400, {"error": "INVALID_FIELD", "message": f"Field '{key}' is not allowed for PATCH"}

        # status transition validation
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
            except ValueError as e:
                return 400, {"error": "INVALID_STATUS_TRANSITION", "message": str(e)}

        # partial update: display_name
        new_display_name = body.get("display_name")
        if new_display_name is not None:
            emp.display_name = new_display_name

        # skills_add / skills_remove (not persisted yet in MVP, just accepted)
        skills_add = body.get("skills_add")
        skills_remove = body.get("skills_remove")

        repo.update_status(emp)
        conn.commit()

        response = {
            "employee_id": emp.id,
            "display_name": emp.display_name,
            "status": emp.status,
            "reprovision_status": None,
            "updated_at": _today_iso(),
        }
        if skills_add or skills_remove:
            response["skills_updated"] = {"added": skills_add or [], "removed": skills_remove or []}
        return 200, response
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


# ── Main dispatch ──────────────────────────────────────────────────────────

_ROUTES = [
    # (method, path_matcher, handler_fn)
    # Ordered: most specific first
]


def handle_team_route(path: str, method: str, body: dict | None = None) -> tuple[int, dict] | tuple[int, str, str]:
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
        route_handler = lambda conn: _handle_workbench(conn, sub)

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
            route_handler = lambda conn, matched_run_id=run_id: _handle_run_stream(conn, sub, matched_run_id)

    # ── runs/{id}/events ──
    if route_handler is None:
        run_events = _match_prefix(sub, "/runs/")
        if method == "GET" and run_events is not None and run_events.endswith("/events"):
            run_id = run_events[:-len("/events")]
            route_handler = lambda conn, matched_run_id=run_id: _handle_run_events(conn, sub, matched_run_id, query)

    # ── uploads ──
    if route_handler is None and method == "POST" and _match_exact(sub, "/uploads"):
        route_handler = lambda conn: _handle_uploads_post(conn, sub, body)

    # ── employees/{id} detail ──
    if route_handler is None:
        emp_id_detail = _match_prefix(sub, "/employees/")
        if method == "GET" and emp_id_detail is not None and "/" not in emp_id_detail:
            route_handler = lambda conn, employee_id=emp_id_detail: _handle_employee_detail(conn, sub, employee_id)

    # ── employees/{id} patch ──
    if route_handler is None:
        emp_id_patch = _match_prefix(sub, "/employees/")
        if method == "PATCH" and emp_id_patch is not None and "/" not in emp_id_patch:
            route_handler = lambda conn, employee_id=emp_id_patch: _handle_employee_patch(conn, sub, employee_id, body)

    # ── employees list ──
    if route_handler is None and method == "GET" and _match_exact(sub, "/employees"):
        route_handler = lambda conn: _handle_employee_list(conn, sub, query)

    if route_handler is None:
        return 501, {"error": "not_implemented", "message": f"Team API: {method} {path}"}

    conn = None
    try:
        conn = _make_conn()
    except Exception:
        return 503, {"error": "database_unavailable", "message": "Cannot connect to database"}

    try:
        return route_handler(conn)
    finally:
        try:
            conn.close()
        except Exception:
            pass
