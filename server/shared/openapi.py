"""OpenAPI contract enrichment shared by the Python control-plane services.

FastAPI can infer JSON shapes, but it cannot infer business semantics from a
Request-only dependency or from an unannotated ``dict``.  This module keeps the
small amount of cross-cutting documentation policy in one place while each
route remains the source of its actual schema and status codes.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI


# OpenAPI examples are documentation-only values. Keep them deterministic,
# bounded, and obviously synthetic so Swagger never encourages copying a real
# credential or an unbounded dynamic payload.
_EXAMPLE_MAX_DEPTH = 3
_EXAMPLE_MAX_PROPERTIES = 24
_EXAMPLE_VALUES: dict[str, Any] = {
    "account": "13800000000",
    "owner_phone": "13800000000",
    "file": "policy.md (binary)",
    "phone": "13800000000",
    "username": "sysadmin",
    "password": "••••••••",
    "old_password": "••••••••",
    "new_password": "••••••••",
    "initial_password": "••••••••",
    "secret": "••••••••",
    "api_key": "sk-example-redacted",
    "relay_token": "relay-example-redacted",
    "token": "eyJ...redacted",
    "access_token": "eyJ...redacted",
    "owner_bootstrap_secret": "bootstrap-example-redacted",
    "bootstrap_secret": "bootstrap-example-redacted",
    "email": "operator@example.com",
    "url": "https://docs.example.invalid/policy",
    "endpoint": "https://relay.example.invalid/v1",
    "base_url": "https://relay.example.invalid/v1",
    "redirect_uri": "https://manager.example.invalid/oauth/callback",
    "display_name": "示例资源",
    "enterprise_name": "示例企业",
    "enterprise_code": "example-co",
    "enterprise": "example-co",
    "enterprise_id": "enterprise-1",
    "tenant_id": "tenant-1",
    "org_id": "enterprise-1",
    "employee_id": "employee-1",
    "employee_slug": "research-assistant",
    "member_id": "member-1",
    "member_ids": "00000000-0000-4000-8000-000000000002",
    "department_id": "00000000-0000-4000-8000-000000000001",
    "department_ids": "00000000-0000-4000-8000-000000000001",
    "employee_ids": "employee-1",
    "skill_ids": "skill-1",
    "knowledge_refs": "knowledge-space-1",
    "connector_refs": "connector-1",
    "provider_id": "provider-1",
    "provider_ref": "provider-main",
    "model_id": "model-1",
    "model_uid": "gpt-4o-mini",
    "catalog_id": "catalog-1",
    "catalog_type": "expert_template",
    "template_id": "template-1",
    "solution_id": "solution-1",
    "instance_id": "solution-instance-1",
    "order_id": "order-1",
    "policy_id": "policy-1",
    "knowledge_space_id": "knowledge-space-1",
    "document_id": "document-1",
    "memory_id": "memory-1",
    "credential_id": "credential-1",
    "lease_id": "lease-1",
    "skill_id": "skill-1",
    "resource_id": "resource-1",
    "grant_id": "grant-1",
    "version": "1",
    "revision": 1,
    "page": 1,
    "page_size": 20,
    "limit": 20,
    "offset": 0,
    "total": 1,
    "count": 1,
    "amount": "100.00",
    "currency": "CNY",
    "reason": "例行配置变更",
    "message": "这是一条示例通知。",
    "query": "采购政策",
    "keyword": "research",
    "cursor": "next-page-cursor",
    "after": "previous-event-id",
    "Idempotency-Key": "idem-example-1",
    "Mcp-Session-Id": "session-example-1",
    "X-AITeam-Employee-ID": "employee-1",
    "client_protocol": "aiteam-memory-v1",
    "allowed_operations": "recall",
    "retention_mode": "unlimited",
    "period": "month",
    "metric": "token_total",
    "status": "active",
    "operation_status": "active",
    "transition": "activate",
    "action": "activate",
    "title": "示例标题",
    "description": "用于展示 OpenAPI 结构的示例描述。",
    "summary": "示例摘要",
    "persona": "你是一名严谨的研究助手。",
    "system_prompt": "请以简洁、可核验的方式回答。",
    "content": "示例文本内容",
    "text": "示例文本内容",
    "file_name": "policy.md",
    "filename": "policy.md",
    "file_type": "text/markdown",
    "mime_type": "text/markdown",
    "source_type": "file",
    "provider_key": "openai",
    "model": "gpt-4o-mini",
    "model_name": "GPT-4o mini",
    "api_protocol": "openai-completions",
    "visibility": "tenant",
    "scope": "tenant",
    "role": "member",
    "roles": "member",
    "thinking_level": "medium",
    "severity": "info",
    "result": "success",
    "created_at": "2026-09-01T08:00:00Z",
    "updated_at": "2026-09-01T08:00:00Z",
    "occurred_at": "2026-09-01T08:00:00Z",
    "issued_at": "2026-09-01T08:00:00Z",
    "expires_at": "2026-09-01T09:00:00Z",
}

_PLACEHOLDER_DESCRIPTION = "请查看接口名称了解用途"
_GENERATED_DESCRIPTION = "执行接口摘要所述业务操作；成功响应遵循统一 envelope，失败返回 problem+json。"
_HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}

_PARAMETER_DESCRIPTIONS = {
    "tenant_id": "企业租户 ID；用于确定企业数据空间。",
    "enterprise_id": "运营端企业 ID。",
    "org_id": "企业组织 ID。",
    "enterprise_code": "企业可读代码或 slug。",
    "employee_id": "员工/专家实例 ID。",
    "employee_slug": "员工稳定 slug。",
    "member_id": "企业成员 ID。",
    "department_id": "部门 ID。",
    "grant_id": "成员授权记录 ID。",
    "provider_id": "平台 Provider ID。",
    "model_id": "平台模型 ID。",
    "catalog_id": "企业能力目录条目 ID。",
    "skill_id": "技能 ID。",
    "version": "资源的不可变版本号。",
    "template_id": "Operator 模板 ID。",
    "solution_id": "行业方案模板 ID。",
    "instance_id": "企业方案实例 ID。",
    "order_id": "招募订单 ID。",
    "policy_id": "配额策略 ID。",
    "knowledge_space_id": "企业知识空间 ID。",
    "document_id": "知识文档 ID。",
    "memory_id": "Hindsight 记忆条目 ID。",
    "credential_id": "认证凭据 ID。",
    "lease_id": "Hindsight runtime lease ID。",
    "provider": "第三方 OAuth 提供方标识。",
    "resource_type": "资源类型，例如 expert、solution 或 member。",
    "resource_id": "被授权资源 ID。",
    "catalog_type": "目录类型：expert_template 或 solution_template。",
    "period": "统计周期或聚合粒度。",
    "metric": "报表使用的指标名称。",
    "status": "按资源状态筛选。",
    "keyword": "按名称、代码或关键词筛选。",
    "query": "检索关键词。",
    "cursor": "不透明分页游标；不传表示从第一页开始。",
    "page": "页码，从 1 开始。",
    "page_size": "每页返回条数。",
    "limit": "返回条数上限。",
    "offset": "跳过的记录数。",
    "window_start": "统计窗口起点（ISO 8601 UTC）。",
    "window_end": "统计窗口终点（ISO 8601 UTC）。",
    "after": "从指定事件/条目之后继续读取。",
    "action": "要执行的业务动作。",
    "transition": "生命周期状态转换名称。",
    "owner": "外部技能发布者句柄。",
    "slug": "外部技能 slug。",
}

_FIELD_DESCRIPTIONS = {
    **_PARAMETER_DESCRIPTIONS,
    "id": "资源唯一标识。",
    "name": "资源名称。",
    "display_name": "面向用户展示的名称。",
    "description": "面向用户展示的业务描述。",
    "summary": "资源摘要。",
    "title": "标题。",
    "category": "业务分类。",
    "icon": "展示图标标识。",
    "avatar_url": "头像图片 URL。",
    "system_prompt": "员工运行时使用的系统提示词。",
    "persona": "员工角色人设文本。",
    "roles": "账号拥有的角色列表。",
    "role": "账号角色。",
    "account": "登录账号或身份外部标识。",
    "username": "运营端系统账号。",
    "password": "登录密码；仅用于认证请求，不会在响应中返回。",
    "old_password": "当前密码；仅用于密码重置。",
    "new_password": "要设置的新密码。",
    "token": "短期 access token。",
    "access_token": "短期 access token。",
    "refresh_token": "刷新凭据（如该认证方式支持）。",
    "must_reset": "是否需要首次登录后重置凭据。",
    "status": "当前业务状态。",
    "operation_status": "企业运营生命周期状态。",
    "enabled": "是否启用该配置。",
    "active": "是否处于启用状态。",
    "is_active": "是否处于启用状态。",
    "read": "是否已读。",
    "created_at": "创建时间（ISO 8601 UTC）。",
    "updated_at": "最后更新时间（ISO 8601 UTC）。",
    "occurred_at": "事件发生时间（ISO 8601 UTC）。",
    "expires_at": "过期时间（ISO 8601 UTC）。",
    "version": "资源配置版本，用于增量同步或并发控制。",
    "config_version": "配置版本，用于并发控制。",
    "snapshot_version": "执行快照版本。",
    "etag": "资源版本 ETag。",
    "next_cursor": "下一页不透明游标；null 表示没有更多数据。",
    "has_more": "是否还有下一页。",
    "total": "符合条件的记录总数。",
    "items": "当前页记录。",
    "data": "业务数据；具体类型由该接口的响应 schema 定义。",
    "meta": "非敏感诊断元数据。",
    "page": "分页信息。",
    "reason": "本次操作的原因或备注。",
    "message": "消息正文。",
    "detail": "人类可读的结果或错误说明。",
    "errors": "字段级校验错误列表。",
    "type": "资源或错误类型。",
    "code": "机器可读业务码。",
    "request_id": "请求关联 ID。",
    "tenant_id": "企业租户 ID。",
    "enterprise": "企业代码或名称；用于登录前定位 tenant，不是 Host 或进程绑定。",
    "member_ids": "被授权的成员 ID 列表。",
    "department_ids": "被授权的部门 ID 列表。",
    "employee_ids": "员工 ID 列表。",
    "skill_ids": "技能 ID 列表。",
    "knowledge_refs": "已授权知识空间引用列表。",
    "connector_refs": "连接器引用列表。",
    "tools": "允许使用的工具名称列表。",
    "skills": "技能引用列表。",
    "tags": "用于筛选和展示的标签列表。",
    "files": "技能或上传资源文件列表。",
    "content_hash": "内容哈希，用于完整性校验。",
    "sha256": "SHA-256 内容摘要。",
    "provider_ref": "Operator 平台 Provider 引用。",
    "provider_code": "Provider 稳定代码。",
    "model": "模型标识。",
    "model_id": "模型 ID。",
    "model_ids": "模型 ID 列表。",
    "model_name": "模型展示名称。",
    "model_uid": "Provider 内部模型标识。",
    "thinking_level": "模型思考深度设置。",
    "timeout_seconds": "单次执行超时时间（秒）。",
    "api_protocol": "Provider 使用的 API 协议。",
    "base_url": "服务基础 URL。",
    "relay_base_url": "企业 Relay 基础 URL。",
    "relay_token": "企业作用域 Relay 访问令牌；仅在受控响应中返回。",
    "api_key": "Provider API key；仅用于写入，不会在响应中返回。",
    "provider_key": "Provider 逻辑标识；不代表明文密钥。",
    "amount": "金额；使用 decimal string 表示。",
    "currency": "金额币种。",
    "cost_total": "统计窗口内总成本。",
    "input_tokens": "输入 token 数。",
    "output_tokens": "输出 token 数。",
    "cache_tokens": "缓存 token 数。",
    "prompt_count": "提示次数。",
    "error_count": "错误次数。",
    "duration_seconds_total": "总耗时（秒）。",
    "pricing_status": "价格状态：known 或 unknown。",
    "pricing_version": "计价版本。",
    "schema_version": "摘要 schema 版本。",
    "action": "要执行的业务动作。",
    "visible_scope": "目录可见范围配置。",
    "initial_quota_policy": "首次开通时的默认配额策略。",
    "features": "企业功能开关配置。",
    "config": "能力配置 JSON；字段由对应能力类型定义。",
    "policy": "策略配置 JSON；字段由对应策略类型定义。",
    "metadata": "调用方附加元数据。",
    "response": "浏览器 WebAuthn API 返回的凭据响应。",
    "redirect_uri": "OAuth 回调地址。",
    "provider": "第三方 OAuth 提供方。",
}


def _humanize(value: str) -> str:
    value = value.replace("_", " ")
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value)
    return value.strip()


def _description_for(name: str, *, location: str | None = None) -> str:
    if name in _FIELD_DESCRIPTIONS:
        return _FIELD_DESCRIPTIONS[name]
    if location == "path":
        return f"路径资源标识：{_humanize(name)}。"
    if location in {"query", "header", "cookie"}:
        return f"请求{location}参数：{_humanize(name)}。"
    return f"业务字段：{_humanize(name)}。"


def _resolve_schema(schema: Any, components: dict[str, Any], seen: set[str] | None = None) -> dict[str, Any]:
    """Resolve one local component reference for documentation examples only."""
    if not isinstance(schema, dict):
        return {}
    ref = schema.get("$ref")
    if not isinstance(ref, str):
        return schema
    seen = seen or set()
    if ref in seen:
        return {}
    target = components.get("schemas", {}).get(ref.rsplit("/", 1)[-1])
    if not isinstance(target, dict):
        return {}
    return _resolve_schema(target, components, seen | {ref})


def _allows_null(schema: Any, components: dict[str, Any]) -> bool:
    if not isinstance(schema, dict):
        return False
    resolved = _resolve_schema(schema, components)
    if resolved.get("type") == "null":
        return True
    return any(_resolve_schema(branch, components).get("type") == "null" for branch in resolved.get("anyOf", []))


def _example_scalar(field_name: str | None, schema: dict[str, Any]) -> Any:
    """Return a safe scalar for a schema after enum/default handling."""
    if schema.get("enum"):
        return schema["enum"][0]
    schema_type = schema.get("type")
    schema_types = set(schema_type) if isinstance(schema_type, list) else {schema_type}
    if field_name:
        if field_name in _EXAMPLE_VALUES:
            value = _EXAMPLE_VALUES[field_name]
            if (schema_type is None or "string" in schema_types) and isinstance(value, str):
                return value
            if "boolean" in schema_types and isinstance(value, bool):
                return value
            if schema_types & {"integer", "number"} and isinstance(value, (int, float)):
                return value
        lowered = field_name.casefold()
        if lowered.endswith(("_at", "_time", "_date")):
            return "2026-09-01T08:00:00Z"
        if lowered.endswith("_id"):
            return f"{lowered[:-3].rstrip('_') or 'resource'}-1"
        if "email" in lowered:
            return "operator@example.com"
        if "phone" in lowered or lowered == "mobile":
            return "13800000000"
        if lowered.endswith("_url") or lowered in {"url", "uri"}:
            return "https://example.invalid/resource"
        if lowered.startswith(("is_", "has_", "can_")):
            return True
    fmt = schema.get("format")
    if fmt == "date-time":
        return "2026-09-01T08:00:00Z"
    if fmt == "date":
        return "2026-09-01"
    if fmt in {"uri", "url"}:
        return "https://example.invalid/resource"
    if fmt == "email":
        return "operator@example.com"
    if fmt in {"byte", "binary"}:
        return "ZXhhbXBsZQ=="
    scalar_type = next((item for item in schema_types if item != "null"), None)
    if scalar_type == "integer":
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)):
            return int(max(minimum, 0))
        return 1
    if scalar_type == "number":
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)):
            return max(minimum, 0)
        return 1.0
    if scalar_type == "boolean":
        return True
    return "string"


def _example_for_schema(
    schema: Any,
    components: dict[str, Any],
    *,
    field_name: str | None = None,
    depth: int = 0,
    seen_refs: set[str] | None = None,
) -> Any:
    """Build a bounded, deterministic example from an OpenAPI schema."""
    if not isinstance(schema, dict):
        return None
    if "example" in schema:
        return schema["example"]
    if isinstance(schema.get("examples"), list) and schema["examples"]:
        return schema["examples"][0]
    if "default" in schema and schema["default"] not in (None, ""):
        return schema["default"]

    seen_refs = seen_refs or set()
    ref = schema.get("$ref")
    if isinstance(ref, str):
        if ref in seen_refs:
            return None
        target = components.get("schemas", {}).get(ref.rsplit("/", 1)[-1])
        return _example_for_schema(target, components, field_name=field_name, depth=depth, seen_refs=seen_refs | {ref})

    for key in ("oneOf", "anyOf"):
        branches = schema.get(key)
        if isinstance(branches, list):
            for branch in branches:
                if _resolve_schema(branch, components).get("type") == "null":
                    continue
                value = _example_for_schema(branch, components, field_name=field_name, depth=depth, seen_refs=seen_refs)
                if value is not None:
                    return value
            return None

    if isinstance(schema.get("allOf"), list):
        merged: dict[str, Any] = {}
        first_value: Any = None
        for branch in schema["allOf"]:
            value = _example_for_schema(branch, components, field_name=field_name, depth=depth, seen_refs=seen_refs)
            if isinstance(value, dict):
                merged.update(value)
            elif first_value is None and value is not None:
                first_value = value
        return merged if merged else first_value

    resolved = _resolve_schema(schema, components, seen_refs)
    if resolved is not schema and resolved:
        return _example_for_schema(resolved, components, field_name=field_name, depth=depth, seen_refs=seen_refs)
    if depth > _EXAMPLE_MAX_DEPTH:
        return _example_scalar(field_name, resolved)

    schema_type = resolved.get("type")
    if isinstance(schema_type, list):
        schema_type = next((item for item in schema_type if item != "null"), "string")
    if schema_type == "object" or "properties" in resolved:
        properties = resolved.get("properties")
        if isinstance(properties, dict):
            result: dict[str, Any] = {}
            for name, child in list(properties.items())[:_EXAMPLE_MAX_PROPERTIES]:
                value = _example_for_schema(
                    child,
                    components,
                    field_name=str(name),
                    depth=depth + 1,
                    seen_refs=seen_refs,
                )
                if value is not None or _allows_null(child, components):
                    result[str(name)] = value
            if result:
                return result
        additional = resolved.get("additionalProperties")
        if isinstance(additional, dict) and depth < _EXAMPLE_MAX_DEPTH:
            return {"example_key": _example_for_schema(additional, components, field_name="value", depth=depth + 1, seen_refs=seen_refs)}
        if additional is True:
            return {"example_key": "synthetic-value"}
        return {}
    if schema_type == "array":
        if resolved.get("maxItems") == 0:
            return []
        item_schema = resolved.get("items", {})
        item = _example_for_schema(item_schema, components, field_name=field_name, depth=depth + 1, seen_refs=seen_refs)
        return [] if item is None and _allows_null(item_schema, components) else [item]
    if schema_type == "null":
        return None
    return _example_scalar(field_name, resolved)


def _response_uses_envelope(schema: Any, components: dict[str, Any]) -> bool:
    resolved = _resolve_schema(schema, components)
    properties = resolved.get("properties", {}) if isinstance(resolved, dict) else {}
    return isinstance(properties, dict) and "data" in properties and bool({"meta", "page"} & set(properties))


def _example_for_media(schema: Any, media_type: str, components: dict[str, Any], *, field_name: str | None = None) -> Any:
    if media_type.startswith("text/event-stream"):
        return "event: message\\ndata: {\\\"type\\\":\\\"heartbeat\\\"}\\n\\n"
    if media_type == "text/csv":
        return "id,name\\nresource-1,示例资源\\n"
    if media_type.startswith(("application/octet-stream", "application/pdf", "image/")):
        return "ZXhhbXBsZQ=="
    return _example_for_schema(schema, components, field_name=field_name)


def _request_id_header() -> dict[str, Any]:
    return {
        "description": "服务端生成的请求关联 ID；可用于日志排查。",
        "schema": {"type": "string", "minLength": 1, "maxLength": 128},
    }


def _mcp_session_header() -> dict[str, Any]:
    return {
        "description": "FastMCP 会话 ID；initialize 后返回，后续请求通过 Mcp-Session-Id 头回传。",
        "schema": {"type": "string", "minLength": 1, "maxLength": 256},
    }


def _trace_id_header() -> dict[str, Any]:
    return {
        "description": "跨服务追踪 ID；用于关联同一请求在 Operator/Manager 中的链路日志。",
        "schema": {"type": "string", "minLength": 1, "maxLength": 128},
    }


def _cache_control_header() -> dict[str, Any]:
    return {
        "description": "缓存策略；含 token、密钥或租约的响应必须禁止缓存。",
        "schema": {"type": "string", "example": "no-store"},
    }


def _problem_example(status: int, code: str, detail: str) -> dict[str, Any]:
    return {
        "type": f"https://docs.aiteam.local/problems/{code}",
        "title": code.replace("_", " ").title(),
        "status": status,
        "code": code,
        "detail": detail,
        "instance": "/api/example",
        "request_id": "req-example",
    }


def _problem_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "description": "统一 problem+json 错误响应。",
        "required": ["type", "title", "status", "code", "detail", "instance", "request_id"],
        "properties": {
            "type": {"type": "string", "description": "错误类型 URI。"},
            "title": {"type": "string", "description": "错误标题。"},
            "status": {"type": "integer", "description": "HTTP 状态码。"},
            "code": {"type": "string", "description": "机器可读错误码。"},
            "detail": {"type": "string", "description": "人类可读错误说明。"},
            "instance": {"type": "string", "description": "发生错误的资源路径。"},
            "request_id": {"type": "string", "description": "请求关联 ID。"},
            "errors": {
                "type": "array",
                "description": "字段级校验错误。",
                "items": {
                    "type": "object",
                    "required": ["loc", "message", "type"],
                    "properties": {
                        "loc": {"type": "array", "items": {"type": ["string", "integer"]}, "description": "错误字段路径。"},
                        "message": {"type": "string", "description": "字段校验说明。"},
                        "type": {"type": "string", "description": "校验错误类型。"},
                    },
                },
            },
            "meta": {"type": "object", "description": "非敏感诊断元数据。"},
        },
    }


def _problem_response(
    description: str,
    *,
    status: int,
    code: str,
    detail: str,
) -> dict[str, Any]:
    return {
        "description": description,
        "content": {
            "application/problem+json": {
                "schema": {"$ref": "#/components/schemas/Problem"},
                "examples": {"problem": {"summary": description, "value": _problem_example(status, code, detail)}},
            }
        },
        "headers": {
            "X-Request-ID": {"$ref": "#/components/headers/RequestId"},
            "X-Trace-ID": {"$ref": "#/components/headers/TraceId"},
        },
    }


def _security_kind(path: str, operation_id: str) -> str | None:
    """Return bearer/service/public for the known v1 route boundaries."""
    if path in {"/healthz", "/readyz", "/metrics", "/openapi.json"}:
        return None
    if path.endswith("/ping") or path in {"/api/operation/auth/login"}:
        return None
    if path.startswith("/api/auth/"):
        return None
    if path.startswith("/api/operation/catalog/pull/"):
        return "service"
    if path.startswith("/api/operation/skill-market/pull/"):
        return "service"
    if operation_id in {
        "operation_ingest_rollup",
        "operation_platform_provider_pull",
        "operation_tenant_provider_access_resolve",
        "manager_provision_tenant",
        "manager_owner_bootstrap",
        "manager_catalog_notify",
        "manager_inbox_deliver_from_operation",
    }:
        return "service"
    return "bearer"


def _enrich_schema_node(node: Any, *, field_name: str | None = None, location: str | None = None, seen: set[int] | None = None) -> None:
    if not isinstance(node, dict):
        if isinstance(node, list):
            for item in node:
                _enrich_schema_node(item, field_name=field_name, location=location, seen=seen)
        return
    seen = seen or set()
    marker = id(node)
    if marker in seen:
        return
    seen.add(marker)
    if field_name and not node.get("description"):
        node["description"] = _description_for(field_name, location=location)
    if node.get("type") == "object" and node.get("additionalProperties") is True:
        node.setdefault("x-dynamic-json", True)
        if not node.get("description"):
            node["description"] = "扩展 JSON 对象；具体键由对应业务能力约定。"
    properties = node.get("properties")
    if isinstance(properties, dict):
        for name, child in properties.items():
            _enrich_schema_node(child, field_name=name, location=None, seen=seen)
    for key, child in node.items():
        if key != "properties":
            _enrich_schema_node(child, field_name=None, location=location, seen=seen)


_MCP_COMPONENTS = {
    "McpJsonRpcRequest": {
        "type": "object",
        "description": "Manager RAG MCP Streamable HTTP 的 JSON-RPC 2.0 请求；params 由具体 MCP 方法定义。",
        "required": ["jsonrpc", "id", "method"],
        "properties": {
            "jsonrpc": {"type": "string", "const": "2.0", "description": "JSON-RPC 协议版本。"},
            "id": {"type": ["string", "integer"], "description": "请求 ID。"},
            "method": {"type": "string", "description": "MCP 方法，如 initialize、tools/list、tools/call。"},
            "params": {"type": "object", "additionalProperties": True, "x-dynamic-json": True, "description": "方法参数；由 MCP 工具 schema 约束。"},
        },
        "additionalProperties": False,
        "x-dynamic-json": True,
    },
    "McpJsonRpcResponse": {
        "type": "object",
        "description": "Manager RAG MCP Streamable HTTP 的 JSON-RPC 2.0 响应或错误。",
        "required": ["jsonrpc", "id"],
        "properties": {
            "jsonrpc": {"type": "string", "const": "2.0", "description": "JSON-RPC 协议版本。"},
            "id": {"type": ["string", "integer", "null"], "description": "对应请求 ID。"},
            "result": {"type": "object", "additionalProperties": True, "x-dynamic-json": True, "description": "MCP 方法结果。"},
            "error": {"type": "object", "additionalProperties": True, "x-dynamic-json": True, "description": "JSON-RPC 错误对象。"},
        },
        "additionalProperties": True,
        "x-dynamic-json": True,
    },
}


_OPERATION_PROJECTION_COMPONENTS = {
    "EnterpriseRechargeRecord": {
        "type": "object", "description": "企业充值记录摘要。", "additionalProperties": False,
        "properties": {
            "recharge_id": {"type": "string", "description": "充值记录 ID。"},
            "amount": {"type": "string", "description": "充值金额；decimal string。"},
            "created_at": {"type": "string", "format": "date-time", "description": "充值时间。"},
        },
        "required": ["recharge_id", "amount", "created_at"],
    },
    "EnterpriseAuditRecord": {
        "type": "object", "description": "企业脱敏审计事件摘要。", "additionalProperties": False,
        "properties": {
            "event_id": {"type": "string", "description": "审计事件 ID。"},
            "action": {"type": "string", "description": "审计动作。"},
            "detail": {"type": "string", "description": "脱敏操作说明。"},
            "severity": {"type": "string", "enum": ["info", "warning", "critical"], "description": "严重级别。"},
            "result": {"type": "string", "enum": ["success", "failure"], "description": "操作结果。"},
            "ip_address": {"type": ["string", "null"], "description": "来源 IP（如可用）。"},
            "user_agent": {"type": ["string", "null"], "description": "来源 User-Agent（如可用）。"},
            "created_at": {"type": "string", "format": "date-time", "description": "事件时间。"},
        },
        "required": ["event_id", "action", "detail", "severity", "result", "created_at"],
    },
    "EnterpriseTokenHistory": {
        "type": "object", "description": "企业脱敏用量历史摘要。", "additionalProperties": False,
        "properties": {
            "run_count": {"type": "integer", "minimum": 0, "description": "运行次数。"},
            "token_total": {"type": "integer", "minimum": 0, "description": "token 总数。"},
            "cost_total": {"type": "string", "description": "总费用；decimal string。"},
            "error_count": {"type": "integer", "minimum": 0, "description": "错误次数。"},
            "window_start": {"type": ["string", "null"], "format": "date-time", "description": "窗口起点。"},
            "window_end": {"type": ["string", "null"], "format": "date-time", "description": "窗口终点。"},
        },
        "required": ["run_count", "token_total", "cost_total", "error_count"],
    },
    "EnterpriseQuotaSnapshot": {
        "type": "object", "description": "企业配额上限与使用量快照。", "additionalProperties": False,
        "properties": {
            "employee_limit": {"type": "integer", "description": "员工上限；-1 表示不限。"},
            "employee_used": {"type": "integer", "minimum": 0, "description": "已使用员工数。"},
            "storage_limit_mb": {"type": "integer", "description": "存储上限 MB；-1 表示不限。"},
            "storage_used_mb": {"type": "integer", "minimum": 0, "description": "已使用存储 MB。"},
            "api_rate_limit": {"type": "integer", "description": "API 每分钟上限；-1 表示不限。"},
            "api_rate_used": {"type": "integer", "minimum": 0, "description": "当前 API 使用量。"},
            "token_quota_limit": {"type": "integer", "description": "月度 token 配额；-1 表示不限。"},
            "token_quota_used": {"type": "integer", "minimum": 0, "description": "当前月度 token 使用量。"},
        },
        "required": ["employee_limit", "employee_used", "storage_limit_mb", "storage_used_mb", "api_rate_limit", "api_rate_used", "token_quota_limit", "token_quota_used"],
    },
    "EnterpriseExportRow": {
        "type": "object", "description": "企业导出行；不含凭据和会话内容。", "additionalProperties": False,
        "properties": {
            "org_id": {"type": "string", "description": "企业 ID。"},
            "enterprise_name": {"type": "string", "description": "企业名称。"},
            "status": {"type": "string", "enum": ["active", "suspended", "banned", "closed"], "description": "企业生命周期。"},
            "total_recharged": {"type": "string", "description": "累计充值；decimal string。"},
            "token_consumed": {"type": "integer", "minimum": 0, "description": "累计消耗 token。"},
            "registered_at": {"type": "string", "format": "date-time", "description": "注册时间。"},
        },
        "required": ["org_id", "enterprise_name", "status", "total_recharged", "token_consumed", "registered_at"],
    },
    "UsageTrendPoint": {
        "type": "object", "description": "按天聚合的员工用量趋势点。", "additionalProperties": False,
        "properties": {
            "day": {"type": "string", "format": "date", "description": "UTC 日期。"},
            "tokens": {"type": "integer", "minimum": 0, "description": "该日 token 数。"},
            "cost": {"type": "string", "description": "该日成本；decimal string。"},
        },
        "required": ["day", "tokens", "cost"],
    },
    "UsageRankingPoint": {
        "type": "object", "description": "员工用量排名点。", "additionalProperties": False,
        "properties": {
            "employee_id": {"type": "string", "description": "员工 ID。"},
            "tokens": {"type": "integer", "minimum": 0, "description": "员工 token 数。"},
            "cost": {"type": "string", "description": "员工成本；decimal string。"},
        },
        "required": ["employee_id", "tokens", "cost"],
    },
    "FinanceTrendPoint": {
        "type": "object", "description": "财务周期趋势点。", "additionalProperties": False,
        "properties": {
            "period": {"type": "string", "description": "趋势时间桶。"},
            "amount": {"type": "string", "description": "该桶充值金额；decimal string。"},
        },
        "required": ["period", "amount"],
    },
    "FinanceConsumerPoint": {
        "type": "object", "description": "企业用量成本排名摘要。", "additionalProperties": False,
        "properties": {
            "org_id": {"type": "string", "description": "企业 ID。"},
            "enterprise_name": {"type": "string", "description": "企业名称。"},
            "cost_total": {"type": ["string", "null"], "description": "已知价格摘要成本；未知价格时为 null。"},
            "token_total": {"type": "integer", "minimum": 0, "description": "token 总数。"},
            "pricing_status": {"type": "string", "enum": ["known", "partial"], "description": "价格完整性。"},
            "unknown_pricing_tokens": {"type": "integer", "minimum": 0, "description": "未知价格 token 数。"},
        },
        "required": ["org_id", "enterprise_name", "cost_total", "token_total", "pricing_status", "unknown_pricing_tokens"],
    },
    "FinanceRechargeDetail": {
        "type": "object", "description": "财务充值明细。", "additionalProperties": False,
        "properties": {
            "recharge_id": {"type": "string", "description": "充值记录 ID。"},
            "enterprise_id": {"type": "string", "description": "企业 ID。"},
            "amount": {"type": "string", "description": "充值金额；decimal string。"},
            "created_at": {"type": "string", "format": "date-time", "description": "充值时间。"},
            "currency": {"type": "string", "enum": ["CNY"], "description": "收入币种。"},
        },
        "required": ["recharge_id", "enterprise_id", "amount", "created_at", "currency"],
    },
    "FinanceConsumptionDetail": {
        "type": "object", "description": "财务用量消耗明细。", "additionalProperties": False,
        "properties": {
            "enterprise_id": {"type": "string", "description": "企业 ID。"},
            "token_total": {"type": "integer", "minimum": 0, "description": "token 总数。"},
            "cost_total": {"type": ["string", "null"], "description": "已知价格摘要成本；未知价格时为 null。"},
            "run_count": {"type": "integer", "minimum": 0, "description": "运行次数。"},
            "pricing_status": {"type": "string", "enum": ["known", "partial"], "description": "价格完整性。"},
            "unknown_pricing_tokens": {"type": "integer", "minimum": 0, "description": "未知价格 token 数。"},
            "currency": {"type": "string", "enum": ["USD"], "description": "成本币种。"},
        },
        "required": ["enterprise_id", "token_total", "cost_total", "run_count", "pricing_status", "unknown_pricing_tokens", "currency"],
    },
    "FinanceProfitDetail": {
        "type": "object", "description": "财务利润明细；币种不一致时利润为空。", "additionalProperties": False,
        "properties": {
            "total_revenue": {"type": "string", "description": "总收入；decimal string。"},
            "revenue_currency": {"type": "string", "enum": ["CNY"], "description": "收入币种。"},
            "total_cost": {"type": "string", "description": "总成本；decimal string。"},
            "cost_currency": {"type": "string", "enum": ["USD"], "description": "成本币种。"},
            "gross_profit": {"type": ["string", "null"], "description": "毛利；无 FX 时为 null。"},
            "profit_status": {"type": "string", "description": "利润可用性状态。"},
            "period": {"type": "string", "description": "财务周期。"},
        },
        "required": ["total_revenue", "revenue_currency", "total_cost", "cost_currency", "gross_profit", "profit_status", "period"],
    },
    "ServiceHealthMap": {
        "type": "object", "description": "依赖服务健康状态映射。", "additionalProperties": {"type": "string", "enum": ["up", "degraded"]},
    },
}


_SUMMARY_COMPONENTS = {
    "UsageSummary": {
        "type": "object",
        "description": "脱敏用量聚合摘要；不含会话内容、文件内容或逐 token 明细。",
        "required": ["summary_id", "tenant_id", "window_start", "window_end"],
        "properties": {
            "summary_id": {"type": "string", "description": "幂等摘要 ID。"},
            "tenant_id": {"type": "string", "description": "企业租户 ID。"},
            "employee_id": {"type": ["string", "null"], "description": "员工 ID；可为空表示企业级聚合。"},
            "window_start": {"type": "string", "format": "date-time", "description": "聚合窗口起点。"},
            "window_end": {"type": "string", "format": "date-time", "description": "聚合窗口终点。"},
            "run_count": {"type": "integer", "minimum": 0, "default": 0, "description": "运行次数。"},
            "token_total": {"type": "integer", "minimum": 0, "default": 0, "description": "token 总数。"},
            "cost_total": {"type": ["string", "null"], "description": "USD 总费用；pricing_status=unknown 时为 null，不把未知价格当作免费。"},
            "currency": {"type": "string", "enum": ["USD"], "default": "USD", "description": "费用币种。"},
            "pricing_version": {"type": ["integer", "null"], "minimum": 1, "description": "计价版本。"},
            "pricing_status": {"type": "string", "enum": ["known", "unknown"], "default": "unknown", "description": "价格是否已知。"},
            "error_count": {"type": "integer", "minimum": 0, "default": 0, "description": "错误次数。"},
            "duration_seconds_total": {"type": "integer", "minimum": 0, "default": 0, "description": "总耗时（秒）。"},
        },
        "additionalProperties": False,
    },
    "AuditSummaryEvent": {
        "type": "object",
        "description": "脱敏审计摘要；不含会话正文或运行时原始事件。",
        "required": ["summary_id", "tenant_id", "actor", "action", "occurred_at"],
        "properties": {
            "summary_id": {"type": "string", "description": "幂等摘要 ID。"},
            "tenant_id": {"type": "string", "description": "企业租户 ID。"},
            "actor": {"type": "string", "description": "用户 ID 或服务身份。"},
            "action": {"type": "string", "description": "审计动作，例如 login、grant_change。"},
            "resource_type": {"type": ["string", "null"], "description": "资源类型。"},
            "resource_id": {"type": ["string", "null"], "description": "资源 ID。"},
            "occurred_at": {"type": "string", "format": "date-time", "description": "事件发生时间。"},
        },
        "additionalProperties": False,
    },
}


def _install_manager_mcp_documentation(schema: dict[str, Any], components: dict[str, Any]) -> None:
    """Expose the mounted RAG Streamable HTTP protocol beside REST routes."""
    schemas = components.setdefault("schemas", {})
    for name, model in _MCP_COMPONENTS.items():
        schemas.setdefault(name, model)
    components.setdefault("headers", {}).setdefault("McpSessionId", _mcp_session_header())
    session_header = {
        "name": "Mcp-Session-Id",
        "in": "header",
        "required": False,
        "description": "FastMCP 会话 ID；initialize 成功后由服务端返回，后续请求原样回传。",
        "schema": {"type": "string", "minLength": 1, "maxLength": 256},
        "example": "session-example-1",
    }
    employee_header = {
        "name": "X-AITeam-Employee-ID",
        "in": "header",
        "required": True,
        "description": "要执行知识检索的 employee ID；Manager 会再次按当前 snapshot/绑定授权校验。",
        "schema": {"type": "string", "minLength": 1, "maxLength": 256},
        "example": "employee-1",
    }
    accept_header = {
        "name": "Accept",
        "in": "header",
        "required": True,
        "description": "Streamable HTTP 必须同时接受 application/json 和 text/event-stream。",
        "schema": {"type": "string"},
        "example": "application/json, text/event-stream",
    }
    request_example = {
        "initialize": {
            "summary": "初始化会话",
            "value": {"jsonrpc": "2.0", "id": "request-1", "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        },
        "knowledgeSearch": {
            "summary": "调用 knowledge_search",
            "value": {"jsonrpc": "2.0", "id": "request-2", "method": "tools/call", "params": {"name": "knowledge_search", "arguments": {"query": "采购政策", "limit": 10}}},
        },
    }
    response_examples = {
        "toolsCall": {
            "summary": "工具调用结果",
            "value": {"jsonrpc": "2.0", "id": "request-2", "result": {"content": [{"type": "text", "text": "[\\\"citation:knowledge-space-1:document-1\\\"]"}], "isError": False}},
        }
    }
    mcp_path = schema.setdefault("paths", {}).setdefault("/api/manager/rag/mcp", {})
    mcp_path["x-mcp-tools"] = [
        {"name": "knowledge_search", "description": "检索当前 employee 有权访问的企业知识空间，返回有界 citation。", "arguments": {"query": "string", "limit": "integer 1..20"}},
        {"name": "knowledge_get", "description": "读取当前 employee 有权访问的 citation 文本，返回有界片段。", "arguments": {"citation_id": "string"}},
    ]
    mcp_path.setdefault("get", {
        "tags": ["manager", "rag-mcp"],
        "summary": "建立 RAG MCP SSE 流",
        "description": "Manager-owned Streamable HTTP MCP 长连接；需要 Bearer token、X-AITeam-Employee-ID 和 text/event-stream Accept。",
        "operationId": "manager_rag_mcp_stream",
        "x-protocol": "mcp",
        "parameters": [employee_header, session_header, accept_header],
        "responses": {
            "200": {"description": "MCP SSE 事件流。", "content": {"text/event-stream": {"schema": {"type": "string"}, "examples": {"event": {"summary": "JSON-RPC SSE 事件", "value": "event: message\\ndata: {\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"notifications/tools/list_changed\\\"}\\n\\n"}}}}},
            "404": {"description": "MCP session 不存在或已终止；返回 JSON-RPC error。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}, "examples": {"notFound": {"summary": "会话不存在", "value": {"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": "Session not found"}}}}}}},
            "406": {"description": "Accept 未包含 text/event-stream；返回 JSON-RPC error。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}, "examples": {"notAcceptable": {"summary": "Accept 不支持", "value": {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "Not Acceptable"}}}}}}},
            "409": {"description": "当前 session 已有 SSE stream；返回 JSON-RPC error。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}, "examples": {"conflict": {"summary": "流冲突", "value": {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "Only one SSE stream is allowed"}}}}}}},
            "500": {"description": "MCP 内部处理错误；返回 JSON-RPC error。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}, "examples": {"internal": {"summary": "内部错误", "value": {"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": "Internal error"}}}}}}},
        },
    })
    mcp_path.setdefault("post", {
        "tags": ["manager", "rag-mcp"],
        "summary": "调用 RAG MCP 方法",
        "description": "向 Manager RAG MCP 发送 JSON-RPC 2.0 请求；支持 initialize、tools/list、knowledge_search 和 knowledge_get。",
        "operationId": "manager_rag_mcp_call",
        "x-protocol": "mcp",
        "parameters": [employee_header, session_header, {**accept_header, "description": "必须同时接受 application/json 和 text/event-stream。"}],
        "requestBody": {"required": True, "description": "JSON-RPC 2.0 请求；params 由具体 MCP 方法约束。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcRequest"}, "examples": request_example}}},
        "responses": {
            "200": {"description": "JSON-RPC 响应或 SSE 事件流。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}, "examples": response_examples}, "text/event-stream": {"schema": {"type": "string"}, "examples": {"event": {"summary": "JSON-RPC SSE 事件", "value": "event: message\\ndata: {\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":\\\"request-2\\\",\\\"result\\\":{}}\\n\\n"}}}}},
            "202": {"description": "JSON-RPC notification/response 已接受；响应体可能为空。", "content": {"application/json": {"schema": {"anyOf": [{"$ref": "#/components/schemas/McpJsonRpcResponse"}, {"type": "null"}]}, "examples": {"accepted": {"summary": "通知已接受", "value": None}}}}},
            "400": {"description": "MCP JSON-RPC 请求格式无效；返回 JSON-RPC error。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}, "examples": {"invalid": {"summary": "请求无效", "value": {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}}}}}},
            "406": {"description": "Accept 未同时包含 JSON 和 SSE；返回 JSON-RPC error。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}}}},
            "415": {"description": "Content-Type 必须为 application/json；返回 JSON-RPC error。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}}}},
        },
    })
    mcp_path.setdefault("delete", {
        "tags": ["manager", "rag-mcp"],
        "summary": "终止 RAG MCP 会话",
        "description": "使用当前 Mcp-Session-Id 显式终止 Streamable HTTP 会话。",
        "operationId": "manager_rag_mcp_terminate",
        "x-protocol": "mcp",
        "parameters": [employee_header, session_header],
        "responses": {"200": {"description": "会话已终止；响应体为空。", "content": {"application/json": {"schema": {"anyOf": [{"$ref": "#/components/schemas/McpJsonRpcResponse"}, {"type": "null"}]}, "examples": {"terminated": {"summary": "会话已终止", "value": None}}}}}, "404": {"description": "MCP session 不存在或已终止；返回 JSON-RPC error。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}, "examples": {"notFound": {"summary": "会话不存在", "value": {"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": "Session not found"}}}}}}}, "405": {"description": "当前没有可终止的 MCP 会话。", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/McpJsonRpcResponse"}, "examples": {"methodNotAllowed": {"summary": "无可终止会话", "value": {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "Method Not Allowed"}}}}}}}},
    })
    for method in ("get", "post", "delete"):
        operation = mcp_path.get(method)
        if not isinstance(operation, dict):
            continue
        for response in operation.get("responses", {}).values():
            if isinstance(response, dict) and "$ref" not in response and response.get("description"):
                response.setdefault("headers", {})["Mcp-Session-Id"] = {"$ref": "#/components/headers/McpSessionId"}

    schema.setdefault("info", {}).setdefault("x-manager-protocols", {})["rag_mcp"] = {
        "endpoint": "/api/manager/rag/mcp",
        "transport": "Streamable HTTP",
        "auth": "Bearer + X-AITeam-Employee-ID",
        "tools": ["knowledge_search(query, limit)", "knowledge_get(citation_id)"],
    }


def _install_control_plane_schema_overrides(schemas: dict[str, Any]) -> None:
    """Tighten docs for known projection fields without changing validation."""
    for name, model in {**_SUMMARY_COMPONENTS, **_OPERATION_PROJECTION_COMPONENTS}.items():
        schemas.setdefault(name, model)

    admin_detail = schemas.get("EnterpriseAccountDetail")
    if isinstance(admin_detail, dict):
        properties = admin_detail.setdefault("properties", {})
        for field, ref in {
            "recharge_records": "EnterpriseRechargeRecord",
            "audit_events": "EnterpriseAuditRecord",
            "token_history": "EnterpriseTokenHistory",
        }.items():
            if isinstance(properties.get(field), dict):
                properties[field]["items"] = {"$ref": f"#/components/schemas/{ref}"}
        if isinstance(properties.get("quota"), dict):
            properties["quota"] = {
                "anyOf": [{"$ref": "#/components/schemas/EnterpriseQuotaSnapshot"}, {"type": "null"}],
                "description": "企业配额上限与使用量快照；未初始化时为 null。",
            }

    export = schemas.get("EnterpriseExportResponse")
    if isinstance(export, dict) and isinstance(export.get("properties", {}).get("rows"), dict):
        export["properties"]["rows"]["items"] = {"$ref": "#/components/schemas/EnterpriseExportRow"}

    finance = schemas.get("FinanceOverviewOut")
    if isinstance(finance, dict):
        properties = finance.setdefault("properties", {})
        for field, ref in {"monthly_trend": "FinanceTrendPoint", "top5_consumers": "FinanceConsumerPoint"}.items():
            if isinstance(properties.get(field), dict):
                properties[field]["items"] = {"$ref": f"#/components/schemas/{ref}"}

    usage_overview = schemas.get("UsageOverviewOut")
    if isinstance(usage_overview, dict):
        properties = usage_overview.setdefault("properties", {})
        for field, ref in {"trend": "UsageTrendPoint", "ranking": "UsageRankingPoint"}.items():
            if isinstance(properties.get(field), dict):
                properties[field]["items"] = {"$ref": f"#/components/schemas/{ref}"}

    reports = schemas.get("FinanceReportOut")
    if isinstance(reports, dict):
        properties = reports.setdefault("properties", {})
        for field, ref in {
            "recharge_details": "FinanceRechargeDetail",
            "consumption_details": "FinanceConsumptionDetail",
            "profit_details": "FinanceProfitDetail",
        }.items():
            if isinstance(properties.get(field), dict):
                properties[field]["items"] = {"$ref": f"#/components/schemas/{ref}"}

    health = schemas.get("SystemHealthOut")
    if isinstance(health, dict) and isinstance(health.get("properties", {}).get("services"), dict):
        health["properties"]["services"] = {"$ref": "#/components/schemas/ServiceHealthMap"}

    health_response = schemas.get("HealthResponse")
    if isinstance(health_response, dict) and isinstance(health_response.get("properties", {}).get("status"), dict):
        health_response["properties"]["status"]["enum"] = ["ok", "ready", "degraded", "blocked"]
        health_response["properties"]["status"]["description"] = "服务状态：ok=存活、ready=依赖就绪、degraded/blocked=不可完全提供能力。"

    for schema_name, field_name, values in (
        ("EnterpriseAccountOut", "status", ["active", "suspended", "banned", "closed"]),
        ("EnterpriseAccountOut", "operation_status", ["active", "suspended", "banned", "closed"]),
        ("LifecycleStatusOut", "operation_status", ["active", "suspended", "banned", "closed"]),
        ("LifecycleResponse", "operation_status", ["active", "suspended", "banned", "closed"]),
        ("EnrichedAuditOut", "severity", ["info", "warning", "critical"]),
        ("EnrichedAuditOut", "result", ["success", "failure"]),
        ("PlatformSkillOut", "status", ["draft", "published", "unpublished", "blocked"]),
        ("PlatformSkillImportOut", "status", ["draft", "published", "unpublished", "blocked"]),
        ("EmployeeConfigOut", "status", ["draft", "provisioning", "active", "paused", "provisioning_failed", "archived"]),
        ("SolutionInstanceOut", "status", ["draft", "applied", "archived"]),
        ("RecruitmentOrderOut", "status", ["pending", "provisioning", "succeeded", "failed", "cancelled"]),
        ("MemberOut", "status", ["active", "disabled"]),
    ):
        model = schemas.get(schema_name)
        field = model.get("properties", {}).get(field_name) if isinstance(model, dict) else None
        if isinstance(field, dict):
            field["enum"] = values

    transition = schemas.get("EmployeeTransitionIn")
    if isinstance(transition, dict) and isinstance(transition.get("properties", {}).get("reason"), dict):
        transition["properties"]["reason"]["description"] = "archive 转换必填；其他转换可省略。"

    solution_create = schemas.get("RegisterSolutionTemplateRequest")
    if isinstance(solution_create, dict):
        properties = solution_create.setdefault("properties", {})
        if isinstance(properties.get("expert_template_ids"), dict):
            properties["expert_template_ids"]["description"] = "包含的专家模板 ID；至少一个，且至少一个启用专家。"
            properties["expert_template_ids"]["minItems"] = 1
        if isinstance(properties.get("coordinator_template_id"), dict):
            properties["coordinator_template_id"]["description"] = "协调专家模板 ID；必须是已启用专家之一。"
            properties["coordinator_template_id"]["minLength"] = 1

    solution_update = schemas.get("UpdateSolutionTemplateRequest")
    if isinstance(solution_update, dict):
        properties = solution_update.setdefault("properties", {})
        if isinstance(properties.get("expert_template_ids"), dict):
            properties["expert_template_ids"]["description"] = "替换专家模板 ID 列表；提供时至少一个。"
        if isinstance(properties.get("coordinator_template_id"), dict):
            properties["coordinator_template_id"]["description"] = "协调专家模板 ID；提供时必须属于启用专家。"

    usage = schemas.get("UsageSummaryUploadIn")
    if isinstance(usage, dict):
        properties = usage.setdefault("properties", {})
        required = usage.setdefault("required", [])
        if isinstance(required, list) and "tenant_id" not in required:
            required.append("tenant_id")
        if isinstance(properties.get("tenant_id"), dict):
            properties["tenant_id"]["description"] = "企业租户 ID；必须与当前服务身份 claim 一致。"
        if isinstance(properties.get("usage"), dict):
            properties["usage"]["items"] = {"$ref": "#/components/schemas/UsageSummary"}
        if isinstance(properties.get("audits"), dict):
            properties["audits"]["items"] = {"$ref": "#/components/schemas/AuditSummaryEvent"}

    for schema_name in ("MemberCreate", "MemberUpdate", "MemberGrantCreate", "MemberGrantUpdate", "RecruitExpertRequest", "ApplySolutionRequest"):
        audience_schema = schemas.get(schema_name)
        if not isinstance(audience_schema, dict):
            continue
        for field_name in ("department_ids", "member_ids"):
            field = audience_schema.get("properties", {}).get(field_name)
            if isinstance(field, dict):
                items = field.setdefault("items", {})
                if isinstance(items, dict):
                    items.update({"type": "string", "format": "uuid", "minLength": 1})
                    items.setdefault("description", "非空 UUID 列表；有效但不存在/跨租户主体返回 404。")

    authorized = schemas.get("AuthorizedConfigPullResponse")
    if isinstance(authorized, dict):
        properties = authorized.setdefault("properties", {})
        if isinstance(properties.get("experts"), dict) and "EmployeeConfigOut" in schemas:
            properties["experts"]["items"] = {"$ref": "#/components/schemas/EmployeeConfigOut"}
        if isinstance(properties.get("solutions"), dict) and "SolutionInstanceOut" in schemas:
            properties["solutions"]["items"] = {"$ref": "#/components/schemas/SolutionInstanceOut"}


_BODY_NOT_FOUND_OPERATION_IDS = frozenset({
    "manager_login",
    "manager_owner_reset",
    "manager_owner_bootstrap",
    "manager_employee_config_create",
    "manager_recruit_expert",
    "manager_apply_solution",
    "manager_snapshot_generate",
    "manager_provider_runtime_config",
    "manager_speech_runtime_config",
    "manager_hindsight_runtime_config",
    "manager_memory_list",
    "manager_memory_recall",
    "manager_memory_create",
    "manager_memory_retain",
    "manager_grants_authorized_config_pull",
    "operation_tenant_provider_access_resolve",
})


_NO_NOT_FOUND_OPERATION_IDS = frozenset({
    "operation_enterprise_rollup",
    "manager_connector_status",
    "manager_connector_test",
    "manager_connector_grants",
    "manager_oauth_unlink",
})


_PHASE_GATED_OPERATION_IDS = frozenset({
    "manager_provision_tenant",
    "manager_owner_bootstrap",
    "manager_inbox_deliver_from_operation",
})


_NO_CONFLICT_OPERATION_IDS = frozenset({
    "operation_system_login",
    "operation_reset_owner_bootstrap",
    "operation_ingest_rollup",
    "operation_skill_market_settings_update",
    "operation_admin_enterprise_model_access_update",
    "operation_admin_quota_change",
    "manager_owner_bootstrap",
    "manager_catalog_notify",
    "manager_inbox_deliver_from_operation",
    "manager_passkey_login",
    "manager_passkey_registration_options",
    "manager_oauth_authorize",
    "manager_oauth_callback",
    "manager_provider_runtime_config",
    "manager_speech_runtime_config",
    "manager_hindsight_runtime_config",
    "manager_hindsight_lease_revoke",
    "manager_grants_authorized_config_pull",
    "manager_snapshot_generate",
    "manager_usage_upload",
    "manager_memory_create",
    "manager_memory_retain",
    "manager_connector_test",
    "manager_connector_grants",
    "manager_oauth_unlink",
})


_OPERATION_429_OPERATION_IDS = frozenset({
    "operation_skill_market_external_list",
    "operation_skill_market_external_download",
})


_OPERATION_SUMMARY_OVERRIDES = {
    "operation_platform_provider_list": "列出平台 Provider",
    "operation_platform_provider_sync_models": "同步 Provider 模型目录",
    "operation_platform_model_list": "列出 Provider 模型及价格",
    "operation_platform_model_public_price_sync": "同步公开模型价格",
    "operation_platform_model_rate_create": "创建模型价格卡",
    "operation_platform_model_publish": "发布平台模型",
    "operation_platform_models_publish_priced": "批量发布有价格模型",
    "manager_provider_runtime_config": "获取 Provider 运行配置",
    "manager_platform_model_list": "列出平台模型目录",
}


_OPERATION_DESCRIPTION_OVERRIDES = {
    "operation_system_login": "系统管理员使用运营端账号密码登录，返回短期 RS256 access token；密码仅用于本次请求，不会回显。",
    "operation_provision_enterprise": "创建企业在 Operator 的主记录，并通过 Manager 建立 tenant；响应中的 bootstrap 仅一次性返回。",
    "operation_reset_owner_bootstrap": "为指定企业重新签发一次性负责人 bootstrap；旧 bootstrap 立即失效。",
    "operation_platform_provider_list": "列出 Operator 维护的平台 Provider；仅返回非敏感目录和状态，不返回 provider secret。",
    "operation_platform_provider_sync_models": "从指定 Provider 同步模型目录；同步不会把 provider 凭据写入响应。",
    "operation_platform_model_list": "列出指定 Provider 的模型及当前价格卡。",
    "operation_platform_model_public_price_sync": "同步公开价格并保留手工价格优先级；响应返回更新、跳过和未匹配计数。",
    "operation_platform_model_rate_create": "为平台模型创建或更新价格卡；价格单位和生效范围见请求 schema。",
    "operation_platform_model_publish": "发布指定模型，使其进入 Manager 可见的平台目录。",
    "operation_platform_models_publish_priced": "批量发布已具备价格卡的平台模型。",
    "operation_tenant_provider_access_resolve": "为指定企业解析受限的 Provider/模型访问配置；响应含企业作用域 relay_token，仅供受控运行时使用且禁止缓存。",
    "operation_whoami": "返回当前运营端 access token 的身份声明；不读取或返回系统密码。",
    "operation_list_catalog": "按目录类型和发布状态筛选 Operator 专家模板与行业方案目录。",
    "operation_get_catalog_entry": "读取单个专家模板或行业方案模板的完整非敏感目录信息。",
    "operation_update_catalog_entry": "局部更新专家模板或行业方案目录项；发布状态和可见范围使用专用操作。",
    "operation_publish_catalog_entry": "发布专家模板或行业方案，并通知 Manager 刷新目录投影。",
    "operation_unpublish_catalog_entry": "下架目录项并通知 Manager；已存在的企业实例不在此接口删除。",
    "operation_set_catalog_visibility": "更新目录项可见范围并通知 Manager。",
    "operation_ingest_rollup": "接收 Manager 上报的脱敏企业计量/审计聚合；不接收会话内容或逐 token 明细。",
    "operation_cross_enterprise_board": "读取跨企业脱敏聚合看板；结果只包含平台汇总和企业级统计。",
    "operation_rollup_report": "按时间桶、指标和窗口生成跨企业治理汇总报表。",
    "operation_enterprise_rollup": "读取单企业脱敏聚合视图，不下钻租户会话或执行明细。",
    "operation_skill_market_external_list": "浏览可导入的外部纯文本技能市场，并返回安全检查和版本信息；响应为兼容的 {data,next_cursor} 结构，不含 page。",
    "operation_skill_market_external_download": "校验并导入外部技能；仅允许安全清单内的纯文本技能文件。",
    "operation_skill_market_internal_list": "列出 Operator 已导入的平台技能及发布状态。",
    "operation_skill_market_settings_get": "读取外部技能下载后的自动发布策略。",
    "operation_skill_market_settings_update": "更新外部技能下载后的自动发布策略。",
    "operation_skill_market_internal_publish": "发布指定平台技能的当前导入版本，使 Manager 可以拉取。",
    "operation_skill_market_internal_unpublish": "下架指定平台技能，阻止新的 Manager 拉取。",
    "operation_admin_enterprise_list": "分页列出企业运营账号，支持关键词、生命周期、页码和每页条数筛选。",
    "operation_admin_enterprise_detail": "读取企业运营详情，包含生命周期、配额、审计和计量摘要。",
    "operation_admin_enterprise_export": "导出企业列表摘要；导出内容不包含密码、token 或会话内容。",
    "operation_admin_lifecycle_status": "读取企业当前生命周期状态及暂停、封禁、关闭时间。",
    "operation_admin_lifecycle_change": "驱动企业生命周期状态转换；关闭后不可恢复为其他状态。",
    "operation_admin_enterprise_model_access_get": "读取企业允许使用的平台模型 allow-list。",
    "operation_admin_enterprise_model_access_update": "更新企业平台模型 allow-list；null 表示全部已发布模型，空列表表示不开放。",
    "operation_admin_quota_get": "读取企业配额上限与当前使用量。",
    "operation_admin_quota_change": "局部更新企业配额维度；未提供的维度保持不变。",
    "operation_admin_enterprise_action": "执行企业运营动作，如充值、通知、暂停、封禁、解封或关闭；请求体仅支持 action、amount 和 message。",
    "operation_admin_stats": "读取平台企业统计卡片及生命周期分布。",
    "operation_admin_solution_stats": "读取行业方案应用次数和活跃企业统计。",
    "operation_admin_finance_overview": "读取指定财务周期的充值、用量成本和利润概览。",
    "operation_admin_finance_reports": "读取财务充值、消耗和利润明细报表。",
    "operation_admin_audit_events": "分页查询平台运营审计事件，可按企业、严重级别和动作筛选；响应为 data 内含 total/items/next_cursor 的兼容结构。",
    "operation_admin_health": "读取 Operator 依赖服务健康状态。",
    "manager_resolve_tenant_by_account": "根据成员账号解析所属 tenant；账号跨企业返回 tenant_selection_required 409，带 enterprise 后继续。不返回密码或 token。",
    "manager_login": "成员或负责人使用企业代码/名称、账号和密码登录，返回短期 RS256 access token。tenant_id 仅为内部解析结果，非用户必填。企业标识歧义返回 enterprise_ambiguous 409。",
    "manager_owner_reset": "负责人首次登录时使用企业代码/名称或已解析 tenant 重置 bootstrap 密码并获取新的短期 access token。企业标识歧义返回 enterprise_ambiguous 409。",
    "manager_jwks": "返回指定 tenant 当前有效的公开 JWKS；不包含私钥或对称签名密钥。",
    "manager_resolve_tenant": "根据企业代码或名称解析 tenant_id；代码精确匹配优先，slug 歧义返回 enterprise_ambiguous 409。不使用 Host 或第一行 registry。",
    "manager_employee_config_create": "创建 runtime 中立的 employee 配置；不会写入任何 runtime 原生文件。",
    "manager_employee_lifecycle_transition": "执行 employee 生命周期状态转换；archive 转换必须提供 reason，其余转换按状态机约束执行。",
    "manager_grants_authorized_config_pull": "按当前成员权限与 known_versions 生成增量授权投影；员工配置含真实可空 role_title 与全部 department_ids，实际修改推进 version，无需猜测岗位或主部门。只返回授权的专家、方案和能力引用。",
    "manager_knowledge_intake_upload": "上传知识文档并创建 intake 任务；文件随后异步解析和索引，响应不接受 workspace。",
    "manager_knowledge_intake_import_url": "抓取并导入 HTTP(S) 文档，创建异步 intake 任务；URL 内容受大小和重定向限制。",
    "manager_knowledge_analytics": "返回企业固定知识空间的 LightRAG 统计；响应使用单元素 ListEnvelope 以兼容列表型前端。",
    "manager_knowledge_intake_delete": "请求异步删除知识文档索引；使用 Idempotency-Key 可安全重试。",
    "manager_knowledge_intake_reindex": "请求异步重建知识文档索引；失败时可用同一幂等键重试。",
    "manager_provider_runtime_config": "按当前成员和 employee 快照返回最小 Provider 运行配置；响应含敏感 api_key，必须 no-store。",
    "manager_speech_runtime_config": "按当前成员的企业模型 allow-list 返回语音模型运行配置；响应必须 no-store。",
    "manager_hindsight_runtime_config": "按当前 employee 快照签发短期 Hindsight facade lease；响应包含 client_protocol、recall/retain allowlist、policy_revision、explicit_auto_retain 与 retention_mode，lease token 仅本次返回且必须 no-store。缺失或未知协议只读 recall；retain-only 策略要求升级到 aiteam-memory-v1。",
    "manager_hindsight_lease_revoke": "撤销当前成员可见的 Hindsight lease；响应不返回原 lease token。",
    "manager_snapshot_generate": "生成供 Agent 拉取并本地冻结的 employee 执行快照；快照只含授权投影。",
    "manager_usage_upload": "接收 Agent 上报的脱敏 usage/audit 摘要并写入企业级聚合；不接收会话内容。",
    "manager_usage_rollup": "查询企业 usage 聚合；同时提供窗口聚合视图和未指定完整窗口时的明细列表分支。",
    "manager_audit_list": "读取本租户脱敏审计摘要；不返回会话正文或 runtime 原始事件。",
    "manager_memory_analytics": "返回各员工 Hindsight 记忆统计；响应使用单元素 ListEnvelope，记忆正文不在统计接口返回。",
    "manager_settings_get": "读取当前企业设置和功能开关。",
    "manager_settings_patch": "局部更新企业设置；未提供的字段保持不变。",
    "manager_passkey_login": "使用 WebAuthn assertion 完成公开 Passkey 登录并返回短期 access token。",
    "manager_oauth_callback": "处理 OAuth 提供方回调并完成登录；state 仅一次有效。",
}


def _apply_known_documentation_constraints(
    operation_id: str,
    operation: dict[str, Any],
    components: dict[str, Any],
) -> None:
    """Add constraints that are enforced outside Pydantic without changing code paths."""
    for parameter in operation.get("parameters", []):
        if not isinstance(parameter, dict):
            continue
        name = str(parameter.get("name", ""))
        parameter_schema = parameter.get("schema")
        if not isinstance(parameter_schema, dict):
            continue
        if name.casefold() in {"idempotency-key", "idempotency_key"}:
            parameter_schema.update({"minLength": 1, "maxLength": 256, "pattern": r"^[^\r\n]{1,256}$"})
        if operation_id == "operation_rollup_report" and name == "period":
            parameter_schema.update({"enum": ["day", "week", "month"], "default": "day"})
        if operation_id == "operation_rollup_report" and name == "metric":
            parameter_schema.update({
                "enum": ["run_count", "token_total", "cost_total", "error_count", "duration_seconds_total"],
                "default": "token_total",
            })
        if operation_id in {"manager_billing_usage_overview", "manager_billing_usage_records"} and name == "period":
            parameter_schema.update({"enum": ["month", "last_month", "all"], "default": "month"})
        if operation_id == "manager_admin_invite_list" and name == "status":
            parameter_schema.update({"enum": ["pending", "accepted", "revoked", "expired"]})
        if operation_id == "manager_employee_lifecycle_transition" and name == "transition":
            parameter_schema.update({
                "enum": ["provision", "activate", "pause", "resume", "archive", "retry_provision", "mark_provisioning_failed"],
            })
        if operation_id in {"operation_list_catalog", "operation_get_catalog_entry", "operation_update_catalog_entry", "operation_publish_catalog_entry", "operation_unpublish_catalog_entry", "operation_set_catalog_visibility"} and name == "catalog_type":
            parameter_schema.update({"enum": ["expert_template", "solution_template"]})
        if operation_id == "operation_list_catalog" and name == "status":
            parameter_schema.update({"enum": ["draft", "published", "unpublished"]})
        if operation_id == "operation_admin_enterprise_list" and name == "status":
            parameter_schema.update({"enum": ["active", "suspended", "banned", "closed"]})
        if operation_id == "operation_admin_audit_events" and name == "severity":
            parameter_schema.update({"enum": ["info", "warning", "critical"]})

    request_body = operation.get("requestBody")
    if not isinstance(request_body, dict):
        return
    request_content = request_body.get("content")
    if not isinstance(request_content, dict):
        return
    if operation_id in {"manager_memory_create", "manager_memory_retain", "manager_memory_update"}:
        media = request_content.get("application/json")
        if isinstance(media, dict):
            body_schema = _resolve_schema(media.get("schema"), components)
            if operation_id in {"manager_memory_create", "manager_memory_retain"}:
                request_body["x-max-body-bytes"] = 256 * 1024
                body_schema["x-max-body-bytes"] = 256 * 1024
                metadata = body_schema.get("properties", {}).get("metadata")
                if isinstance(metadata, dict):
                    metadata["x-max-json-bytes"] = 64 * 1024
                    metadata["description"] = "附加元数据；JSON UTF-8 序列化后最大 64 KiB。"
                request_body["description"] = "写入 employee 作用域的 Hindsight 记忆；JSON 请求体最大 256 KiB，metadata 序列化后最大 64 KiB。"
            else:
                request_body["x-max-body-bytes"] = 256 * 1024
                body_schema["minProperties"] = 1
                body_schema["x-max-body-bytes"] = 256 * 1024
                body_schema["description"] = "JSON 请求体最大 256 KiB；至少提供非空 text、content 或 valid/invalidated state 之一。"
                for name in ("text", "content"):
                    field = body_schema.get("properties", {}).get(name)
                    if isinstance(field, dict):
                        field["description"] = "非空记忆正文；最大 131072 字符。"
                state = body_schema.get("properties", {}).get("state")
                if isinstance(state, dict):
                    state["description"] = "记忆状态，只能是 valid 或 invalidated。"
    if operation_id == "manager_knowledge_intake_upload":
        media = request_content.get("multipart/form-data")
        if isinstance(media, dict):
            body_schema = _resolve_schema(media.get("schema"), components)
            file_schema = body_schema.get("properties", {}).get("file")
            if isinstance(file_schema, dict):
                file_schema.update({
                    "type": "string",
                    "format": "binary",
                    "contentMediaType": "application/octet-stream",
                    "description": "知识文档文件；非空，最大 4 MiB。",
                })
            media["encoding"] = {
                "file": {"contentType": "text/plain, text/markdown, application/pdf, application/json"}
            }
            request_body["description"] = "multipart/form-data 文件上传；文件非空，最大 4 MiB，随后异步解析和索引。"
    elif operation_id == "manager_knowledge_intake_import_url":
        body_schema = _resolve_schema(
            next(iter(request_content.values()), {}).get("schema"), components
        )
        url_schema = body_schema.get("properties", {}).get("url")
        if isinstance(url_schema, dict):
            url_schema.update({"maxLength": 2048, "format": "uri", "description": "HTTP(S) 文档 URL，最长 2048 字符。"})


_MANAGER_AUTH_OPERATION_IDS = {
    "manager_whoami",
    "manager_passkey_authentication_options",
    "manager_passkey_login",
    "manager_passkeys_list",
    "manager_passkey_registration_options",
    "manager_passkey_register",
    "manager_passkey_delete",
    "manager_oauth_authorize",
    "manager_oauth_callback",
    "manager_oauth_connections",
    "manager_oauth_link",
    "manager_oauth_unlink",
}


def _apply_known_documentation_examples(operation_id: str, operation: dict[str, Any]) -> None:
    """Replace heuristic examples where a cross-field business invariant matters."""
    request_body = operation.get("requestBody")
    if not isinstance(request_body, dict):
        return
    content = request_body.get("content")
    if not isinstance(content, dict):
        return
    media = content.get("application/json")
    if not isinstance(media, dict):
        return
    if operation_id == "manager_hindsight_runtime_config":
        request_body["description"] = (
            "请求当前 employee 的短期 Hindsight facade lease；必须提交受支持的 "
            "client_protocol=aiteam-memory-v1。缺失或未知协议只获得当前 recall 只读范围；"
            "仅在 retain 策略、正 policy_revision 与受支持协议同时满足时授予 retain。"
        )
        media["examples"] = {
            "currentAgent": {
                "summary": "当前受支持 Agent 协议",
                "value": {
                    "employee_id": "00000000-0000-4000-8000-000000000001",
                    "client_protocol": "aiteam-memory-v1",
                    "rotate": False,
                },
            },
        }
    elif operation_id in {"manager_memory_create", "manager_memory_retain"}:
        request_body["description"] = "写入 employee 作用域的 Hindsight 记忆；成功只确认异步 operation，不在响应中回显正文。请求 JSON（含 metadata）最大 256 KiB。"
        media["examples"] = {
            "retain": {
                "summary": "employee 作用域异步记忆写入",
                "value": {
                    "employee_id": "00000000-0000-4000-8000-000000000001",
                    "content": "示例文本内容",
                    "metadata": {"source": "synthetic-fixture"},
                },
            }
        }
    elif operation_id == "manager_memory_update":
        request_body["description"] = "更新 employee 作用域的 Hindsight 记忆；JSON 请求体最大 256 KiB，至少提供非空正文或 valid/invalidated 状态之一。"
        media["examples"] = {
            "updateText": {
                "summary": "更新记忆正文",
                "value": {"text": "更新后的示例文本"},
            },
            "invalidate": {
                "summary": "使记忆失效",
                "value": {"state": "invalidated"},
            },
        }
    elif operation_id in {"manager_employee_knowledge_bind", "manager_employee_knowledge_bind_patch"}:
        request_body["description"] = "配置 employee 的企业知识绑定；config 为有界的非敏感合成配置示例，不接受 workspace 或凭据。"
        value = {"enabled": True, "config": {"source": "synthetic-fixture"}}
        if operation_id == "manager_employee_knowledge_bind":
            value["knowledge_space_id"] = "enterprise_shared"
        media["examples"] = {
            "binding": {
                "summary": "企业知识绑定（合成配置）",
                "value": value,
            }
        }
    elif operation_id in {"manager_recruit_expert", "manager_apply_solution"}:
        request_body["description"] = (
            f"{operation.get('summary', '企业目录操作')}；department_ids/member_ids 如提供必须是当前企业的 UUID 主体。"
        )
        if operation_id == "manager_recruit_expert":
            value = {
                "template_id": "template-1",
                "template_version": "1",
                "employee_slug": "research-assistant",
                "department_ids": ["00000000-0000-4000-8000-000000000001"],
                "member_ids": ["00000000-0000-4000-8000-000000000002"],
            }
        else:
            value = {
                "solution_id": "solution-1",
                "solution_version": "1",
                "department_ids": ["00000000-0000-4000-8000-000000000001"],
                "member_ids": ["00000000-0000-4000-8000-000000000002"],
            }
        media["examples"] = {"audience": {"summary": "当前企业 UUID audience", "value": value}}
    elif operation_id == "manager_login":
        request_body["description"] = (
            "企业成员或负责人登录；用户填写企业代码/名称、账号和密码。"
            "tenant_id 仅为内部解析结果，不必由浏览器提交。"
        )
        media["examples"] = {
            "enterpriseLogin": {
                "summary": "企业代码 + 账号 + 密码",
                "value": {
                    "enterprise": "example-co",
                    "account": "13800000000",
                    "password": "••••••••",
                },
            }
        }
    elif operation_id == "manager_owner_reset":
        request_body["description"] = (
            "负责人使用企业代码/名称或已解析 tenant 重置密码。"
            "请求示例以企业标识为主，不要求用户填写 tenant UUID。"
        )
        media["examples"] = {
            "enterpriseReset": {
                "summary": "企业代码 + 账号 + 新旧密码",
                "value": {
                    "enterprise": "example-co",
                    "account": "13800000000",
                    "old_password": "••••••••",
                    "new_password": "••••••••",
                },
            }
        }
    elif operation_id == "manager_resolve_tenant":
        request_body["description"] = "用企业代码或名称解析 tenant_id；歧义返回 enterprise_ambiguous 409。"
        media["examples"] = {
            "enterprise": {
                "summary": "按企业代码解析",
                "value": {"enterprise": "example-co"},
            }
        }
    elif operation_id == "manager_resolve_tenant_by_account":
        request_body["description"] = (
            "用成员账号解析 tenant_id；跨企业时返回 tenant_selection_required 409，需同时提供 enterprise。"
        )
        media["examples"] = {
            "uniqueAccount": {
                "summary": "账号仅属于一个企业",
                "value": {"account": "13800000000"},
            },
            "disambiguated": {
                "summary": "跨企业账号需带企业标识",
                "value": {"account": "13800000000", "enterprise": "example-co"},
            },
        }
    elif operation_id == "operation_register_solution_template":
        request_body["description"] = "行业方案模板请求；至少一个启用专家，coordinator_template_id 必须属于启用专家。"
        media["examples"] = {
            "solution": {
                "summary": "行业方案模板",
                "value": {
                    "display_name": "市场研究方案",
                    "description": "由研究助手和分析助手协同完成市场研究。",
                    "expert_template_ids": ["research-assistant"],
                    "coordinator_template_id": "research-assistant",
                    "coordinator_instructions": "先研究，再由协调专家汇总结论。",
                    "tags": ["research"],
                },
            }
        }
    elif operation_id == "operation_update_catalog_entry":
        request_body["description"] = "目录项局部更新请求；expert_template 使用专家字段，solution_template 使用方案字段。"
        media["examples"] = {
            "expert": {
                "summary": "更新专家模板",
                "value": {
                    "display_name": "更新后的研究助手",
                    "thinking_level": "medium",
                    "description": "更新后的职位描述。",
                },
            },
            "solution": {
                "summary": "更新行业方案",
                "value": {
                    "description": "更新后的市场研究方案描述。",
                    "expert_template_ids": ["research-assistant"],
                    "coordinator_template_id": "research-assistant",
                },
            },
        }


def _apply_known_response_examples(operation_id: str, operation: dict[str, Any], components: dict[str, Any]) -> None:
    """Show both branches for responses whose wire shape depends on query inputs."""
    response = operation.get("responses", {}).get("200")
    if response is None:
        response = operation.get("responses", {}).get("201")
    media = response.get("content", {}).get("application/json") if isinstance(response, dict) else None
    if operation_id == "healthz_healthz_get" and isinstance(media, dict):
        media["examples"] = {"ok": {"summary": "服务存活", "value": {"status": "ok", "service": "aiteam-service"}}}
    elif operation_id == "readyz_readyz_get" and isinstance(media, dict):
        media["examples"] = {"ready": {"summary": "服务就绪", "value": {"status": "ready", "service": "aiteam-service"}}}
    elif operation_id == "operation_system_login" and isinstance(media, dict):
        media["examples"] = {"loggedIn": {"summary": "系统账号登录成功", "value": {"data": {"token": "eyJ...redacted", "claims": {"tenant_id": None, "enterprise_id": None, "user_id": "sysadmin", "roles": ["system_admin"], "iss": "aiteam-operation", "aud": "aiteam-operation", "iat": 1790000000, "exp": 1790003600}}}}}
    elif operation_id == "manager_login" and isinstance(media, dict):
        media["examples"] = {"loggedIn": {"summary": "企业成员登录成功", "value": {"data": {"token": "eyJ...redacted", "claims": {"tenant_id": "tenant-1", "enterprise_id": "tenant-1", "user_id": "member-1", "roles": ["member"], "iss": "aiteam-manager", "aud": "aiteam-agent", "iat": 1790000000, "exp": 1790003600}}}}}
    if operation_id == "manager_usage_rollup":
        response = operation.get("responses", {}).get("200")
        if isinstance(response, dict):
            media = response.get("content", {}).get("application/json")
            if isinstance(media, dict):
                media["examples"] = {
                    "aggregate": {
                        "summary": "提供完整窗口时返回聚合",
                        "value": {"data": {"rollup_count": 2, "run_count": 12, "token_total": 4800, "cost_total": "0.240000", "unknown_pricing_tokens": 0, "unknown_pricing_runs": 0, "error_count": 1, "duration_seconds_total": 95}},
                    },
                    "details": {
                        "summary": "未提供完整窗口时返回明细列表",
                        "value": {"data": {"items": [{"rollup_id": "rollup-1", "summary_id": "summary-1", "employee_id": "employee-1", "window_start": "2026-09-01T08:00:00Z", "window_end": "2026-09-01T09:00:00Z", "run_count": 6, "token_total": 2400, "cost_total": "0.120000", "pricing_version": 1, "pricing_status": "known", "currency": "USD", "error_count": 0, "duration_seconds_total": 40}]}},
                    },
                }
    elif operation_id == "operation_skill_market_external_list":
        response = operation.get("responses", {}).get("200")
        if isinstance(response, dict):
            media = response.get("content", {}).get("application/json")
            if isinstance(media, dict):
                media["examples"] = {"browse": {"summary": "外部技能分页结果（兼容结构）", "value": {"data": [{"owner": "example-owner", "slug": "research-skill", "display_name": "Research Skill", "summary": "示例技能", "version": "1.0.0", "latest_version": "1.0.0", "updated_at": 1790000000, "downloads": 12, "canonical_url": "https://skills.example.invalid/research-skill", "security_ok": True}], "next_cursor": "next-page-cursor"}}}
    elif operation_id in {"manager_memory_create", "manager_memory_retain"}:
        if isinstance(response, dict):
            media = response.get("content", {}).get("application/json")
            if isinstance(media, dict):
                media["examples"] = {
                    "accepted": {
                        "summary": "异步记忆写入已接受",
                        "value": {
                            "data": {
                                "success": True,
                                "async": True,
                                "operation_id": "00000000-0000-4000-8000-000000000004",
                            }
                        },
                    }
                }
    elif operation_id == "manager_memory_recall":
        if isinstance(response, dict):
            media = response.get("content", {}).get("application/json")
            if isinstance(media, dict):
                media["examples"] = {
                    "empty": {"summary": "无匹配记忆", "value": {"data": {"items": [], "total": 0}}}
                }
    elif operation_id == "manager_memory_update":
        if isinstance(response, dict):
            media = response.get("content", {}).get("application/json")
            if isinstance(media, dict):
                media["examples"] = {
                    "invalidate": {"summary": "记忆已失效", "value": {"data": {"state": "invalidated"}}}
                }
    elif operation_id == "manager_hindsight_runtime_config":
        response = operation.get("responses", {}).get("200")
        if isinstance(response, dict):
            media = response.get("content", {}).get("application/json")
            if isinstance(media, dict):
                media["examples"] = {
                    "currentLease": {
                        "summary": "当前协议 lease（可按策略包含 retain）",
                        "value": {
                            "data": {
                                "base_url": "/api/manager/hindsight",
                                "bank_id": "aiteam-00000000000000000000000000000001",
                                "token": "opaque-lease-example-redacted",
                                "lease_id": "lease-example-1",
                                "version": 1,
                                "issued_at": "2026-09-01T08:00:00Z",
                                "expires_at": "2026-09-01T08:05:00Z",
                                "allowed_operations": ["recall", "retain"],
                                "policy_revision": 1,
                                "client_protocol": "aiteam-memory-v1",
                                "explicit_auto_retain": False,
                                "retention_mode": "unlimited",
                            }
                        },
                    },
                    "legacyReadOnly": {
                        "summary": "缺协议客户端的 recall 只读 lease",
                        "value": {
                            "data": {
                                "base_url": "/api/manager/hindsight",
                                "bank_id": "aiteam-00000000000000000000000000000001",
                                "token": "opaque-lease-example-redacted",
                                "lease_id": "lease-example-readonly",
                                "version": 2,
                                "issued_at": "2026-09-01T08:00:00Z",
                                "expires_at": "2026-09-01T08:05:00Z",
                                "allowed_operations": ["recall"],
                                "policy_revision": 1,
                                "client_protocol": None,
                                "explicit_auto_retain": False,
                                "retention_mode": "unlimited",
                            }
                        },
                    },
                }
    elif operation_id == "operation_admin_audit_events":
        response = operation.get("responses", {}).get("200")
        if isinstance(response, dict):
            media = response.get("content", {}).get("application/json")
            if isinstance(media, dict):
                media["examples"] = {"auditPage": {"summary": "审计分页结果（兼容结构）", "value": {"data": {"total": 1, "items": [{"event_id": "audit-1", "enterprise_id": "enterprise-1", "action": "login", "detail": "登录成功", "actor_id": "member-1", "actor_name": "示例用户", "severity": "info", "result": "success", "ip_address": "203.0.113.10", "user_agent": "ExampleClient/1.0", "created_at": "2026-09-01T08:00:00Z"}], "next_cursor": None}}}}


def enrich_openapi(schema: dict[str, Any], tier: str) -> dict[str, Any]:
    """Apply common documentation policy to an already-generated OpenAPI document."""
    components = schema.setdefault("components", {})
    schemas = components.setdefault("schemas", {})
    schemas.setdefault("Problem", _problem_schema())
    if tier in {"operation", "manager"}:
        _install_control_plane_schema_overrides(schemas)
    for schema_name in ("MemoryItemOut", "MemoryResultOut"):
        memory_schema = schemas.get(schema_name)
        state_schema = memory_schema.get("properties", {}).get("state") if isinstance(memory_schema, dict) else None
        if isinstance(state_schema, dict):
            state_schema["enum"] = ["valid", "invalidated"]
            state_schema["description"] = "Hindsight 记忆状态：valid 或 invalidated。"
    if tier == "manager":
        _install_manager_mcp_documentation(schema, components)
    components.setdefault("securitySchemes", {})
    components["securitySchemes"].setdefault(
        "bearerAuth",
        {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
            "description": "当前端签发的短期 RS256 access token。",
        },
    )
    components["securitySchemes"].setdefault(
        "serviceIdentity",
        {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
            "description": "生产 Operator↔Manager 服务调用使用每请求短期 RS256 service assertion；绑定 audience、scope、origin、target、path/body 与 jti。",
        },
    )
    # Compatibility documentation only: routes never advertise this scheme;
    # the X-Service-Token guard is available solely in explicit dev/test mode.
    components["securitySchemes"].setdefault(
        "serviceToken",
        {
            "type": "apiKey",
            "in": "header",
            "name": "X-Service-Token",
            "description": "仅 dev/test 兼容的 legacy shared token；production 不接受，不是用户登录 token。",
        },
    )
    components.setdefault("headers", {})
    components["headers"].setdefault("RequestId", _request_id_header())
    components["headers"].setdefault("TraceId", _trace_id_header())
    if tier == "manager":
        components["headers"].setdefault("McpSessionId", _mcp_session_header())
    components["headers"].setdefault("CacheControl", _cache_control_header())
    components.setdefault("responses", {})
    components["responses"].update(
        {
            "BadRequest": _problem_response(
                "请求格式无效。", status=400, code="http_error", detail="Request format is invalid."
            ),
            "Unauthorized": _problem_response(
                "认证失败；需要有效凭据。", status=401, code="unauthorized", detail="Authentication is required."
            ),
            "Forbidden": _problem_response(
                "鉴权失败；当前身份无权执行该操作。", status=403, code="forbidden", detail="The caller is not authorized."
            ),
            "AuthForbidden": {
                "description": "Manager 认证相关操作可能因账号停用或密码生命周期要求而返回 403；仅 password_reset_required/password_expired 可进入重置流程。",
                "content": {
                    "application/problem+json": {
                        "schema": {"$ref": "#/components/schemas/Problem"},
                        "examples": {
                            "passwordResetRequired": {"summary": "首次登录需要重置密码", "value": _problem_example(403, "password_reset_required", "Password reset is required before login.")},
                            "passwordExpired": {"summary": "密码已过期", "value": _problem_example(403, "password_expired", "Password reset is required because the password expired.")},
                            "principalInactive": {"summary": "账号已停用", "value": _problem_example(403, "principal_inactive", "The account is not active.")},
                        },
                    }
                },
                "headers": {
                    "X-Request-ID": {"$ref": "#/components/headers/RequestId"},
                    "X-Trace-ID": {"$ref": "#/components/headers/TraceId"},
                },
            },
            "NotFound": _problem_response(
                "请求的资源不存在。", status=404, code="not_found", detail="The requested resource was not found."
            ),
            "Conflict": _problem_response(
                "请求与当前资源状态冲突。", status=409, code="conflict", detail="The request conflicts with current state."
            ),
            "AuthConflict": {
                "description": "Manager 登录前企业解析冲突：企业标识歧义或账号跨企业需要选择。错误体不含密码、token 或会话内容。",
                "content": {
                    "application/problem+json": {
                        "schema": {"$ref": "#/components/schemas/Problem"},
                        "examples": {
                            "enterpriseAmbiguous": {
                                "summary": "企业代码或名称匹配多个 tenant",
                                "value": _problem_example(
                                    409,
                                    "enterprise_ambiguous",
                                    "The enterprise identifier matches more than one tenant.",
                                ),
                            },
                            "tenantSelectionRequired": {
                                "summary": "账号属于多个企业，需要提供 enterprise",
                                "value": _problem_example(
                                    409,
                                    "tenant_selection_required",
                                    "The account belongs to multiple enterprises; specify enterprise.",
                                ),
                            },
                        },
                    }
                },
                "headers": {
                    "X-Request-ID": {"$ref": "#/components/headers/RequestId"},
                    "X-Trace-ID": {"$ref": "#/components/headers/TraceId"},
                },
            },
            "HindsightClientUpgradeRequired": _problem_response(
                "当前记忆策略要求升级受控 Agent 协议。", status=409,
                code="hindsight_client_upgrade_required",
                detail="The controlled Agent must negotiate aiteam-memory-v1 before retain is allowed.",
            ),
            "ValidationError": _problem_response(
                "请求参数校验失败。", status=422, code="validation_error", detail="Request validation failed."
            ),
            "TooLarge": _problem_response(
                "请求体超过接口限制。", status=413, code="request_too_large", detail="The request body exceeds the permitted size."
            ),
            "TooManyRequests": _problem_response(
                "请求过于频繁，请稍后重试。", status=429, code="rate_limited", detail="Too many requests."
            ),
            "ServiceUnavailable": _problem_response(
                "依赖服务暂时不可用。", status=503, code="service_unavailable", detail="A required service is unavailable."
            ),
            "MultitenancyPhasePending": {
                "description": "Manager 多租户控制面写入仍处于相位闸。",
                "content": {
                    "application/problem+json": {
                        "schema": {"$ref": "#/components/schemas/Problem"},
                        "examples": {
                            "phasePending": {
                                "summary": "多租户阶段尚未开放控制面写入",
                                "value": _problem_example(
                                    503,
                                    "multitenancy_phase_pending",
                                    "Control-plane tenant writes are unavailable until the Manager multi-tenancy stages complete.",
                                ),
                            },
                            "databaseUnconfigured": {
                                "summary": "Manager 本端数据库尚未配置",
                                "value": _problem_example(
                                    503,
                                    "manager_admin_db_unconfigured",
                                    "Manager database is not configured.",
                                ),
                            },
                        },
                    }
                },
                "headers": {
                    "X-Request-ID": {"$ref": "#/components/headers/RequestId"},
                    "X-Trace-ID": {"$ref": "#/components/headers/TraceId"},
                },
            },
            "InternalError": _problem_response(
                "服务内部错误；详细信息只写入受控日志。", status=500, code="internal_error", detail="Unexpected server error."
            ),
        }
    )

    for path, path_item in schema.get("paths", {}).items():
        is_api = path.startswith("/api/")
        if not isinstance(path_item, dict) or (not is_api and path not in {"/healthz", "/readyz", "/metrics", "/openapi.json"}):
            continue
        for method, operation in path_item.items():
            if method not in _HTTP_METHODS or not isinstance(operation, dict):
                continue
            operation_id = str(operation.get("operationId") or f"{method}_{path}")
            if operation_id in _OPERATION_SUMMARY_OVERRIDES:
                operation["summary"] = _OPERATION_SUMMARY_OVERRIDES[operation_id]
            summary = str(operation.get("summary") or _humanize(operation_id))
            if not operation.get("summary"):
                operation["summary"] = summary
            description = operation.get("description")
            if operation_id in _OPERATION_DESCRIPTION_OVERRIDES:
                operation["description"] = _OPERATION_DESCRIPTION_OVERRIDES[operation_id]
            elif not description or description in {_PLACEHOLDER_DESCRIPTION, _GENERATED_DESCRIPTION}:
                operation["description"] = (
                    f"{summary}。成功响应遵循本端统一 envelope；失败响应使用 application/problem+json。"
                )

            for parameter in operation.get("parameters", []):
                if not isinstance(parameter, dict):
                    continue
                name = str(parameter.get("name") or "parameter")
                if not parameter.get("description"):
                    parameter["description"] = _description_for(name, location=parameter.get("in"))
                parameter_schema = parameter.get("schema")
                if isinstance(parameter_schema, dict):
                    if not parameter_schema.get("description"):
                        parameter_schema["description"] = parameter["description"]
                    if "example" not in parameter and "examples" not in parameter:
                        parameter["example"] = _example_for_schema(
                            parameter_schema, components, field_name=name
                        )

            request_body = operation.get("requestBody")
            if isinstance(request_body, dict):
                request_body.setdefault("description", f"{summary} 请求体；字段约束见对应 schema。")
                request_content = request_body.get("content")
                if isinstance(request_content, dict):
                    for media_type, media in request_content.items():
                        if not isinstance(media, dict) or "examples" in media or "example" in media:
                            continue
                        media["examples"] = {
                            "request": {
                                "summary": f"{summary} 请求示例（仅含文档占位值）",
                                "value": _example_for_media(
                                    media.get("schema"), media_type, components
                                ),
                            }
                        }
            _apply_known_documentation_constraints(operation_id, operation, components)
            _apply_known_documentation_examples(operation_id, operation)

            kind = _security_kind(path, operation_id)
            is_mcp = operation.get("x-protocol") == "mcp"
            operation["security"] = [] if kind is None else [{"serviceIdentity": []}] if kind == "service" else [{"bearerAuth": []}]
            responses = operation.setdefault("responses", {})
            public_auth_forbidden = operation_id in {
                "manager_login", "manager_owner_reset", "manager_passkey_authentication_options",
                "manager_passkey_login", "manager_oauth_authorize", "manager_oauth_callback",
            }
            if kind == "bearer":
                responses.setdefault("401", {"$ref": "#/components/responses/Unauthorized"})
                responses["403"] = (
                    {"$ref": "#/components/responses/AuthForbidden"}
                    if tier == "manager" and operation_id in _MANAGER_AUTH_OPERATION_IDS
                    else responses.get("403", {"$ref": "#/components/responses/Forbidden"})
                )
            elif public_auth_forbidden:
                responses["403"] = {"$ref": "#/components/responses/AuthForbidden"}
            elif kind == "service":
                responses.setdefault("401", {"$ref": "#/components/responses/Unauthorized"})
                responses.pop("403", None)
            # FastAPI's default HTTPValidationError is an internal shape; the
            # public REST contract always uses Problem (application/problem+json).
            if is_api and not is_mcp:
                responses["422"] = {"$ref": "#/components/responses/ValidationError"}
            if operation_id == "manager_knowledge_intake_import_url":
                # This route deliberately translates URL parser failures to HTTP 400;
                # ordinary FastAPI body validation remains the documented 422 contract.
                responses.setdefault("400", {"$ref": "#/components/responses/BadRequest"})
            if is_api and not is_mcp and operation_id not in _NO_NOT_FOUND_OPERATION_IDS and (path.count("{") or operation_id in _BODY_NOT_FOUND_OPERATION_IDS or operation_id in {"manager_resolve_tenant", "manager_resolve_tenant_by_account"}):
                responses.setdefault("404", {"$ref": "#/components/responses/NotFound"})
            if is_api and not is_mcp and method in {"post", "put", "patch", "delete"} and operation_id not in _NO_CONFLICT_OPERATION_IDS:
                responses.setdefault("409", {"$ref": "#/components/responses/Conflict"})
            if operation_id in {
                "manager_login",
                "manager_owner_reset",
                "manager_resolve_tenant",
                "manager_resolve_tenant_by_account",
            }:
                responses["409"] = {"$ref": "#/components/responses/AuthConflict"}
            if operation_id == "manager_hindsight_runtime_config":
                responses["409"] = {"$ref": "#/components/responses/HindsightClientUpgradeRequired"}
            if operation_id in _OPERATION_429_OPERATION_IDS:
                responses.setdefault("429", {"$ref": "#/components/responses/TooManyRequests"})
            if operation_id == "readyz_readyz_get":
                responses["503"] = {"$ref": "#/components/responses/ServiceUnavailable"}
            elif operation_id in _PHASE_GATED_OPERATION_IDS:
                responses["503"] = {"$ref": "#/components/responses/MultitenancyPhasePending"}
            elif is_api and not is_mcp and (kind in {"bearer", "service"} or path.startswith("/api/auth/") or operation_id in {"operation_system_login", "manager_login", "manager_owner_reset", "manager_passkey_login", "manager_oauth_callback"}):
                responses.setdefault("503", {"$ref": "#/components/responses/ServiceUnavailable"})
            if operation_id in {
                "operation_system_login", "manager_login", "manager_owner_reset",
                "manager_passkey_authentication_options", "manager_passkey_login",
                "manager_oauth_authorize", "manager_oauth_callback",
            }:
                responses.setdefault("401", {"$ref": "#/components/responses/Unauthorized"})
            if operation_id in {"manager_memory_create", "manager_memory_retain", "manager_memory_update"}:
                responses["413"] = {"$ref": "#/components/responses/TooLarge"}
            if is_api and not is_mcp:
                responses.setdefault("500", {"$ref": "#/components/responses/InternalError"})

            # FastAPI adds an empty application/json branch for handlers that
            # return Response. Keep the declared CSV/binary representation only.
            for status, response in list(responses.items()):
                if not isinstance(response, dict) or "$ref" in response:
                    continue
                content = response.get("content")
                if isinstance(content, dict) and "application/json" in content and len(content) >= 2:
                    if not content["application/json"].get("schema") and any(media != "application/json" for media in content):
                        content.pop("application/json", None)
                if status.startswith("2") and response.get("description") in {None, "", "Successful Response"}:
                    response_schema = next(
                        (
                            media.get("schema")
                            for media in (content or {}).values()
                            if isinstance(media, dict) and media.get("schema") is not None
                        ),
                        None,
                    ) if isinstance(content, dict) else None
                    result_kind = "统一 envelope" if _response_uses_envelope(response_schema, components) else "响应 schema"
                    if status == "201":
                        response["description"] = f"{summary} 成功创建资源；返回{result_kind}。"
                    elif status == "202":
                        response["description"] = f"{summary} 已接受；异步结果按响应中的 operation/status 查询。"
                    elif status == "204":
                        response["description"] = "操作成功；响应无消息体。"
                    else:
                        response["description"] = f"{summary} 成功；返回{result_kind}。"
                response.setdefault("headers", {})
                response["headers"].setdefault("X-Request-ID", {"$ref": "#/components/headers/RequestId"})
                response["headers"].setdefault("X-Trace-ID", {"$ref": "#/components/headers/TraceId"})
                if status != "204":
                    if isinstance(content, dict):
                        for media_type, media in content.items():
                            if not isinstance(media, dict) or "examples" in media or "example" in media:
                                continue
                            media["examples"] = {
                                "response": {
                                    "summary": f"{summary} 成功响应示例（仅含文档占位值）",
                                    "value": _example_for_media(
                                        media.get("schema"), media_type, components
                                    ),
                                }
                            }
            _apply_known_response_examples(operation_id, operation, components)

            if operation_id in {
                "manager_provider_runtime_config",
                "manager_speech_runtime_config",
                "manager_hindsight_runtime_config",
                "manager_hindsight_lease_revoke",
                "operation_tenant_provider_access_resolve",
            }:
                for status, response in responses.items():
                    if status.startswith("2") and isinstance(response, dict) and "$ref" not in response:
                        response.setdefault("headers", {})["Cache-Control"] = {"$ref": "#/components/headers/CacheControl"}

    for name, model in list(schemas.items()):
        if isinstance(model, dict) and not model.get("description"):
            model["description"] = f"{_humanize(name)} 数据结构。"
        _enrich_schema_node(model)
    schema.setdefault("info", {})
    schema["info"]["description"] = (
        "AI Team v1 "
        + ("运营端 Operator" if tier == "operation" else "企业端 Manager")
        + " API。成功响应默认遵循统一 envelope；JWKS、CSV、二进制以及明确标注的兼容列表响应使用各自 schema。"
        "示例中的 token、密钥、企业和资源 ID 均为不可用占位值。"
    )
    schema.setdefault("tags", [])
    existing_tags = {item.get("name") for item in schema["tags"] if isinstance(item, dict)}
    tag_descriptions = {
        "operation-enterprise": "企业开通、负责人 bootstrap 与企业级配置。",
        "operation-platform-provider": "Operator 平台 Provider、模型和价格卡。",
        "operation-catalog": "专家模板和行业方案目录管理。",
        "operation-catalog-pull": "Manager 服务间拉取的已发布目录。",
        "operation-rollup": "脱敏计量与跨企业治理汇总。",
        "skill-market": "平台技能市场浏览、导入和发布。",
        "employee-config": "企业 employee/expert 中立配置与生命周期。",
        "employee-prompt": "员工提示词及版本历史。",
        "employee-bindings": "员工与技能、知识、连接器和记忆策略绑定。",
        "member": "企业成员、部门与角色管理。",
        "grant": "成员级资源授权和 Agent 授权投影。",
        "knowledge-space": "企业知识空间元数据和绑定。",
        "knowledge-intake": "知识文档上传、解析、索引和删除生命周期。",
        "capability-catalog": "租户技能、连接器和记忆策略目录。",
        "platform-provider-runtime": "按成员授权返回 Provider 运行配置；敏感响应禁止缓存。",
        "recruit-solution": "从 Operator 目录招募专家和应用行业方案。",
        "usage-audit-quota": "脱敏用量、审计摘要和软配额治理。",
        "control-plane": "Operator 与 Manager 的服务间窄通信。",
        "inbox": "运营通知与企业站内信收件箱。",
        "billing": "企业余额、充值和用量账单。",
        "llm": "企业 LLM Provider/Model 配置。",
        "hindsight": "企业记忆管理和 Hindsight facade lease。",
        "org": "组织树和员工部门分配。",
        "settings": "企业设置和子管理员邀请。",
        "audit": "企业审计事件查询。",
        "mfa": "多因素登录与 OAuth/Passkey 流程。",
        "passkey": "WebAuthn Passkey 注册和登录。",
        "oauth": "第三方 OAuth 连接管理。",
    }
    for tag in schema["tags"]:
        if isinstance(tag, dict) and not tag.get("description"):
            name = str(tag.get("name") or "api")
            tag["description"] = tag_descriptions.get(name, f"{_humanize(name)} 接口。")
    for name, description in {
        "infra": "服务存活、就绪和运行指标。",
        "auth": "登录、身份解析和公钥分发。",
        "operation": "平台运营端业务接口。",
        "manager": "企业管理端业务接口。",
        "agent": "用户本地 Agent 业务接口。",
    }.items():
        if name not in existing_tags:
            schema["tags"].append({"name": name, "description": description})
    return schema


def install_openapi_enrichment(app: FastAPI, tier: str) -> None:
    """Wrap FastAPI's generator after all routers are registered."""
    original: Callable[[], dict[str, Any]] = app.openapi

    def documented_openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = enrich_openapi(original(), tier)
        return app.openapi_schema

    app.openapi = documented_openapi  # type: ignore[method-assign]
