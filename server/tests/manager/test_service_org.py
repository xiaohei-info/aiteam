"""OrgService unit tests for org tree and assignment regressions."""

from __future__ import annotations

import pytest

from manager_service.org_service import OrgService
from shared.errors import Forbidden, NotFound

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
                ("emp-1", "alice", "Alice", ["dept-a", "dept-b"], "研究分析师"),
                ("emp-2", "bob", "Bob", ["missing-dept"], None),
                ("emp-3", "cathy", "Cathy", None, None),
            ]
        ),
    )

    tree = OrgService(router).build_tree(ctx())

    sales = next(child for child in tree["children"] if child["id"] == "dept-a")
    assert [child["id"] for child in sales["children"]] == ["emp-1"]
    assert sales["children"][0]["parent_id"] == "dept-a"
    assert sales["children"][0]["role_title"] == "研究分析师"
    engineering = next(child for child in tree["children"] if child["id"] == "dept-b")
    assert engineering["children"][0]["role_title"] == "研究分析师"
    assert all(child["type"] == "department" for child in tree["children"])
    unassigned = next(child for child in tree["children"] if child["id"] == "unassigned")
    assert unassigned["name"] == "未设置"
    assert [child["id"] for child in unassigned["children"]] == ["emp-2", "emp-3"]
    assert all(child["parent_id"] == "unassigned" for child in unassigned["children"])
    assert all(child["role_title"] is None for child in unassigned["children"])
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


def test_update_assignment_requires_manager_role():
    router = FakeRouter()
    with pytest.raises(Forbidden, match="organization assignment"):
        OrgService(router).update_assignment(ctx(roles=["member"]), "emp-1", "dept-a")
    assert router.executed == []


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
