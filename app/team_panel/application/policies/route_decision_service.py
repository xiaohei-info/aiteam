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
        if mentioned:
            return RouteDecision(
                route_mode="single_agent",
                target_employee_ids=(mentioned[0],),
            )
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
            target_employee_ids=(mentioned[0],),
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
    """Resolve @mentions in text to a de-duplicated, order-preserving list of employee_ids.

    Two matching layers, both strict about the ``@`` prefix so that email-like
    tokens (``foo@bar.com``) never produce a spurious mention:

    1. **Handle-tokenization** with the same character set as
       ``server/agent_service/mainline/mentions.py`` — ``@<word>`` where word is
       ``[A-Za-z0-9_-]+`` and preceded by a non-word, non-``@`` char (line start ok).
       The handle is compared (case-insensitively, whitespace-tolerantly) against
       member aliases (employee_id / display_name / role_name / profile_name).
    2. **Literal alias check** for multi-byte aliases (e.g. CJK display names like
       ``张三``) where the handle tokenizer's ASCII-only class wouldn't fire: if
       ``@{normalized_alias}`` occurs verbatim in the normalized message, the alias
       is considered mentioned.

    Email-like text such as ``foo@bar.com`` is safe under both layers: layer 1 rejects
    it via the lookbehind (``foo`` precedes the ``@``), and layer 2 requires the
    normalized alias to appear as ``@foo`` — which it does not.
    """
    normalized_text = _normalize_text(text)
    roster: dict[str, str] = {}
    literal_aliases: list[tuple[str, str]] = []
    for member in members:
        employee_id = member["employee_id"]
        if not employee_id:
            continue
        for alias in (
            member.get("employee_id", ""),
            member.get("display_name", ""),
            member.get("role_name", ""),
            member.get("profile_name", ""),
        ):
            token = _normalize_text(alias)
            if token:
                roster.setdefault(token, employee_id)
                literal_aliases.append((token, employee_id))

    mentioned: list[str] = []
    seen: set[str] = set()

    # Layer 1: canonical ASCII-tokenized handles.
    for handle in _parse_handles(text):
        employee_id = roster.get(_normalize_text(handle))
        if employee_id is not None and employee_id not in seen:
            seen.add(employee_id)
            mentioned.append(employee_id)

    # Layer 2: literal multi-byte aliases (e.g. CJK names) scanned verbatim
    # with the @-prefix — deliberately substring-only on `@{alias}` (never bare
    # `alias in text`, which is what used to cause foo@bar.com matches).
    if not mentioned:
        for token, employee_id in literal_aliases:
            if employee_id in seen:
                continue
            if f"@{token}" in normalized_text:
                seen.add(employee_id)
                mentioned.append(employee_id)

    return mentioned


_MENTION_RE = re.compile(r"(?<![A-Za-z0-9_@])@([A-Za-z0-9_-]+)")


def _parse_handles(text: str) -> list[str]:
    """Pull @handle tokens out of a message, preserving first-seen order and de-duping."""
    seen: dict[str, None] = {}
    for m in _MENTION_RE.finditer(text):
        seen.setdefault(m.group(1), None)
    return list(seen)


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
