from __future__ import annotations


def test_admin_routers_use_shared_request_helpers():
    import team_panel.api_team.router_common as router_common
    import team_panel.api_team.router_enterprise_admin as router_enterprise_admin
    import team_panel.api_team.router_system_admin as router_system_admin

    assert router_enterprise_admin._require_permission is router_common._require_permission
    assert router_system_admin._require_permission is router_common._require_permission
    assert router_system_admin._request_actor_id is router_common._request_actor_id
    assert router_system_admin._request_role is router_common._request_role


def test_team_router_registers_high_conflict_route_modules():
    import team_panel.api_team.router_team as router_team
    import team_panel.api_team.router_team_billing_usage as billing_usage
    import team_panel.api_team.router_team_connectors as connectors
    import team_panel.api_team.router_team_talent as talent

    assert billing_usage.resolve_team_route("/billing/usage/overview", "GET", "", None) is not None
    assert connectors.resolve_team_route("/connectors", "GET", "", None) is not None
    assert connectors.resolve_team_route("/connectors/conn_123/test", "POST", "", {}) is not None
    assert talent.resolve_team_route("/talent-market/templates", "GET", "", None) is not None
    assert talent.resolve_team_route("/solutions", "GET", "", None) is not None
    assert hasattr(router_team, "handle_team_route")
