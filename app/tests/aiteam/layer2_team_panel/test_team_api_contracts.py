"""Layer2 Team Panel — northbound API contract tests for the first 12 endpoints.

Tests go through the existing host dispatch seam (_get/_post/_patch) so the
full request → dispatch → router path is exercised in-process.
"""
from __future__ import annotations

import json
import os
import uuid
from urllib.parse import urlparse

import pytest

from team_panel.transactions.uow import UnitOfWork

# Reuse the FakeHandler pattern from layer0_contracts
try:
    from tests.aiteam.layer0_contracts.test_host_routing import _FakeHandler, _get, _post, _patch, _delete
except ImportError:
    # Fallback: re-define inline
    class _FakeHandler:
        def __init__(self):
            self.status = None
            self.sent_headers: list[tuple[str, str]] = []
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


    def _get(parsed_path: str) -> tuple[int, dict]:
        from api.routes import handle_get
        handler = _FakeHandler()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_get(handler, parsed)
        return handler.status, handler.get_json()


    def _post(parsed_path: str, body: dict | None = None) -> tuple[int, dict]:
        from api.routes import handle_post
        handler = _FakeHandler()
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            handler.headers["Content-Length"] = str(len(raw))
            handler.rfile = type("_BytesIO", (), {"read": lambda n: raw})()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_post(handler, parsed)
        return handler.status, handler.get_json()


    def _patch(parsed_path: str, body: dict | None = None) -> tuple[int, dict]:
        from api.routes import handle_patch
        handler = _FakeHandler()
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            handler.headers["Content-Length"] = str(len(raw))
            handler.rfile = type("_BytesIO", (), {"read": lambda n: raw})()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_patch(handler, parsed)
        return handler.status, handler.get_json()


    def _delete(parsed_path: str) -> tuple[int, dict]:
        from api.routes import handle_delete
        handler = _FakeHandler()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_delete(handler, parsed)
        return handler.status, handler.get_json()


def _handler_text(handler: "_FakeHandler") -> str:
    return handler.body.decode("utf-8") if handler.body else ""


def _handler_content_type(handler: "_FakeHandler") -> str | None:
    for key, value in handler.sent_headers:
        if key.lower() == "content-type":
            return value
    return None


def _get_raw(parsed_path: str) -> "_FakeHandler":
    from api.routes import handle_get
    handler = _FakeHandler()
    parsed = urlparse(f"http://example.com{parsed_path}")
    handle_get(handler, parsed)
    return handler


def test_private_history_keeps_assistant_reply_when_terminal_summary_is_empty_but_reasoning_events_exist(
    uow, clean_tables_with_enterprise
):
    from team_panel.api_team import router_team
    from team_panel.domain.entities import ConversationMessage, RunEvent, TeamRun

    with uow:
        conversation = uow.conversations().get_by_id("conv_test")
        assert conversation is not None

        run = TeamRun(
            id="run_reasoning_only_summary_gap",
            enterprise_id="ent_test",
            conversation_id=conversation.id,
            trigger_type="private_message",
            execution_mode="single_agent",
            status="succeeded",
            entry_employee_id="emp_test",
            input_message_json=json.dumps({"message_text": "帮我做一份大模型行业简报"}, ensure_ascii=False),
            result_summary_json=json.dumps({}, ensure_ascii=False),
        )
        uow.team_runs().create(run)

        uow.conversation_messages().create(
            ConversationMessage(
                id="msg_user_reasoning_gap",
                conversation_id=conversation.id,
                run_id=run.id,
                sender_id="user_test",
                sender_type="user",
                message_text="帮我做一份大模型行业简报",
                message_json=json.dumps({"message_text": "帮我做一份大模型行业简报"}, ensure_ascii=False),
            )
        )
        uow.conversation_messages().create(
            ConversationMessage(
                id="msg_assistant_reasoning_gap",
                conversation_id=conversation.id,
                run_id=run.id,
                sender_id="emp_test",
                sender_type="employee",
                message_text="以下是大模型行业简要调研：市场持续增长，企业落地聚焦提效与降本。",
                message_json=json.dumps(
                    {
                        "message_text": "以下是大模型行业简要调研：市场持续增长，企业落地聚焦提效与降本。",
                        "citations": [],
                    },
                    ensure_ascii=False,
                ),
            )
        )

        uow.run_events().create(
            RunEvent(
                id="evt_reasoning_gap_1",
                enterprise_id="ent_test",
                run_id=run.id,
                cursor_no=1,
                event_type="message_delta",
                source_type="session",
                source_id="src_reasoning_gap",
                employee_id="emp_test",
                preview_text="报告，不是",
                payload_json=json.dumps(
                    {"delta": "报告，不是", "kind": "reasoning"},
                    ensure_ascii=False,
                ),
            )
        )
        uow.run_events().create(
            RunEvent(
                id="evt_reasoning_gap_2",
                enterprise_id="ent_test",
                run_id=run.id,
                cursor_no=2,
                event_type="run_succeeded",
                source_type="session",
                source_id="src_reasoning_gap",
                employee_id="emp_test",
                preview_text="",
                payload_json=json.dumps({"success": True, "citations": []}, ensure_ascii=False),
            )
        )

        page, total, next_cursor, has_more = router_team._serialize_private_history(
            uow.cur,
            conversation.id,
            cursor=0,
            limit=50,
        )

    assert total >= 3
    assert next_cursor >= 3
    assert has_more is False

    assistant_messages = [item for item in page if item["role"] == "assistant"]
    assert assistant_messages, "assistant reply must still render even when run_succeeded has no summary text"
    assert assistant_messages[-1]["text"] == "以下是大模型行业简要调研：市场持续增长，企业落地聚焦提效与降本。"

    reasoning_items = [
        item for item in page
        if item.get("__timeline_item", {}).get("kind") == "reasoning"
    ]
    assert reasoning_items, "reasoning timeline item should still be preserved"


def test_private_history_coalesces_consecutive_reasoning_deltas_into_one_bubble(
    uow, clean_tables_with_enterprise
):
    """A streamed reasoning span (many few-char deltas) must render as ONE
    reasoning bubble in the persisted history — otherwise it floods the view."""
    from team_panel.api_team import router_team
    from team_panel.domain.entities import RunEvent, TeamRun

    deltas = ["用户", "问", "今天", "天气", "怎么样。", "根据", "我的角色", "设定。"]

    with uow:
        conversation = uow.conversations().get_by_id("conv_test")
        assert conversation is not None

        run = TeamRun(
            id="run_reasoning_flood",
            enterprise_id="ent_test",
            conversation_id=conversation.id,
            trigger_type="private_message",
            execution_mode="single_agent",
            status="succeeded",
            entry_employee_id="emp_test",
            input_message_json=json.dumps({"message_text": "你好"}, ensure_ascii=False),
            result_summary_json=json.dumps({"summary": "您好！"}, ensure_ascii=False),
        )
        uow.team_runs().create(run)

        for idx, delta in enumerate(deltas, start=1):
            uow.run_events().create(
                RunEvent(
                    id=f"evt_flood_{idx}",
                    enterprise_id="ent_test",
                    run_id=run.id,
                    cursor_no=idx,
                    event_type="message_delta",
                    source_type="session",
                    source_id="src_flood",
                    employee_id="emp_test",
                    preview_text=delta,
                    payload_json=json.dumps({"delta": delta, "kind": "reasoning"}, ensure_ascii=False),
                )
            )

        page, _total, _next_cursor, _has_more = router_team._serialize_private_history(
            uow.cur, conversation.id, cursor=0, limit=50,
        )

    reasoning_items = [
        item for item in page
        if item.get("__timeline_item", {}).get("kind") == "reasoning"
        and item["run_id"] == "run_reasoning_flood"
    ]
    assert len(reasoning_items) == 1, (
        f"expected ONE coalesced reasoning bubble, got {len(reasoning_items)}"
    )
    assert reasoning_items[0]["__timeline_item"]["payload"]["delta"] == "".join(deltas)


# ═══════════════════════════════════════════════════════
# Batch 1: GET endpoints
# ═══════════════════════════════════════════════════════════════════════════

class TestWorkbench:
    """S06-T01: GET /api/team/workbench returns 200 with correct shape."""

    def test_get_workbench_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/workbench")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_workbench_has_enterprise_key(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "enterprise" in body, f"Missing enterprise key: {body}"

    def test_workbench_has_employees_key(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "employees" in body, f"Missing employees key: {body}"
        assert isinstance(body["employees"], list)

    def test_workbench_has_groups_key(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "groups" in body

    def test_workbench_has_office_digest_key(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "office_digest" in body
        assert "online_employee_count" in body["office_digest"]
        assert "running_task_count" in body["office_digest"]

    def test_workbench_enterprise_has_expected_fields(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        ent = body["enterprise"]
        assert "enterprise_id" in ent
        assert "name" in ent
        assert ent["name"] == "Test Corp"

    def test_workbench_employees_have_expected_shape(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        employees = body["employees"]
        assert len(employees) >= 1
        emp = employees[0]
        for key in ("employee_id", "display_name", "role_name", "status", "presence", "unread_count", "last_active_at", "is_starred"):
            assert key in emp, f"Missing {key} in employee: {emp}"

    def test_workbench_groups_match_frontend_contract_shape(self, uow, clean_tables_with_enterprise):
        from team_panel.application.commands.conversation_service import create_group_conversation, submit_group_message

        with uow:
            conv_id = create_group_conversation(
                uow,
                "ent_test",
                "Ops Sync",
                ["emp_test", "emp_member", "emp_planner"],
                "user_test",
            )
            submit_group_message(
                uow,
                conv_id,
                "协作组同步一下最新排期",
                "orchestration",
                "workbench-group-contract-001",
                "emp_test",
            )

        status, body = _get("/api/team/workbench")
        assert status == 200, body
        group = next(item for item in body["groups"] if item["conversation_id"] == conv_id)
        for key in ("conversation_id", "title", "member_count", "running_count", "last_message_preview"):
            assert key in group, f"Missing {key} in group: {group}"

    def test_workbench_state_post_updates_starred_and_read_state(self, seeded_enterprise):
        create_status, created = _post(
            "/api/team/runs",
            {
                "employee_id": seeded_enterprise["employee_id"],
                "conversation_id": seeded_enterprise["conversation_id"],
                "message_text": "请整理本周任务摘要",
                "idempotency_key": "idem_workbench_state_read_001",
            },
        )
        assert create_status == 201, created

        before_status, before = _get("/api/team/workbench?actor_id=user_test")
        assert before_status == 200, before
        employee = next(item for item in before["employees"] if item["employee_id"] == seeded_enterprise["employee_id"])
        assert employee["is_starred"] is False
        assert employee["unread_count"] >= 1

        update_status, update = _post(
            "/api/team/workbench/state?actor_id=user_test",
            {
                "employee_id": seeded_enterprise["employee_id"],
                "is_starred": True,
                "conversation_id": seeded_enterprise["conversation_id"],
                "mark_read": True,
            },
        )
        assert update_status == 200, update
        assert update["employee_id"] == seeded_enterprise["employee_id"]
        assert update["is_starred"] is True
        assert update["conversation_id"] == seeded_enterprise["conversation_id"]
        assert update["unread_count"] == 0

        after_status, after = _get("/api/team/workbench?actor_id=user_test")
        assert after_status == 200, after
        employee = next(item for item in after["employees"] if item["employee_id"] == seeded_enterprise["employee_id"])
        assert employee["is_starred"] is True
        assert employee["unread_count"] == 0

    def test_workbench_exposes_navigation_permissions_and_task_digest(self, seeded_enterprise):
        _, body = _get("/api/team/workbench")
        assert "my_team" in body
        assert "conversations" in body
        assert "navigation" in body
        assert "task_status_digest" in body
        assert "permissions" in body
        assert body["navigation"]["talent"]["target"] == "/app/marketplace"
        assert body["navigation"]["org"]["target"] == "/app/workbench"
        assert body["permissions"]["role"] == "member"
        assert body["permissions"]["can_view_admin"] is False

    def test_workbench_ignores_public_role_query_param(self, seeded_enterprise):
        _, body = _get("/api/team/workbench?role=owner")
        assert body["navigation"]["org"]["target"] == "/app/workbench"
        assert body["permissions"]["role"] == "member"
        assert body["permissions"]["can_view_admin"] is False

    def test_workbench_returns_structured_permission_error_for_system_admin(self, seeded_enterprise, monkeypatch):
        monkeypatch.setenv("HERMES_AITEAM_WORKBENCH_ROLE", "system_admin")
        status, body = _get("/api/team/workbench")
        assert status == 403
        assert body["error"]["code"] == "PERMISSION_DENIED"
        assert body["error"]["retryable"] is False

    def test_workbench_owner_gets_org_admin_navigation_target(self, seeded_enterprise, monkeypatch):
        monkeypatch.setenv("HERMES_AITEAM_WORKBENCH_ROLE", "owner")
        _, body = _get("/api/team/workbench")
        assert body["navigation"]["org"]["target"] == "/app/org"
        assert body["permissions"]["can_view_admin"] is True

    def test_workbench_without_enterprise_returns_distinct_empty_state(self, clean_tables):
        status, body = _get("/api/team/workbench")
        assert status == 200, body
        assert body["enterprise"] is None
        assert body["employees"] == []
        assert body["empty_state"]["code"] == "NO_ENTERPRISE"
        assert body["empty_state"]["title"] == "还没有企业空间"
        assert body["empty_state"]["message"] == "当前还没有可用的企业工作台。"


class TestTalentMarketTemplates:
    """S06-T02: GET /api/team/talent-market/templates."""

    def test_get_templates_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/talent-market/templates")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_templates_response_has_items(self, seeded_enterprise):
        _, body = _get("/api/team/talent-market/templates")
        assert "items" in body
        assert "page" in body
        assert "total" in body
        assert "has_more" in body

    def test_templates_items_have_expected_shape(self, seeded_enterprise):
        _, body = _get("/api/team/talent-market/templates")
        items = body["items"]
        assert len(items) >= 1, f"No templates found: {body}"
        tpl = items[0]
        for key in ("template_id", "name", "role", "skills", "tags"):
            assert key in tpl, f"Missing {key} in template: {tpl}"
        assert tpl["template_id"] == seeded_enterprise["template_id"]
        assert tpl["skills"] == ["web_search", "slides"]
        assert tpl["default_model_ref"]["model"] == "gpt-4o"
        assert tpl["recruit_count"] >= 0

    def test_admin_templates_alias_returns_same_payload_shape(self, seeded_enterprise):
        status, body = _get("/api/team/templates")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert "items" in body
        assert body["items"][0]["template_id"] == seeded_enterprise["template_id"]

    def test_admin_templates_alias_requires_manage_employees_for_finance_admin(self, seeded_enterprise):
        status, body = _get("/api/team/templates?role=finance_admin")
        assert status == 403, body
        assert body["required_action"] == "manage_employees"

    def test_templates_support_keyword_category_sort_and_pagination(self, seeded_enterprise, db_conn):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO agent_template (id, name, category_code, role_name, status, prompt_pack_json, default_model_json, default_binding_json, version_no, source_type) "
                "VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s)",
                (
                    "tpl_finance_v1",
                    "Finance Advisor",
                    "finance",
                    "财务分析",
                    "published",
                    json.dumps(
                        {
                            "description": "擅长预算、核算与报表复盘",
                            "tags": ["财务", "预算"],
                        },
                        ensure_ascii=False,
                    ),
                    json.dumps({"provider": "openai", "model": "gpt-4.1-mini"}, ensure_ascii=False),
                    json.dumps({"skills": ["forecasting"]}, ensure_ascii=False),
                    1,
                    "system",
                ),
            )
            cur.execute(
                "INSERT INTO agent_template (id, name, category_code, role_name, status, prompt_pack_json, default_model_json, default_binding_json, version_no, source_type) "
                "VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s)",
                (
                    "tpl_ops_v1",
                    "Ops Planner",
                    "operations",
                    "运营增长",
                    "published",
                    json.dumps(
                        {
                            "description": "擅长 SOP、排期与协作推进",
                            "tags": ["运营", "协作"],
                        },
                        ensure_ascii=False,
                    ),
                    json.dumps({"provider": "anthropic", "model": "claude-3.7-sonnet"}, ensure_ascii=False),
                    json.dumps({"skills": ["reporting"]}, ensure_ascii=False),
                    1,
                    "system",
                ),
            )
            cur.execute(
                "INSERT INTO agent_template (id, name, category_code, role_name, status, prompt_pack_json, default_model_json, default_binding_json, version_no, source_type) "
                "VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s)",
                ("tpl_draft_only", "草稿模板", "ops", "operator", "draft", "{}", "{}", "{}", 1, "system"),
            )
            cur.execute(
                "INSERT INTO recruitment_order (id, enterprise_id, template_id, status, requested_by, created_employee_id, error_code, error_message, idempotency_key) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    "ord_finance_hot",
                    seeded_enterprise["enterprise_id"],
                    "tpl_finance_v1",
                    "succeeded",
                    "user_test",
                    seeded_enterprise["employee_id"],
                    None,
                    None,
                    str(uuid.uuid4()),
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _get("/api/team/talent-market/templates?q=预算&category=finance&sort_by=popularity&page=1&page_size=1")
        assert status == 200, body
        assert body["total"] == 1
        assert body["page"] == 1
        assert body["page_size"] == 1
        assert body["has_more"] is False
        assert body["sort_by"] == "popularity"
        assert body["sort_order"] == "desc"
        assert [item["template_id"] for item in body["items"]] == ["tpl_finance_v1"]
        assert body["items"][0]["tags"] == ["财务", "预算"]

        status, body = _get("/api/team/talent-market/templates?tag=协作")
        assert status == 200, body
        assert [item["template_id"] for item in body["items"]] == ["tpl_ops_v1"]

        status, body = _get("/api/team/templates")
        assert status == 200, body
        assert all(item["template_id"] != "tpl_draft_only" for item in body["items"])

    def test_template_list_uses_prompt_pack_tags_instead_of_category_only(self, seeded_enterprise):
        status, body = _get("/api/team/talent-market/templates")
        assert status == 200, body
        template = next(item for item in body["items"] if item["template_id"] == seeded_enterprise["template_id"])
        assert template["tags"] == ["营销", "策略"]

    def test_unpublished_template_is_hidden_from_team_marketplace(self, seeded_enterprise):
        template_id = seeded_enterprise["template_id"]
        patch_status, patched = _patch(
            f"/api/system-admin/templates/{template_id}?role=system_admin",
            {"publish_action": "unpublish"},
        )
        assert patch_status == 200, patched
        status, body = _get("/api/team/templates")
        assert status == 200, body
        assert all(item["template_id"] != template_id for item in body["items"])


class TestTalentTemplateDetail:
    """S06-T03: GET /api/team/talent-market/templates/{id}."""

    def test_get_existing_template_returns_200(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        status, body = _get(f"/api/team/talent-market/templates/{tpl_id}")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_get_missing_template_returns_404(self, seeded_enterprise):
        status, body = _get("/api/team/talent-market/templates/nonexistent")
        assert status == 404, f"Expected 404, got {status}: {body}"
        assert body.get("error") == "TEMPLATE_NOT_FOUND"

    def test_template_detail_has_expected_shape(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        _, body = _get(f"/api/team/talent-market/templates/{tpl_id}")
        for key in ("template_id", "name", "category", "description", "default_skills",
                     "default_memory_config", "price_tier"):
            assert key in body, f"Missing {key} in template detail: {body}"
        assert body["default_skills"] == ["web_search", "slides"]
        assert body["default_model_ref"]["model"] == "gpt-4o"
        assert body["knowledge_bindings"] == [{"knowledge_id": "kb_style_guide", "scope": "enterprise"}]
        assert body["connector_requirements"] == [{"connector_type": "web_search", "required": False}]
        assert body["default_memory_config"]["max_tokens"] == 8000
        assert body["price_tier"] == "standard"
        assert body["tags"] == ["营销", "策略"]

    def test_admin_template_alias_returns_same_detail_shape(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        status, body = _get(f"/api/team/templates/{tpl_id}")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["template_id"] == tpl_id
        assert body["default_skills"] == ["web_search", "slides"]

    def test_admin_template_detail_requires_manage_employees_for_member(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        status, body = _get(f"/api/team/templates/{tpl_id}?role=member")
        assert status == 403, body
        assert body["required_action"] == "manage_employees"

    def test_admin_template_alias_returns_404_for_unpublished_template(self, seeded_enterprise, db_conn):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO agent_template (id, name, category_code, role_name, status, prompt_pack_json, default_model_json, default_binding_json, version_no, source_type) "
                "VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s)",
                ("tpl_draft_detail", "草稿详情模板", "ops", "operator", "draft", "{}", "{}", "{}", 1, "system"),
            )
            db_conn.commit()
        finally:
            cur.close()
        status, body = _get("/api/team/templates/tpl_draft_detail")
        assert status == 404, body
        assert body["error"] == "TEMPLATE_NOT_FOUND"


class TestConversationDetail:
    """S06-T05: GET /api/team/conversations/{id}."""

    def test_get_existing_conversation_returns_200(self, seeded_enterprise):
        conv_id = seeded_enterprise["conversation_id"]
        status, body = _get(f"/api/team/conversations/{conv_id}")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_get_missing_conversation_returns_404(self, seeded_enterprise):
        status, body = _get("/api/team/conversations/nonexistent")
        assert status == 404
        assert body.get("error") == "CONVERSATION_NOT_FOUND"

    def test_conversation_detail_has_expected_shape(self, seeded_enterprise):
        conv_id = seeded_enterprise["conversation_id"]
        _, body = _get(f"/api/team/conversations/{conv_id}")
        for key in ("conversation_id", "conversation_type", "status", "created_at"):
            assert key in body, f"Missing {key}: {body}"

    def test_conversation_detail_includes_message_page_and_employee_summary(self, seeded_enterprise):
        conv_id = seeded_enterprise["conversation_id"]
        _, body = _get(f"/api/team/conversations/{conv_id}")
        assert "messages" in body
        assert body["messages"]["items"] == []
        assert body["messages"]["next_cursor"] == 0
        assert body["messages"]["has_more"] is False
        assert body["employee_summary"]["employee_id"] == seeded_enterprise["employee_id"]
        assert body["employee_summary"]["role_name"] == "市场分析"
        assert body["employee_summary"]["usage_summary"]["total_runs"] == 0


class TestGroupConversationDetail:
    def test_post_group_conversation_creates_northbound_group_entry(self, seeded_enterprise):
        status, body = _post(
            "/api/team/group-conversations",
            {
                "title": "Ops Sync",
                "member_employee_ids": ["emp_test", "emp_member"],
                "created_by": "user_owner",
            },
        )
        assert status == 201, body
        assert body["title"] == "Ops Sync"
        assert body["member_count"] == 2
        assert body["status"] == "active"
        assert body["navigation"]["conversation"].startswith("/app/group/")

        detail_status, detail = _get(f"/api/team/group-conversations/{body['conversation_id']}")
        assert detail_status == 200, detail
        assert detail["member_count"] == 2
        assert sorted(member["employee_id"] for member in detail["members"]) == ["emp_member", "emp_test"]

    def test_get_group_conversation_returns_contract_shape(self, uow, clean_tables_with_enterprise):
        from team_panel.application.commands.conversation_service import create_group_conversation, submit_group_message

        with uow:
            conv_id = create_group_conversation(
                uow,
                "ent_test",
                "Strategy Sync",
                ["emp_test", "emp_member", "emp_planner"],
                "user_test",
            )
            submit_group_message(
                uow,
                conv_id,
                "emp_member emp_planner please collaborate on the brief",
                "orchestration",
                "group-detail-contract-001",
                "emp_test",
            )

        status, body = _get(f"/api/team/group-conversations/{conv_id}")
        assert status == 200, body
        for key in (
            "conversation_id",
            "conversation_type",
            "title",
            "status",
            "display_state",
            "default_route_hint",
            "member_count",
            "members",
            "latest_run",
            "timeline",
            "latest_route_decision",
            "task_tree",
            "created_at",
        ):
            assert key in body, f"Missing {key}: {body}"
        assert body["conversation_type"] == "group"
        assert body["member_count"] == 4
        assert len(body["members"]) == 4
        system_planner = next(member for member in body["members"] if member.get("is_system_planner"))
        assert system_planner["display_name"] == "协作主持人"
        assert body["latest_run"]["run_id"].startswith("run_")
        assert body["latest_run"]["runtime_handle"]["kind"] == "kanban_task"
        assert body["timeline"]["latest_event_cursor"] == 0
        assert body["latest_route_decision"]["route_mode"] == "orchestration"
        assert sorted(body["latest_route_decision"]["candidate_employee_ids"]) == ["emp_member", "emp_planner", "emp_test"]
        assert system_planner["employee_id"] not in body["latest_route_decision"]["candidate_employee_ids"]
        assert isinstance(body["task_tree"]["items"], list)

    def test_get_group_conversation_missing_returns_404(self, seeded_enterprise):
        status, body = _get("/api/team/group-conversations/nonexistent")
        assert status == 404
        assert body.get("error") == "CONVERSATION_NOT_FOUND"

    def test_group_conversation_member_add_remove_and_archive_flow(self, seeded_enterprise):
        create_status, created = _post(
            "/api/team/group-conversations",
            {
                "title": "Launch Squad",
                "member_employee_ids": ["emp_test", "emp_member"],
                "created_by": "user_owner",
            },
        )
        assert create_status == 201, created
        conv_id = created["conversation_id"]

        add_status, add_body = _post(
            f"/api/team/group-conversations/{conv_id}/members",
            {"employee_id": "emp_planner"},
        )
        assert add_status == 200, add_body
        assert add_body["employee_id"] == "emp_planner"
        assert add_body["status"] == "active"

        detail_status, detail = _get(f"/api/team/group-conversations/{conv_id}")
        assert detail_status == 200, detail
        assert detail["member_count"] == 4
        system_planner = next(member for member in detail["members"] if member.get("is_system_planner"))
        planner_remove_status, planner_remove_body = _delete(
            f"/api/team/group-conversations/{conv_id}/members/{system_planner['member_id']}"
        )
        assert planner_remove_status == 409, planner_remove_body
        assert planner_remove_body["error"] == "GROUP_MEMBER_REMOVE_FAILED"
        removed_member = next(member for member in detail["members"] if member["employee_id"] == "emp_member")

        remove_status, remove_body = _delete(
            f"/api/team/group-conversations/{conv_id}/members/{removed_member['member_id']}"
        )
        assert remove_status == 200, remove_body
        assert remove_body["member_id"] == removed_member["member_id"]
        assert remove_body["status"] == "removed"

        detail_status, detail = _get(f"/api/team/group-conversations/{conv_id}")
        assert detail_status == 200, detail
        assert detail["member_count"] == 3
        assert sorted(member["employee_id"] for member in detail["members"] if not member.get("is_system_planner")) == ["emp_planner", "emp_test"]
        assert any(member.get("is_system_planner") for member in detail["members"])

        archive_status, archive_body = _delete(f"/api/team/group-conversations/{conv_id}")
        assert archive_status == 200, archive_body
        assert archive_body["conversation_id"] == conv_id
        assert archive_body["status"] == "archived"

        archived_status, archived_detail = _get(f"/api/team/group-conversations/{conv_id}")
        assert archived_status == 200, archived_detail
        assert archived_detail["status"] == "archived"


class TestEmployeeList:
    """S06-T10: GET /api/team/employees."""

    def test_get_employees_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/employees?role=owner")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_employees_response_has_correct_structure(self, seeded_enterprise):
        _, body = _get("/api/team/employees?role=owner")
        assert "employees" in body
        assert "total" in body
        assert "page" in body
        assert "limit" in body
        assert isinstance(body["employees"], list)
        assert body["total"] >= 1

    def test_employee_items_have_expected_shape(self, seeded_enterprise):
        _, body = _get("/api/team/employees?role=owner")
        employees = body["employees"]
        emp = employees[0]
        for key in ("employee_id", "display_name", "role_name", "status", "presence"):
            assert key in emp, f"Missing {key} in employee: {emp}"

    def test_finance_admin_cannot_list_employees(self, seeded_enterprise):
        status, body = _get("/api/team/employees?role=finance_admin")
        assert status == 403
        assert body.get("error") == "FORBIDDEN"


class TestEmployeeProfileReconcile:
    """Both creation and update must push config to the Hermes profile via the
    single shared _reconcile_employee_profile entry (no model/persona drift)."""

    def test_create_routes_through_shared_reconcile_with_model(self, seeded_enterprise, monkeypatch):
        from team_panel.api_team import router_team
        calls = []
        monkeypatch.setattr(
            router_team, "_reconcile_employee_profile",
            lambda cur, employee, **kw: calls.append((employee.id, employee.model_provider, employee.model_name)),
        )
        status, body = _post(
            "/api/team/employees?role=owner",
            {"display_name": "建档测试", "model_provider": "openrouter", "model_name": "claude-opus-4-8"},
        )
        assert status == 201, body
        assert calls, "create must reconcile the profile via the shared entry"
        assert calls[-1][1] == "openrouter" and calls[-1][2] == "claude-opus-4-8", calls

    def test_patch_model_change_reconciles_profile(self, seeded_enterprise, monkeypatch):
        from team_panel.api_team import router_team
        calls = []
        def spy(cur, employee, *, system_prompt=None):
            calls.append((employee.id, employee.model_provider, employee.model_name))
        monkeypatch.setattr(router_team, "_reconcile_employee_profile", spy)
        emp_id = seeded_enterprise["employee_id"]
        status, body = _patch(
            f"/api/team/employees/{emp_id}?role=owner",
            {"model_provider": "openrouter", "model_name": "claude-opus-4-8"},
        )
        assert status == 200, body
        assert body["reprovision_status"] == "reconciled"
        assert calls, "PATCH must reconcile the profile so the new model reaches the runtime"
        assert calls[-1] == (emp_id, "openrouter", "claude-opus-4-8"), calls

    def test_patch_persona_change_reconciles_profile(self, seeded_enterprise, monkeypatch):
        from team_panel.api_team import router_team
        calls = []
        monkeypatch.setattr(
            router_team, "_reconcile_employee_profile",
            lambda cur, employee, **kw: calls.append(employee.id),
        )
        emp_id = seeded_enterprise["employee_id"]
        status, body = _patch(
            f"/api/team/employees/{emp_id}?role=owner",
            {"prompt_system": "你是一名严谨的市场分析师。"},
        )
        assert status == 200, body
        assert calls, "PATCH persona change must reconcile the profile (SOUL drift fix)"


class TestEmployeeCreateDelete:
    """POST /api/team/employees (direct create) and DELETE /api/team/employees/{id}."""

    def test_create_employee_returns_201_and_appears_in_list(self, seeded_enterprise):
        status, body = _post(
            "/api/team/employees?role=owner",
            {"display_name": "市场新人", "role_name": "市场专员"},
        )
        assert status == 201, f"Expected 201, got {status}: {body}"
        assert body["employee_id"].startswith("emp_")
        assert body["conversation_id"].startswith("conv_")
        assert body["status"] == "active"
        _, listing = _get("/api/team/employees?role=owner")
        ids = {e["employee_id"] for e in listing["employees"]}
        assert body["employee_id"] in ids

    def test_create_employee_requires_display_name(self, seeded_enterprise):
        status, body = _post("/api/team/employees?role=owner", {"role_name": "市场专员"})
        assert status == 400
        assert body.get("error") == "MISSING_DISPLAY_NAME"

    def test_create_employee_forbidden_for_finance_admin(self, seeded_enterprise):
        status, body = _post("/api/team/employees?role=finance_admin", {"display_name": "X"})
        assert status == 403
        assert body.get("error") == "FORBIDDEN"

    def test_delete_employee_soft_deletes_and_disappears(self, seeded_enterprise):
        _, created = _post("/api/team/employees?role=owner", {"display_name": "待删除"})
        emp_id = created["employee_id"]
        status, body = _delete(f"/api/team/employees/{emp_id}?role=owner")
        assert status == 200, body
        assert body["status"] == "deleted"
        _, listing = _get("/api/team/employees?role=owner")
        ids = {e["employee_id"] for e in listing["employees"]}
        assert emp_id not in ids
        detail_status, _ = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert detail_status == 404

    def test_delete_missing_employee_returns_404(self, seeded_enterprise):
        status, body = _delete("/api/team/employees/nonexistent?role=owner")
        assert status == 404
        assert body.get("error") == "EMPLOYEE_NOT_FOUND"

    def test_delete_employee_forbidden_for_member(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, body = _delete(f"/api/team/employees/{emp_id}?role=member")
        assert status == 403
        assert body.get("error") == "FORBIDDEN"


class TestEmployeeDetail:
    """S06-T11: GET /api/team/employees/{id}."""

    def test_get_existing_employee_returns_200(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, body = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_get_missing_employee_returns_404(self, seeded_enterprise):
        status, body = _get("/api/team/employees/nonexistent?role=owner")
        assert status == 404
        assert body.get("error") == "EMPLOYEE_NOT_FOUND"

    def test_employee_detail_has_expected_shape(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        _, body = _get(f"/api/team/employees/{emp_id}?role=owner")
        for key in ("employee_id", "display_name", "role_name", "status", "presence",
                     "profile_config", "usage_summary", "created_at"):
            assert key in body, f"Missing {key}: {body}"

    def test_employee_detail_exposes_complete_capability_and_loop_surfaces(self, seeded_enterprise, db_conn):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO enterprise_connector (id, enterprise_id, name, provider_code, connector_type, credential_ref, status) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                ("conn_docs", seeded_enterprise["enterprise_id"], "Docs Connector", "test", "api_key_connector", "cred://docs", "online"),
            )
            cur.execute(
                "INSERT INTO employee_memory_binding (id, enterprise_id, employee_id, memory_mode, provider_code, retention_days, writeback_enabled, binding_version) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                ("mem_emp_detail", seeded_enterprise["enterprise_id"], seeded_enterprise["employee_id"], "builtin", "mem0", 30, True, 2),
            )
            cur.execute(
                "INSERT INTO employee_prompt (employee_id, system_prompt, behavior_rules_json, opening_message, version_no, source_template_version) VALUES (%s, %s, %s::jsonb, %s, %s, %s)",
                (seeded_enterprise["employee_id"], "Stay truthful", '{"tone": "direct"}', "Ready to help", 4, 1),
            )
            cur.execute(
                "INSERT INTO employee_knowledge_binding (id, enterprise_id, employee_id, knowledge_base_id, scope_mode, enabled) VALUES (%s, %s, %s, %s, %s, %s)",
                ("ekb_detail", seeded_enterprise["enterprise_id"], seeded_enterprise["employee_id"], "kb_marketing", "read", True),
            )
            cur.execute(
                "INSERT INTO employee_connector_binding (id, enterprise_id, employee_id, connector_id, access_mode, enabled) VALUES (%s, %s, %s, %s, %s, %s)",
                ("ecb_detail", seeded_enterprise["enterprise_id"], seeded_enterprise["employee_id"], "conn_docs", "invoke", True),
            )
            cur.execute(
                "INSERT INTO scheduled_job (id, enterprise_id, employee_id, name, goal, schedule_expr, status, max_consecutive_failures, consecutive_failures, last_run_status, last_run_at, last_success_at, runtime_job_id, notification_policy_json, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz, %s::timestamptz, %s, %s::jsonb, %s)",
                ("job_detail", seeded_enterprise["enterprise_id"], seeded_enterprise["employee_id"], "Daily monitor", "Check dashboards", "0 9 * * *", "enabled", 3, 1, "succeeded", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z", "job_detail", '{"on_failure": "email"}', "user_test"),
            )
            cur.execute(
                "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, scheduled_job_id, result_summary_json, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)",
                ("run_detail", seeded_enterprise["enterprise_id"], seeded_enterprise["conversation_id"], "scheduled_job", "cron_single_agent", "succeeded", seeded_enterprise["employee_id"], "job_detail", '{"summary": "done"}', "user_test"),
            )
            cur.execute(
                "INSERT INTO usage_ledger (id, enterprise_id, employee_id, conversation_id, run_id, input_tokens, output_tokens, total_tokens, cost_cents, source_type, occurred_at, created_by, updated_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz, %s, %s)",
                ("ulg_detail", seeded_enterprise["enterprise_id"], seeded_enterprise["employee_id"], seeded_enterprise["conversation_id"], "run_detail", 10, 22, 32, 5, "run_summary", "2026-06-02T09:00:00Z", "user_test", "user_test"),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _get(f"/api/team/employees/{seeded_enterprise['employee_id']}?role=owner")
        assert status == 200, body
        assert body["profile_config"]["knowledge"] == ["kb_marketing"]
        assert body["profile_config"]["connectors"] == [{
            "connector_id": "conn_docs",
            "access_mode": "invoke",
            "enabled": True,
        }]
        assert body["usage_summary"] == {
            "total_runs": 1,
            "total_tokens": 32,
            "last_run_at": body["run_summary"]["last_run_at"],
        }
        assert body["run_summary"]["latest_run_id"] == "run_detail"
        assert body["run_summary"]["latest_trigger_type"] == "scheduled_job"
        assert body["run_summary"]["total_cost_cents"] == 5
        assert body["scheduled_jobs"] == [{
            "scheduled_job_id": "job_detail",
            "name": "Daily monitor",
            "goal": "Check dashboards",
            "schedule_expr": "0 9 * * *",
            "status": "enabled",
            "max_consecutive_failures": 3,
            "consecutive_failures": 1,
            "last_run_status": "succeeded",
            "last_run_at": "2026-06-02 09:00:00+00:00",
            "last_success_at": "2026-06-02 09:00:00+00:00",
            "runtime_job_id": "job_detail",
            "notification_policy": {"on_failure": "email"},
        }]
        binding_counts = {item["binding_type"]: item["count"] for item in body["bindings_summary"]}
        assert binding_counts["knowledge_bases"] == 1
        assert binding_counts["connectors"] == 1
        assert binding_counts["loop"] == 1


class TestEmployeeConversationHistory:
    """GET /api/team/employees/{id}/conversations — private history picker source."""

    def test_missing_employee_returns_404(self, seeded_enterprise):
        status, body = _get("/api/team/employees/nonexistent/conversations")
        assert status == 404
        assert body.get("error") == "EMPLOYEE_NOT_FOUND"

    def test_lists_private_conversations_newest_first(self, seeded_enterprise, db_conn):
        emp_id = seeded_enterprise["employee_id"]
        ent_id = seeded_enterprise["enterprise_id"]
        cur = db_conn.cursor()
        try:
            # Seed an older + a newer private conversation alongside the fixture's conv_test.
            cur.execute(
                "INSERT INTO conversation (id, enterprise_id, type, status, title, entry_employee_id, "
                "last_message_preview, last_message_at, created_by) "
                "VALUES (%s, %s, 'private', 'active', %s, %s, %s, %s, 'user_test')",
                ("conv_old", ent_id, "Older Chat", emp_id, "old preview", "2026-06-10 09:00:00+00"),
            )
            cur.execute(
                "INSERT INTO conversation (id, enterprise_id, type, status, title, entry_employee_id, "
                "last_message_preview, last_message_at, created_by) "
                "VALUES (%s, %s, 'private', 'active', %s, %s, %s, %s, 'user_test')",
                ("conv_new", ent_id, "Newer Chat", emp_id, "new preview", "2026-06-14 09:00:00+00"),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _get(f"/api/team/employees/{emp_id}/conversations")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["employee_id"] == emp_id
        ids = [item["conversation_id"] for item in body["items"]]
        # All three private chats are present; newer activity sorts ahead of older.
        assert {"conv_test", "conv_new", "conv_old"} <= set(ids)
        assert ids.index("conv_new") < ids.index("conv_old")
        new_item = next(item for item in body["items"] if item["conversation_id"] == "conv_new")
        for key in ("conversation_id", "title", "status", "last_preview", "last_message_at", "navigation_target"):
            assert key in new_item, f"Missing {key}: {new_item}"
        assert new_item["navigation_target"] == "/app/chat/conv_new"

    def test_excludes_other_employees(self, seeded_enterprise):
        # emp_planner has no private conversations seeded → empty list, still 200.
        status, body = _get("/api/team/employees/emp_planner/conversations")
        assert status == 200
        assert body["items"] == []


class TestGovernanceBillingAndExport:
    def test_billing_overview_requires_billing_permission(self, seeded_enterprise):
        status, body = _get("/api/team/billing/usage/overview?role=member")
        assert status == 403
        assert body.get("required_action") == "view_billing"

    def test_billing_overview_returns_real_totals(self, seeded_enterprise, db_conn):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO team_run (id, enterprise_id, conversation_id, trigger_type, execution_mode, status, entry_employee_id, result_summary_json, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)",
                (
                    "run_bill_001",
                    seeded_enterprise["enterprise_id"],
                    seeded_enterprise["conversation_id"],
                    "manual_run",
                    "single_agent",
                    "succeeded",
                    seeded_enterprise["employee_id"],
                    '{"total_tokens": 42, "cost_cents": 7}',
                    "user_test",
                ),
            )
            db_conn.commit()
        finally:
            cur.close()
        status, body = _get("/api/team/billing/usage/overview?role=owner&period_start=2000-01-01&period_end=2099-12-31")
        assert status == 200
        assert body["total_tokens"] >= 42
        assert body["total_cost_cents"] >= 7

    def test_billing_alias_returns_deprecated_metadata(self, seeded_enterprise):
        status, body = _get("/api/enterprise-admin/billing/usage?role=owner")
        assert status == 200
        assert body.get("deprecated") is True
        assert body.get("canonical_path") == "/api/team/billing/usage/overview"

    def test_employees_export_returns_csv(self, seeded_enterprise):
        handler = _get_raw("/api/team/employees/export?role=owner")
        assert handler.status == 200
        ct = _handler_content_type(handler)
        assert ct is not None and "text/csv" in ct
        text = _handler_text(handler)
        assert "employee_id,display_name,role_name,status" in text
        assert "emp_test,Test Analyst" in text

    def test_billing_records_export_requires_export_permission(self, seeded_enterprise):
        handler = _get_raw("/api/team/billing/usage/records/export?role=member")
        assert handler.status == 403

    def test_audit_events_returns_employee_update(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, _ = _patch(
            f"/api/team/employees/{emp_id}?role=owner&actor_id=user_test&request_id=req_audit",
            {"display_name": "Governed Analyst"},
        )
        assert status == 200
        status, body = _get("/api/team/audit-events?role=owner&target_type=employee&target_id=emp_test")
        assert status == 200
        assert body["total"] >= 1
        matching = [item for item in body["items"] if item["event_type"] == "employee.updated"]
        assert matching
        assert matching[0]["request_id"] == "req_audit"
        assert matching[0]["payload"]["display_name"] == "Governed Analyst"


# ═══════════════════════════════════════════════════════════════════════════
# Batch 2: POST endpoints
# ═══════════════════════════════════════════════════════════════════════════

class TestRecruitmentsPost:
    """S06-T04: POST /api/team/recruitments."""

    def test_post_recruitment_returns_201_with_contract_shape(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        body = {
            "template_id": tpl_id,
            "display_name": "My Analyst",
            "idempotency_key": f"recruit-{uuid.uuid4().hex[:8]}",
        }
        status, resp = _post("/api/team/recruitments", body)
        assert status == 201, f"Expected 201, got {status}: {resp}"

    def test_recruitment_response_has_required_fields(self, seeded_enterprise):
        tpl_id = seeded_enterprise["template_id"]
        body = {"template_id": tpl_id, "display_name": "New Analyst"}
        _, resp = _post("/api/team/recruitments", body)
        for key in ("order_id", "status", "employee_id", "profile_name"):
            assert key in resp, f"Missing {key}: {resp}"
        assert resp["status"] == "succeeded"


class TestRunsPost:
    """S06-T06: POST /api/team/runs."""

    def test_post_run_returns_201(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        conv_id = seeded_enterprise["conversation_id"]
        body = {
            "employee_id": emp_id,
            "conversation_id": conv_id,
            "message": {"text": "Hello"},
            "idempotency_key": f"run-{uuid.uuid4().hex[:8]}",
        }
        status, resp = _post("/api/team/runs", body)
        assert status == 201, f"Expected 201, got {status}: {resp}"

    def test_run_response_has_required_fields(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {
            "employee_id": emp_id,
            "conversation_id": seeded_enterprise["conversation_id"],
            "message": {"text": "Hello"},
        }
        _, resp = _post("/api/team/runs", body)
        for key in ("run_id", "status", "conversation_id", "stream_url", "events_url", "runtime_handle"):
            assert key in resp, f"Missing {key}: {resp}"
        assert resp["status"] == "queued"
        assert resp["runtime_handle"]["kind"] == "session"
        assert resp["runtime_handle"]["profile_name"] == emp_id
        assert resp["runtime_handle"]["session_id"].startswith("sess_")
        assert resp["run_id"] in resp["stream_url"]
        assert resp["run_id"] in resp["events_url"]

    def test_post_run_persists_runtime_binding_with_real_session_handle(self, seeded_enterprise, db_conn):
        body = {
            "employee_id": seeded_enterprise["employee_id"],
            "conversation_id": seeded_enterprise["conversation_id"],
            "message": {"text": "Need a real runtime handle"},
            "idempotency_key": f"run-{uuid.uuid4().hex[:8]}",
        }
        status, resp = _post("/api/team/runs", body)
        assert status == 201, resp
        runtime_handle = resp["runtime_handle"]
        assert runtime_handle["kind"] == "session"
        assert runtime_handle["profile_name"] == seeded_enterprise["employee_id"]
        assert runtime_handle["session_id"].startswith("sess_")

        with UnitOfWork(db_conn) as uow:
            binding = uow.runtime_bindings().get_by_owner("team_run", resp["run_id"])
            assert binding is not None
            assert binding.runtime_kind == "session"
            assert binding.profile_name == seeded_enterprise["employee_id"]
            assert binding.runtime_session_id == runtime_handle["session_id"]
            assert binding.runtime_session_id is not None


class TestRunControls:
    def test_post_run_retry_replays_original_message_with_new_run(self, seeded_enterprise):
        status, first = _post(
            "/api/team/runs",
            {
                "employee_id": seeded_enterprise["employee_id"],
                "conversation_id": seeded_enterprise["conversation_id"],
                "message": {"text": "Retry me once"},
                "idempotency_key": f"run-{uuid.uuid4().hex[:8]}",
            },
        )
        assert status == 201, first

        status, retry = _post(
            f"/api/team/runs/{first['run_id']}/retry",
            {"idempotency_key": f"retry-{uuid.uuid4().hex[:8]}"},
        )
        assert status == 201, retry
        assert retry["run_id"] != first["run_id"]
        assert retry["conversation_id"] == first["conversation_id"]
        assert retry["retry_of_run_id"] == first["run_id"]
        assert retry["runtime_handle"]["kind"] == "session"

    def test_post_run_abort_marks_run_cancelled_and_advances_numeric_cursor(self, seeded_enterprise):
        status, created = _post(
            "/api/team/runs",
            {
                "employee_id": seeded_enterprise["employee_id"],
                "conversation_id": seeded_enterprise["conversation_id"],
                "message": {"text": "Abort me"},
                "idempotency_key": f"run-{uuid.uuid4().hex[:8]}",
            },
        )
        assert status == 201, created

        status, aborted = _post(
            f"/api/team/runs/{created['run_id']}/abort",
            {"reason": "User stopped this run"},
        )
        assert status == 200, aborted
        assert aborted["run_id"] == created["run_id"]
        assert aborted["status"] == "cancelled"
        assert aborted["aborted"] is True
        assert aborted["event_cursor"] >= 1

        _, events = _get(f"/api/team/runs/{created['run_id']}/events?cursor=0")
        assert events["run_status"] == "cancelled"
        assert events["items"][-1]["event_type"] == "run_cancelled"
        assert events["items"][-1]["event_cursor"] == aborted["event_cursor"]


class TestUploadsPost:
    """S06-T09: POST /api/team/uploads."""

    def test_post_upload_returns_201(self, seeded_enterprise):
        body = {"name": "test.pdf", "size": 1024, "mime_type": "application/pdf"}
        status, resp = _post("/api/team/uploads", body)
        assert status == 201, f"Expected 201, got {status}: {resp}"

    def test_upload_response_has_required_fields(self, seeded_enterprise):
        body = {"name": "doc.pdf"}
        _, resp = _post("/api/team/uploads", body)
        for key in ("asset_id", "name", "size", "mime_type", "storage_key", "preview_url"):
            assert key in resp, f"Missing {key}: {resp}"


# ═══════════════════════════════════════════════════════════════════════════
# Batch 3: Run stream & events
# ═══════════════════════════════════════════════════════════════════════════

class TestRunStream:
    """S06-T07: GET /api/team/runs/{run_id}/stream."""

    def test_get_run_stream_returns_200_and_sse_content_type(self, seeded_enterprise):
        # First create a run
        emp_id = seeded_enterprise["employee_id"]
        body = {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}}
        _, run_resp = _post("/api/team/runs", body)
        run_id = run_resp["run_id"]

        handler = _get_raw(f"/api/team/runs/{run_id}/stream")
        assert handler.status == 200, f"Expected 200, got {handler.status}: {_handler_text(handler)}"
        ct = _handler_content_type(handler)
        assert ct is not None, "Content-Type header missing"
        assert "text/event-stream" in ct, f"Expected text/event-stream, got {ct}"

    def test_stream_for_existing_run_produces_valid_sse_frames(self, seeded_enterprise, db_conn):
        emp_id = seeded_enterprise["employee_id"]
        enterprise_id = seeded_enterprise["enterprise_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
        run_id = run_resp["run_id"]

        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    f"evt_{uuid.uuid4().hex[:8]}",
                    enterprise_id,
                    run_id,
                    1,
                    "run_started",
                    "session",
                    "sess_test",
                    emp_id,
                    "Starting...",
                    json.dumps({"message_id": "msg_001"}),
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        handler = _get_raw(f"/api/team/runs/{run_id}/stream")
        ct = _handler_content_type(handler)
        assert ct is not None and "text/event-stream" in ct
        body_text = _handler_text(handler)
        assert body_text, "Expected at least one SSE frame for seeded run event"

        frames = body_text.rstrip("\n").split("\n\n")
        for frame in frames:
            if not frame:
                continue
            lines = frame.split("\n")
            assert lines[0] == "event: timeline", f"SSE event line mismatch: {lines[0]}"
            assert lines[1].startswith("data: "), f"SSE data line missing: {lines}"
            data_json_str = lines[1][len("data: "):]
            data = json.loads(data_json_str)
            for key in ("event_id", "event_cursor", "run_id", "event_type", "source_type", "source_id", "event_ts"):
                assert key in data, f"RunTimelineEvent missing key: {key}"
            assert data["event_type"] == "run_started"
            assert data["run_id"] == run_id

    def test_stream_resume_replays_only_events_after_cursor(self, seeded_enterprise, db_conn):
        emp_id = seeded_enterprise["employee_id"]
        enterprise_id = seeded_enterprise["enterprise_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
        run_id = run_resp["run_id"]

        cur = db_conn.cursor()
        try:
            cur.executemany(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    (
                        f"evt_{uuid.uuid4().hex[:8]}",
                        enterprise_id,
                        run_id,
                        1,
                        "run_started",
                        "session",
                        "sess_test",
                        emp_id,
                        "Starting...",
                        json.dumps({"message_id": "msg_001"}),
                    ),
                    (
                        f"evt_{uuid.uuid4().hex[:8]}",
                        enterprise_id,
                        run_id,
                        2,
                        "message_delta",
                        "session",
                        "sess_test",
                        emp_id,
                        "Part 1",
                        json.dumps({"message_id": "msg_001", "delta": "Part 1"}),
                    ),
                    (
                        f"evt_{uuid.uuid4().hex[:8]}",
                        enterprise_id,
                        run_id,
                        3,
                        "message_delta",
                        "session",
                        "sess_test",
                        emp_id,
                        "Part 2",
                        json.dumps({"message_id": "msg_001", "delta": "Part 2"}),
                    ),
                ],
            )
            db_conn.commit()
        finally:
            cur.close()

        handler = _get_raw(f"/api/team/runs/{run_id}/stream?cursor=1")
        assert handler.status == 200, f"Expected 200, got {handler.status}: {_handler_text(handler)}"
        ct = _handler_content_type(handler)
        assert ct is not None and "text/event-stream" in ct

        body_text = _handler_text(handler)
        frames = [frame for frame in body_text.rstrip("\n").split("\n\n") if frame]
        payloads = [json.loads(frame.split("\n", 1)[1][len("data: "):]) for frame in frames]

        assert [payload["event_cursor"] for payload in payloads] == [2, 3]
        assert all(payload["event_cursor"] > 1 for payload in payloads)
        assert [payload["event_type"] for payload in payloads] == ["message_delta", "message_delta"]

    def test_stream_for_nonexistent_run_returns_404(self, seeded_enterprise):
        status, resp = _get("/api/team/runs/nonexistent/stream")
        assert status == 404
        assert resp.get("error") == "RUN_NOT_FOUND"

    def test_stream_filters_unknown_event_types(self, seeded_enterprise, db_conn):
        """Regression: /api/team/runs/{run_id}/stream must not leak raw/unknown
        event_type strings in northbound RunTimelineEvent payloads."""
        emp_id = seeded_enterprise["employee_id"]
        enterprise_id = seeded_enterprise["enterprise_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
        run_id = run_resp["run_id"]

        cur = db_conn.cursor()
        try:
            cur.execute(
                "ALTER TABLE run_event DROP CONSTRAINT IF EXISTS run_event_event_type_check"
            )
            cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    f"evt_{uuid.uuid4().hex[:8]}",
                    enterprise_id,
                    run_id,
                    1,
                    "run_started",
                    "session",
                    "sess_test",
                    emp_id,
                    "Starting...",
                    json.dumps({}),
                ),
            )
            cur.execute(
                "INSERT INTO run_event (id, enterprise_id, run_id, cursor_no, event_type, source_type, source_id, employee_id, preview_text, payload_json) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    f"evt_{uuid.uuid4().hex[:8]}",
                    enterprise_id,
                    run_id,
                    2,
                    "internal_debug_trace",
                    "session",
                    "sess_test",
                    emp_id,
                    "Internal trace...",
                    json.dumps({}),
                ),
            )
            db_conn.commit()
        finally:
            cur.close()

        handler = _get_raw(f"/api/team/runs/{run_id}/stream")
        assert handler.status == 200, f"Expected 200, got {handler.status}"
        ct = _handler_content_type(handler)
        assert ct is not None and "text/event-stream" in ct
        body_text = _handler_text(handler)

        # The unknown raw event_type string must not appear in the SSE body
        assert "internal_debug_trace" not in body_text, (
            f"Unknown event_type leaked to SSE: {body_text[:500]}"
        )

        # The valid event should still be present
        assert "run_started" in body_text, (
            f"Valid event_type missing from SSE: {body_text[:500]}"
        )

        # Frames should still be well-formed SSE with valid JSON
        frames = body_text.rstrip("\n").split("\n\n")
        for frame in frames:
            if not frame:
                continue
            lines = frame.split("\n")
            assert lines[0] == "event: timeline", f"SSE event line mismatch: {lines[0]}"
            assert lines[1].startswith("data: "), f"SSE data line missing: {lines}"
            data = json.loads(lines[1][len("data: "):])
            assert data["event_type"] in {"run_started"}, (
                f"Unexpected event_type in frame: {data['event_type']}"
            )

        # Restore the check constraint (delete the unknown-typed row first)
        cur2 = db_conn.cursor()
        try:
            cur2.execute("DELETE FROM run_event WHERE event_type = 'internal_debug_trace'")
            cur2.execute("""
                ALTER TABLE run_event ADD CONSTRAINT run_event_event_type_check
                CHECK(event_type IN ('run_created','routing_decided','run_started','message_delta','tool_call','task_created','task_started','task_completed','task_failed','run_waiting_human','result_merged','memory_written','usage_recorded','run_succeeded','run_failed','run_cancelled','heartbeat','error'))
            """)
            db_conn.commit()
        finally:
            cur2.close()


class TestRunEvents:
    """S06-T08: GET /api/team/runs/{run_id}/events."""

    def test_get_run_events_returns_200(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
        run_id = run_resp["run_id"]

        status, resp = _get(f"/api/team/runs/{run_id}/events")
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_events_response_has_cursor_pagination_shape(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        _, run_resp = _post("/api/team/runs", {"employee_id": emp_id, "conversation_id": seeded_enterprise["conversation_id"], "message": {"text": "Hello"}})
        run_id = run_resp["run_id"]

        _, resp = _get(f"/api/team/runs/{run_id}/events")
        for key in ("items", "next_cursor", "has_more", "run_status"):
            assert key in resp, f"Missing {key}: {resp}"
        assert isinstance(resp["items"], list)
        assert isinstance(resp["next_cursor"], int)
        assert isinstance(resp["has_more"], bool)

    def test_events_for_nonexistent_run_returns_404(self, seeded_enterprise):
        status, resp = _get("/api/team/runs/nonexistent/events")
        assert status == 404
        assert resp.get("error") == "RUN_NOT_FOUND"


# ═══════════════════════════════════════════════════════════════════════════
# Batch 4: PATCH employee
# ═══════════════════════════════════════════════════════════════════════════

class TestEmployeePatch:
    """S06-T12: PATCH /api/team/employees/{id}."""

    def test_patch_display_name_returns_200(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"display_name": "Updated Analyst"}
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner&actor_id=user_test", body)
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["display_name"] == "Updated Analyst"

    def test_patch_status_active_to_paused(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"status": "paused"}
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["status"] == "paused"

    def test_patch_invalid_status_transition_rejected(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        # active -> provisioning_failed is not a valid transition
        body = {"status": "provisioning_failed"}
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "INVALID_STATUS_TRANSITION"

    def test_patch_archived_employee_cannot_be_modified(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        # First archive the employee
        _patch(f"/api/team/employees/{emp_id}?role=owner", {"status": "archived"})
        # Now try to transition from archived to active
        body = {"status": "active"}
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        assert status == 400
        assert resp.get("error") == "INVALID_STATUS_TRANSITION"

    def test_patch_unknown_field_rejected(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"unknown_field": "value"}
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "INVALID_FIELD"

    def test_patch_nonexistent_employee_returns_404(self, seeded_enterprise):
        status, resp = _patch("/api/team/employees/nonexistent?role=owner", {"display_name": "x"})
        assert status == 404
        assert resp.get("error") == "EMPLOYEE_NOT_FOUND"

    def test_patch_response_has_expected_shape(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        body = {"display_name": "Final Name"}
        _, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", body)
        for key in ("employee_id", "display_name", "status", "updated_at", "audit_event_id", "audit_event_ids"):
            assert key in resp, f"Missing {key}: {resp}"
        assert resp["audit_event_id"]
        assert isinstance(resp["audit_event_ids"], list) and resp["audit_event_ids"]

    def test_finance_admin_cannot_patch_employee(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=finance_admin", {"display_name": "Nope"})
        assert status == 403
        assert resp["required_action"] == "manage_employees"

    def test_patch_complete_capability_fields_persist(self, seeded_enterprise, db_conn):
        _, create_resp = _post("/api/team/connectors", {
            "name": "Docs Connector",
            "provider_code": "test",
        })
        connector_id = create_resp["connector_id"]
        cur = db_conn.cursor()
        try:
            cur.execute(
                "UPDATE enterprise_connector SET status='online' WHERE id=%s",
                (connector_id,),
            )
            db_conn.commit()
        finally:
            cur.close()

        emp_id = seeded_enterprise["employee_id"]
        body = {
            "model_provider": "anthropic",
            "model_name": "claude-3-7-sonnet",
            "prompt_version": 6,
            "prompt_system": "Use evidence first",
            "prompt_behavior_rules_json": '{"tone":"concise"}',
            "prompt_opening_message": "Ready.",
            "memory_mode": "external",
            "memory_provider_code": "memx",
            "memory_retention_days": 45,
            "memory_writeback_enabled": False,
            "knowledge_base_ids": ["kb_ops"],
            "connector_ids": [connector_id],
            "scheduled_job": {
                "name": "Morning Ops Loop",
                "goal": "Check alerts",
                "schedule_expr": "0 8 * * *",
                "status": "enabled",
                "max_consecutive_failures": 4,
                "notification_policy": {"on_failure": "email"},
            },
        }
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner&actor_id=user_test", body)
        assert status == 200, resp

        detail_status, detail = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert detail_status == 200, detail
        assert detail["model_provider"] == "anthropic"
        assert detail["model_name"] == "claude-3-7-sonnet"
        assert detail["prompt_version"] == 6
        assert detail["prompt_config"] == {
            "system_prompt": "Use evidence first",
            "behavior_rules_json": '{"tone": "concise"}',
            "opening_message": "Ready.",
            "version_no": 6,
        }
        assert detail["recent_audit_events"]
        assert any(item["event_type"] == "employee.updated" for item in detail["recent_audit_events"])
        assert any(item["event_type"] == "scheduled_job.create" for item in detail["recent_audit_events"])
        assert detail["profile_config"]["memory_config"] == {
            "mode": "external",
            "provider_code": "memx",
            "retention_days": 45,
            "writeback_enabled": False,
        }
        assert detail["profile_config"]["knowledge"] == ["kb_ops"]
        assert detail["profile_config"]["connectors"] == [{
            "connector_id": connector_id,
            "access_mode": "invoke",
            "enabled": True,
        }]
        assert len(detail["scheduled_jobs"]) == 1
        scheduled_job = detail["scheduled_jobs"][0]
        assert scheduled_job["name"] == "Morning Ops Loop"
        assert scheduled_job["goal"] == "Check alerts"
        assert scheduled_job["schedule_expr"] == "0 8 * * *"
        assert scheduled_job["status"] == "enabled"
        assert scheduled_job["max_consecutive_failures"] == 4
        assert scheduled_job["notification_policy"] == {"on_failure": "email"}

    def test_patch_scheduled_job_action_pause_resume_archive(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        create_status, create_resp = _patch(
            f"/api/team/employees/{emp_id}?role=owner&actor_id=user_test",
            {
                "scheduled_job": {
                    "name": "Status Loop",
                    "goal": "Watch status",
                    "schedule_expr": "*/10 * * * *",
                    "status": "enabled",
                }
            },
        )
        assert create_status == 200
        assert create_resp["audit_event_ids"]

        detail_status, detail = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert detail_status == 200
        scheduled_job_id = detail["scheduled_jobs"][0]["scheduled_job_id"]
        assert any(item["event_type"] == "scheduled_job.create" for item in detail["recent_audit_events"])

        pause_status, pause_resp = _patch(
            f"/api/team/employees/{emp_id}?role=owner&actor_id=user_test",
            {"scheduled_job_action": "pause", "scheduled_job": {"scheduled_job_id": scheduled_job_id}},
        )
        assert pause_status == 200
        assert pause_resp["audit_event_ids"]
        _, paused_detail = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert paused_detail["scheduled_jobs"][0]["status"] == "paused"
        assert any(item["event_type"] == "scheduled_job.pause" for item in paused_detail["recent_audit_events"])

        resume_status, resume_resp = _patch(
            f"/api/team/employees/{emp_id}?role=owner&actor_id=user_test",
            {"scheduled_job_action": "resume", "scheduled_job": {"scheduled_job_id": scheduled_job_id}},
        )
        assert resume_status == 200
        assert resume_resp["audit_event_ids"]
        _, resumed_detail = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert resumed_detail["scheduled_jobs"][0]["status"] == "enabled"
        assert any(item["event_type"] == "scheduled_job.resume" for item in resumed_detail["recent_audit_events"])

        archive_status, archive_resp = _patch(
            f"/api/team/employees/{emp_id}?role=owner&actor_id=user_test",
            {"scheduled_job_action": "archive", "scheduled_job": {"scheduled_job_id": scheduled_job_id}},
        )
        assert archive_status == 200
        assert archive_resp["audit_event_ids"]
        _, archived_detail = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert archived_detail["scheduled_jobs"] == []
        assert any(item["event_type"] == "scheduled_job.archive" for item in archived_detail["recent_audit_events"])


class TestOrgTree:
    def test_get_org_tree_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/org/tree")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["enterprise"]["enterprise_id"] == seeded_enterprise["enterprise_id"]

    def test_org_tree_has_expected_shape(self, seeded_enterprise):
        _, body = _get("/api/team/org/tree")
        for key in ("enterprise", "departments", "unassigned_members", "stats"):
            assert key in body, f"Missing {key}: {body}"
        root = body["departments"][0]
        for key in ("department_id", "name", "visibility_scope", "members", "children"):
            assert key in root, f"Missing {key}: {root}"
        member = root["members"][0]
        for key in ("assignment_id", "employee_id", "department_id", "position_title", "visibility_scope", "presence"):
            assert key in member, f"Missing {key}: {member}"

    def test_org_tree_includes_unassigned_employees(self, seeded_enterprise):
        _, body = _get("/api/team/org/tree")
        unassigned_ids = {item["employee_id"] for item in body["unassigned_members"]}
        assert "emp_member" in unassigned_ids
        assert body["stats"]["unassigned_employee_count"] >= 1


class TestOrgAssignments:
    def test_patch_org_assignment_updates_department_and_position(self, seeded_enterprise):
        assignment_id = seeded_enterprise["employee_id"]
        status, resp = _patch(
            f"/api/team/org/assignments/{assignment_id}",
            {"department_id": "dept_content", "position_title": "内容策划", "visibility_scope": "private"},
        )
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["department_id"] == "dept_content"
        assert resp["position_title"] == "内容策划"
        assert resp["visibility_scope"] == "private"

        _, tree = _get("/api/team/org/tree")
        content_group = tree["departments"][0]["children"][0]
        moved_ids = {member["employee_id"] for member in content_group["members"]}
        assert assignment_id in moved_ids

    def test_patch_org_assignment_allows_unassigned(self, seeded_enterprise):
        assignment_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/org/assignments/{assignment_id}", {"department_id": None})
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert resp["department_id"] is None
        assert resp["department"] is None

    def test_patch_org_assignment_rejects_missing_department(self, seeded_enterprise):
        assignment_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/org/assignments/{assignment_id}", {"department_id": "dept_missing"})
        assert status == 404
        assert resp.get("error") == "DEPARTMENT_NOT_FOUND"

    def test_patch_org_assignment_rejects_invalid_field(self, seeded_enterprise):
        assignment_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/org/assignments/{assignment_id}", {"role_name": "x"})
        assert status == 400
        assert resp.get("error") == "INVALID_FIELD"
class TestSettingsAndBillingB08B09:
    def test_get_settings_returns_enterprise_and_policy_shape(self, seeded_enterprise):
        status, body = _get("/api/team/settings")
        assert status == 200, body
        assert body["enterprise_id"] == seeded_enterprise["enterprise_id"]
        assert body["name"] == "Test Corp"
        assert "invite_code" in body
        assert isinstance(body["notification_policy"], dict)
        assert isinstance(body["admin_invites"], list)

    def test_patch_settings_updates_enterprise_and_notification_policy(self, seeded_enterprise):
        status, body = _patch(
            "/api/team/settings",
            {
                "name": "Updated Corp",
                "contact_phone": "13800138000",
                "notification_policy": {"employee_task_completed": False, "system_announcements": True},
                "low_balance_threshold_cents": 8800,
            },
        )
        assert status == 200, body
        assert body["name"] == "Updated Corp"
        assert body["contact_phone"] == "13800138000"
        assert body["notification_policy"]["employee_task_completed"] is False
        assert body["low_balance_threshold_cents"] == 8800

    def test_post_admin_invite_is_created_and_idempotent(self, seeded_enterprise):
        payload = {
            "phone": "13900001111",
            "role": "enterprise_admin",
            "permissions": {"employees": "write"},
            "idempotency_key": "invite-001",
        }
        status, body = _post("/api/team/settings/admin-invites", payload)
        assert status == 201, body
        assert body["status"] == "pending"
        assert body["phone"] == payload["phone"]

        repeat_status, repeat_body = _post("/api/team/settings/admin-invites", payload)
        assert repeat_status == 200, repeat_body
        assert repeat_body["invite_id"] == body["invite_id"]

        settings_status, settings_body = _get("/api/team/settings")
        assert settings_status == 200, settings_body
        assert any(item["invite_id"] == body["invite_id"] for item in settings_body["admin_invites"])

    def test_enterprise_admin_invites_list_post_and_delete_follow_canonical_namespace(self, seeded_enterprise):
        list_status, list_body = _get("/api/enterprise-admin/invites?role=owner")
        assert list_status == 200, list_body
        assert "items" in list_body
        assert isinstance(list_body["items"], list)

        payload = {
            "phone": "13900003333",
            "role": "enterprise_admin",
            "permissions": {"employees": True, "audit": True},
            "idempotency_key": "invite-enterprise-admin-001",
        }
        create_status, create_body = _post("/api/enterprise-admin/invites?role=owner", payload)
        assert create_status == 201, create_body
        assert create_body["status"] == "pending"
        assert create_body["phone"] == payload["phone"]

        repeat_status, repeat_body = _post("/api/enterprise-admin/invites?role=owner", payload)
        assert repeat_status == 200, repeat_body
        assert repeat_body["invite_id"] == create_body["invite_id"]

        list_status, list_body = _get("/api/enterprise-admin/invites?role=owner")
        assert list_status == 200, list_body
        assert any(item["invite_id"] == create_body["invite_id"] for item in list_body["items"])

        delete_status, delete_body = _delete(f"/api/enterprise-admin/invites/{create_body['invite_id']}?role=owner")
        assert delete_status == 200, delete_body
        assert delete_body["invite_id"] == create_body["invite_id"]
        assert delete_body["status"] == "revoked"

        list_status, list_body = _get("/api/enterprise-admin/invites?role=owner")
        assert list_status == 200, list_body
        assert not any(item["invite_id"] == create_body["invite_id"] for item in list_body["items"])

    def test_delete_admin_invite_revokes_and_hides_from_settings(self, seeded_enterprise):
        payload = {
            "phone": "13900002222",
            "role": "finance_admin",
            "permissions": {"billing": "read"},
            "idempotency_key": "invite-delete-001",
        }
        create_status, create_body = _post("/api/team/settings/admin-invites", payload)
        assert create_status == 201, create_body

        delete_status, delete_body = _delete(f"/api/team/settings/admin-invites/{create_body['invite_id']}")
        assert delete_status == 200, delete_body
        assert delete_body["invite_id"] == create_body["invite_id"]
        assert delete_body["status"] == "revoked"

        settings_status, settings_body = _get("/api/team/settings")
        assert settings_status == 200, settings_body
        assert not any(item["invite_id"] == create_body["invite_id"] for item in settings_body["admin_invites"])

    def test_get_balance_defaults_to_zero_and_low_balance_warning(self, seeded_enterprise):
        status, body = _get("/api/team/billing/balance")
        assert status == 200, body
        assert body["balance"] == "0.00"
        assert body["balance_cents"] == 0
        assert body["low_balance_warning"] is True

    def test_mock_recharge_updates_balance_and_recharge_history(self, seeded_enterprise):
        recharge_status, recharge_body = _post(
            "/api/team/billing/recharges",
            {"amount": 100, "payment_method": "mock_pay", "idempotency_key": "recharge-001"},
        )
        assert recharge_status == 201, recharge_body
        assert recharge_body["status"] == "succeeded"
        assert recharge_body["mock_provider"] is True
        assert recharge_body["token_credited"] > 0

        balance_status, balance_body = _get("/api/team/billing/balance")
        assert balance_status == 200, balance_body
        assert balance_body["balance_cents"] == 10000
        assert balance_body["token_balance"] == recharge_body["token_credited"]
        assert balance_body["low_balance_warning"] is False

        list_status, list_body = _get("/api/team/billing/recharges")
        assert list_status == 200, list_body
        assert list_body["total"] == 1
        assert list_body["items"][0]["recharge_id"] == recharge_body["recharge_id"]

    def test_run_creation_returns_402_when_initialized_balance_is_empty(self, seeded_enterprise):
        balance_status, _ = _get("/api/team/billing/balance")
        assert balance_status == 200
        status, body = _post(
            "/api/team/runs",
            {
                "employee_id": seeded_enterprise["employee_id"],
                "conversation_id": seeded_enterprise["conversation_id"],
                "message": {"text": "Need help reviewing the empty balance case"},
                "idempotency_key": "run-insufficient-001",
            },
        )
        assert status == 402, body
        assert body["error"] == "INSUFFICIENT_BALANCE"
        assert body["recharge_required"] is True

    def test_run_creation_succeeds_after_mock_recharge(self, seeded_enterprise):
        _post(
            "/api/team/billing/recharges",
            {"amount": 50, "payment_method": "mock_pay", "idempotency_key": "recharge-run-001"},
        )
        status, body = _post(
            "/api/team/runs",
            {
                "employee_id": seeded_enterprise["employee_id"],
                "conversation_id": seeded_enterprise["conversation_id"],
                "message": {"text": "Need help after the recharge clears"},
                "idempotency_key": "run-funded-001",
            },
        )
        assert status == 201, body
        assert body["status"] == "queued"
        assert body["run_id"].startswith("run_")


# ═══════════════════════════════════════════════════════════════════════════
# Regression: non-team paths still work
# ═══════════════════════════════════════════════════════════════════════════

def test_non_team_paths_still_work():
    """Unchanged paths should not be caught by team dispatch."""
    for path in ["/api/sessions", "/api/models"]:
        status, body = _get(path)
        # These should not be 200 from team dispatch — they should hit their normal handlers
        # or 404 if no handler, but NOT from our team router
        if status == 200:
            # If we get 200, make sure it's not a team-panel response
            assert "enterprise_id" not in body or "employees" in body, \
                f"Non-team path {path} should not return team workbench data"


# ═══════════════════════════════════════════════════════════════════════════
# Batch C shared integration coverage
# ═══════════════════════════════════════════════════════════════════════════

class TestSolutionsList:
    def test_get_solutions_returns_200(self, seeded_enterprise):
        status, body = _get("/api/team/solutions")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert "solutions" in body
        assert isinstance(body["solutions"], list)
        assert "total" in body

    def test_unpublished_solution_is_hidden_from_team_solution_list(self, seeded_enterprise):
        solution_id = seeded_enterprise["solution_id"]
        patch_status, patched = _patch(
            f"/api/system-admin/solutions/{solution_id}?role=system_admin",
            {"publish_action": "unpublish"},
        )
        assert patch_status == 200, patched

        status, body = _get("/api/team/solutions")
        assert status == 200, body
        assert all(item["solution_id"] != solution_id for item in body["solutions"])

    def test_solutions_list_reflects_apply_records_and_template_stats(self, seeded_enterprise):
        payload = {
            "mode": "append",
            "department_id": "dept_marketing",
            "idempotency_key": "solution-list-truth-001",
        }
        status, apply_body = _post(f"/api/team/solutions/{seeded_enterprise['solution_id']}/apply", payload)
        assert status == 201, apply_body

        status, body = _get("/api/team/solutions")
        assert status == 200, body
        solution = next(item for item in body["solutions"] if item["solution_id"] == seeded_enterprise["solution_id"])
        assert solution["template_ids"] == [seeded_enterprise["template_id"]]
        assert solution["template_count"] == 1
        assert solution["apply_count"] == 1
        assert solution["active_employee_count"] == 1
        assert solution["last_apply_record_id"] == apply_body["apply_record_id"]
        assert solution["last_apply_status"] == "succeeded"
        assert solution["created_employee_ids"] == apply_body["created_employee_ids"]
        assert solution["created_knowledge_base_ids"] == apply_body["created_knowledge_base_ids"]
        assert solution["solution_stats"]["apply_count"] == 1
        assert solution["solution_stats"]["active_employee_count"] == 1
        assert solution["solution_stats"]["template_count"] == 1
        assert solution["template_summaries"] == [
            {
                "template_id": seeded_enterprise["template_id"],
                "name": "Marketing Analyst",
                "role_name": "市场分析",
                "default_model_ref": {"provider": "openai", "model": "gpt-4o"},
            }
        ]


class TestConnectorsIntegration:
    def test_get_connectors_returns_both_lists(self, seeded_enterprise):
        status, body = _get("/api/team/connectors")
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert "connectors" in body
        assert "definitions" in body
        assert isinstance(body["connectors"], list)
        assert isinstance(body["definitions"], list)

    def test_post_connector_returns_201(self, seeded_enterprise):
        status, resp = _post(
            "/api/team/connectors",
            {"name": "Test Slack", "provider_code": "slack", "type": "oauth_connector"},
        )
        assert status == 201, f"Expected 201, got {status}: {resp}"
        assert "connector_id" in resp
        assert resp["status"] == "draft"

    def test_connector_test_missing_connector_returns_404(self, seeded_enterprise):
        status, resp = _post("/api/team/connectors/nonexistent/test", {})
        assert status == 404, f"Expected 404, got {status}: {resp}"
        assert resp.get("error") == "CONNECTOR_NOT_FOUND"

    def test_connector_grants_shape_returns_200(self, seeded_enterprise):
        _, create_resp = _post(
            "/api/team/connectors",
            {"name": "Grant Test", "provider_code": "test"},
        )
        connector_id = create_resp["connector_id"]
        status, resp = _patch(
            f"/api/team/connectors/{connector_id}/grants",
            {"grant": [], "revoke": []},
        )
        assert status == 200, f"Expected 200, got {status}: {resp}"
        for key in ("granted", "revoked", "errors"):
            assert key in resp, f"Missing {key}: {resp}"

    def test_get_connector_detail_returns_masked_contract(self, seeded_enterprise):
        status, create_resp = _post(
            "/api/team/connectors",
            {
                "name": "Detail Test",
                "provider_code": "slack",
                "type": "oauth_connector",
                "credential_ref": "cred://vault/slack/detail",
                "config": {"tenant_hint": "acme", "bot_secret": "top-secret"},
            },
        )
        assert status == 201, create_resp
        connector_id = create_resp["connector_id"]

        status, body = _get(f"/api/team/connectors/{connector_id}")
        assert status == 200, body
        assert body["connector_id"] == connector_id
        assert body["credential_ref"] == "cred://vault/slack/detail"
        assert body["credential_mask"] == "已配置"
        assert body["credential_state"] == "configured"
        assert body["config"] == {"tenant_hint": "acme", "bot_secret": "****"}
        assert body["employee_grants"] == []

    def test_patch_connector_rotates_credential_and_masks_config(self, seeded_enterprise):
        status, create_resp = _post(
            "/api/team/connectors",
            {
                "name": "Patch Test",
                "provider_code": "slack",
                "type": "oauth_connector",
                "credential_ref": "cred://vault/slack/original",
                "config": {"tenant_hint": "acme", "bot_secret": "old-secret"},
            },
        )
        assert status == 201, create_resp
        connector_id = create_resp["connector_id"]

        patch_status, patch_body = _patch(
            f"/api/team/connectors/{connector_id}",
            {
                "name": "Patch Test Updated",
                "config": {"tenant_hint": "acme-updated", "bot_secret": "new-secret"},
                "credential_input": {"mode": "opaque_ref", "credential_ref": "cred://vault/slack/rotated"},
            },
        )
        assert patch_status == 200, patch_body
        assert patch_body["status"] == "draft"
        assert patch_body["credential_state"] == "rotated"
        assert patch_body["rotation_version"] == 1

        detail_status, detail = _get(f"/api/team/connectors/{connector_id}")
        assert detail_status == 200, detail
        assert detail["name"] == "Patch Test Updated"
        assert detail["credential_ref"] == "cred://vault/slack/rotated"
        assert detail["credential_mask"] == "已轮换"
        assert detail["credential_state"] == "rotated"
        assert detail["config"] == {"tenant_hint": "acme-updated", "bot_secret": "****"}
        assert detail["last_test_result"]["result"] == "never_tested"

    def test_get_connector_status_returns_latest_test_payload(self, seeded_enterprise, db_conn):
        status, create_resp = _post(
            "/api/team/connectors",
            {"name": "Status Test", "provider_code": "slack", "type": "oauth_connector"},
        )
        assert status == 201, create_resp
        connector_id = create_resp["connector_id"]

        cur = db_conn.cursor()
        try:
            cur.execute(
                "UPDATE enterprise_connector SET status='online' WHERE id=%s",
                (connector_id,),
            )
            db_conn.commit()
        finally:
            cur.close()

        test_status, test_body = _post(f"/api/team/connectors/{connector_id}/test", {})
        assert test_status == 200, test_body

        status, body = _get(f"/api/team/connectors/{connector_id}/status")
        assert status == 200, body
        assert body["connector_id"] == connector_id
        assert body["status"] == "online"
        assert body["last_test_result"]["result"] == "passed"

    def test_delete_connector_archives_and_hides_from_lists(self, seeded_enterprise):
        status, create_resp = _post(
            "/api/team/connectors",
            {"name": "Archive Test", "provider_code": "slack", "type": "oauth_connector"},
        )
        assert status == 201, create_resp
        connector_id = create_resp["connector_id"]

        delete_status, delete_body = _delete(f"/api/team/connectors/{connector_id}")
        assert delete_status == 200, delete_body
        assert delete_body["connector_id"] == connector_id
        assert delete_body["status"] == "archived"

        detail_status, detail_body = _get(f"/api/team/connectors/{connector_id}")
        assert detail_status == 404, detail_body
        assert detail_body["error"] == "CONNECTOR_NOT_FOUND"

        list_status, list_body = _get("/api/team/connectors")
        assert list_status == 200, list_body
        assert not any(item["connector_id"] == connector_id for item in list_body["connectors"])

    def test_connectors_list_reflects_config_credentials_grants_and_test_state(self, seeded_enterprise, db_conn):
        status, create_resp = _post(
            "/api/team/connectors",
            {
                "name": "Refresh Truth",
                "provider_code": "slack",
                "type": "oauth_connector",
                "credential_ref": "cred://vault/slack/ent_test",
                "config": {"tenant_hint": "acme", "bot_secret": "should-mask-in-ui-only"},
            },
        )
        assert status == 201, create_resp
        connector_id = create_resp["connector_id"]

        cur = db_conn.cursor()
        try:
            cur.execute(
                "UPDATE enterprise_connector SET status='online', last_validated_at=now() WHERE id=%s",
                (connector_id,),
            )
            db_conn.commit()
        finally:
            cur.close()

        grant_status, grant_resp = _patch(
            f"/api/team/connectors/{connector_id}/grants",
            {"grant": [{"employee_ids": ["emp_member", "emp_test"], "access_mode": "invoke"}], "revoke": []},
        )
        assert grant_status == 200, grant_resp

        status, body = _get("/api/team/connectors")
        assert status == 200, body
        connector = next(item for item in body["connectors"] if item["connector_id"] == connector_id)
        assert connector["credential_ref"] == "cred://vault/slack/ent_test"
        assert connector["credential_mask"] == "已配置"
        assert connector["credential_state"] == "configured"
        assert connector["config"] == {"tenant_hint": "acme", "bot_secret": "****"}
        assert connector["status"] == "online"
        assert connector["health_status"] == "online"
        assert connector["last_test_at"]
        assert connector["grants"] == ["emp_member", "emp_test"]
        assert connector["granted_employee_ids"] == ["emp_member", "emp_test"]
        assert connector["employee_grants"] == [
            {"employee_id": "emp_member", "access_mode": "invoke", "enabled": True},
            {"employee_id": "emp_test", "access_mode": "invoke", "enabled": True},
        ]


class TestEmployeePatchExpanded:
    def test_patch_model_provider_accepted(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"model_provider": "openai"})
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_patch_model_name_accepted(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"model_name": "gpt-4o"})
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_patch_prompt_version_accepted(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"prompt_version": 3})
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_patch_capabilities_json_accepted(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"capabilities_json": '{"web": true}'})
        assert status == 200, f"Expected 200, got {status}: {resp}"

    def test_patch_unknown_field_still_rejected(self, seeded_enterprise):
        emp_id = seeded_enterprise["employee_id"]
        status, resp = _patch(f"/api/team/employees/{emp_id}?role=owner", {"random_field": "nope"})
        assert status == 400, f"Expected 400, got {status}: {resp}"
        assert resp.get("error") == "INVALID_FIELD"


class TestBatchCReworkPersistence:
    def test_employee_detail_preserves_truthful_prompt_and_memory_config(self, seeded_enterprise, db_conn):
        cur = db_conn.cursor()
        try:
            cur.execute(
                "INSERT INTO employee_memory_binding (id, enterprise_id, employee_id, memory_mode, provider_code, retention_days, writeback_enabled, binding_version) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                ("mem_emp_test", seeded_enterprise["enterprise_id"], seeded_enterprise["employee_id"], "builtin", "mem0", 30, True, 2),
            )
            cur.execute(
                "INSERT INTO employee_prompt (employee_id, system_prompt, behavior_rules_json, opening_message, version_no, source_template_version) VALUES (%s, %s, %s::jsonb, %s, %s, %s)",
                (seeded_enterprise["employee_id"], "Stay truthful", '{"tone": "direct"}', "Ready to help", 4, 1),
            )
            db_conn.commit()
        finally:
            cur.close()

        status, body = _get(f"/api/team/employees/{seeded_enterprise['employee_id']}?role=owner")
        assert status == 200, body
        assert body["profile_config"]["memory_config"] == {
            "mode": "builtin",
            "provider_code": "mem0",
            "retention_days": 30,
            "writeback_enabled": True,
        }
        assert body["prompt_config"] == {
            "system_prompt": "Stay truthful",
            "behavior_rules_json": '{"tone": "direct"}',
            "opening_message": "Ready to help",
            "version_no": 4,
        }

    def test_patch_skills_add_persists(self, seeded_enterprise):
        # ensure skill is installed so authorization passes
        _post('/api/team/skills/installs', {
            'skill_code': 'forecasting',
            'scope_mode': 'all_employees',
        })
        emp_id = seeded_enterprise["employee_id"]
        status, _ = _patch(
            f"/api/team/employees/{emp_id}?role=owner",
            {"skills_add": ["forecasting"]},
        )
        assert status == 200
        detail_status, detail_body = _get(f"/api/team/employees/{emp_id}?role=owner")
        assert detail_status == 200
        assert "forecasting" in detail_body["profile_config"]["skills"], detail_body

    def test_connector_grants_accept_employee_ids_array(self, seeded_enterprise, db_conn):
        _, create_resp = _post("/api/team/connectors", {
            "name": "Bulk Grant Test",
            "provider_code": "test",
        })
        connector_id = create_resp["connector_id"]
        cur = db_conn.cursor()
        try:
            cur.execute(
                "UPDATE enterprise_connector SET status='online' WHERE id=%s",
                (connector_id,),
            )
            db_conn.commit()
        finally:
            cur.close()
        status, resp = _patch(
            f"/api/team/connectors/{connector_id}/grants",
            {"grant": [{"employee_ids": ["emp_test", "emp_member"], "access_mode": "invoke"}], "revoke": []},
        )
        assert status == 200, f"Expected 200, got {status}: {resp}"
        assert len(resp["granted"]) == 2, resp
