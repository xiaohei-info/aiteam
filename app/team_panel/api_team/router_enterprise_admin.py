"""Team Panel — /api/enterprise-admin/* router."""
from __future__ import annotations

from ..repositories.employee_repo import EmployeeRepo
from ..repositories.enterprise_repo import EnterpriseRepo
from .router_team import (
    _database_unavailable_response,
    _require_permission,
    _billing_usage_overview_payload,
)
from ..transactions.db import create_connection


def _make_conn():
    return create_connection()


def _match_exact(path: str, target: str) -> bool:
    return path == target or path.rstrip("/") == target


def _handle_employees(conn, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "manage_employees")
    if denial is not None:
        return denial
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {"employees": [], "total": 0, "enterprise": None, "effective_role": role}
        employees = EmployeeRepo(cur).list_by_enterprise(enterprise.id)
        return 200, {
            "enterprise": {
                "enterprise_id": enterprise.id,
                "name": enterprise.name,
                "status": enterprise.status,
            },
            "employees": [
                {
                    "employee_id": emp.id,
                    "display_name": emp.display_name,
                    "role_name": emp.role_name,
                    "status": emp.status,
                    "created_from": emp.created_from,
                    "template_id": emp.template_id,
                }
                for emp in employees
            ],
            "total": len(employees),
            "effective_role": role,
        }
    finally:
        cur.close()


def _handle_billing_usage(conn, query: str) -> tuple[int, dict]:
    role, denial = _require_permission(query, None, "view_billing")
    if denial is not None:
        return denial
    payload = _billing_usage_overview_payload(conn, query)
    payload["effective_role"] = role
    payload["deprecated"] = True
    payload["canonical_path"] = "/api/team/billing/usage/overview"
    return 200, payload

def handle_team_route(path: str, method: str, body: dict | None = None) -> tuple[int, dict]:
    """Returns (status_code, response_dict)."""
    sub = path[len("/api/enterprise-admin"):] if path.startswith("/api/enterprise-admin") else path
    if not sub:
        sub = "/"

    query = ""
    if "?" in sub:
        sub, query = sub.split("?", 1)

    if method == "GET" and _match_exact(sub, "/employees"):
        try:
            conn = _make_conn()
        except Exception:
            return _database_unavailable_response()
        try:
            return _handle_employees(conn, query)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    if method == "GET" and _match_exact(sub, "/billing/usage"):
        try:
            conn = _make_conn()
        except Exception:
            return _database_unavailable_response()
        try:
            return _handle_billing_usage(conn, query)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    return 501, {"error": "not_implemented", "message": f"Enterprise Admin API not yet implemented: {method} {path}"}
