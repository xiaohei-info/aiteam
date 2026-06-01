"""Employee admin view service — employee detail view (stub)."""

from __future__ import annotations

from ...transactions.uow import UnitOfWork
from ...views.schemas import EmployeeAdminView


def get_employee_admin_view(
    uow: UnitOfWork, employee_id: str
) -> EmployeeAdminView | None:
    """Build employee admin detail view (stub).

    V1: returns basic employee fields. Full binding/job/run summary in Layer3+.
    """
    emp = uow.employees().get_by_id(employee_id)
    if emp is None:
        return None
    return EmployeeAdminView(
        employee_id=emp.id,
        display_name=emp.display_name,
        status=emp.status,
        role_name=emp.role_name,
        model_provider=emp.model_provider,
        model_name=emp.model_name,
    )
