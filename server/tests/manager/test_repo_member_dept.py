"""repository_member.py branch coverage (issue #234, target >=90%).

Exercises MemberDeptRepository + GrantRepository and module helpers against
FakeRouter canned results, covering insert/get/list/update/delete branches,
None (not-found) paths, department_exists, validate_resource_type edge cases.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from manager_service.repository_member import (
    DepartmentRow,
    GrantRepository,
    GrantRow,
    MemberDeptRepository,
    MemberRow,
    validate_resource_type,
    _sa,
    _s,
)
from shared.errors import ValidationProblem

from ._fake_router import FakeCursor, FakeRouter, ctx


def _dept_row(uid="d-1", slug="eng", name="Engineering", created=None):
    return (uid, slug, name, created or datetime(2026, 1, 1))


def _member_row(uid="m-1", name="Alice", status="active", roles=None, dept_ids=None):
    return (uid, name, status, roles or ["member"], dept_ids or ["d-1"])


def _grant_row(gid="g-1", rtype="expert", rid="e-1", dept_ids=None, mem_ids=None, updated=None):
    return (gid, rtype, rid, dept_ids or ["d-1"], mem_ids or ["m-1"], updated)


class TestCreateDepartment:
    def test_returns_department_row(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_dept_row()))
        repo = MemberDeptRepository(router)

        row = repo.create_department(ctx(), department_slug="eng", display_name="Engineering")

        assert isinstance(row, DepartmentRow)
        assert row.id == "d-1"
        assert row.department_slug == "eng"
        assert row.display_name == "Engineering"
        assert row.created_at == datetime(2026, 1, 1)


class TestGetDepartment:
    def test_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_dept_row()))
        row = MemberDeptRepository(router).get_department(ctx(), department_id="d-1")
        assert row is not None
        assert row.id == "d-1"

    def test_not_found_returns_none(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=None))
        row = MemberDeptRepository(router).get_department(ctx(), department_id="missing")
        assert row is None


class TestListDepartments:
    def test_returns_list(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchall=[_dept_row("d-1"), _dept_row("d-2", slug="ops")]))
        rows = MemberDeptRepository(router).list_departments(ctx())
        assert len(rows) == 2
        assert rows[0].id == "d-1"
        assert rows[1].department_slug == "ops"

    def test_empty_list(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchall=[]))
        rows = MemberDeptRepository(router).list_departments(ctx())
        assert rows == []


class TestUpdateDepartment:
    def test_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_dept_row(name="Updated")))
        row = MemberDeptRepository(router).update_department(ctx(), department_id="d-1", display_name="Updated")
        assert row is not None
        assert row.display_name == "Updated"

    def test_not_found_returns_none(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=None))
        row = MemberDeptRepository(router).update_department(ctx(), department_id="x", display_name="Y")
        assert row is None


class TestDeleteDepartment:
    def test_deleted_returns_true_and_clears_denormalized_assignments(self):
        router = FakeRouter()
        router.queue_many(FakeCursor(), FakeCursor(), FakeCursor(), FakeCursor(), FakeCursor(rowcount=1))
        assert MemberDeptRepository(router).delete_department(ctx(), department_id="d-1") is True
        assert len(router.executed) == 5
        assert all("department_ids" in sql for sql, _ in router.executed[:3])
        assert "knowledge_space_binding" in router.executed[3][0]

    def test_not_found_returns_false(self):
        router = FakeRouter()
        router.queue_many(FakeCursor(), FakeCursor(), FakeCursor(), FakeCursor(), FakeCursor(rowcount=0))
        assert MemberDeptRepository(router).delete_department(ctx(), department_id="x") is False


class TestDepartmentExists:
    def test_exists_true(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_dept_row()))
        assert MemberDeptRepository(router).department_exists(ctx(), department_id="d-1") is True

    def test_exists_false(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=None))
        assert MemberDeptRepository(router).department_exists(ctx(), department_id="x") is False


class TestListMembers:
    def test_returns_member_rows(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchall=[_member_row(), _member_row("m-2", name="Bob")]))
        rows = MemberDeptRepository(router).list_members(ctx())
        assert len(rows) == 2
        assert rows[0].id == "m-1"
        assert rows[1].display_name == "Bob"

    def test_empty(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchall=[]))
        assert MemberDeptRepository(router).list_members(ctx()) == []


class TestGetMember:
    def test_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_member_row()))
        row = MemberDeptRepository(router).get_member(ctx(), member_id="m-1")
        assert row is not None
        assert row.roles == ["member"]
        assert row.department_ids == ["d-1"]

    def test_not_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=None))
        assert MemberDeptRepository(router).get_member(ctx(), member_id="x") is None


class TestUpdateMember:
    def test_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_member_row(name="Updated", roles=["owner"])))
        row = MemberDeptRepository(router).update_member(
            ctx(), member_id="m-1", display_name=None, roles=["owner"], department_ids=None, status=None
        )
        assert row is not None
        assert row.display_name == "Updated"
        assert row.roles == ["owner"]

    def test_not_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=None))
        row = MemberDeptRepository(router).update_member(
            ctx(), member_id="x", display_name=None, roles=None, department_ids=None, status=None
        )
        assert row is None


class TestDeleteMember:
    def test_deleted(self):
        router = FakeRouter()
        router.queue(FakeCursor(rowcount=1))
        assert MemberDeptRepository(router).delete_member(ctx(), member_id="m-1") is True

    def test_not_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(rowcount=0))
        assert MemberDeptRepository(router).delete_member(ctx(), member_id="x") is False


class TestGrantUpsert:
    def test_returns_grant_row(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_grant_row()))
        row = GrantRepository(router).upsert(
            ctx(), resource_type="expert", resource_id="e-1",
            department_ids=["d-1"], member_ids=["m-1"],
        )
        assert isinstance(row, GrantRow)
        assert row.resource_type == "expert"
        assert row.resource_id == "e-1"


class TestGrantListAll:
    def test_returns_list(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchall=[_grant_row("g-1"), _grant_row("g-2")]))
        rows = GrantRepository(router).list_all(ctx())
        assert len(rows) == 2

    def test_empty(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchall=[]))
        assert GrantRepository(router).list_all(ctx()) == []


class TestGrantListByResource:
    def test_returns_list(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchall=[_grant_row()]))
        rows = GrantRepository(router).list_by_resource(ctx(), resource_type="expert", resource_id="e-1")
        assert len(rows) == 1
        assert rows[0].resource_id == "e-1"

    def test_empty(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchall=[]))
        assert GrantRepository(router).list_by_resource(ctx(), resource_type="expert", resource_id="x") == []


class TestGrantGet:
    def test_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_grant_row()))
        assert GrantRepository(router).get(ctx(), grant_id="g-1") is not None

    def test_not_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=None))
        assert GrantRepository(router).get(ctx(), grant_id="x") is None


class TestGrantUpdate:
    def test_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=_grant_row(mem_ids=["m-2"])))
        row = GrantRepository(router).update(ctx(), grant_id="g-1", department_ids=["d-1"], member_ids=["m-2"])
        assert row is not None
        assert row.member_ids == ["m-2"]

    def test_not_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(fetchone=None))
        row = GrantRepository(router).update(ctx(), grant_id="x", department_ids=[], member_ids=[])
        assert row is None


class TestGrantDelete:
    def test_deleted(self):
        router = FakeRouter()
        router.queue(FakeCursor(rowcount=1))
        assert GrantRepository(router).delete(ctx(), grant_id="g-1") is True

    def test_not_found(self):
        router = FakeRouter()
        router.queue(FakeCursor(rowcount=0))
        assert GrantRepository(router).delete(ctx(), grant_id="x") is False


class TestValidateResourceType:
    def test_valid_expert(self):
        validate_resource_type("expert")

    def test_valid_solution(self):
        validate_resource_type("solution")

    def test_invalid_raises(self):
        with pytest.raises(ValidationProblem):
            validate_resource_type("workspace")


class TestStringHelpers:
    def test_s_converts_uuid(self):
        class _U:
            def __str__(self):
                return "uuid-str"

        assert _s(_U()) == "uuid-str"

    def test_sa_handles_none(self):
        assert _sa(None) == []

    def test_sa_converts_list_with_uuid(self):
        class _U:
            def __str__(self):
                return "u1"

        assert _sa([_U()]) == ["u1"]


class TestRowDataclassFields:
    def test_department_row_defaults(self):
        dept = DepartmentRow(id="d-1", department_slug="eng", display_name="x")
        assert dept.created_at is None

    def test_member_row(self):
        member = MemberRow(id="m-1", display_name="A", status="active", roles=[], department_ids=[])
        assert member.roles == []

    def test_grant_row_defaults(self):
        grant = GrantRow(id="g-1", resource_type="expert", resource_id="e-1", department_ids=[], member_ids=[])
        assert grant.updated_at is None
