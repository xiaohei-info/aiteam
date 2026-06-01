"""Credential resolver — maps capability bindings to provider credentials."""


def resolve_credentials(
    employee_id: str,
    connector_type: str,
    capabilities_json: dict,
) -> dict:
    """Extract provider credentials from employee capabilities.

    Returns {provider, api_key, ...} dict or raises ValueError if the
    requested connector_type is not found.
    """
    conns = capabilities_json.get("connectors", [])
    for c in conns:
        if c.get("type") == connector_type:
            return c.get("credentials", {})
    raise ValueError(
        f"Employee {employee_id} has no '{connector_type}' connector"
    )
