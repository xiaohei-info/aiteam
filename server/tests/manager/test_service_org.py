"""OrgService unit tests for org tree and assignment regressions."""

from __future__ import annotations

import pytest

from manager_service.org_service import OrgService
from shared.errors import NotFound

from ._fake_router import FakeCursor, FakeRouter, ctx


def test_build_tree_assigns_employees_from_employee_department_ids():
    router = FakeRouter()
    router.queue_many(
        FakeCursor(
            fetchall=[
                ("dept-a", "sales", "Sales"),
                ("dept-b", "engineering", "Engineering"),
            ]
        ),
        FakeCursor(
            fetchall=[
                ("emp-1", "alice", "Alice", ["dept-a"]),
                ("emp-2", "bob", "Bob", ["missing-dept"]),
                ("emp-3", "cathy", "Cathy", None),
            ]
        ),
    )

    tree = OrgService(router).build_tree(ctx())

    sales = next(child for child in tree["children"] if child["id"] == "dept-a")
    assert [child["id"] for child in sales["children"]] == ["emp-1"]
    root_employee_ids = [child["id"] for child in tree["children"] if child["type"] == "employee"]
    assert root_employee_ids == ["emp-2", "emp-3"]
    assert all("app_user" not in sql for sql, _ in router.executed)


def test_update_assignment_updates_employee_department_ids():
    router = FakeRouter()
    router.queue_many(
        FakeCursor(fetchone=("dept-a",)),
        FakeCursor(fetchone=("emp-1",)),
        FakeCursor(rowcount=1),
    )

    result = OrgService(router).update_assignment(ctx(), "emp-1", "dept-a")

    assert result == {"assignment_id": "emp-1", "department_id": "dept-a", "updated": True}
    update_sql, params = router.executed[-1]
    assert "UPDATE employee SET department_ids = array_append" in update_sql
    assert "app_user" not in update_sql
    assert params == ("dept-a", "emp-1", "dept-a")


def test_update_assignment_rejects_missing_department():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))

    with pytest.raises(NotFound, match="department not found"):
        OrgService(router).update_assignment(ctx(), "emp-1", "missing")


def test_update_assignment_rejects_missing_employee():
    router = FakeRouter()
    router.queue_many(
        FakeCursor(fetchone=("dept-a",)),
        FakeCursor(fetchone=None),
    )

    with pytest.raises(NotFound, match="employee not found"):
        OrgService(router).update_assignment(ctx(), "missing", "dept-a")
