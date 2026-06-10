from __future__ import annotations


def resolve_team_route(sub: str, method: str, query: str, body: dict | None):
    if method == "GET" and (sub == "/talent-market/templates" or sub.rstrip("/") == "/talent-market/templates"):
        return lambda conn: _handle_talent_templates(conn, sub)

    if sub.startswith("/talent-market/templates/"):
        template_id = sub[len("/talent-market/templates/"):]
        if method == "GET" and "/" not in template_id:
            return lambda conn, matched_template_id=template_id: _handle_talent_template_detail(conn, sub, matched_template_id)

    if method == "POST" and (sub == "/recruitments" or sub.rstrip("/") == "/recruitments"):
        return lambda conn: _handle_recruitments_post(conn, sub, body)

    if sub.startswith("/solutions/") and sub.endswith("/apply"):
        solution_id = sub[len("/solutions/"):-len("/apply")]
        if method == "POST" and "/" not in solution_id:
            return lambda conn, matched_solution_id=solution_id: _handle_solution_apply_post(conn, sub, matched_solution_id, body)

    if method == "GET" and (sub == "/solutions" or sub.rstrip("/") == "/solutions"):
        return lambda conn: _handle_solutions_list(conn, sub)

    return None


def _handle_talent_templates(conn, sub: str):
    from . import router_team

    return router_team._handle_talent_templates(conn, sub)


def _handle_talent_template_detail(conn, sub: str, template_id: str):
    from . import router_team

    return router_team._handle_talent_template_detail(conn, sub, template_id)


def _handle_recruitments_post(conn, sub: str, body: dict | None):
    from . import router_team

    return router_team._handle_recruitments_post(conn, sub, body)


def _handle_solution_apply_post(conn, sub: str, solution_id: str, body: dict | None):
    from . import router_team

    return router_team._handle_solution_apply_post(conn, sub, solution_id, body)


def _handle_solutions_list(conn, sub: str):
    from . import router_team

    return router_team._handle_solutions_list(conn, sub)
