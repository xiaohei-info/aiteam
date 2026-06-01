"""Team Panel — /api/enterprise-admin/* router."""
from __future__ import annotations

from dataclasses import asdict
from urllib.parse import parse_qs

from ..application.queries.billing_view_service import get_billing_view
from ..repositories.employee_repo import EmployeeRepo
from ..repositories.enterprise_repo import EnterpriseRepo
from ..transactions.db import create_connection
from ..transactions.uow import UnitOfWork


def _make_conn():
    return create_connection()


def _match_exact(path: str, target: str) -> bool:
    return path == target or path.rstrip("/") == target


def _handle_employees(conn) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 200, {"employees": [], "total": 0, "enterprise": None}
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
        }
    finally:
        cur.close()


def _handle_billing_usage(conn, query: str) -> tuple[int, dict]:
    cur = conn.cursor()
    try:
        enterprises = EnterpriseRepo(cur).list_all()
        enterprise = enterprises[0] if enterprises else None
    finally:
        cur.close()
    conn.rollback()

    params = parse_qs(query, keep_blank_values=True)
    period_start = params.get("period_start", [None])[0] or "2000-01-01"
    period_end = params.get("period_end", [None])[0] or "2099-12-31"

    if enterprise is None:
        return 200, {
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
    return 200, asdict(view)


def _database_unavailable_response() -> tuple[int, dict]:
    return 503, {"error": "database_unavailable", "message": "Cannot connect to database"}


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
            return _handle_employees(conn)
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
