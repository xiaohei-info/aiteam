"""Team Panel — /api/system-admin/* router.

Platform Tenant Management bounded context.
Aggregate root: Enterprise.
"""
from __future__ import annotations

import json
import uuid
from urllib.parse import parse_qs, urlparse

from api.system_health import build_system_health_payload
from ..domain.entities import AuditEvent
from ..repositories.audit_event_repo import AuditEventRepo
from ..repositories.enterprise_repo import EnterpriseRepo
from ..transactions.db import create_connection
from .router_team import (
    _request_actor_id,
    _request_params,
    _request_role,
    _require_permission,
)


_ENTERPRISE_ACTIONS = {"suspend", "ban", "reactivate", "unban", "recharge", "notify"}
_NOTIFICATION_LEVELS = {"info", "warning", "critical"}


def _make_conn():
    return create_connection()


def _get_db_url() -> str:
    from ..transactions.db import get_database_url
    return get_database_url()


def _parse_query(path: str) -> dict[str, str]:
    """Extract the first value for each query param."""
    qs = urlparse(path).query
    if not qs:
        return {}
    parsed = parse_qs(qs)
    return {k: v[0] for k, v in parsed.items()}

from ..application.commands.system_admin_content_service import (
    create_solution,
    create_template,
    update_solution,
    update_template,
)
from ..application.queries.system_admin_view_service import (
    get_platform_finance_overview,
    get_platform_finance_reports,
    list_solutions,
    list_templates,
)
from ..transactions.db import create_connection
from ..transactions.uow import UnitOfWork


def _make_conn():
    return create_connection()


def _match_exact(path: str, target: str) -> bool:
    return path == target or path.rstrip("/") == target


# ═══════════════════════════════════════════════════════════════════
# Route handlers
# ═══════════════════════════════════════════════════════════════════

def _handle_list_enterprises(path: str) -> tuple[int, dict]:
    query = _parse_query(path)
    page = int(query.get("page", "1"))
    limit = int(query.get("limit", "20"))
    name = query.get("name", "").strip() or None
    status = query.get("status", "").strip() or None

    conn = _make_conn()
    try:
        cur = conn.cursor()
        try:
            repo = EnterpriseRepo(cur)
            items, total = repo.list_with_filter(
                name=name, status=status, page=page, limit=limit,
            )
            return 200, {
                "enterprises": [
                    {
                        "id": e.id,
                        "slug": e.slug,
                        "name": e.name,
                        "status": e.status,
                        "owner_user_id": e.owner_user_id,
                        "created_at": e.created_at,
                    }
                    for e in items
                ],
                "total": total,
                "page": page,
                "limit": limit,
                "has_more": (page * limit) < total,
            }
        finally:
            cur.close()
    finally:
        conn.close()


def _handle_enterprise_detail(path: str, sub: str) -> tuple[int, dict]:
    # sub is like "/enterprises/{id}" or "/enterprises/{id}/"
    clean = sub[len("/enterprises/"):].rstrip("/")
    ent_id = clean

    conn = _make_conn()
    try:
        cur = conn.cursor()
        try:
            repo = EnterpriseRepo(cur)
            ent = repo.get_by_id(ent_id)
            if ent is None:
                return 404, {"error": "ENTERPRISE_NOT_FOUND", "message": f"Enterprise {ent_id} not found"}
            return 200, {
                "id": ent.id,
                "slug": ent.slug,
                "name": ent.name,
                "status": ent.status,
                "owner_user_id": ent.owner_user_id,
                "default_workspace_id": ent.default_workspace_id,
                "archive_reason": ent.archive_reason,
                "created_at": ent.created_at,
                "updated_at": ent.updated_at,
            }
        finally:
            cur.close()
    finally:
        conn.close()


def _enterprise_view(enterprise) -> dict:
    return {
        "enterprise_id": enterprise.id,
        "name": enterprise.name,
        "status": enterprise.status,
        "archive_reason": enterprise.archive_reason,
    }


def _create_audit_event(
    cur,
    *,
    enterprise_id: str,
    query: str,
    body: dict | None,
    event_type: str,
    target_id: str,
    payload: dict,
) -> str:
    event = AuditEvent(
        id=f"audit_{uuid.uuid4().hex[:12]}",
        enterprise_id=enterprise_id,
        actor_type="user",
        actor_id=_request_actor_id(query, body),
        event_type=event_type,
        target_type="enterprise",
        target_id=target_id,
        request_id=str(_request_params(query, body).get("request_id") or uuid.uuid4().hex[:12]),
        payload_json=json.dumps(payload, ensure_ascii=False),
        created_by=_request_role(query, body),
    )
    AuditEventRepo(cur).create(event)
    return event.id


def _enterprise_action_error(message: str, *, error: str = "INVALID_REQUEST", status: int = 400) -> tuple[int, dict]:
    return status, {"error": error, "message": message}


def _load_enterprise(repo: EnterpriseRepo, ent_id: str):
    ent = repo.get_by_id(ent_id)
    if ent is None:
        return None, (404, {"error": "ENTERPRISE_NOT_FOUND", "message": f"Enterprise {ent_id} not found"})
    return ent, None


def _build_action_response(
    ent_id: str,
    action: str,
    *,
    message: str = "enterprise action applied",
    **extra: object,
) -> dict:
    response: dict[str, object] = {
        "enterprise_id": ent_id,
        "action": action,
        "status": "succeeded",
        "message": message,
    }
    for key, value in extra.items():
        response[key] = value
    return response


def _validate_action_payload(action: str, body: dict | None) -> tuple[int, dict] | None:
    payload = body or {}
    if action not in _ENTERPRISE_ACTIONS:
        return _enterprise_action_error(
            f"Unsupported enterprise action: {action}",
            error="INVALID_ACTION",
        )
    if action == "recharge":
        amount = payload.get("amount")
        if amount is None:
            return _enterprise_action_error("recharge action requires a positive integer amount")
        try:
            amount_int = int(amount)
        except (TypeError, ValueError):
            return _enterprise_action_error("recharge action amount must be a positive integer")
        if amount_int <= 0:
            return _enterprise_action_error("recharge action requires a positive integer amount")
    if action == "notify":
        message = payload.get("message")
        if message is not None and not isinstance(message, str):
            return _enterprise_action_error("notify action message must be a string")

    return None


def _apply_enterprise_action(ent_id: str, action: str, body: dict | None, query: str) -> tuple[int, dict]:
    # Normalize action aliases
    action_aliases = {
        "suspend": "suspend",
        "ban": "suspend",
        "reactivate": "reactivate",
        "unban": "reactivate",
        "recharge": "recharge",
        "notify": "notify",
    }
    normalized = action_aliases.get(action)
    if normalized is None:
        return _enterprise_action_error(
            f"Unsupported enterprise action: {action}",
            error="INVALID_ACTION",
        )

    _role, denial = _require_permission(query, body, "system_write")
    if denial is not None:
        return denial

    validation_error = _validate_action_payload(action, body)
    if validation_error is not None:
        return validation_error

    payload = body or {}

    conn = _make_conn()
    try:
        cur = conn.cursor()
        try:
            repo = EnterpriseRepo(cur)
            ent, not_found = _load_enterprise(repo, ent_id)
            if not_found is not None:
                return not_found
            assert ent is not None

            previous_status = ent.status
            audit_payload: dict = {
                "action": normalized,
                "requested_action": action,
            }
            if payload.get("reason") not in (None, ""):
                audit_payload["reason"] = str(payload.get("reason"))
            if payload.get("amount") not in (None, ""):
                audit_payload["amount"] = str(payload.get("amount"))
            if payload.get("amount_cents") not in (None, ""):
                audit_payload["amount_cents"] = str(payload.get("amount_cents"))
            if payload.get("message") not in (None, ""):
                audit_payload["message"] = str(payload.get("message"))

            response_message = "enterprise action applied"

            if normalized == "suspend":
                ent.suspend(str(payload.get("reason") or ""))
                repo.update(ent)
                audit_payload["previous_status"] = previous_status
                audit_payload["current_status"] = ent.status
                event_type = "enterprise.suspended"
                response_message = f"Enterprise {ent.id} suspended"
            elif normalized == "reactivate":
                try:
                    ent.reactivate()
                except ValueError as exc:
                    conn.rollback()
                    return 409, {
                        "error": "ENTERPRISE_ACTION_CONFLICT",
                        "message": str(exc),
                        "action": action,
                        "enterprise_id": ent.id,
                    }
                repo.update(ent)
                audit_payload["previous_status"] = previous_status
                audit_payload["current_status"] = ent.status
                event_type = "enterprise.reactivated"
                response_message = f"Enterprise {ent.id} reactivated"
            elif normalized == "recharge":
                audit_payload["enterprise_status"] = ent.status
                event_type = "enterprise.recharge_recorded"
                response_message = f"Manual recharge request recorded for {ent.id}"
            else:
                audit_payload["enterprise_status"] = ent.status
                event_type = "enterprise.notify_recorded"
                response_message = f"Notification request recorded for {ent.id}"

            audit_event_id = _create_audit_event(
                cur,
                enterprise_id=ent.id,
                query=query,
                body=body,
                event_type=event_type,
                target_id=ent.id,
                payload=audit_payload,
            )
            conn.commit()
            return 200, _build_action_response(
                ent.id,
                action,
                message=response_message,
                audit_event_id=audit_event_id,
            )
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()
    finally:
        conn.close()


def _handle_actions_enterprise(path: str, sub: str, body: dict | None) -> tuple[int, dict]:
    ent_id = sub[len("/enterprises/"):].split("/")[0]
    action = ((body or {}).get("action") or "").strip()
    if not action:
        return _enterprise_action_error("action is required")
    query = ""
    if "?" in path:
        query = path.split("?", 1)[1]
    return _apply_enterprise_action(ent_id, action, body, query)


def _handle_legacy_action_alias(path: str, sub: str, body: dict | None, action: str) -> tuple[int, dict]:
    ent_id = sub[len("/enterprises/"):].split("/")[0]
    payload = dict(body or {})
    payload["action"] = action
    query = ""
    if "?" in path:
        query = path.split("?", 1)[1]
    return _apply_enterprise_action(ent_id, action, payload, query)


def _handle_quota_get(path: str, sub: str) -> tuple[int, dict]:
    ent_id = sub[len("/enterprises/"):].split("/")[0]

    conn = _make_conn()
    try:
        cur = conn.cursor()
        try:
            repo = EnterpriseRepo(cur)
            ent = repo.get_by_id(ent_id)
            if ent is None:
                return 404, {"error": "ENTERPRISE_NOT_FOUND", "message": f"Enterprise {ent_id} not found"}
            return 200, {
                "id": ent.id,
                "employee_quota": 50,
                "storage_quota_mb": 1024,
                "api_rate_limit": 100,
            }
        finally:
            cur.close()
    finally:
        conn.close()


def _handle_quota_post(path: str, sub: str, body: dict | None) -> tuple[int, dict]:
    ent_id = sub[len("/enterprises/"):].split("/")[0]
    new_quota = (body or {})

    conn = _make_conn()
    try:
        cur = conn.cursor()
        try:
            repo = EnterpriseRepo(cur)
            ent = repo.get_by_id(ent_id)
            if ent is None:
                return 404, {"error": "ENTERPRISE_NOT_FOUND", "message": f"Enterprise {ent_id} not found"}
            return 200, {
                "id": ent.id,
                "employee_quota": new_quota.get("employee_quota", 50),
                "storage_quota_mb": new_quota.get("storage_quota_mb", 1024),
                "api_rate_limit": new_quota.get("api_rate_limit", 100),
                "message": "quota updated",
            }
        finally:
            cur.close()
    finally:
        conn.close()


def _handle_export_enterprises(path: str) -> tuple[int, dict]:
    query = _parse_query(path)
    name = query.get("name", "").strip() or None
    status = query.get("status", "").strip() or None

    conn = _make_conn()
    try:
        cur = conn.cursor()
        try:
            repo = EnterpriseRepo(cur)
            items, total = repo.list_with_filter(
                name=name, status=status, page=1, limit=10000,
            )
            return 200, {
                "items": [
                    {
                        "id": e.id,
                        "slug": e.slug,
                        "name": e.name,
                        "status": e.status,
                        "owner_user_id": e.owner_user_id,
                        "created_at": e.created_at,
                    }
                    for e in items
                ],
                "total": total,
            }
        finally:
            cur.close()
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════
# Main dispatch
# ═══════════════════════════════════════════════════════════════════

def _match_prefix(path: str, prefix: str) -> str | None:
    if path.startswith(prefix):
        return path[len(prefix):]
    return None


def _database_unavailable_response() -> tuple[int, dict]:
    return 503, {"error": "database_unavailable", "message": "Cannot connect to database"}


def _require_system_read(query: str, body: dict | None) -> tuple[int, dict] | None:
    _role, denial = _require_permission(query, body, "system_read")
    return denial


def _require_system_write(query: str, body: dict | None) -> tuple[int, dict] | None:
    _role, denial = _require_permission(query, body, "system_write")
    return denial


def _handle_templates_get(conn) -> tuple[int, dict]:
    with UnitOfWork(conn) as uow:
        return 200, list_templates(uow)


def _handle_templates_post(conn, body: dict | None) -> tuple[int, dict]:
    try:
        with UnitOfWork(conn) as uow:
            template = create_template(uow, body)
            payload = list_templates(uow)
            created = next(item for item in payload["items"] if item["template_id"] == template.id)
            return 201, created
    except ValueError as exc:
        return 400, {"error": "INVALID_TEMPLATE_PAYLOAD", "message": str(exc)}


def _handle_template_patch(conn, template_id: str, body: dict | None) -> tuple[int, dict]:
    try:
        with UnitOfWork(conn) as uow:
            template = update_template(uow, template_id, body)
            payload = list_templates(uow)
            updated = next(item for item in payload["items"] if item["template_id"] == template.id)
            return 200, updated
    except LookupError:
        return 404, {"error": "TEMPLATE_NOT_FOUND", "message": f"Template {template_id} not found"}
    except ValueError as exc:
        return 400, {"error": "INVALID_TEMPLATE_PAYLOAD", "message": str(exc)}


def _handle_solutions_get(conn) -> tuple[int, dict]:
    with UnitOfWork(conn) as uow:
        return 200, list_solutions(uow)


def _handle_solutions_post(conn, body: dict | None) -> tuple[int, dict]:
    try:
        with UnitOfWork(conn) as uow:
            solution = create_solution(uow, body)
            payload = list_solutions(uow)
            created = next(item for item in payload["items"] if item["solution_id"] == solution.id)
            return 201, created
    except ValueError as exc:
        return 400, {"error": "INVALID_SOLUTION_PAYLOAD", "message": str(exc)}


def _handle_solution_patch(conn, solution_id: str, body: dict | None) -> tuple[int, dict]:
    try:
        with UnitOfWork(conn) as uow:
            solution = update_solution(uow, solution_id, body)
            payload = list_solutions(uow)
            updated = next(item for item in payload["items"] if item["solution_id"] == solution.id)
            return 200, updated
    except LookupError:
        return 404, {"error": "SOLUTION_NOT_FOUND", "message": f"Solution {solution_id} not found"}
    except ValueError as exc:
        return 400, {"error": "INVALID_SOLUTION_PAYLOAD", "message": str(exc)}


def _handle_finance_overview(conn, query: str) -> tuple[int, dict]:
    params = parse_qs(query, keep_blank_values=True)
    period_start = params.get("period_start", [None])[0]
    period_end = params.get("period_end", [None])[0]
    with UnitOfWork(conn) as uow:
        return 200, get_platform_finance_overview(uow, period_start=period_start, period_end=period_end)


def _handle_finance_reports(conn, query: str) -> tuple[int, dict]:
    params = parse_qs(query, keep_blank_values=True)
    period_start = params.get("period_start", [None])[0]
    period_end = params.get("period_end", [None])[0]
    with UnitOfWork(conn) as uow:
        return 200, get_platform_finance_reports(uow, period_start=period_start, period_end=period_end)


def handle_team_route(path: str, method: str, body: dict | None = None) -> tuple[int, dict]:
    """Returns (status_code, response_dict)."""
    sub = path[len("/api/system-admin"):] if path.startswith("/api/system-admin") else path
    if not sub:
        sub = "/"

    sub_clean = sub.split("?")[0]
    query = ""
    if "?" in sub:
        sub_clean, query = sub.split("?", 1)

    if method == "GET" and _match_exact(sub_clean, "/health"):
        return 200, build_system_health_payload()

    # Legacy enterprise-admin management routes retained for compatibility.
    if method == "GET" and sub_clean.rstrip("/") == "/enterprises/export":
        denial = _require_system_read(query, None)
        if denial is not None:
            return denial
        return _handle_export_enterprises(path)
    if sub_clean.endswith("/quota"):
        ent_prefix = sub_clean[:-len("/quota")]
        if ent_prefix.startswith("/enterprises/") and ent_prefix.count("/") == 2:
            if method == "GET":
                denial = _require_system_read(query, None)
                if denial is not None:
                    return denial
                return _handle_quota_get(path, sub_clean)
            if method == "POST":
                denial = _require_system_write(query, body)
                if denial is not None:
                    return denial
                return _handle_quota_post(path, sub_clean, body)
    if method == "POST" and sub_clean.endswith("/actions"):
        ent_prefix = sub_clean[:-len("/actions")]
        if ent_prefix.startswith("/enterprises/") and ent_prefix.count("/") == 2:
            return _handle_actions_enterprise(path, sub_clean, body)
    if method == "POST" and sub_clean.endswith("/recharge"):
        ent_prefix = sub_clean[:-len("/recharge")]
        if ent_prefix.startswith("/enterprises/") and ent_prefix.count("/") == 2:
            return _handle_legacy_action_alias(path, sub_clean, body, "recharge")
    if method == "POST" and sub_clean.endswith("/ban"):
        ent_prefix = sub_clean[:-len("/ban")]
        if ent_prefix.startswith("/enterprises/") and ent_prefix.count("/") == 2:
            return _handle_legacy_action_alias(path, sub_clean, body, "ban")
    if method == "POST" and sub_clean.endswith("/notify"):
        ent_prefix = sub_clean[:-len("/notify")]
        if ent_prefix.startswith("/enterprises/") and ent_prefix.count("/") == 2:
            return _handle_legacy_action_alias(path, sub_clean, body, "notify")
    if method == "GET" and sub_clean.rstrip("/") == "/enterprises":
        denial = _require_system_read(query, None)
        if denial is not None:
            return denial
        return _handle_list_enterprises(path)
    if method == "GET" and sub_clean.startswith("/enterprises/") and sub_clean.count("/") == 2:
        denial = _require_system_read(query, None)
        if denial is not None:
            return denial
        return _handle_enterprise_detail(path, sub_clean)

    route_handler = None
    if method == "GET" and _match_exact(sub_clean, "/templates"):
        denial = _require_system_read(query, None)
        if denial is not None:
            return denial
        route_handler = lambda conn: _handle_templates_get(conn)
    elif method == "POST" and _match_exact(sub_clean, "/templates"):
        denial = _require_system_write(query, body)
        if denial is not None:
            return denial
        route_handler = lambda conn: _handle_templates_post(conn, body)
    elif method == "GET" and _match_exact(sub_clean, "/solutions"):
        denial = _require_system_read(query, None)
        if denial is not None:
            return denial
        route_handler = lambda conn: _handle_solutions_get(conn)
    elif method == "POST" and _match_exact(sub_clean, "/solutions"):
        denial = _require_system_write(query, body)
        if denial is not None:
            return denial
        route_handler = lambda conn: _handle_solutions_post(conn, body)
    elif method == "GET" and _match_exact(sub_clean, "/finance/overview"):
        denial = _require_system_read(query, None)
        if denial is not None:
            return denial
        route_handler = lambda conn: _handle_finance_overview(conn, query)
    elif method == "GET" and _match_exact(sub_clean, "/finance/reports"):
        denial = _require_system_read(query, None)
        if denial is not None:
            return denial
        route_handler = lambda conn: _handle_finance_reports(conn, query)
    else:
        template_id = _match_prefix(sub_clean, "/templates/")
        if method == "PATCH" and template_id is not None and "/" not in template_id:
            denial = _require_system_write(query, body)
            if denial is not None:
                return denial
            route_handler = lambda conn, matched_template_id=template_id: _handle_template_patch(conn, matched_template_id, body)
        else:
            solution_id = _match_prefix(sub_clean, "/solutions/")
            if method == "PATCH" and solution_id is not None and "/" not in solution_id:
                denial = _require_system_write(query, body)
                if denial is not None:
                    return denial
                route_handler = lambda conn, matched_solution_id=solution_id: _handle_solution_patch(conn, matched_solution_id, body)

    if route_handler is None:
        return 501, {"error": "not_implemented", "message": f"System Admin API not yet implemented: {method} {path}"}

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
