"""Permission service — role-based access control.

Enterprise roles and system roles are separate per the shared contract (§8).
System roles do NOT inherit enterprise-side permissions.
"""

from team_panel.domain.enums import EnterpriseRole, SystemRole

_ROLE_PERMISSIONS = {
    EnterpriseRole.OWNER: {
        "manage_enterprise",
        "manage_employees",
        "view_billing",
        "manage_connectors",
        "view_all_conversations",
    },
    EnterpriseRole.ENTERPRISE_ADMIN: {
        "manage_employees",
        "manage_connectors",
        "view_all_conversations",
    },
    EnterpriseRole.FINANCE_ADMIN: {
        "view_billing",
        "export_data",
    },
    EnterpriseRole.MEMBER: {
        "view_own_conversations",
        "send_message",
    },
    SystemRole.SYSTEM_ADMIN: {
        "system_read",
        "system_write",
    },
    SystemRole.SYSTEM_OPERATOR: {
        "system_read",
    },
}


def check_permission(role: str, action: str) -> tuple:
    """Check whether *role* is allowed to perform *action*.

    Returns (allowed: bool, reason: str).
    Denials are never raised as exceptions — the caller decides how to handle them.
    """
    if not role:
        return False, "role is required"
    if not action:
        return False, "action is required"

    enterprise_role = _resolve_enum(EnterpriseRole, role)
    system_role = _resolve_enum(SystemRole, role)

    allowed_actions = set()
    if enterprise_role is not None:
        allowed_actions.update(_ROLE_PERMISSIONS.get(enterprise_role, set()))
    if system_role is not None:
        allowed_actions.update(_ROLE_PERMISSIONS.get(system_role, set()))

    if not allowed_actions:
        return False, f"unknown role '{role}'"

    if action in allowed_actions:
        return True, ""
    return False, f"role '{role}' lacks permission '{action}'"


def _resolve_enum(enum_cls, value: str):
    try:
        return enum_cls(value)
    except (ValueError, TypeError):
        return None
