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
                ("dept-a", "sales", "Sales", None),
                ("dept-b", "engineering", "Engineering", None),
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


def test_build_tree_nests_departments_by_parent_and_keeps_employees_under_their_own_department():
    router = FakeRouter()
    router.queue_many(
        FakeCursor(
            fetchall=[
                ("d-root", "a", "总部", None),
                ("d-child", "b", "研发部", "d-root"),
                ("d-orphan", "c", "游离", "d-missing"),
            ]
        ),
        FakeCursor(fetchall=[("emp-1", "alice", "Alice", ["d-child"], None)]),
    )

    tree = OrgService(router).build_tree(ctx())

    assert [c["id"] for c in tree["children"]] == ["d-root", "d-orphan"]
    root = tree["children"][0]
    assert [c["id"] for c in root["children"]] == ["d-child"]
    child = root["children"][0]
    assert child["parent_id"] == "d-root"
    assert [c["id"] for c in child["children"]] == ["emp-1"]
