from __future__ import annotations


def resolve_team_route(sub: str, method: str, query: str, body: dict | None):
    if method == "GET" and (sub == "/connectors" or sub.rstrip("/") == "/connectors"):
        return lambda conn: _handle_connectors_list(conn, sub)

    if method == "POST" and (sub == "/connectors" or sub.rstrip("/") == "/connectors"):
        return lambda conn: _handle_connectors_post(conn, sub, body)

    if sub.startswith("/connectors/") and sub.endswith("/status"):
        connector_id = sub[len("/connectors/"):-len("/status")]
        if method == "GET" and "/" not in connector_id:
            return lambda conn, matched_connector_id=connector_id: _handle_connector_status(conn, sub, matched_connector_id)

    if sub.startswith("/connectors/") and sub.endswith("/test"):
        connector_id = sub[len("/connectors/"):-len("/test")]
        if method == "POST" and "/" not in connector_id:
            return lambda conn, matched_connector_id=connector_id: _handle_connector_test(conn, sub, matched_connector_id)

    if sub.startswith("/connectors/") and sub.endswith("/grants"):
        connector_id = sub[len("/connectors/"):-len("/grants")]
        if method == "PATCH" and "/" not in connector_id:
            return lambda conn, matched_connector_id=connector_id: _handle_connector_grants_patch(conn, sub, matched_connector_id, body)

    if sub.startswith("/connectors/"):
        connector_id = sub[len("/connectors/"):]
        if "/" not in connector_id:
            if method == "GET":
                return lambda conn, matched_connector_id=connector_id: _handle_connector_detail(conn, sub, matched_connector_id)
            if method == "PATCH":
                return lambda conn, matched_connector_id=connector_id: _handle_connector_patch(conn, sub, matched_connector_id, body)

    return None


def _handle_connectors_list(conn, sub: str):
    from . import router_team

    return router_team._handle_connectors_list(conn, sub)


def _handle_connectors_post(conn, sub: str, body: dict | None):
    from . import router_team

    return router_team._handle_connectors_post(conn, sub, body)


def _handle_connector_status(conn, sub: str, connector_id: str):
    from . import router_team

    return router_team._handle_connector_status(conn, sub, connector_id)


def _handle_connector_test(conn, sub: str, connector_id: str):
    from . import router_team

    return router_team._handle_connector_test(conn, sub, connector_id)


def _handle_connector_grants_patch(conn, sub: str, connector_id: str, body: dict | None):
    from . import router_team

    return router_team._handle_connector_grants_patch(conn, sub, connector_id, body)


def _handle_connector_detail(conn, sub: str, connector_id: str):
    from . import router_team

    return router_team._handle_connector_detail(conn, sub, connector_id)


def _handle_connector_patch(conn, sub: str, connector_id: str, body: dict | None):
    from . import router_team

    return router_team._handle_connector_patch(conn, sub, connector_id, body)
