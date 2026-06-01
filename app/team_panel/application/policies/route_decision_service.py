"""Route decision — determines single_agent vs orchestration for group messages.

Uses a simple heuristic: explicit @mentions drive orchestration;
otherwise single_agent.  The returned value conforms to the existing
``RouteDecision`` value object in domain.
"""

from team_panel.domain.value_objects import RouteDecision


def decide_route(
    message_text: str,
    available_employee_ids: list[str],
    route_hint: str = "auto",
) -> RouteDecision:
    """Return a RouteDecision value object.

    - ``route_hint = "orchestration"`` → all available employees are targeted.
    - ``route_hint = "single_agent"`` → single_agent (no planner).
    - ``route_hint = "auto"`` (default) → detects @mentions:
      if >1 employee mentioned → orchestration with those employees;
      otherwise → single_agent.
    """
    if route_hint == "orchestration":
        return RouteDecision(
            route_mode="orchestration",
            target_employee_ids=tuple(available_employee_ids),
        )
    if route_hint == "single_agent":
        return RouteDecision(route_mode="single_agent")

    # auto: detect @mentions
    mentioned = _extract_mentions(message_text, available_employee_ids)
    if len(mentioned) > 1:
        return RouteDecision(
            route_mode="orchestration",
            target_employee_ids=tuple(mentioned),
        )
    return RouteDecision(route_mode="single_agent")


def _extract_mentions(text: str, available: list[str]) -> list[str]:
    """V1 simple substring check — finds employee IDs literally present in text."""
    return [eid for eid in available if eid in text]
