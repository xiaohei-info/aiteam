"""Auto-generated API index + Swagger UI for the AI Team backend.

The backend has no web framework — routing is hand-written string matching in
``api/routes.py``, ``api/kanban_bridge.py`` and ``team_panel/api_team/router_*.py``.
There is therefore no declarative route registry for a tool like FastAPI's
built-in docs / flasgger / apispec to introspect. Instead of migrating 200+
routes to a framework (large, risky refactor), this module *statically scans*
the router source files for their route literals and builds a path-level
OpenAPI document. It is an **endpoint index**, not a full contract: request /
response body schemas are not present in the source, so they are not emitted.

Served read-only at:
  - ``GET /api/openapi.json`` — the generated OpenAPI document
  - ``GET /api/docs``         — Swagger UI (loads swagger-ui-dist from CDN)

Zero changes to existing route code; the only base-file change is a small
hook in ``api/routes.handle_get``.
"""
from __future__ import annotations

import re
from pathlib import Path

_APP_DIR = Path(__file__).resolve().parent.parent

# Files whose route's HTTP method is determined by the enclosing dispatch
# function (handle_get -> GET, ...). Maps file -> {function_name: method}.
_ENCLOSING_FUNCTION_FILES: dict[str, dict[str, str]] = {
    "api/routes.py": {
        "handle_get": "get",
        "handle_post": "post",
        "handle_patch": "patch",
        "handle_delete": "delete",
        "handle_put": "put",
    },
    "api/kanban_bridge.py": {
        "handle_kanban_get": "get",
        "handle_kanban_post": "post",
        "handle_kanban_patch": "patch",
        "handle_kanban_delete": "delete",
    },
}

# Files whose routes carry an explicit ``method == "VERB"`` guard next to a
# prefix-stripped match helper. Maps file -> base prefix to prepend (the
# dispatch strips it before calling the router). ``""`` means paths are already
# absolute (e.g. the auth dispatch inside routes.py).
_METHOD_PAIRED_FILES: dict[str, str] = {
    "api/routes.py": "",
    "team_panel/api_team/router_team.py": "/api/team",
    "team_panel/api_team/router_enterprise_admin.py": "/api/enterprise-admin",
    "team_panel/api_team/router_system_admin.py": "/api/system-admin",
}

_TAG_BY_PREFIX = [
    ("/api/team", "team"),
    ("/api/enterprise-admin", "enterprise-admin"),
    ("/api/system-admin", "system-admin"),
    ("/api/auth", "auth"),
    ("/api/kanban", "kanban"),
    ("/api/mcp", "mcp"),
]

_VALID_METHODS = ("get", "post", "patch", "delete", "put")


def _json_content(schema: dict, example: dict | list | str | None = None) -> dict:
    payload = {"schema": schema}
    if example is not None:
        payload["example"] = example
    return {"application/json": payload}


def _obj(required: list[str], properties: dict, description: str | None = None) -> dict:
    schema = {
        "type": "object",
        "required": required,
        "properties": properties,
    }
    if description:
        schema["description"] = description
    return schema


_MANUAL_OPERATION_OVERRIDES: dict[tuple[str, str], dict] = {
    ("/api/auth/login/phone/send-code", "post"): {
        "summary": "发送手机验证码",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(["phone"], {"phone": {"type": "string"}}),
                example={"phone": "13800138000"},
            ),
        },
        "responses": {
            "200": {
                "description": "验证码已发送",
                "content": _json_content(
                    _obj(["expires_in"], {"expires_in": {"type": "integer"}}),
                    example={"expires_in": 300},
                ),
            }
        },
    },
    ("/api/auth/login/phone/verify", "post"): {
        "summary": "校验手机验证码并登录",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["phone", "code"],
                    {
                        "phone": {"type": "string"},
                        "code": {"type": "string"},
                    },
                ),
                example={"phone": "13800138000", "code": "888888"},
            ),
        },
        "responses": {
            "200": {
                "description": "登录成功",
                "content": _json_content(
                    _obj(
                        ["access_token", "expires_in"],
                        {
                            "access_token": {"type": "string"},
                            "expires_in": {"type": "integer"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/workbench", "get"): {
        "summary": "获取工作台聚合视图",
        "responses": {
            "200": {
                "description": "工作台聚合数据",
                "content": _json_content(
                    _obj(
                        [],
                        {
                            "enterprise": {"type": ["object", "null"]},
                            "employees": {"type": "array", "items": {"type": "object"}},
                            "my_team": {"type": "object"},
                            "conversations": {"type": "array", "items": {"type": "object"}},
                            "navigation": {"type": "object"},
                            "task_status_digest": {"type": "object"},
                            "permissions": {"type": "object"},
                            "empty_state": {"type": ["object", "null"]},
                        },
                    ),
                    example={
                        "enterprise": None,
                        "employees": [],
                        "empty_state": {
                            "code": "NO_ENTERPRISE",
                            "title": "还没有企业空间",
                            "message": "当前还没有可用的企业工作台。",
                        },
                    },
                ),
            }
        },
    },
    ("/api/team/group-conversations", "post"): {
        "summary": "创建群聊会话",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["title", "member_employee_ids"],
                    {
                        "title": {"type": "string"},
                        "member_employee_ids": {"type": "array", "items": {"type": "string"}},
                        "created_by": {"type": "string"},
                    },
                ),
                example={"title": "预算评审群", "member_employee_ids": ["emp_member", "emp_planner"]},
            ),
        },
        "responses": {
            "201": {
                "description": "创建成功",
                "content": _json_content(
                    _obj(
                        ["conversation_id", "title", "member_count", "status", "navigation"],
                        {
                            "conversation_id": {"type": "string"},
                            "title": {"type": "string"},
                            "member_count": {"type": "integer"},
                            "status": {"type": "string"},
                            "navigation": {"type": "object"},
                        },
                    ),
                    example={
                        "conversation_id": "group_new",
                        "title": "预算评审群",
                        "member_count": 2,
                        "status": "active",
                        "navigation": {"conversation": "/app/group/group_new"},
                    },
                ),
            }
        },
    },
    ("/api/team/group-conversations/{id}", "get"): {
        "summary": "获取群聊详情",
        "responses": {
            "200": {
                "description": "群聊详情",
                "content": _json_content(
                    _obj(
                        ["conversation_id", "conversation_type", "title", "status", "member_count", "members", "timeline"],
                        {
                            "conversation_id": {"type": "string"},
                            "conversation_type": {"type": "string"},
                            "title": {"type": "string"},
                            "status": {"type": "string"},
                            "display_state": {"type": "string"},
                            "member_count": {"type": "integer"},
                            "members": {"type": "array", "items": {"type": "object"}},
                            "latest_run": {"type": "object"},
                            "timeline": {"type": "object"},
                            "latest_route_decision": {"type": "object"},
                            "task_tree": {"type": "object"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/group-conversations/{id}/members", "post"): {
        "summary": "新增群成员",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(["employee_id"], {"employee_id": {"type": "string"}}),
                example={"employee_id": "emp_planner"},
            ),
        },
        "responses": {
            "200": {
                "description": "新增成功",
                "content": _json_content(
                    _obj(
                        ["employee_id", "status"],
                        {
                            "employee_id": {"type": "string"},
                            "status": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/group-conversations/{id}/messages", "post"): {
        "summary": "发送群聊消息",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    [],
                    {
                        "text": {"type": "string"},
                        "message": {"type": "string"},
                        "attachments": {"type": "array", "items": {"type": "object"}},
                        "mentions": {"type": "array", "items": {"type": "string"}},
                    },
                ),
                example={"text": "@planner 请拆分今天的回归任务"},
            ),
        },
        "responses": {
            "200": {
                "description": "消息已接收",
                "content": _json_content(
                    _obj(
                        ["accepted"],
                        {
                            "accepted": {"type": "boolean"},
                            "conversation_id": {"type": "string"},
                            "message_id": {"type": "string"},
                        },
                    ),
                    example={"accepted": True, "conversation_id": "group_ops", "message_id": "msg_001"},
                ),
            }
        },
    },
    ("/api/team/workbench/state", "post"): {
        "summary": "更新工作台展示状态",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    [],
                    {
                        "conversation_id": {"type": "string"},
                        "mark_read": {"type": "boolean"},
                        "pin": {"type": "boolean"},
                    },
                ),
                example={"conversation_id": "conv_demo", "mark_read": True},
            ),
        },
        "responses": {
            "200": {
                "description": "状态更新成功",
                "content": _json_content(
                    _obj(["ok"], {"ok": {"type": "boolean"}}),
                    example={"ok": True},
                ),
            }
        },
    },
    ("/api/team/employees/{id}/conversations", "get"): {
        "summary": "获取员工关联私聊列表",
        "responses": {
            "200": {
                "description": "员工关联会话列表",
                "content": _json_content(
                    _obj(
                        ["items"],
                        {
                            "items": {"type": "array", "items": {"type": "object"}},
                            "employee_id": {"type": "string"},
                        },
                    ),
                    example={"employee_id": "emp_demo", "items": []},
                ),
            }
        },
    },
    ("/api/team/settings", "get"): {
        "summary": "获取企业设置",
        "responses": {
            "200": {
                "description": "企业设置",
                "content": _json_content(
                    _obj(
                        ["enterprise_id", "name", "invite_code", "notification_policy", "admin_invites"],
                        {
                            "enterprise_id": {"type": "string"},
                            "name": {"type": "string"},
                            "invite_code": {"type": "string"},
                            "notification_policy": {"type": "object"},
                            "admin_invites": {"type": "array", "items": {"type": "object"}},
                        },
                    ),
                    example={
                        "enterprise_id": "ent_test",
                        "name": "Test Corp",
                        "invite_code": "INV-DEMO",
                        "notification_policy": {"employee_task_completed": True},
                        "admin_invites": [],
                    },
                ),
            }
        },
    },
    ("/api/team/settings", "patch"): {
        "summary": "更新企业设置",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    [],
                    {
                        "name": {"type": "string"},
                        "contact_phone": {"type": "string"},
                        "notification_policy": {"type": "object"},
                        "low_balance_threshold_cents": {"type": "integer"},
                    },
                ),
                example={
                    "name": "Updated Corp",
                    "contact_phone": "13800138000",
                    "notification_policy": {"employee_task_completed": False},
                    "low_balance_threshold_cents": 8800,
                },
            ),
        },
        "responses": {
            "200": {
                "description": "更新后的企业设置",
                "content": _json_content(
                    _obj([], {"name": {"type": "string"}, "contact_phone": {"type": "string"}, "notification_policy": {"type": "object"}})
                ),
            }
        },
    },
    ("/api/team/billing/balance", "get"): {
        "summary": "获取企业余额",
        "responses": {
            "200": {
                "description": "余额信息",
                "content": _json_content(
                    _obj(
                        ["balance", "balance_cents", "low_balance_warning"],
                        {
                            "balance": {"type": "string"},
                            "balance_cents": {"type": "integer"},
                            "token_balance": {"type": "integer"},
                            "low_balance_warning": {"type": "boolean"},
                        },
                    ),
                    example={"balance": "0.00", "balance_cents": 0, "low_balance_warning": True},
                ),
            }
        },
    },
    ("/api/team/billing/usage/overview", "get"): {
        "summary": "获取企业用量概览",
        "responses": {
            "200": {
                "description": "企业用量概览",
                "content": _json_content(
                    _obj(
                        ["summary"],
                        {
                            "summary": {"type": "object"},
                            "trend": {"type": "array", "items": {"type": "object"}},
                            "by_employee": {"type": "array", "items": {"type": "object"}},
                        },
                    ),
                    example={"summary": {"total_cost": 120.5, "total_tokens": 998877}, "trend": []},
                ),
            }
        },
    },
    ("/api/team/billing/usage/records", "get"): {
        "summary": "获取企业用量明细",
        "responses": {
            "200": {
                "description": "用量明细分页列表",
                "content": _json_content(
                    _obj(
                        ["items", "total"],
                        {
                            "items": {"type": "array", "items": {"type": "object"}},
                            "total": {"type": "integer"},
                            "page": {"type": "integer"},
                            "page_size": {"type": "integer"},
                        },
                    ),
                    example={"items": [], "total": 0, "page": 1, "page_size": 20},
                ),
            }
        },
    },
    ("/api/team/billing/recharges", "post"): {
        "summary": "发起充值",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["amount", "payment_method"],
                    {
                        "amount": {"type": "integer"},
                        "payment_method": {"type": "string"},
                        "idempotency_key": {"type": "string"},
                    },
                ),
                example={"amount": 100, "payment_method": "mock_pay", "idempotency_key": "recharge-001"},
            ),
        },
        "responses": {
            "201": {
                "description": "充值成功",
                "content": _json_content(
                    _obj(
                        ["recharge_id", "status", "mock_provider", "token_credited"],
                        {
                            "recharge_id": {"type": "string"},
                            "status": {"type": "string"},
                            "mock_provider": {"type": "boolean"},
                            "token_credited": {"type": "integer"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/office/scene", "get"): {
        "summary": "获取办公区场景视图",
        "responses": {
            "200": {
                "description": "办公区场景快照",
                "content": _json_content(
                    _obj(
                        [],
                        {
                            "scene": {"type": "object"},
                            "employees": {"type": "array", "items": {"type": "object"}},
                            "refresh_cursor": {"type": "integer"},
                        },
                    ),
                    example={"scene": {"name": "开放办公区"}, "employees": [], "refresh_cursor": 12},
                ),
            }
        },
    },
    ("/api/team/office/feed", "get"): {
        "summary": "获取办公区动态流",
        "responses": {
            "200": {
                "description": "办公区动态流",
                "content": _json_content(
                    _obj(
                        ["items"],
                        {
                            "items": {"type": "array", "items": {"type": "object"}},
                            "queue": {"type": "array", "items": {"type": "object"}},
                            "generated_cursor": {"type": "integer"},
                            "refresh_hint_ms": {"type": "integer"},
                        },
                    ),
                    example={"items": [], "queue": [], "generated_cursor": 18, "refresh_hint_ms": 3000},
                ),
            }
        },
    },
    ("/api/team/connectors", "get"): {
        "summary": "获取连接器列表",
        "responses": {
            "200": {
                "description": "连接器列表与定义",
                "content": _json_content(
                    _obj(
                        ["connectors", "definitions"],
                        {
                            "connectors": {"type": "array", "items": {"type": "object"}},
                            "definitions": {"type": "array", "items": {"type": "object"}},
                        },
                    ),
                    example={"connectors": [], "definitions": []},
                ),
            }
        },
    },
    ("/api/team/connectors", "post"): {
        "summary": "创建连接器",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["name", "provider_code"],
                    {
                        "name": {"type": "string"},
                        "provider_code": {"type": "string"},
                        "type": {"type": "string"},
                        "credential_ref": {"type": "string"},
                        "config": {"type": "object"},
                    },
                ),
                example={"name": "Test Slack", "provider_code": "slack", "type": "oauth_connector"},
            ),
        },
        "responses": {
            "201": {
                "description": "创建成功",
                "content": _json_content(
                    _obj(
                        ["connector_id", "status"],
                        {
                            "connector_id": {"type": "string"},
                            "status": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/connectors/{id}", "get"): {
        "summary": "获取连接器详情",
        "responses": {
            "200": {
                "description": "连接器详情",
                "content": _json_content(
                    _obj(
                        ["connector_id", "credential_ref", "credential_mask", "credential_state", "config", "employee_grants"],
                        {
                            "connector_id": {"type": "string"},
                            "credential_ref": {"type": "string"},
                            "credential_mask": {"type": "string"},
                            "credential_state": {"type": "string"},
                            "config": {"type": "object"},
                            "employee_grants": {"type": "array", "items": {"type": "object"}},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/connectors/{id}", "patch"): {
        "summary": "更新连接器",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    [],
                    {
                        "name": {"type": "string"},
                        "config": {"type": "object"},
                        "credential_input": {"type": "object"},
                    },
                ),
                example={
                    "name": "Patch Test Updated",
                    "config": {"tenant_hint": "acme-updated"},
                    "credential_input": {"mode": "opaque_ref", "credential_ref": "cred://vault/slack/rotated"},
                },
            ),
        },
        "responses": {
            "200": {
                "description": "更新成功",
                "content": _json_content(
                    _obj([], {"status": {"type": "string"}, "credential_state": {"type": "string"}, "rotation_version": {"type": "integer"}})
                ),
            }
        },
    },
    ("/api/team/connectors/{id}/grants", "patch"): {
        "summary": "更新连接器授权",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["grant", "revoke"],
                    {
                        "grant": {"type": "array", "items": {"type": "object"}},
                        "revoke": {"type": "array", "items": {"type": "object"}},
                    },
                ),
                example={"grant": [], "revoke": []},
            ),
        },
        "responses": {
            "200": {
                "description": "授权调整结果",
                "content": _json_content(
                    _obj(
                        ["granted", "revoked", "errors"],
                        {
                            "granted": {"type": "array", "items": {"type": "object"}},
                            "revoked": {"type": "array", "items": {"type": "object"}},
                            "errors": {"type": "array", "items": {"type": "object"}},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/connectors/{id}/status", "get"): {
        "summary": "获取连接器状态",
        "responses": {
            "200": {
                "description": "连接器状态",
                "content": _json_content(
                    _obj(
                        ["connector_id", "status"],
                        {
                            "connector_id": {"type": "string"},
                            "status": {"type": "string"},
                            "last_test_result": {"type": "object"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/connectors/{id}/test", "post"): {
        "summary": "测试连接器",
        "requestBody": {
            "required": False,
            "content": _json_content(
                _obj([], {"dry_run": {"type": "boolean"}}),
                example={"dry_run": True},
            ),
        },
        "responses": {
            "200": {
                "description": "测试结果",
                "content": _json_content(
                    _obj(
                        ["connector_id", "status"],
                        {
                            "connector_id": {"type": "string"},
                            "status": {"type": "string"},
                            "message": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/memories", "get"): {
        "summary": "获取记忆列表",
        "responses": {
            "200": {
                "description": "记忆分页结果",
                "content": _json_content(
                    _obj(
                        ["items", "page", "page_size", "total", "has_more", "sort_by", "sort_order"],
                        {
                            "items": {"type": "array", "items": {"type": "object"}},
                            "page": {"type": "integer"},
                            "page_size": {"type": "integer"},
                            "total": {"type": "integer"},
                            "has_more": {"type": "boolean"},
                            "sort_by": {"type": "string"},
                            "sort_order": {"type": "string"},
                        },
                    ),
                    example={
                        "items": [],
                        "page": 1,
                        "page_size": 20,
                        "total": 0,
                        "has_more": False,
                        "sort_by": "importance",
                        "sort_order": "desc",
                    },
                ),
            }
        },
    },
    ("/api/team/memories", "post"): {
        "summary": "创建记忆",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["employee_id", "content"],
                    {
                        "employee_id": {"type": "string"},
                        "content": {"type": "string"},
                        "category": {"type": "string"},
                        "importance": {"type": "integer"},
                        "tags": {"type": "array", "items": {"type": "string"}},
                        "visibility_scope": {"type": "string"},
                    },
                ),
                example={
                    "employee_id": "emp_test",
                    "content": "Customer prefers concise weekly reports",
                    "category": "preference",
                    "importance": 5,
                    "tags": ["vip", "reporting"],
                    "visibility_scope": "admin_only",
                },
            ),
        },
        "responses": {
            "201": {
                "description": "创建成功",
                "content": _json_content(
                    _obj(
                        ["memory_id", "employee_id", "content", "importance", "source_type", "visibility_scope", "review", "tags"],
                        {
                            "memory_id": {"type": "string"},
                            "employee_id": {"type": "string"},
                            "content": {"type": "string"},
                            "importance": {"type": "integer"},
                            "source_type": {"type": "string"},
                            "visibility_scope": {"type": "string"},
                            "runtime_ref": {"type": "object"},
                            "review": {"type": "object"},
                            "tags": {"type": "array", "items": {"type": "string"}},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/memories/{id}", "patch"): {
        "summary": "更新记忆",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    [],
                    {
                        "content": {"type": "string"},
                        "importance": {"type": "integer"},
                        "tags": {"type": "array", "items": {"type": "string"}},
                        "review": {"type": "object"},
                    },
                ),
                example={
                    "content": "Updated note",
                    "importance": 4,
                    "tags": ["updated", "important"],
                    "review": {
                        "decision": "corrected",
                        "comment": "remove unverified detail",
                        "corrected_content": "Corrected final note",
                    },
                },
            ),
        },
        "responses": {
            "200": {
                "description": "更新成功",
                "content": _json_content(
                    _obj([], {"content": {"type": "string"}, "importance": {"type": "integer"}, "tags": {"type": "array", "items": {"type": "string"}}, "review": {"type": "object"}})
                ),
            }
        },
    },
    ("/api/team/employees", "get"): {
        "summary": "获取员工列表",
        "responses": {
            "200": {
                "description": "员工列表",
                "content": _json_content(
                    _obj(
                        ["employees", "total", "page", "limit"],
                        {
                            "employees": {"type": "array", "items": {"type": "object"}},
                            "total": {"type": "integer"},
                            "page": {"type": "integer"},
                            "limit": {"type": "integer"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/employees", "post"): {
        "summary": "创建员工",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["display_name"],
                    {
                        "display_name": {"type": "string"},
                        "role_name": {"type": "string"},
                        "model_provider": {"type": "string"},
                        "model_name": {"type": "string"},
                    },
                ),
                example={"display_name": "市场新人", "role_name": "市场专员"},
            ),
        },
        "responses": {
            "201": {
                "description": "创建成功",
                "content": _json_content(
                    _obj(
                        ["employee_id", "conversation_id", "status"],
                        {
                            "employee_id": {"type": "string"},
                            "conversation_id": {"type": "string"},
                            "status": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/employees/{id}", "get"): {
        "summary": "获取员工详情",
        "responses": {
            "200": {
                "description": "员工详情",
                "content": _json_content(
                    _obj(
                        ["employee_id", "display_name", "role_name", "status", "presence", "profile_config", "usage_summary", "created_at"],
                        {
                            "employee_id": {"type": "string"},
                            "display_name": {"type": "string"},
                            "role_name": {"type": "string"},
                            "status": {"type": "string"},
                            "presence": {"type": "string"},
                            "profile_config": {"type": "object"},
                            "usage_summary": {"type": "object"},
                            "run_summary": {"type": "object"},
                            "scheduled_jobs": {"type": "array", "items": {"type": "object"}},
                            "bindings_summary": {"type": "array", "items": {"type": "object"}},
                            "created_at": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/talent-market/templates", "get"): {
        "summary": "获取前台人才模板列表",
        "responses": {
            "200": {
                "description": "模板列表",
                "content": _json_content(
                    _obj(
                        ["items", "page", "page_size", "total", "has_more"],
                        {
                            "items": {"type": "array", "items": {"type": "object"}},
                            "page": {"type": "integer"},
                            "page_size": {"type": "integer"},
                            "total": {"type": "integer"},
                            "has_more": {"type": "boolean"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/talent-market/templates/{id}", "get"): {
        "summary": "获取模板详情",
        "responses": {
            "200": {
                "description": "模板详情",
                "content": _json_content(
                    _obj(
                        ["template_id", "name", "category", "description", "default_skills", "default_memory_config", "price_tier"],
                        {
                            "template_id": {"type": "string"},
                            "name": {"type": "string"},
                            "category": {"type": "string"},
                            "description": {"type": "string"},
                            "default_skills": {"type": "array", "items": {"type": "string"}},
                            "default_model_ref": {"type": "object"},
                            "default_memory_config": {"type": "object"},
                            "knowledge_bindings": {"type": "array", "items": {"type": "object"}},
                            "connector_requirements": {"type": "array", "items": {"type": "object"}},
                            "price_tier": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string"}},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/recruitments", "post"): {
        "summary": "从模板招募员工",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["template_id"],
                    {
                        "template_id": {"type": "string"},
                        "display_name": {"type": "string"},
                        "idempotency_key": {"type": "string"},
                    },
                ),
                example={"template_id": "tpl_marketing_v1", "display_name": "My Analyst", "idempotency_key": "recruit-001"},
            ),
        },
        "responses": {
            "201": {
                "description": "招募成功",
                "content": _json_content(
                    _obj(
                        ["order_id", "status", "employee_id", "profile_name"],
                        {
                            "order_id": {"type": "string"},
                            "status": {"type": "string"},
                            "employee_id": {"type": "string"},
                            "profile_name": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/memories/bulk-delete", "post"): {
        "summary": "批量删除记忆",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["employee_id", "memory_ids"],
                    {
                        "employee_id": {"type": "string"},
                        "memory_ids": {"type": "array", "items": {"type": "string"}},
                    },
                ),
                example={"employee_id": "emp_test", "memory_ids": ["mem_1", "mem_2"]},
            ),
        },
        "responses": {
            "200": {
                "description": "删除结果",
                "content": _json_content(
                    _obj(
                        ["deleted_count", "memory_ids"],
                        {
                            "deleted_count": {"type": "integer"},
                            "memory_ids": {"type": "array", "items": {"type": "string"}},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/skills/catalog", "get"): {
        "summary": "获取技能市场目录",
        "responses": {
            "200": {
                "description": "技能目录",
                "content": _json_content(
                    _obj(
                        ["items"],
                        {
                            "items": {"type": "array", "items": {"type": "object"}},
                            "page": {"type": "integer"},
                            "page_size": {"type": "integer"},
                            "total": {"type": "integer"},
                        },
                    ),
                    example={"items": [], "page": 1, "page_size": 20, "total": 0},
                ),
            }
        },
    },
    ("/api/team/skills/installs", "get"): {
        "summary": "获取已安装技能列表",
        "responses": {
            "200": {
                "description": "已安装技能列表",
                "content": _json_content(
                    _obj(["items"], {"items": {"type": "array", "items": {"type": "object"}}}),
                    example={"items": []},
                ),
            }
        },
    },
    ("/api/team/skills/installs", "post"): {
        "summary": "安装技能",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["skill_code"],
                    {
                        "skill_code": {"type": "string"},
                        "config": {"type": "object"},
                    },
                ),
                example={"skill_code": "skill.crm.sync", "config": {"scope": "team"}},
            ),
        },
        "responses": {
            "201": {
                "description": "安装成功",
                "content": _json_content(
                    _obj(["install_id", "status"], {"install_id": {"type": "string"}, "status": {"type": "string"}})
                ),
            }
        },
    },
    ("/api/team/skills/installs/{id}", "patch"): {
        "summary": "更新已安装技能",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj([], {"enabled": {"type": "boolean"}, "config": {"type": "object"}}),
                example={"enabled": False},
            ),
        },
        "responses": {
            "200": {
                "description": "更新成功",
                "content": _json_content(
                    _obj(["install_id", "status"], {"install_id": {"type": "string"}, "status": {"type": "string"}})
                ),
            }
        },
    },
    ("/api/team/solutions", "get"): {
        "summary": "获取行业方案列表",
        "responses": {
            "200": {
                "description": "行业方案列表",
                "content": _json_content(
                    _obj(
                        ["solutions"],
                        {
                            "solutions": {"type": "array", "items": {"type": "object"}},
                            "total": {"type": "integer"},
                        },
                    ),
                    example={"solutions": [], "total": 0},
                ),
            }
        },
    },
    ("/api/team/solutions/{id}/apply", "post"): {
        "summary": "应用行业方案",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["mode"],
                    {
                        "mode": {"type": "string"},
                        "department_id": {"type": "string"},
                        "idempotency_key": {"type": "string"},
                    },
                ),
                example={"mode": "full", "department_id": "dept_sales"},
            ),
        },
        "responses": {
            "200": {
                "description": "应用结果",
                "content": _json_content(
                    _obj(
                        ["apply_record_id"],
                        {
                            "apply_record_id": {"type": "string"},
                            "created_employee_ids": {"type": "array", "items": {"type": "string"}},
                            "created_knowledge_base_ids": {"type": "array", "items": {"type": "string"}},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/llm-providers", "get"): {
        "summary": "获取企业 LLM Provider 列表",
        "responses": {
            "200": {
                "description": "Provider 列表",
                "content": _json_content(
                    _obj(["providers"], {"providers": {"type": "array", "items": {"type": "object"}}}),
                    example={"providers": []},
                ),
            }
        },
    },
    ("/api/team/llm-providers", "post"): {
        "summary": "创建企业 LLM Provider",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["provider_key"],
                    {
                        "provider_key": {"type": "string"},
                        "display_name": {"type": "string"},
                        "base_url": {"type": "string"},
                        "api_key": {"type": "string"},
                        "transport": {"type": "string"},
                    },
                ),
                example={"provider_key": "openai", "display_name": "OpenAI Prod", "base_url": "https://api.openai.com/v1"},
            ),
        },
        "responses": {
            "201": {
                "description": "创建成功",
                "content": _json_content(
                    _obj(["provider_id"], {"provider_id": {"type": "string"}, "status": {"type": "string"}})
                ),
            }
        },
    },
    ("/api/team/collaboration-template", "get"): {
        "summary": "获取群聊协作模板",
        "responses": {
            "200": {
                "description": "协作模板",
                "content": _json_content(
                    _obj(
                        [],
                        {
                            "defaults": {"type": "object"},
                            "placeholders": {"type": "array", "items": {"type": "string"}},
                            "template": {"type": "object"},
                        },
                    ),
                    example={"defaults": {}, "placeholders": [], "template": {}},
                ),
            }
        },
    },
    ("/api/team/collaboration-template", "post"): {
        "summary": "保存群聊协作模板",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    [],
                    {
                        "name": {"type": "string"},
                        "planner_prompt": {"type": "string"},
                        "subtask_prompt": {"type": "string"},
                        "aggregate_prompt": {"type": "string"},
                    },
                ),
                example={"name": "默认编排", "planner_prompt": "请先拆解任务"},
            ),
        },
        "responses": {
            "200": {
                "description": "保存成功",
                "content": _json_content(
                    _obj(["saved"], {"saved": {"type": "boolean"}, "template": {"type": "object"}}),
                    example={"saved": True, "template": {}},
                ),
            }
        },
    },
    ("/api/enterprise-admin/invites", "post"): {
        "summary": "创建管理员邀请",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["phone", "role", "permissions"],
                    {
                        "phone": {"type": "string"},
                        "role": {"type": "string"},
                        "permissions": {"type": "object"},
                        "idempotency_key": {"type": "string"},
                    },
                ),
                example={
                    "phone": "13900003333",
                    "role": "enterprise_admin",
                    "permissions": {"employees": True, "audit": True},
                    "idempotency_key": "invite-enterprise-admin-001",
                },
            ),
        },
        "responses": {
            "201": {
                "description": "邀请创建成功",
                "content": _json_content(
                    _obj(
                        ["invite_id", "status", "phone"],
                        {
                            "invite_id": {"type": "string"},
                            "status": {"type": "string"},
                            "phone": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/system-admin/health", "get"): {
        "summary": "系统健康概览",
        "responses": {
            "200": {"description": "系统健康数据"}
        },
    },
    ("/api/system-admin/finance/overview", "get"): {
        "summary": "平台财务总览",
        "responses": {
            "200": {
                "description": "平台财务总览",
                "content": _json_content(
                    _obj(
                        ["summary", "trend"],
                        {
                            "summary": {"type": "object"},
                            "trend": {"type": "array", "items": {"type": "object"}},
                            "top_enterprises": {"type": "array", "items": {"type": "object"}},
                        },
                    )
                ),
            }
        },
    },
    ("/api/system-admin/enterprises", "get"): {
        "summary": "获取企业账号列表",
        "responses": {
            "200": {
                "description": "企业账号分页列表",
                "content": _json_content(
                    _obj(
                        ["items"],
                        {
                            "items": {"type": "array", "items": {"type": "object"}},
                            "total": {"type": "integer"},
                            "page": {"type": "integer"},
                            "limit": {"type": "integer"},
                            "has_more": {"type": "boolean"},
                        },
                    ),
                    example={"items": [], "total": 0, "page": 1, "limit": 20, "has_more": False},
                ),
            }
        },
    },
    ("/api/system-admin/enterprises/export", "get"): {
        "summary": "导出企业账号列表",
        "responses": {
            "200": {
                "description": "企业账号导出内容",
                "content": {
                    "text/csv": {
                        "schema": {"type": "string"},
                        "example": "id,name,status\nent_001,Acme,active\n",
                    }
                },
            }
        },
    },
    ("/api/system-admin/enterprises/{id}", "get"): {
        "summary": "获取企业详情",
        "responses": {
            "200": {
                "description": "企业详情",
                "content": _json_content(
                    _obj(
                        ["id", "name", "slug"],
                        {
                            "id": {"type": "string"},
                            "name": {"type": "string"},
                            "slug": {"type": "string"},
                            "status": {"type": "string"},
                            "owner_user_id": {"type": "string"},
                            "default_workspace_id": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/system-admin/enterprises/{id}/quota", "get"): {
        "summary": "获取企业配额",
        "responses": {
            "200": {
                "description": "企业配额详情",
                "content": _json_content(
                    _obj(
                        [],
                        {
                            "enterprise_id": {"type": "string"},
                            "quota": {"type": "object"},
                        },
                    ),
                    example={"enterprise_id": "ent_001", "quota": {"employee_quota": 50}},
                ),
            }
        },
    },
    ("/api/system-admin/enterprises/{id}/actions", "post"): {
        "summary": "执行企业治理动作",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["action"],
                    {
                        "action": {"type": "string", "enum": ["ban", "unban", "recharge", "notify"]},
                        "reason": {"type": "string"},
                        "amount": {"type": "integer"},
                        "idempotency_key": {"type": "string"},
                        "message": {"type": "string"},
                    },
                ),
                example={"action": "ban", "reason": "policy violation"},
            ),
        },
        "responses": {
            "200": {
                "description": "动作执行成功",
                "content": _json_content(
                    _obj(
                        ["enterprise_id", "action", "status", "message", "audit_event_id"],
                        {
                            "enterprise_id": {"type": "string"},
                            "action": {"type": "string"},
                            "status": {"type": "string"},
                            "message": {"type": "string"},
                            "audit_event_id": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/system-admin/templates", "get"): {
        "summary": "获取系统模板列表",
        "responses": {
            "200": {
                "description": "系统模板列表",
                "content": _json_content(
                    _obj(["items"], {"items": {"type": "array", "items": {"type": "object"}}}),
                    example={"items": []},
                ),
            }
        },
    },
    ("/api/system-admin/templates", "post"): {
        "summary": "创建系统模板",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["name", "role_name"],
                    {
                        "name": {"type": "string"},
                        "role_name": {"type": "string"},
                        "category_code": {"type": "string"},
                        "default_model_ref": {"type": "string"},
                    },
                ),
                example={"name": "运营专员", "role_name": "ops_agent", "category_code": "ops"},
            ),
        },
        "responses": {
            "201": {
                "description": "创建成功",
                "content": _json_content(
                    _obj(["template_id"], {"template_id": {"type": "string"}, "status": {"type": "string"}})
                ),
            }
        },
    },
    ("/api/system-admin/solutions", "get"): {
        "summary": "获取系统方案列表",
        "responses": {
            "200": {
                "description": "系统方案列表",
                "content": _json_content(
                    _obj(["items"], {"items": {"type": "array", "items": {"type": "object"}}}),
                    example={"items": []},
                ),
            }
        },
    },
    ("/api/system-admin/solutions", "post"): {
        "summary": "创建系统方案",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["name", "template_ids"],
                    {
                        "name": {"type": "string"},
                        "template_ids": {"type": "array", "items": {"type": "string"}},
                        "description": {"type": "string"},
                    },
                ),
                example={"name": "零售增长方案", "template_ids": ["tpl_ops", "tpl_sales"]},
            ),
        },
        "responses": {
            "201": {
                "description": "创建成功",
                "content": _json_content(
                    _obj(["solution_id"], {"solution_id": {"type": "string"}, "status": {"type": "string"}})
                ),
            }
        },
    },
    ("/api/team/runs", "post"): {
        "summary": "创建一次私聊运行",
        "description": "桌面端/前端发起一次员工私聊执行，成功后通过 SSE timeline 与 events 分页读取运行过程。",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["employee_id", "conversation_id", "message"],
                    {
                        "employee_id": {"type": "string"},
                        "conversation_id": {"type": "string"},
                        "message": _obj(
                            ["text"],
                            {
                                "text": {"type": "string"},
                                "attachments": {
                                    "type": "array",
                                    "items": _obj(
                                        ["asset_id", "preview_url"],
                                        {
                                            "asset_id": {"type": "string"},
                                            "preview_url": {"type": "string"},
                                        },
                                    ),
                                },
                            },
                        ),
                        "idempotency_key": {"type": "string"},
                        "create_new": {"type": "boolean"},
                    },
                ),
                example={
                    "employee_id": "emp_test",
                    "conversation_id": "conv_test",
                    "message": {"text": "Hello"},
                    "idempotency_key": "run-001",
                },
            ),
        },
        "responses": {
            "201": {
                "description": "运行已创建",
                "content": _json_content(
                    _obj(
                        ["run_id", "status", "conversation_id", "stream_url", "events_url", "runtime_handle"],
                        {
                            "run_id": {"type": "string"},
                            "status": {"type": "string", "enum": ["queued"]},
                            "conversation_id": {"type": "string"},
                            "stream_url": {"type": "string"},
                            "events_url": {"type": "string"},
                            "runtime_handle": _obj(
                                ["kind", "profile_name", "session_id"],
                                {
                                    "kind": {"type": "string"},
                                    "profile_name": {"type": "string"},
                                    "session_id": {"type": "string"},
                                },
                            ),
                        },
                    ),
                    example={
                        "run_id": "run_xxx",
                        "status": "queued",
                        "conversation_id": "conv_test",
                        "stream_url": "/api/team/runs/run_xxx/stream?cursor=0",
                        "events_url": "/api/team/runs/run_xxx/events?cursor=0",
                        "runtime_handle": {
                            "kind": "session",
                            "profile_name": "emp_test",
                            "session_id": "sess_xxx",
                        },
                    },
                ),
            },
            "402": {
                "description": "余额不足",
                "content": _json_content(
                    _obj(
                        ["error", "recharge_required"],
                        {
                            "error": {"type": "string", "enum": ["INSUFFICIENT_BALANCE"]},
                            "recharge_required": {"type": "boolean"},
                        },
                    ),
                    example={"error": "INSUFFICIENT_BALANCE", "recharge_required": True},
                ),
            },
        },
    },
    ("/api/team/runs/{id}/retry", "post"): {
        "summary": "重试一次运行",
        "requestBody": {
            "required": False,
            "content": _json_content(
                _obj([], {"idempotency_key": {"type": "string"}}),
                example={"idempotency_key": "retry-001"},
            ),
        },
        "responses": {
            "200": {
                "description": "重试已创建",
                "content": _json_content(
                    _obj(
                        ["run_id", "conversation_id"],
                        {
                            "run_id": {"type": "string"},
                            "retry_of_run_id": {"type": "string"},
                            "conversation_id": {"type": "string"},
                            "runtime_handle": {"type": "object"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/runs/{id}/abort", "post"): {
        "summary": "中断运行",
        "requestBody": {
            "required": False,
            "content": _json_content(
                _obj([], {"reason": {"type": "string"}}),
                example={"reason": "user_cancelled"},
            ),
        },
        "responses": {
            "200": {
                "description": "中断结果",
                "content": _json_content(
                    _obj(
                        ["run_id", "aborted"],
                        {
                            "run_id": {"type": "string"},
                            "status": {"type": "string"},
                            "aborted": {"type": "boolean"},
                            "event_cursor": {"type": "integer"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/uploads", "post"): {
        "summary": "上传附件内容或元数据",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["name"],
                    {
                        "name": {"type": "string"},
                        "size": {"type": "integer"},
                        "mime_type": {"type": "string"},
                        "content_text": {"type": "string"},
                    },
                ),
                example={"name": "faq.txt", "mime_type": "text/plain", "content_text": "Hello"},
            ),
        },
        "responses": {
            "201": {
                "description": "上传成功",
                "content": _json_content(
                    _obj(
                        ["asset_id", "name"],
                        {
                            "asset_id": {"type": "string"},
                            "name": {"type": "string"},
                            "size": {"type": "integer"},
                            "mime_type": {"type": "string"},
                            "storage_key": {"type": "string"},
                            "preview_url": {"type": "string"},
                        },
                    ),
                    example={"asset_id": "ast_new", "name": "faq.txt", "preview_url": "/api/team/uploads/ast_new/preview"},
                ),
            }
        },
    },
    ("/api/team/knowledge-bases/{id}/documents", "post"): {
        "summary": "向知识库挂载文档",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["asset_id"],
                    {"asset_id": {"type": "string"}, "display_name": {"type": "string"}},
                ),
                example={"asset_id": "ast_001", "display_name": "FAQ"},
            ),
        },
        "responses": {
            "201": {
                "description": "挂载成功",
                "content": _json_content(
                    _obj(
                        ["document_id", "status"],
                        {
                            "document_id": {"type": "string"},
                            "status": {"type": "string"},
                            "ingestion_job_id": {"type": "string"},
                        },
                    )
                ),
            }
        },
    },
    ("/api/team/knowledge-bases", "get"): {
        "summary": "获取知识库列表",
        "responses": {
            "200": {
                "description": "知识库列表",
                "content": _json_content(
                    _obj(
                        ["knowledge_bases"],
                        {
                            "knowledge_bases": {
                                "type": "array",
                                "items": _obj(
                                    ["knowledge_base_id", "name", "status", "document_count"],
                                    {
                                        "knowledge_base_id": {"type": "string"},
                                        "name": {"type": "string"},
                                        "description": {"type": "string"},
                                        "status": {"type": "string"},
                                        "document_count": {"type": "integer"},
                                    },
                                ),
                            }
                        },
                    ),
                    example={"knowledge_bases": []},
                ),
            }
        },
    },
    ("/api/team/knowledge-bases", "post"): {
        "summary": "创建知识库",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["name"],
                    {
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                    },
                ),
                example={"name": "新知识库", "description": "用于新员工资料"},
            ),
        },
        "responses": {
            "201": {
                "description": "创建成功",
                "content": _json_content(
                    _obj(
                        ["knowledge_base_id", "name", "description", "status", "document_count"],
                        {
                            "knowledge_base_id": {"type": "string"},
                            "name": {"type": "string"},
                            "description": {"type": "string"},
                            "status": {"type": "string"},
                            "document_count": {"type": "integer"},
                        },
                    ),
                    example={
                        "knowledge_base_id": "kb_xxx",
                        "name": "新知识库",
                        "description": "用于新员工资料",
                        "status": "active",
                        "document_count": 0,
                    },
                ),
            },
            "400": {
                "description": "请求无效",
                "content": _json_content(
                    _obj(["error"], {"error": {"type": "string"}}),
                    example={"error": "MISSING_NAME"},
                ),
            },
        },
    },
    ("/api/team/knowledge-bases/{id}/search", "get"): {
        "summary": "搜索/问答知识库",
        "parameters": [
            {
                "name": "id",
                "in": "path",
                "required": True,
                "schema": {"type": "string"},
            },
            {
                "name": "q",
                "in": "query",
                "required": True,
                "schema": {"type": "string"},
                "description": "查询内容",
            },
        ],
        "responses": {
            "200": {
                "description": "检索成功",
                "content": _json_content(
                    _obj(
                        ["knowledge_base_id", "query", "answer", "citations", "items"],
                        {
                            "knowledge_base_id": {"type": "string"},
                            "query": {"type": "string"},
                            "answer": {"type": "string"},
                            "citations": {
                                "type": "array",
                                "items": _obj(["title"], {"title": {"type": "string"}}),
                            },
                            "items": {
                                "type": "array",
                                "items": _obj(["document_id"], {"document_id": {"type": "string"}}),
                            },
                        },
                    ),
                    example={
                        "knowledge_base_id": "kb_xxx",
                        "query": "入职",
                        "answer": "已命中《入职手册》相关知识。",
                        "citations": [{"title": "入职手册"}],
                        "items": [{"document_id": "doc_xxx"}],
                    },
                ),
            },
            "400": {
                "description": "缺少查询内容",
                "content": _json_content(
                    _obj(["error"], {"error": {"type": "string"}}),
                    example={"error": "MISSING_QUERY"},
                ),
            },
        },
    },
    ("/api/auth/onboarding/create-enterprise", "post"): {
        "summary": "创建企业并入驻",
        "requestBody": {
            "required": True,
            "content": _json_content(
                _obj(
                    ["name"],
                    {
                        "name": {"type": "string"},
                        "slug": {"type": "string"},
                    },
                ),
                example={"name": "Acme AI Lab", "slug": "acme-ai-lab"},
            ),
        },
        "responses": {
            "201": {
                "description": "创建成功",
                "content": _json_content(
                    _obj(
                        ["enterprise_id", "name", "slug", "role"],
                        {
                            "enterprise_id": {"type": "string"},
                            "name": {"type": "string"},
                            "slug": {"type": "string"},
                            "role": {"type": "string", "enum": ["owner"]},
                        },
                    ),
                    example={
                        "enterprise_id": "ent_xxx",
                        "name": "Acme AI Lab",
                        "slug": "acme-ai-lab",
                        "role": "owner",
                    },
                ),
            }
        },
    },
    ("/api/team/runs/{id}/stream", "get"): {
        "summary": "订阅 run timeline SSE",
        "description": "返回 event-stream；客户端只消费 `event: timeline`，并使用 numeric cursor 断线续传。",
        "parameters": [
            {
                "name": "id",
                "in": "path",
                "required": True,
                "schema": {"type": "string"},
            },
            {
                "name": "cursor",
                "in": "query",
                "required": False,
                "schema": {"type": "integer", "default": 0},
            },
        ],
        "responses": {
            "200": {
                "description": "SSE timeline stream",
                "content": {
                    "text/event-stream": {
                        "schema": {"type": "string"},
                        "example": (
                            "event: timeline\n"
                            "data: {\"event_id\":\"evt_xxx\",\"event_cursor\":1,"
                            "\"run_id\":\"run_xxx\",\"event_type\":\"run_started\","
                            "\"source_type\":\"session\",\"source_id\":\"sess_xxx\","
                            "\"event_ts\":\"2026-06-15T12:00:00Z\"}\n\n"
                        ),
                    }
                },
            },
            "404": {
                "description": "运行不存在",
                "content": _json_content(
                    _obj(["error"], {"error": {"type": "string"}}),
                    example={"error": "RUN_NOT_FOUND"},
                ),
            },
        },
    },
}


def _merge_manual_overrides(paths: dict[str, dict]) -> dict[str, dict]:
    for (path, method), override in _MANUAL_OPERATION_OVERRIDES.items():
        ops = paths.setdefault(path, {})
        base = dict(ops.get(method, {}))
        base.update(override)
        ops[method] = base
    return paths

# A literal that looks like an API path: "/api/..." with no whitespace.
_ABS_API_LITERAL = re.compile(r'"(/api/[A-Za-z0-9_./{}-]*)"')
# `_match_exact(var, "/x")` / `_match_prefix(var, "/x/")`
_MATCH_CALL = re.compile(r'_match_(exact|prefix)\(\s*\w+\s*,\s*"([^"]+)"')
# `... .endswith("/seg")` — used to reconstruct sub-routes under a prefix match.
_ENDSWITH = re.compile(r'\.endswith\(\s*"(/[^"]+)"')
# `method == "VERB"`
_METHOD_EQ = re.compile(r'method\s*==\s*"(\w+)"')


def _normalize(path: str, is_prefix: bool, suffix: str | None) -> str:
    """Turn a raw route literal into an OpenAPI path template.

    A ``_match_prefix`` literal ends with ``/`` and captures a trailing id, so
    ``/runs/`` becomes ``/runs/{id}``; an optional ``.endswith`` suffix turns it
    into ``/runs/{id}/stream``.
    """
    path = path.rstrip("/") if is_prefix else path
    if is_prefix:
        path = f"{path}/{{id}}"
    if suffix:
        path = f"{path}{suffix}"
    return path


def _add(routes: dict[str, set[str]], method: str, path: str) -> None:
    method = method.lower()
    if method not in _VALID_METHODS or not path.startswith("/api/"):
        return
    routes.setdefault(path, set()).add(method)


def _scan_enclosing_function(text: str, func_to_method: dict[str, str], routes: dict[str, set[str]]) -> None:
    """Within each `def handle_*` block, every "/api/..." literal is a route
    served with that function's HTTP method."""
    func_re = re.compile(r"^def (\w+)\(", re.MULTILINE)
    matches = list(func_re.finditer(text))
    for i, m in enumerate(matches):
        name = m.group(1)
        method = func_to_method.get(name)
        if not method:
            continue
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        for lit in _ABS_API_LITERAL.finditer(text, start, end):
            _add(routes, method, lit.group(1))


def _scan_method_paired(text: str, prefix: str, routes: dict[str, set[str]]) -> None:
    """Pair each match-helper / absolute literal with the HTTP method declared
    on the same logical line (`method == "GET" and _match_exact(sub, "/x")`),
    falling back to the nearest `method ==` within a small window."""
    lines = text.splitlines()
    for idx, line in enumerate(lines):
        methods = _METHOD_EQ.findall(line)
        if not methods:
            # Decoupled form: `var = _match_prefix(...)` on its own line. Look a
            # few lines ahead for the method guard that consumes the variable.
            if _MATCH_CALL.search(line):
                window = " ".join(lines[idx : idx + 8])
                methods = _METHOD_EQ.findall(window)
            if not methods:
                continue

        suffix_match = _ENDSWITH.search(line) or _ENDSWITH.search(" ".join(lines[idx : idx + 4]))
        suffix = suffix_match.group(1) if suffix_match else None

        for kind, raw in _MATCH_CALL.findall(line):
            path = _normalize(raw, is_prefix=(kind == "prefix"), suffix=suffix)
            full = path if path.startswith("/api/") else f"{prefix}{path}"
            for method in methods:
                _add(routes, method, full)

        if prefix == "":  # absolute-path dispatch (auth) inside routes.py
            for lit in _ABS_API_LITERAL.finditer(line):
                for method in methods:
                    _add(routes, method, lit.group(1))


def _collect_routes() -> dict[str, set[str]]:
    routes: dict[str, set[str]] = {}
    for rel, func_map in _ENCLOSING_FUNCTION_FILES.items():
        text = (_APP_DIR / rel).read_text(encoding="utf-8")
        _scan_enclosing_function(text, func_map, routes)
    for rel, prefix in _METHOD_PAIRED_FILES.items():
        text = (_APP_DIR / rel).read_text(encoding="utf-8")
        _scan_method_paired(text, prefix, routes)
    return routes


def _tag_for(path: str) -> str:
    for prefix, tag in _TAG_BY_PREFIX:
        if path.startswith(prefix):
            return tag
    return "other"


def _version() -> str:
    try:
        from api.updates import WEBUI_VERSION
        return str(WEBUI_VERSION)
    except Exception:
        return "dev"


def build_openapi_spec() -> dict:
    """Build a path-level OpenAPI 3.0 document from the router sources."""
    routes = _collect_routes()
    paths: dict[str, dict] = {}
    tags_seen: set[str] = set()

    for path in sorted(routes):
        tag = _tag_for(path)
        tags_seen.add(tag)
        params = []
        if "{id}" in path:
            params = [{
                "name": "id", "in": "path", "required": True,
                "schema": {"type": "string"},
                "description": "Path identifier (auto-detected from prefix match).",
            }]
        ops: dict[str, dict] = {}
        for method in sorted(routes[path]):
            op = {
                "tags": [tag],
                "summary": f"{method.upper()} {path}",
                "description": "Auto-extracted from router source. Request/response "
                               "schemas are not declared in code and are omitted.",
                "responses": {"200": {"description": "OK"}},
            }
            if params:
                op["parameters"] = params
            ops[method] = op
        paths[path] = ops

    paths = _merge_manual_overrides(paths)

    return {
        "openapi": "3.0.3",
        "info": {
            "title": "AI Team Backend API (auto-extracted index)",
            "version": _version(),
            "description": (
                "Endpoint index statically extracted from the hand-written "
                "routers (no web framework in use). Paths and HTTP methods are "
                "accurate. For key northbound APIs consumed by the current AI "
                "Team frontend, request/response contracts are overlaid "
                "manually so `/api/docs` can serve as a usable external API doc."
            ),
        },
        "tags": [{"name": t} for t in sorted(tags_seen)],
        "paths": paths,
    }


_SWAGGER_UI_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>AI Team API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: "/api/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        docExpansion: "none",
        defaultModelsExpandDepth: -1,
      });
    };
  </script>
</body>
</html>
"""


def swagger_ui_html() -> str:
    """Return the Swagger UI page (loads swagger-ui-dist from CDN in browser)."""
    return _SWAGGER_UI_HTML
