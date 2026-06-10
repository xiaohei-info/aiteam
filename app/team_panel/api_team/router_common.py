from __future__ import annotations

from urllib.parse import parse_qs

from ..application.policies.permission_service import check_permission


def _request_params(query: str, body: dict | None = None) -> dict:
    params = {key: values[0] for key, values in parse_qs(query, keep_blank_values=True).items() if values}
    if isinstance(body, dict):
        for key in (
            "role",
            "actor_role",
            "enterprise_role",
            "system_role",
            "actor_id",
            "request_id",
            "period_start",
            "period_end",
            "employee_id",
            "target_type",
            "target_id",
            "limit",
            "format",
        ):
            value = body.get(key)
            if value not in (None, ""):
                params[key] = value
    return params


def _request_role(query: str, body: dict | None = None) -> str:
    params = _request_params(query, body)
    for key in ("actor_role", "role", "enterprise_role", "system_role"):
        value = params.get(key)
        if value:
            return str(value)
    return "owner"


def _request_actor_id(query: str, body: dict | None = None) -> str:
    params = _request_params(query, body)
    for key in ("actor_id", "user_id", "requester_id"):
        value = params.get(key)
        if value:
            return str(value)
    return "governance_api"


def _forbidden(role: str, action: str, reason: str) -> tuple[int, dict]:
    return 403, {
        "error": "FORBIDDEN",
        "message": reason,
        "required_action": action,
        "role": role or "",
    }


def _require_permission(query: str, body: dict | None, action: str) -> tuple[str | None, tuple[int, dict] | None]:
    role = _request_role(query, body)
    allowed, reason = check_permission(role, action)
    if not allowed:
        return None, _forbidden(role, action, reason)
    return role, None
