"""EmployeeConfigRepository department assignment projection tests."""

from __future__ import annotations

from manager_service.employee_config_repository import EmployeeConfigRepository, _row_to_config

from ._fake_router import FakeCursor, FakeRouter, ctx


def _row(department_ids=None, role_title=None):
    return (
        "emp-1", "expert", "专家", "persona", "model", "provider", "deep", 60,
        [], [], [], [], None, 2, "active", None, None, None, department_ids or [], role_title,
    )


def test_legacy_rows_without_department_ids_default_to_empty():
    assert _row_to_config(_row()[:-2]).department_ids == []
    assert _row_to_config(_row()[:-1]).role_title is None


def test_create_and_update_carry_department_ids():
    router = FakeRouter()
    router.queue_many(FakeCursor(fetchone=_row(["d-1"], "分析师")), FakeCursor(fetchone=("emp-1",)), FakeCursor(fetchone=None), FakeCursor(), FakeCursor(), FakeCursor())
    created = EmployeeConfigRepository(router).create(
        ctx(), employee_slug="expert", display_name="专家", persona="persona",
        model="model", provider_ref="provider", thinking_level="deep",
        timeout_seconds=60, tools=[], skills=[], knowledge_refs=[], connector_refs=[],
        memory_policy=None, department_ids=["d-1"], role_title="分析师",
    )
    assert created.department_ids == ["d-1"]
    insert_sql, insert_params = router.executed[0]
    assert "department_ids" in insert_sql
    assert insert_params[-2:] == (["d-1"], "分析师")
    assert created.role_title == "分析师"
    assert "role_title" in insert_sql

    router.queue_many(FakeCursor(fetchone=("emp-1",)), FakeCursor(fetchone=("emp-1",)), FakeCursor(fetchone=None), FakeCursor(), FakeCursor(), FakeCursor(fetchone=_row(["d-2"])))
    updated = EmployeeConfigRepository(router).update(
        ctx(), employee_id="emp-1", display_name="专家", persona="persona",
        model="model", provider_ref="provider", thinking_level="deep",
        timeout_seconds=60, tools=[], skills=[], knowledge_refs=[], connector_refs=[],
        memory_policy=None, department_ids=["d-2"],
    )
    assert updated is not None
    assert updated.department_ids == ["d-2"]
    update_sql, update_params = router.executed[-1]
    assert "department_ids = %s" in update_sql
    assert update_params[-3:] == (["d-2"], None, "emp-1")
    assert updated.role_title is None
    assert "role_title = %s" in update_sql
