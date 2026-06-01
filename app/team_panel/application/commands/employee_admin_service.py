"""Employee admin service — lifecycle transitions.

activate / pause / archive with audit event recording.
"""

import json
import uuid

from ...domain.entities import AuditEvent


def _create_audit(uow, *, enterprise_id: str, actor_id: str, actor_type: str,
                  event_type: str, target_type: str, target_id: str,
                  payload: dict | None = None) -> AuditEvent:
    """Create an audit event record and return it."""
    event = AuditEvent(
        id=f"ae_{uuid.uuid4().hex[:12]}",
        enterprise_id=enterprise_id,
        actor_type=actor_type,
        actor_id=actor_id,
        event_type=event_type,
        target_type=target_type,
        target_id=target_id,
        payload_json=json.dumps(payload or {}, ensure_ascii=False),
    )
    uow.audit_events().create(event)
    return event


def activate_employee(uow, employee_id: str, actor_id: str) -> None:
    """Activate an employee — transitions to active if currently draft or provisioning."""
    emp = uow.employees().get_by_id(employee_id)
    if emp is None:
        raise ValueError(f"Employee {employee_id} not found")
    from_status = emp.status
    emp.activate()
    uow.employees().update_status(emp)
    _create_audit(
        uow, enterprise_id=emp.enterprise_id, actor_id=actor_id,
        actor_type="user", event_type="employee.activate",
        target_type="employee", target_id=employee_id,
        payload={"from_status": from_status, "to_status": emp.status},
    )


def pause_employee(uow, employee_id: str, actor_id: str) -> None:
    """Pause an active employee — retain config, block new runs."""
    emp = uow.employees().get_by_id(employee_id)
    if emp is None:
        raise ValueError(f"Employee {employee_id} not found")
    from_status = emp.status
    emp.pause()
    uow.employees().update_status(emp)
    _create_audit(
        uow, enterprise_id=emp.enterprise_id, actor_id=actor_id,
        actor_type="user", event_type="employee.pause",
        target_type="employee", target_id=employee_id,
        payload={"from_status": from_status, "to_status": emp.status},
    )


def archive_employee(uow, employee_id: str, actor_id: str) -> None:
    """Archive an employee — terminal state for historical trace only."""
    emp = uow.employees().get_by_id(employee_id)
    if emp is None:
        raise ValueError(f"Employee {employee_id} not found")
    from_status = emp.status
    emp.archive()
    uow.employees().update_status(emp)
    _create_audit(
        uow, enterprise_id=emp.enterprise_id, actor_id=actor_id,
        actor_type="user", event_type="employee.archive",
        target_type="employee", target_id=employee_id,
        payload={"from_status": from_status, "to_status": emp.status},
    )
