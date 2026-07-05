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


# ---- update_solution_instance (issue #234, PR #12 diff-cover) ----


def _captured_router():
    """构建一个能捕获最后一次 execute(params) 的 router。"""
    router = FakeRouter()

    class CaptureRouter:
        def __init__(self, inner):
            self._inner = inner

        def session(self, context):
            return _Sess(self._inner, context)

    class _Sess:
        def __init__(self, inner, context):
            self._inner = inner
            self._context = context

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return None

        def execute(self, sql, params=None):
            CaptureRouter.last_sql = sql
            CaptureRouter.last_params = params
            return self._inner._pop()

    return router, CaptureRouter



def _set_clause(sql):
    """从 UPDATE ... SET <here> WHERE ... RETURNING 截取 SET 子句。"""
    import re
    m = re.search(r"\bSET\b(.+?)\bWHERE\b", sql, re.IGNORECASE)
    return m.group(1) if m else ""


def _update_sql(router):
    """返回最近一条 UPDATE solution_instance 语句；不存在的返回空串。"""
    for sql, _ in reversed(router.executed):
        if "update solution_instance" in sql.lower():
            return sql
    return ""


def test_update_solution_instance_no_fields_returns_get():
    """不传任何字段 → 等同 get_solution_instance（只走 SELECT）。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_sol_row(iid="i-1")))
    row = RecruitRepository(router).update_solution_instance(ctx(), instance_id="i-1")
    assert row is not None
    assert row.id == "i-1"
    assert _update_sql(router) == ""  # 未发 UPDATE


def test_update_solution_instance_not_found_returns_none():
    """instance_id 不存在 → 返回 None。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert RecruitRepository(router).update_solution_instance(ctx(), instance_id="ghost") is None


def test_update_solution_instance_empty_string_writes_to_sets():
    """display_name="" / planner_prompt="   " → 空串不触发归一（只有 None 跳过），仍发出 UPDATE。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_sol_row(iid="i-1")))
    row = RecruitRepository(router).update_solution_instance(
        ctx(), instance_id="i-1", display_name="", planner_prompt="   ",
    )
    assert row is not None
    assert _update_sql(router) != ""  # still issues UPDATE


def test_update_solution_instance_all_fields():
    """全部字段写入 + config_version +1 + updated_at now()。"""
    router, Cap = _captured_router()
    router.queue(FakeCursor(fetchone=_sol_row(iid="i-1")))
    cap = Cap(router)
    row = RecruitRepository(cap).update_solution_instance(
        ctx(), instance_id="i-1",
        display_name="New Name",
        expert_employee_ids=["e-9"],
        knowledge_refs=["k-9"],
        skill_refs=["s-9"],
        planner_prompt="plan-x",
        subtask_prompt="sub-x",
        aggregate_prompt="agg-x",
        status="archived",
    )
    assert row is not None
    sql = Cap.last_sql
    for col in ("display_name", "expert_employee_ids", "knowledge_refs", "skill_refs",
                "planner_prompt", "subtask_prompt", "aggregate_prompt", "status"):
        assert col in sql, f"{col} not in SQL"
    assert "config_version = config_version + 1" in sql
    assert "updated_at = now()" in sql
    assert "WHERE id = %s" in sql


def test_update_solution_instance_partial_fields():
    """只传 planner_prompt → 只 SET 该字段（SET 子句判断）。"""
    router, Cap = _captured_router()
    router.queue(FakeCursor(fetchone=_sol_row(iid="i-1")))
    cap = Cap(router)
    row = RecruitRepository(cap).update_solution_instance(
        ctx(), instance_id="i-1", planner_prompt="p-only",
    )
    assert row is not None
    set_clause = _set_clause(Cap.last_sql)
    assert "planner_prompt" in set_clause
    assert "display_name" not in set_clause
    assert "status" not in set_clause


def test_update_solution_instance_uuid_string_coercion():
    """expert_employee_ids 为 uuid → 转 str 存入。"""
    import uuid as _uuid

    router, Cap = _captured_router()
    router.queue(FakeCursor(fetchone=_sol_row(iid="i-1")))
    cap = Cap(router)
    u1, u2 = _uuid.uuid4(), _uuid.uuid4()
    row = RecruitRepository(cap).update_solution_instance(
        ctx(), instance_id="i-1", expert_employee_ids=[u1, u2],
    )
    assert row is not None
    params = Cap.last_params
    list_params = [p for p in params if isinstance(p, list)]
    assert list_params, "没有 list 参数被捕获"
    assert all(isinstance(x, str) for x in list_params[0])
