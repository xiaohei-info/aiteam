"""Route decision — determines single_agent vs orchestration for group messages."""

from __future__ import annotations

import re

from team_panel.domain.value_objects import RouteDecision


def decide_route(
    message_text: str,
    available_members: list,
    route_hint: str = "auto",
) -> RouteDecision:
    """Return a RouteDecision value object.

    ``available_members`` may be either:
    - ``list[str]`` of employee ids, or
    - ``list[dict]`` with ``employee_id`` plus optional aliases such as
      ``display_name`` / ``role_name`` / ``profile_name``.
    """
    members = [_normalize_member(member) for member in available_members]
    employee_ids = [member["employee_id"] for member in members if member["employee_id"]]
    if not employee_ids:
        return RouteDecision(route_mode="single_agent")

    mentioned = _extract_mentions(message_text, members)
    planner_employee_id = _pick_planner_employee_id(members, mentioned or employee_ids)

    if route_hint == "orchestration":
        target_employee_ids = _non_system_planner_employee_ids(members)
        if not target_employee_ids:
            target_employee_ids = employee_ids
        return RouteDecision(
            route_mode="orchestration",
            target_employee_ids=tuple(target_employee_ids),
            planner_employee_id=planner_employee_id,
        )

    if route_hint == "single_agent":
        target_id = mentioned[0] if mentioned else employee_ids[0]
        return RouteDecision(
            route_mode="single_agent",
            target_employee_ids=(),
        )

    if len(mentioned) > 1:
        return RouteDecision(
            route_mode="orchestration",
            target_employee_ids=tuple(mentioned),
            planner_employee_id=_pick_planner_employee_id(members, mentioned),
        )

    if len(mentioned) == 1:
        return RouteDecision(
            route_mode="single_agent",
            target_employee_ids=(),
        )

    if _looks_like_collaboration_request(message_text):
        target_employee_ids = _non_system_planner_employee_ids(members)
        if not _has_system_planner(members):
            target_employee_ids = employee_ids
        return RouteDecision(
            route_mode="orchestration",
            target_employee_ids=tuple(target_employee_ids),
            planner_employee_id=planner_employee_id,
        )

    non_planner_employee_ids = _non_system_planner_employee_ids(members)
    if _has_system_planner(members) and len(non_planner_employee_ids) > 1:
        return RouteDecision(
            route_mode="orchestration",
            target_employee_ids=tuple(non_planner_employee_ids),
            planner_employee_id=planner_employee_id,
        )

    return RouteDecision(
        route_mode="single_agent",
        target_employee_ids=(),
    )


def _normalize_member(member) -> dict[str, str]:
    if isinstance(member, str):
        return {
            "employee_id": member,
            "display_name": "",
            "role_name": "",
            "profile_name": "",
            "is_system_planner": False,
        }
    if isinstance(member, dict):
        return {
            "employee_id": str(member.get("employee_id") or member.get("member_ref_id") or ""),
            "display_name": str(member.get("display_name") or ""),
            "role_name": str(member.get("role_name") or ""),
            "profile_name": str(member.get("profile_name") or ""),
            "is_system_planner": _coerce_bool(member.get("is_system_planner")),
        }
    raise TypeError(f"Unsupported member descriptor: {type(member)!r}")


def _extract_mentions(text: str, members: list[dict[str, str]]) -> list[str]:
    normalized_text = _normalize_text(text)
    mentioned: list[str] = []
    for member in members:
        employee_id = member["employee_id"]
        if not employee_id:
            continue
        aliases = {
            employee_id,
            member.get("display_name", ""),
            member.get("role_name", ""),
            member.get("profile_name", ""),
        }
        for alias in aliases:
            token = _normalize_text(alias)
            if not token:
                continue
            if f"@{token}" in normalized_text or token in normalized_text:
                mentioned.append(employee_id)
                break
    return list(dict.fromkeys(mentioned))


def _looks_like_collaboration_request(text: str) -> bool:
    normalized = _normalize_text(text)
    keywords = (
        "一起", "协作", "分工", "汇总", "对比", "复盘", "方案", "调研", "报告",
        "collaborate", "together", "compare", "research", "summarize", "plan",
    )
    return any(keyword in normalized for keyword in keywords)


def _pick_planner_employee_id(members: list[dict[str, str]], candidate_ids: list[str]) -> str:
    planner_keywords = ("planner", "orchestrator", "协调", "规划")

    def _matches(member: dict[str, str]) -> bool:
        haystack = " ".join(
            [member.get("display_name", ""), member.get("role_name", ""), member.get("profile_name", ""), member.get("employee_id", "")]
        ).lower()
        return any(keyword in haystack for keyword in planner_keywords)

    candidate_set = set(candidate_ids)
    for member in members:
        employee_id = member["employee_id"]
        if employee_id in candidate_set and member.get("is_system_planner"):
            return employee_id
    for member in members:
        if member.get("is_system_planner"):
            return member["employee_id"]
    for member in members:
        employee_id = member["employee_id"]
        if employee_id in candidate_set and _matches(member):
            return employee_id
    for member in members:
        if _matches(member):
            return member["employee_id"]
    return candidate_ids[0] if candidate_ids else ""


def _non_system_planner_employee_ids(members: list[dict[str, str]]) -> list[str]:
    return [
        member["employee_id"]
        for member in members
        if member["employee_id"] and not member.get("is_system_planner")
    ]


def _has_system_planner(members: list[dict[str, str]]) -> bool:
    return any(bool(member.get("is_system_planner")) for member in members)


def _coerce_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "t", "yes", "y"}
    return bool(value)


def _normalize_text(text: str) -> str:
    lowered = str(text or "").strip().lower()
    return re.sub(r"\s+", "", lowered)
