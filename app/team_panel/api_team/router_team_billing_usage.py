from __future__ import annotations


def resolve_team_route(sub: str, method: str, query: str, body: dict | None):
    if method == "GET" and (sub == "/billing/usage/overview" or sub.rstrip("/") == "/billing/usage/overview"):
        return lambda conn: _handle_billing_usage_overview(conn, query)

    if method == "GET" and (sub == "/billing/usage/records" or sub.rstrip("/") == "/billing/usage/records"):
        return lambda conn: _handle_billing_usage_records(conn, query)

    if method == "GET" and (sub == "/billing/usage/records/export" or sub.rstrip("/") == "/billing/usage/records/export"):
        export_query = f"{query}&format=csv" if query else "format=csv"
        return lambda conn: _handle_billing_usage_records(conn, export_query)

    return None


def _handle_billing_usage_overview(conn, query: str):
    from . import router_team

    return router_team._handle_billing_usage_overview(conn, query)


def _handle_billing_usage_records(conn, query: str):
    from . import router_team

    return router_team._handle_billing_usage_records(conn, query)
