"""L5 flow test: 群聊多智能体编排真实执行链 (orchestration_executor).

播种走真实群聊提交路径 (submit_group_message, route_hint=orchestration),
mock WebUI loopback 后直接驱动 execute_orchestration, 验证:
- 任务树事件 (root + 子任务 task_created/started/completed) 回流并镜像为 TeamTask
- 每个子任务产出受派员工署名的群聊消息 (多智能体并发响应)
- planner 汇总产出最终消息 + result_merged + run_succeeded
- run 终态 succeeded
"""

from __future__ import annotations

import json

import pytest

from agent_gateway import runtime_executor, webui_runtime_adapter
from agent_gateway.orchestration_executor import execute_orchestration
from team_panel.application.commands.conversation_service import (
    create_group_conversation,
    submit_group_message,
)
from team_panel.transactions.uow import UnitOfWork


class _FakeTurn:
    def __init__(self, success, text, error=""):
        self.success = success
        self.text = text
        self.error = error
        self.session_id = ""
        self.tool_calls = []


def _seed_orchestration_run(db_conn) -> str:
    with UnitOfWork(db_conn) as uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "协作群",
            ["emp_planner", "emp_test", "emp_member"], "user_test",
        )
    with UnitOfWork(db_conn) as uow:
        result = submit_group_message(
            uow, conv_id,
            "请一起协作完成一篇新能源行业报告",
            "orchestration",
            f"orch-exec-{id(db_conn)}",
            "emp_planner",
        )
    return conv_id, result["run_id"]


@pytest.fixture
def _mock_webui(monkeypatch):
    """plan 轮返回 JSON 计划; 子任务轮返回署名文本; 汇总轮 emit token。"""
    monkeypatch.setattr(runtime_executor, "_provision_profile", lambda *a, **k: None)

    def fake_run_turn(*, profile, message, model="", model_provider="",
                      session_id=None, on_event=None, timeout_seconds=300):
        if "只输出 JSON" in message:
            plan = {
                "subtasks": [
                    {"title": "资料调研", "description": "收集行业数据",
                     "assignee": "emp_test", "depends_on": []},
                    {"title": "撰写报告", "description": "基于调研起草",
                     "assignee": "emp_member", "depends_on": [0]},
                ]
            }
            return _FakeTurn(True, json.dumps(plan, ensure_ascii=False))
        if "请汇总为面向用户的最终交付" in message:
            if on_event:
                on_event("token", {"text": "最终报告："})
                on_event("token", {"text": "新能源前景广阔。"})
            return _FakeTurn(True, "最终报告：新能源前景广阔。")
        # 子任务执行轮
        return _FakeTurn(True, f"[{profile}] 子任务成果")

    monkeypatch.setattr(webui_runtime_adapter, "run_turn", fake_run_turn)
    return fake_run_turn


@pytest.mark.integration
def test_orchestration_executor_end_to_end(db_conn, clean_tables_with_enterprise, _mock_webui):
    conv_id, run_id = _seed_orchestration_run(db_conn)

    conn = runtime_executor._connect()
    try:
        execute_orchestration(conn, run_id)
    finally:
        conn.close()

    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        assert run.status == "succeeded", run.status

        tasks = uow.team_tasks().list_by_run(run_id)
        titles = {t.title for t in tasks}
        assert "资料调研" in titles
        assert "撰写报告" in titles
        # 子任务均到达终态成功
        child = [t for t in tasks if t.title in ("资料调研", "撰写报告")]
        assert all(t.status == "succeeded" for t in child), [(t.title, t.status) for t in child]

        events = uow.run_events().list_by_run(run_id, after_cursor=0, limit=200)
        types = [e.event_type for e in events]
        assert "run_started" in types
        assert types.count("task_created") >= 3      # root + 2 子任务
        assert types.count("task_completed") == 2
        assert "result_merged" in types
        assert "run_succeeded" in types

        messages = uow.conversation_messages().list_by_conversation(conv_id)
        senders = {m.sender_id for m in messages if m.sender_type == "employee"}
        assert "emp_test" in senders and "emp_member" in senders   # 各成员署名消息
        final = [m for m in messages if m.sender_id == run.planner_employee_id]
        assert any("最终报告" in m.message_text for m in final)     # planner 汇总


@pytest.mark.integration
def test_orchestration_executor_partial_failure_still_merges(
        db_conn, clean_tables_with_enterprise, monkeypatch):
    """一个子任务失败不阻断其他分支, 汇总仍产出 (失败后继续推进)。"""
    monkeypatch.setattr(runtime_executor, "_provision_profile", lambda *a, **k: None)

    def fake_run_turn(*, profile, message, on_event=None, **kw):
        if "只输出 JSON" in message:
            plan = {"subtasks": [
                {"title": "任务A", "assignee": "emp_test", "depends_on": []},
                {"title": "任务B", "assignee": "emp_member", "depends_on": []},
            ]}
            return _FakeTurn(True, json.dumps(plan, ensure_ascii=False))
        if "请汇总为面向用户的最终交付" in message:
            return _FakeTurn(True, "汇总：部分完成")
        if "emp-member" in profile:                 # emp_member 子任务失败
            return _FakeTurn(False, "", error="模型超时")
        return _FakeTurn(True, "A 的成果")

    monkeypatch.setattr(webui_runtime_adapter, "run_turn", fake_run_turn)

    conv_id, run_id = _seed_orchestration_run(db_conn)
    conn = runtime_executor._connect()
    try:
        execute_orchestration(conn, run_id)
    finally:
        conn.close()

    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        assert run.status == "succeeded"            # 有成功分支 → run 成功
        events = [e.event_type for e in uow.run_events().list_by_run(run_id, after_cursor=0, limit=200)]
        assert "task_failed" in events
        assert "task_completed" in events
        assert "result_merged" in events

@pytest.mark.integration
def test_orchestration_executor_defaults_message_to_goal_and_uses_round_scoped_task_ids(
        db_conn, clean_tables_with_enterprise, monkeypatch):
    """Group orchestration should goal-loop by default and avoid task mirror id collisions."""
    import agent_gateway.orchestration_executor as executor

    monkeypatch.setattr(runtime_executor, "_provision_profile", lambda *a, **k: None)
    verdicts = iter(["continue", "done"])
    monkeypatch.setattr(executor, "_judge_goal", lambda goal, response: (next(verdicts), "mock"))

    calls = {"plan": 0, "aggregate": 0}

    def fake_run_turn(*, profile, message, on_event=None, **kw):
        if "只输出 JSON" in message:
            calls["plan"] += 1
            plan = {"subtasks": [
                {"title": f"第{calls['plan']}轮调研", "description": "收集资料", "assignee": "emp_test", "depends_on": []},
                {"title": f"第{calls['plan']}轮分析", "description": "分析资料", "assignee": "emp_member", "depends_on": [0]},
            ]}
            if calls["plan"] == 2:
                assert "原始任务: 请一起协作完成一篇新能源行业报告" in message
                assert message.count("[目标持续追踪") == 1
            return _FakeTurn(True, json.dumps(plan, ensure_ascii=False))
        if "请汇总为面向用户的最终交付" in message:
            calls["aggregate"] += 1
            return _FakeTurn(True, f"第{calls['aggregate']}轮汇总")
        return _FakeTurn(True, f"[{profile}] 子任务成果")

    monkeypatch.setattr(webui_runtime_adapter, "run_turn", fake_run_turn)

    conv_id, run_id = _seed_orchestration_run(db_conn)
    conn = runtime_executor._connect()
    try:
        execute_orchestration(conn, run_id)
    finally:
        conn.close()

    with UnitOfWork(db_conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        assert run.status == "succeeded"
        assert calls == {"plan": 2, "aggregate": 2}

        events = uow.run_events().list_by_run(run_id, after_cursor=0, limit=300)
        source_ids = [e.source_id for e in events if e.event_type == "task_created"]
        assert f"sub_{run_id}_r1_0" in source_ids
        assert f"sub_{run_id}_r2_0" in source_ids
        assert "goal_achieved" not in [e.event_type for e in events]
        assert "goal_budget_exhausted" not in [e.event_type for e in events]

        result_events = [e for e in events if e.event_type == "result_merged"]
        assert len(result_events) >= 2
        payloads = [json.loads(e.payload_json or "{}") for e in result_events]
        assert any(payload.get("goal_status") == "achieved" for payload in payloads)

        messages = uow.conversation_messages().list_by_conversation(conv_id)
        employee_senders = [m.sender_id for m in messages if m.sender_type == "employee"]
        assert "emp_test" in employee_senders
        assert "emp_member" in employee_senders
