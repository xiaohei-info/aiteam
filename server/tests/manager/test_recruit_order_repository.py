"""recruit_order_repository state-machine + repo branch coverage (AITEAM-243)."""

from __future__ import annotations

from datetime import datetime

import pytest

from manager_service.recruit_order_repository import (
    RecruitmentOrderRow,
    RecruitOrderRepository,
    _row_to_order,
)

from ._fake_router import FakeCursor, FakeRouter, ctx


def _row(
    oid="ro-1", idem="k-1", action="recruit_expert", tpl="t-1", sol=None,
    req="u-1", emp=None, status="pending", ec=None, em=None, ca=None,
):
    return (oid, idem, action, tpl, sol, req, emp, status, ec, em,
            ca or datetime(2026, 1, 1), datetime(2026, 1, 2))


def test_row_to_order_maps_columns():
    r = _row_to_order(_row())
    assert isinstance(r, RecruitmentOrderRow)
    assert r.id == "ro-1"
    assert r.idempotency_key == "k-1"
    assert r.action == "recruit_expert"
    assert r.template_id == "t-1"
    assert r.solution_id is None
    assert r.requested_by == "u-1"
    assert r.created_employee_id is None
    assert r.status == "pending"


def test_row_to_order_nullables():
    r = _row_to_order(_row(req=None, emp=None))
    assert r.requested_by is None
    assert r.created_employee_id is None


def test_create_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_row(oid="c-1", idem="idem-1")))
    row = RecruitOrderRepository(router).create(
        ctx(), idempotency_key="idem-1", action="recruit_expert", template_id="t-1",
    )
    assert isinstance(row, RecruitmentOrderRow)
    assert row.idempotency_key == "idem-1"
    assert row.status == "pending"
    assert "recruitment_order" in router.last_sql


def test_get_found_and_not_found():
    found = FakeRouter()
    found.queue(FakeCursor(fetchone=_row(oid="ro-2")))
    assert RecruitOrderRepository(found).get(ctx(), order_id="ro-2") is not None

    missing = FakeRouter()
    missing.queue(FakeCursor(fetchone=None))
    assert RecruitOrderRepository(missing).get(ctx(), order_id="nope") is None


def test_get_by_idempotency_key():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_row(oid="ro-3", idem="idem-3")))
    repo = RecruitOrderRepository(router)
    row = repo.get_by_idempotency_key(ctx(), idempotency_key="idem-3")
    assert row is not None and row.idempotency_key == "idem-3"

    missing = FakeRouter()
    missing.queue(FakeCursor(fetchone=None))
    assert RecruitOrderRepository(missing).get_by_idempotency_key(ctx(), idempotency_key="x") is None


def test_list_orders_and_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_row(oid="a", idem="a"), _row(oid="b", idem="b", action="apply_solution")]))
    rows = RecruitOrderRepository(router).list_orders(ctx())
    assert len(rows) == 2

    empty = FakeRouter()
    empty.queue(FakeCursor(fetchall=[]))
    assert RecruitOrderRepository(empty).list_orders(ctx()) == []


def test_update_writes_status_and_result():
    created = RecruitmentOrderRow(id="ro-4", idempotency_key="idem-4", action="recruit_expert",
                                   template_id="t", solution_id=None, requested_by=None,
                                   created_employee_id=None, status="pending",
                                   error_code=None, error_message=None,
                                   created_at=datetime(2026, 1, 1), updated_at=None)
    updated = created.start_provisioning().mark_succeeded("emp-9")
    assert updated.status == "succeeded" and updated.created_employee_id == "emp-9"

    write_router = FakeRouter()
    write_router.queue(FakeCursor(fetchone=_row(oid="ro-4", idem="idem-4", emp="emp-9", status="succeeded")))
    saved = RecruitOrderRepository(write_router).update(ctx(), updated)
    assert saved.status == "succeeded" and saved.created_employee_id == "emp-9"


# ---- state machine paths ----

def _mk(status):
    return RecruitmentOrderRow(id="r", idempotency_key="k", action="recruit_expert",
                               template_id="t", solution_id=None, requested_by=None,
                               created_employee_id=None, status=status,
                               error_code=None, error_message=None,
                               created_at=datetime(2026, 1, 1), updated_at=None)


def test_start_provisioning_ok():
    assert _mk("pending").start_provisioning().status == "provisioning"


def test_start_provisioning_from_non_pending_raises():
    with pytest.raises(ValueError):
        _mk("provisioning").start_provisioning()


def test_mark_succeeded_requires_provisioning():
    out = _mk("provisioning").mark_succeeded("emp-1")
    assert out.status == "succeeded" and out.created_employee_id == "emp-1"
    with pytest.raises(ValueError):
        out.cancel()


def test_mark_failed_requires_provisioning():
    out = _mk("provisioning").mark_failed("E_BOOM", "no more")
    assert out.status == "failed" and out.error_code == "E_BOOM"
    with pytest.raises(ValueError):
        _mk("pending").mark_failed("E", "m")


def test_cancel_from_pending_or_provisioning_ok_and_terminal_raises():
    for st in ("pending", "provisioning"):
        assert _mk(st).cancel().status == "cancelled"
    for st in ("succeeded", "cancelled"):
        with pytest.raises(ValueError):
            _mk(st).cancel()
