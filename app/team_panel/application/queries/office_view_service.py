"""Office view service — office dashboard view (stub)."""

from __future__ import annotations

from ...transactions.uow import UnitOfWork
from ...views.schemas import OfficeView


def get_office_view(uow: UnitOfWork, enterprise_id: str) -> OfficeView:
    """Stub office dashboard view.

    V1: returns minimal aggregates. Full implementation in Layer3+
    will derive busy_employees, pending_tasks from runtime state.
    """
    employees = uow.employees().list_by_enterprise(enterprise_id)
    busy = sum(
        1 for e in employees
        if e.status in ("active", "provisioning")
    )
    return OfficeView(
        enterprise_id=enterprise_id,
        busy_employees=busy,
        pending_tasks=0,
        recent_activity=[],
    )
