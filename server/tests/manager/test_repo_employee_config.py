"""EmployeeConfigRepository department assignment projection tests."""

from __future__ import annotations

from manager_service.employee_config_repository import EmployeeConfigRepository, _row_to_config

from ._fake_router import FakeCursor, FakeRouter, ctx


def _row(department_ids=None):
    return (
        "emp-1", "expert", "专家", "persona", "model", "provider", "deep", 60,
        [], [], [], [], None, 2, "active", None, None, None, department_ids or [],
    )


def test_legacy_rows_without_department_ids_default_to_empty():
    assert _row_to_config(_row()[:-1]).department_ids == []


def test_create_and_update_carry_department_ids():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_row(["d-1"])))
    created = EmployeeConfigRepository(router).create(
        ctx(), employee_slug="expert", display_name="专家", persona="persona",
        model="model", provider_ref="provider", thinking_level="deep",
        timeout_seconds=60, tools=[], skills=[], knowledge_refs=[], connector_refs=[],
        memory_policy=None, department_ids=["d-1"],
    )
    assert created.department_ids == ["d-1"]
    insert_sql, insert_params = router.executed[0]
    assert "department_ids" in insert_sql
    assert insert_params[-1] == ["d-1"]

    router.queue(FakeCursor(fetchone=_row(["d-2"])))
    updated = EmployeeConfigRepository(router).update(
        ctx(), employee_id="emp-1", display_name="专家", persona="persona",
        model="model", provider_ref="provider", thinking_level="deep",
        timeout_seconds=60, tools=[], skills=[], knowledge_refs=[], connector_refs=[],
        memory_policy=None, department_ids=["d-2"],
    )
    assert updated is not None
    assert updated.department_ids == ["d-2"]
    update_sql, update_params = router.executed[1]
    assert "department_ids = %s" in update_sql
    assert update_params[-2:] == (["d-2"], "emp-1")
