"""recruit_repository.py branch coverage (issue #234, target >=90%)."""

from __future__ import annotations

from datetime import datetime

from manager_service.recruit_repository import (
    RecruitRepository,
    RecruitEventRow,
    SolutionInstanceRow,
    _row_to_event,
    _row_to_solution,
)

from ._fake_router import FakeCursor, FakeRouter, ctx


def _sol_row(iid="i-1", sid="sol-1", sv="1", name="Plan A", status="applied",
             exp_ids=None, krefs=None, srefs=None,
             planner="", subtask="", aggregate="",
             dmeta=None, tmeta=None, cv=1, ca=None, ua=None):
    return (iid, sid, sv, name, status, exp_ids or ["e-1"], krefs or ["k-1"],
            srefs or ["s-1"], planner, subtask, aggregate, dmeta, tmeta,
            cv, ca or datetime(2026, 1, 1), ua or datetime(2026, 1, 2))


def _evt_row(eid="ev-1", action="recruit", actor=None, tpl_id=None, tpl_ver=None,
             sol_id=None, sol_ver=None, t_ids=None, t_siid=None, detail=None, ca=None):
    return (eid, action, actor, tpl_id, tpl_ver, sol_id, sol_ver,
            t_ids or [], t_siid, detail, ca or datetime(2026, 1, 1))


def test_create_solution_instance_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_sol_row()))
    row = RecruitRepository(router).create_solution_instance(
        ctx(), solution_id="sol-1", solution_version="1", display_name="Plan A",
        expert_employee_ids=["e-1"], knowledge_refs=["k-1"], skill_refs=["s-1"],
        default_grants_meta=None, template_meta=None,
    )
    assert isinstance(row, SolutionInstanceRow)
    assert row.solution_id == "sol-1"
    assert row.status == "applied"

def test_create_solution_instance_with_meta():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_sol_row(dmeta={"k": "v"}, tmeta={"t": "y"})))
    row = RecruitRepository(router).create_solution_instance(
        ctx(), solution_id="sol-2", solution_version="2", display_name="B",
        expert_employee_ids=[], knowledge_refs=[], skill_refs=[],
        default_grants_meta={"k": "v"}, template_meta={"t": "y"},
    )
    assert row.default_grants_meta == {"k": "v"}
    assert row.template_meta == {"t": "y"}


def test_get_solution_instance_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_sol_row()))
    assert RecruitRepository(router).get_solution_instance(ctx(), instance_id="i-1") is not None

def test_get_solution_instance_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert RecruitRepository(router).get_solution_instance(ctx(), instance_id="x") is None


def test_find_solution_instance_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_sol_row(sid="sol-1", sv="1")))
    row = RecruitRepository(router).find_solution_instance(ctx(), solution_id="sol-1", solution_version="1")
    assert row is not None
    assert row.solution_version == "1"

def test_find_solution_instance_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert RecruitRepository(router).find_solution_instance(ctx(), solution_id="x", solution_version="x") is None


def test_list_solution_instances_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_sol_row("i1"), _sol_row("i2", sid="sol-2")]))
    rows = RecruitRepository(router).list_solution_instances(ctx())
    assert len(rows) == 2

def test_list_solution_instances_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert RecruitRepository(router).list_solution_instances(ctx()) == []


def test_append_recruit_event_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_evt_row(actor="m-1", t_ids=["e-1"])))
    row = RecruitRepository(router).append_recruit_event(
        ctx(), action="recruit", actor_user_id="m-1",
        target_employee_ids=["e-1"], target_solution_instance_id=None, detail=None,
    )
    assert isinstance(row, RecruitEventRow)
    assert row.action == "recruit"
    assert row.actor_user_id == "m-1"
    assert row.target_employee_ids == ["e-1"]

def test_append_recruit_event_full_fields():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_evt_row(
        action="apply_solution", actor="m-2", tpl_id="tpl-1", tpl_ver="2",
        sol_id="sol-1", sol_ver="1", t_ids=["e-1", "e-2"], t_siid="i-1",
        detail={"reason": "test"},
    )))
    row = RecruitRepository(router).append_recruit_event(
        ctx(), action="apply_solution", actor_user_id="m-2",
        source_template_id="tpl-1", source_template_version="2",
        source_solution_id="sol-1", source_solution_version="1",
        target_employee_ids=["e-1", "e-2"], target_solution_instance_id="i-1",
        detail={"reason": "test"},
    )
    assert row.source_template_id == "tpl-1"
    assert row.target_solution_instance_id == "i-1"
    assert row.detail == {"reason": "test"}

def test_append_recruit_event_null_targets():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_evt_row(t_ids=[])))
    row = RecruitRepository(router).append_recruit_event(
        ctx(), action="event", target_employee_ids=None, detail=None,
    )
    assert row.target_employee_ids == []
    assert row.detail is None


def test_list_recruit_events_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_evt_row("e1"), _evt_row("e2", action="deploy")]))
    rows = RecruitRepository(router).list_recruit_events(ctx())
    assert len(rows) == 2

def test_list_recruit_events_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert RecruitRepository(router).list_recruit_events(ctx()) == []


# ---- _row_to_* edge cases ----

def test_row_to_solution_null_knowledge_refs():
    raw = list(_sol_row())
    raw[6] = None
    row = _row_to_solution(tuple(raw))
    assert row.knowledge_refs == []

def test_row_to_solution_null_skill_refs():
    raw = list(_sol_row())
    raw[7] = None
    row = _row_to_solution(tuple(raw))
    assert row.skill_refs == []

def test_row_to_event_null_actor():
    row = _row_to_event(_evt_row(actor=None))
    assert row.actor_user_id is None

def test_row_to_event_null_siid():
    row = _row_to_event(_evt_row(t_siid=None))
    assert row.target_solution_instance_id is None

def test_row_to_event_null_target_ids():
    raw = list(_evt_row())
    raw[7] = None
    row = _row_to_event(tuple(raw))
    assert row.target_employee_ids == []
