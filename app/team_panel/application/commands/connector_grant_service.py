"""Connector grant service — grant/revoke enterprise connectors to employees.

grant_connector requires connector.status='online' and creates an
EmployeeConnectorBinding.  revoke_connector performs a soft delete.
"""

import uuid

from ...domain.entities import EmployeeConnectorBinding


def grant_connector(uow, enterprise_id: str, employee_id: str,
                    connector_id: str, access_mode: str = "invoke") -> str:
    """Create an employee_connector_binding.  Returns binding_id.

    Raises:
        ValueError: connector not found, not online, or employee not found.
    """
    # ── Validate connector ─────────────────────────────────────────
    connector = uow.enterprise_connectors().get_by_id(connector_id)
    if connector is None:
        raise ValueError(f"EnterpriseConnector {connector_id} not found")
    if connector.status != "online":
        raise ValueError(
            f"EnterpriseConnector {connector_id} is {connector.status}, must be online"
        )
    if connector.enterprise_id != enterprise_id:
        raise ValueError(
            f"EnterpriseConnector {connector_id} belongs to "
            f"{connector.enterprise_id}, not {enterprise_id}"
        )

    # ── Validate employee ──────────────────────────────────────────
    emp = uow.employees().get_by_id(employee_id)
    if emp is None:
        raise ValueError(f"Employee {employee_id} not found")
    if emp.enterprise_id != enterprise_id:
        raise ValueError(
            f"Employee {employee_id} belongs to {emp.enterprise_id}, not {enterprise_id}"
        )

    # ── Create binding ─────────────────────────────────────────────
    binding_id = f"cb_{uuid.uuid4().hex[:12]}"
    binding = EmployeeConnectorBinding(
        id=binding_id,
        enterprise_id=enterprise_id,
        employee_id=employee_id,
        connector_id=connector_id,
        enabled=True,
        access_mode=access_mode,
    )
    uow.employee_connector_bindings().create(binding)
    return binding_id


def revoke_connector(uow, binding_id: str) -> None:
    """Soft-delete an employee_connector_binding.

    Raises:
        ValueError: binding not found.
    """
    binding = uow.employee_connector_bindings().get_by_id(binding_id)
    if binding is None:
        raise ValueError(f"EmployeeConnectorBinding {binding_id} not found")
    uow.employee_connector_bindings().delete(binding_id)
