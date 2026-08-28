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


def _problem_response(description: str) -> dict[str, Any]:
    return {
        "description": description,
        "content": {"application/problem+json": {"schema": {"$ref": "#/components/schemas/Problem"}}},
    }


def _security_kind(path: str, operation_id: str) -> str | None:
    """Return bearer/service/public for the known v1 route boundaries."""
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


def enrich_openapi(schema: dict[str, Any], tier: str) -> dict[str, Any]:
    """Apply common documentation policy to an already-generated OpenAPI document."""
    components = schema.setdefault("components", {})
    schemas = components.setdefault("schemas", {})
    schemas.setdefault("Problem", _problem_schema())
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
        "serviceToken",
        {
            "type": "apiKey",
            "in": "header",
            "name": "X-Service-Token",
            "description": "仅用于 Operator↔Manager 服务间窄通信；不是用户登录 token。",
        },
    )
    components.setdefault("responses", {})
    components["responses"].update(
        {
            "Unauthorized": _problem_response("认证失败；需要有效凭据。"),
            "Forbidden": _problem_response("鉴权失败；当前身份无权执行该操作。"),
            "NotFound": _problem_response("请求的资源不存在。"),
            "Conflict": _problem_response("请求与当前资源状态冲突。"),
            "ValidationError": _problem_response("请求参数校验失败。"),
            "TooManyRequests": _problem_response("请求过于频繁，请稍后重试。"),
            "ServiceUnavailable": _problem_response("依赖服务暂时不可用。"),
        }
    )

    for path, path_item in schema.get("paths", {}).items():
        if not isinstance(path_item, dict) or not path.startswith("/api/"):
            continue
        for method, operation in path_item.items():
            if method not in _HTTP_METHODS or not isinstance(operation, dict):
                continue
            operation_id = str(operation.get("operationId") or f"{method}_{path}")
            summary = str(operation.get("summary") or _humanize(operation_id))
            if not operation.get("summary"):
                operation["summary"] = summary
            description = operation.get("description")
            if not description or description in {_PLACEHOLDER_DESCRIPTION, _GENERATED_DESCRIPTION}:
                operation["description"] = (
                    f"{summary}。成功响应遵循本端统一 envelope；失败响应使用 application/problem+json。"
                )

            for parameter in operation.get("parameters", []):
                if not isinstance(parameter, dict):
                    continue
                name = str(parameter.get("name") or "parameter")
                if not parameter.get("description"):
                    parameter["description"] = _description_for(name, location=parameter.get("in"))
                if isinstance(parameter.get("schema"), dict) and not parameter["schema"].get("description"):
                    parameter["schema"]["description"] = parameter["description"]

            kind = _security_kind(path, operation_id)
            operation["security"] = [] if kind is None else [{"serviceToken": []}] if kind == "service" else [{"bearerAuth": []}]
            responses = operation.setdefault("responses", {})
            if kind in {"bearer", "service"}:
                responses.setdefault("401", {"$ref": "#/components/responses/Unauthorized"})
                responses.setdefault("403", {"$ref": "#/components/responses/Forbidden"})
            # FastAPI's default HTTPValidationError is an internal shape; the
            # public contract always uses Problem (application/problem+json).
            responses["422"] = {"$ref": "#/components/responses/ValidationError"}
            if method in {"get", "put", "patch", "delete", "post"} and path.count("{"):
                responses.setdefault("404", {"$ref": "#/components/responses/NotFound"})
            if operation_id in {"manager_resolve_tenant", "manager_resolve_tenant_by_account"}:
                responses.setdefault("404", {"$ref": "#/components/responses/NotFound"})
            if method in {"post", "put", "patch", "delete"}:
                responses.setdefault("409", {"$ref": "#/components/responses/Conflict"})
            if kind in {"bearer", "service"} or path.startswith("/api/auth/") or operation_id in {"operation_system_login", "manager_login", "manager_owner_reset", "manager_passkey_login", "manager_oauth_callback"}:
                responses.setdefault("503", {"$ref": "#/components/responses/ServiceUnavailable"})
            if operation_id in {"operation_system_login", "manager_login", "manager_owner_reset", "manager_passkey_login", "manager_oauth_callback"}:
                responses.setdefault("401", {"$ref": "#/components/responses/Unauthorized"})
            # FastAPI adds an empty application/json branch for handlers that
            # return Response. Keep the declared CSV/binary representation only.
            for response in responses.values():
                content = response.get("content") if isinstance(response, dict) else None
                if not isinstance(content, dict) or "application/json" not in content or len(content) < 2:
                    continue
                if not content["application/json"].get("schema") and any(media != "application/json" for media in content):
                    content.pop("application/json", None)

    for name, model in schemas.items():
        if isinstance(model, dict) and not model.get("description"):
            model["description"] = f"{_humanize(name)} 数据结构。"
        _enrich_schema_node(model)
    schema.setdefault("tags", [])
    existing_tags = {item.get("name") for item in schema["tags"] if isinstance(item, dict)}
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
