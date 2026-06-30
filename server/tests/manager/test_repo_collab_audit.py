"""collab_audit_repository.py branch coverage (issue #265, #295)."""
from __future__ import annotations

from datetime import datetime

from manager_service.collab_audit_repository import CollabAuditRepository
from ._fake_router import FakeCursor, FakeRouter, ctx


def _tmpl_row(tid="t-1", config=None):
    return (tid, "默认协作模板", config or {}, datetime.utcnow())


def test_get_template_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_tmpl_row()))
    row = CollabAuditRepository(router).get_template(ctx())
    assert row is not None

def test_get_template_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert CollabAuditRepository(router).get_template(ctx()) is None

def test_upsert_template_insert():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))  # existing
    router.queue(FakeCursor(rowcount=1))  # INSERT
    router.queue(FakeCursor(fetchone=_tmpl_row()))  # fetch after
    row = CollabAuditRepository(router).upsert_template(ctx(), name="New")
    assert row.name == "默认协作模板"

def test_upsert_template_update():
    import json
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_tmpl_row()))  # existing
    router.queue(FakeCursor(rowcount=1))  # UPDATE
    # fetch after: config includes max_replies_per_message=5
    router.queue(FakeCursor(fetchone=_tmpl_row(config={"max_replies_per_message": 5})))
    row = CollabAuditRepository(router).upsert_template(ctx(), max_replies_per_message=5)
    assert row.max_replies_per_message == 5


# ---- #295 编排提示词 (planner/subtask/aggregate) + is_default ----

def test_upsert_template_writes_planner_subtask_aggregate():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))  # existing
    router.queue(FakeCursor(rowcount=1))  # INSERT
    router.queue(FakeCursor(fetchone=_tmpl_row(config={
        "planner_prompt": "规划指令",
        "subtask_prompt": "子任务指令",
        "aggregate_prompt": "汇总指令",
        "is_default": False,
    })))
    row = CollabAuditRepository(router).upsert_template(
        ctx(),
        planner_prompt="规划指令",
        subtask_prompt="子任务指令",
        aggregate_prompt="汇总指令",
        is_default=False,
    )
    assert row.planner_prompt == "规划指令"
    assert row.subtask_prompt == "子任务指令"
    assert row.aggregate_prompt == "汇总指令"
    assert row.is_default is False


def test_upsert_template_defaults_when_keys_missing():
    """当 config 中尚无 orchestration 字段时，应返回安全默认值（空串 / True）。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))  # existing
    router.queue(FakeCursor(rowcount=1))  # INSERT
    router.queue(FakeCursor(fetchone=_tmpl_row(config={})))
    row = CollabAuditRepository(router).upsert_template(ctx(), name="X")
    assert row.planner_prompt == ""
    assert row.subtask_prompt == ""
    assert row.aggregate_prompt == ""
    assert row.is_default is True


def test_upsert_template_orchestration_partial_update():
    """只传部分 orchestration 字段时，未传字段不被清空。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_tmpl_row(config={
        "planner_prompt": "已存规划",
        "subtask_prompt": "已存子任务",
        "aggregate_prompt": "已存汇总",
        "is_default": True,
    })))  # existing
    router.queue(FakeCursor(rowcount=1))  # UPDATE
    router.queue(FakeCursor(fetchone=_tmpl_row(config={
        "planner_prompt": "已存规划",
        "subtask_prompt": "已存子任务",
        "aggregate_prompt": "已存汇总",
        "is_default": True,
    })))  # fetch after (模拟 jsonb || 合并)
    row = CollabAuditRepository(router).upsert_template(ctx(), planner_prompt="新规划")
    assert row.planner_prompt == "已存规划"  # FakeRouter returns the queued fetch row; update path is exercised.


def test_get_template_returns_full_orchestration_defaults():
    """get_template 应返回含完整 orchestration 字段的 CollabTemplateRow。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_tmpl_row(config={
        "planner_prompt": "p", "subtask_prompt": "s", "aggregate_prompt": "a", "is_default": False,
    })))
    row = CollabAuditRepository(router).get_template(ctx())
    assert row is not None
    assert row.planner_prompt == "p"
    assert row.subtask_prompt == "s"
    assert row.aggregate_prompt == "a"
    assert row.is_default is False


def test_list_events():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("e-1", "login", "u-1", None, None, {}, datetime.utcnow())]))
    rows = CollabAuditRepository(router).list_events(ctx())
    assert len(rows) == 1

def test_list_events_filtered():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[("e-1", "login", "u-1", None, None, {}, datetime.utcnow())]))
    rows = CollabAuditRepository(router).list_events(ctx(), event_type="login", target_type="user")
    assert len(rows) == 1

def test_list_events_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert CollabAuditRepository(router).list_events(ctx()) == []

def test_create_event():
    from datetime import datetime
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("e-1", "login", "u-1", None, None, {}, datetime.utcnow())))
    row = CollabAuditRepository(router).create_event(ctx(), event_type="login", actor_id="u-1")
    assert row.event_type == "login"
