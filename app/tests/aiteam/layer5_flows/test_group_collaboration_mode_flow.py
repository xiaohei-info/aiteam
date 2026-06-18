"""L5 flow tests: 群聊协作模式 — 自由讨论 / 规则编排。

覆盖:
- create_group_conversation 持久化 collaboration_mode + orchestration_brief（free 清空 brief）
- 北向 create API 校验：orchestrated 必填 brief；detail 暴露字段与 default_route_hint
- 规则编排群驱动 execute_orchestration 时，编排指令被注入 planner 拆解提示词
"""

from __future__ import annotations

import json
from urllib.parse import urlparse

import pytest

from team_panel.application.commands.conversation_service import (
    create_group_conversation,
    submit_group_message,
    update_group_conversation,
)
from team_panel.repositories.conversation_repo import ConversationRepo
from team_panel.transactions.uow import UnitOfWork


def _post(parsed_path: str, body: dict | None = None) -> tuple[int, dict]:
    from api.routes import handle_post

    class _H:
        def __init__(self):
            self.status = None
            self.sent_headers = []
            self.body = bytearray()
            self.wfile = self
            self.rfile = None
            self.headers = {}

        def send_response(self, code):
            self.status = code

        def send_header(self, key, value):
            self.sent_headers.append((key, value))

        def end_headers(self):
            pass

        def write(self, data):
            self.body.extend(data if isinstance(data, (bytes, bytearray)) else data.encode("utf-8"))

        def get_json(self):
            return json.loads(self.body.decode("utf-8")) if self.body else {}

    handler = _H()
    if body is not None:
        raw = json.dumps(body).encode("utf-8")
        handler.headers["Content-Length"] = str(len(raw))
        handler.rfile = type("_B", (), {"read": staticmethod(lambda n: raw)})()
    handle_post(handler, urlparse(f"http://example.com{parsed_path}"))
    assert handler.status is not None
    return handler.status, handler.get_json()


def _patch(parsed_path: str, body: dict | None = None) -> tuple[int, dict]:
    from api.routes import handle_patch

    class _H:
        def __init__(self):
            self.status = None
            self.sent_headers = []
            self.body = bytearray()
            self.wfile = self
            self.rfile = None
            self.headers = {}

        def send_response(self, code):
            self.status = code

        def send_header(self, key, value):
            self.sent_headers.append((key, value))

        def end_headers(self):
            pass

        def write(self, data):
            self.body.extend(data if isinstance(data, (bytes, bytearray)) else data.encode("utf-8"))

        def get_json(self):
            return json.loads(self.body.decode("utf-8")) if self.body else {}

    handler = _H()
    if body is not None:
        raw = json.dumps(body).encode("utf-8")
        handler.headers["Content-Length"] = str(len(raw))
        handler.rfile = type("_B", (), {"read": staticmethod(lambda n: raw)})()
    handle_patch(handler, urlparse(f"http://example.com{parsed_path}"))
    assert handler.status is not None
    return handler.status, handler.get_json()


def _get(parsed_path: str) -> tuple[int, dict]:
    from api.routes import handle_get

    class _H:
        def __init__(self):
            self.status = None
            self.sent_headers = []
            self.body = bytearray()
            self.wfile = self
            self.headers = {}

        def send_response(self, code):
            self.status = code

        def send_header(self, key, value):
            self.sent_headers.append((key, value))

        def end_headers(self):
            pass

        def write(self, data):
            self.body.extend(data if isinstance(data, (bytes, bytearray)) else data.encode("utf-8"))

        def get_json(self):
            return json.loads(self.body.decode("utf-8")) if self.body else {}

    handler = _H()
    handle_get(handler, urlparse(f"http://example.com{parsed_path}"))
    assert handler.status is not None
    return handler.status, handler.get_json()


def test_create_group_orchestrated_persists_mode_and_brief(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "规则编排群", ["emp_test", "emp_member"], "user_test",
            collaboration_mode="orchestrated",
            orchestration_brief="先调研，再撰写，最后审校。",
        )
    with uow:
        conv = ConversationRepo(uow.cur).get_by_id(conv_id)
    assert conv is not None
    assert conv.collaboration_mode == "orchestrated"
    assert conv.orchestration_brief == "先调研，再撰写，最后审校。"


def test_create_group_free_clears_brief(uow, clean_tables_with_enterprise):
    with uow:
        # free 模式即便误传 brief 也应被清空，保持向后兼容语义。
        conv_id = create_group_conversation(
            uow, "ent_test", "自由讨论群", ["emp_test", "emp_member"], "user_test",
            collaboration_mode="free",
            orchestration_brief="不应被保存",
        )
    with uow:
        conv = ConversationRepo(uow.cur).get_by_id(conv_id)
    assert conv.collaboration_mode == "free"
    assert conv.orchestration_brief == ""


def test_create_group_defaults_to_free(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "默认群", ["emp_test", "emp_member"], "user_test",
        )
    with uow:
        conv = ConversationRepo(uow.cur).get_by_id(conv_id)
    assert conv.collaboration_mode == "free"
    assert conv.orchestration_brief == ""


@pytest.mark.integration
def test_api_create_orchestrated_requires_brief(test_server, clean_tables_with_enterprise):
    status, body = _post("/api/team/group-conversations", {
        "title": "缺指令群",
        "member_employee_ids": ["emp_test", "emp_member"],
        "collaboration_mode": "orchestrated",
    })
    assert status == 400, body
    assert body.get("error") == "MISSING_ORCHESTRATION_BRIEF"


@pytest.mark.integration
def test_api_create_orchestrated_and_detail_exposes_fields(test_server, clean_tables_with_enterprise):
    status, body = _post("/api/team/group-conversations", {
        "title": "编排群",
        "member_employee_ids": ["emp_test", "emp_member"],
        "collaboration_mode": "orchestrated",
        "orchestration_brief": "先A后B。",
    })
    assert status == 201, body
    assert body.get("collaboration_mode") == "orchestrated"
    conv_id = body["conversation_id"]

    detail_status, detail = _get(f"/api/team/group-conversations/{conv_id}")
    assert detail_status == 200, detail
    assert detail.get("collaboration_mode") == "orchestrated"
    assert detail.get("orchestration_brief") == "先A后B。"
    assert detail.get("default_route_hint") == "orchestration"


@pytest.mark.integration
def test_api_create_free_group_default_route_hint_auto(test_server, clean_tables_with_enterprise):
    status, body = _post("/api/team/group-conversations", {
        "title": "自由群",
        "member_employee_ids": ["emp_test", "emp_member"],
    })
    assert status == 201, body
    detail_status, detail = _get(f"/api/team/group-conversations/{body['conversation_id']}")
    assert detail.get("collaboration_mode") == "free"
    assert detail.get("default_route_hint") == "auto"


def test_update_group_renames_and_switches_mode(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "原始群名", ["emp_test", "emp_member"], "user_test",
        )
    # free → orchestrated + 改名 + 注入编排指令
    with uow:
        result = update_group_conversation(
            uow, conv_id,
            title="新群名",
            collaboration_mode="orchestrated",
            orchestration_brief="先A后B。",
        )
    assert result["title"] == "新群名"
    assert result["collaboration_mode"] == "orchestrated"
    with uow:
        conv = ConversationRepo(uow.cur).get_by_id(conv_id)
    assert conv.title == "新群名"
    assert conv.collaboration_mode == "orchestrated"
    assert conv.orchestration_brief == "先A后B。"


def test_update_group_switch_back_to_free_clears_brief(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "编排群", ["emp_test", "emp_member"], "user_test",
            collaboration_mode="orchestrated", orchestration_brief="原指令。",
        )
    with uow:
        update_group_conversation(uow, conv_id, collaboration_mode="free")
    with uow:
        conv = ConversationRepo(uow.cur).get_by_id(conv_id)
    assert conv.collaboration_mode == "free"
    assert conv.orchestration_brief == ""


def test_update_group_orchestrated_without_brief_rejected(uow, clean_tables_with_enterprise):
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "自由群", ["emp_test", "emp_member"], "user_test",
        )
    with pytest.raises(ValueError):
        with uow:
            update_group_conversation(uow, conv_id, collaboration_mode="orchestrated")


@pytest.mark.integration
def test_api_patch_group_updates_name_and_mode(test_server, clean_tables_with_enterprise):
    status, body = _post("/api/team/group-conversations", {
        "title": "待改群",
        "member_employee_ids": ["emp_test", "emp_member"],
    })
    assert status == 201, body
    conv_id = body["conversation_id"]

    patch_status, patched = _patch(f"/api/team/group-conversations/{conv_id}", {
        "title": "已改群",
        "collaboration_mode": "orchestrated",
        "orchestration_brief": "先调研再撰写。",
    })
    assert patch_status == 200, patched
    assert patched.get("title") == "已改群"
    assert patched.get("collaboration_mode") == "orchestrated"

    detail_status, detail = _get(f"/api/team/group-conversations/{conv_id}")
    assert detail.get("title") == "已改群"
    assert detail.get("collaboration_mode") == "orchestrated"
    assert detail.get("orchestration_brief") == "先调研再撰写。"
    assert detail.get("default_route_hint") == "orchestration"


@pytest.mark.integration
def test_api_patch_group_empty_body_rejected(test_server, clean_tables_with_enterprise):
    status, body = _post("/api/team/group-conversations", {
        "title": "空补丁群",
        "member_employee_ids": ["emp_test", "emp_member"],
    })
    conv_id = body["conversation_id"]
    patch_status, patched = _patch(f"/api/team/group-conversations/{conv_id}", {})
    assert patch_status == 400, patched
    assert patched.get("error") in ("EMPTY_PATCH", "MISSING_BODY")


@pytest.mark.integration
def test_orchestration_injects_brief_into_planner_prompt(db_conn, clean_tables_with_enterprise, monkeypatch):
    from agent_gateway import runtime_executor, webui_runtime_adapter
    from agent_gateway.orchestration_executor import execute_orchestration

    seen_prompts: list[str] = []
    monkeypatch.setattr(runtime_executor, "_provision_profile", lambda *a, **k: None)

    def fake_run_turn(*, profile, message, model="", model_provider="",
                      session_id=None, on_event=None, timeout_seconds=300):
        seen_prompts.append(message)
        if "只输出 JSON" in message:
            plan = {"subtasks": [
                {"title": "调研", "description": "", "assignee": "emp_test", "depends_on": []},
                {"title": "撰写", "description": "", "assignee": "emp_member", "depends_on": [0]},
            ]}
            return type("_T", (), {"success": True, "text": json.dumps(plan, ensure_ascii=False),
                                   "error": "", "session_id": "", "tool_calls": []})()
        if "请汇总为面向用户的最终交付" in message:
            return type("_T", (), {"success": True, "text": "汇总完成",
                                   "error": "", "session_id": "", "tool_calls": []})()
        return type("_T", (), {"success": True, "text": f"[{profile}] 成果",
                               "error": "", "session_id": "", "tool_calls": []})()

    monkeypatch.setattr(webui_runtime_adapter, "run_turn", fake_run_turn)

    with UnitOfWork(db_conn) as uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "编排执行群",
            ["emp_planner", "emp_test", "emp_member"], "user_test",
            collaboration_mode="orchestrated",
            orchestration_brief="务必让 emp_test 先完成调研。",
        )
    with UnitOfWork(db_conn) as uow:
        result = submit_group_message(
            uow, conv_id, "完成一篇报告", "orchestration",
            f"orch-brief-{id(db_conn)}", "emp_planner",
        )
    run_id = result["run_id"]

    conn = runtime_executor._connect()
    try:
        execute_orchestration(conn, run_id)
    finally:
        conn.close()

    planner_prompts = [p for p in seen_prompts if "只输出 JSON" in p]
    assert planner_prompts, "planner 拆解轮应至少发生一次"
    assert any("务必让 emp_test 先完成调研。" in p for p in planner_prompts), \
        "编排指令应被注入 planner 拆解提示词"
    assert any("编排规则" in p for p in planner_prompts), "应带编排规则标题块"
