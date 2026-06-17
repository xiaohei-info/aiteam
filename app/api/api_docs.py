"""Hand-curated OpenAPI index + browser-readable docs for the AI Team backend.

The backend has no web framework — routing is hand-written string matching.
This module maintains a **whitelist registry** of the ~90 endpoints actually
consumed by the Team Panel frontend (``app/static/aiteam/``). Every entry
includes full request/response schemas, parameters, examples, and error codes.

Served read-only at:
  - ``GET /api/openapi.json`` — the generated OpenAPI document
  - ``GET /api/docs``         — self-contained browser-readable API docs

To add a new endpoint that the frontend calls: append an entry to _API_REGISTRY
and update the corresponding test assertions.
"""
from __future__ import annotations

import html

_VALID_METHODS = ("get", "post", "patch", "delete", "put")


# ── Schema helpers ──────────────────────────────────────────────────────────


def _json_content(schema: dict, example: dict | list | str | None = None) -> dict:
    payload = {"schema": schema}
    if example is not None:
        payload["example"] = example
    return {"application/json": payload}


def _obj(required: list[str], properties: dict, description: str | None = None) -> dict:
    schema: dict = {"type": "object", "required": required, "properties": properties}
    if description:
        schema["description"] = description
    return schema


def _arr(items_schema: dict, description: str | None = None) -> dict:
    schema: dict = {"type": "array", "items": items_schema}
    if description:
        schema["description"] = description
    return schema


def _str_(description: str | None = None, enum: list[str] | None = None) -> dict:
    s: dict = {"type": "string"}
    if description:
        s["description"] = description
    if enum:
        s["enum"] = enum
    return s


def _int_(description: str | None = None) -> dict:
    s: dict = {"type": "integer"}
    if description:
        s["description"] = description
    return s


def _bool_(description: str | None = None) -> dict:
    s: dict = {"type": "boolean"}
    if description:
        s["description"] = description
    return s


def _param(name: str, location: str, required: bool, schema: dict, description: str | None = None) -> dict:
    p: dict = {"name": name, "in": location, "required": required, "schema": schema}
    if description:
        p["description"] = description
    return p


def _id_param() -> dict:
    return _param("id", "path", True, _str_("资源 ID"), "资源唯一标识")


def _ok_response(description: str, schema: dict, example: dict | None = None) -> dict:
    return {"description": description, "content": _json_content(schema, example=example)}


def _err(code: str, description: str, example: dict | None = None) -> dict:
    return {
        "description": description,
        "content": _json_content(_obj(["error"], {"error": _str_(), "message": _str_()}), example=example),
    }


def _idempotency_key_field():
    return {"idempotency_key": _str_("幂等键，用于防重提交")}


# ── API Registry ────────────────────────────────────────────────────────────
# Each entry: {path, method, tag, summary, description, requestBody?, responses, parameters?}

_API_REGISTRY: list[dict] = []


def _r(path, method, tag, summary, description="", requestBody=None, responses=None, parameters=None):
    _API_REGISTRY.append({
        "path": path,
        "method": method,
        "tag": tag,
        "summary": summary,
        "description": description,
        "requestBody": requestBody,
        "responses": responses or {"200": {"description": "OK"}},
        "parameters": parameters or [],
    })


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Auth & User
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/me", "get", "auth",
    "获取当前用户信息",
    "返回当前登录用户的身份、所属企业列表及角色信息。",
    responses={
        "200": _ok_response("当前用户信息", _obj(
            ["user_id"],
            {
                "user_id": _str_("用户 ID"),
                "nickname": _str_("用户昵称"),
                "avatar_url": {"type": ["string", "null"], "description": "头像 URL"},
                "current_enterprise": {"type": ["object", "null"], "description": "当前企业"},
                "enterprises": _arr(_obj([], {"id": _str_(), "name": _str_(), "role": _str_()}), "所属企业列表"),
                "onboarding": {"type": ["object", "null"], "description": "初始化引导信息"},
            },
        ), example={"user_id": "user_001", "nickname": "张三", "avatar_url": None, "current_enterprise": None, "enterprises": [], "onboarding": None}),
    },
)

_r(
    "/api/auth/login", "post", "auth",
    "密码登录",
    "使用邮箱+密码登录。成功返回 ok。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["email", "password"], {"email": _str_("登录邮箱"), "password": _str_("密码")}),
            example={"email": "admin@acme.ai", "password": "••••••••"},
        ),
    },
    responses={
        "200": {"description": "登录成功，设置 auth cookie"},
        "401": _err("INVALID_CREDENTIALS", "邮箱或密码错误", example={"error": "INVALID_CREDENTIALS", "message": "邮箱或密码错误"}),
    },
)

_r(
    "/api/auth/login/phone/send-code", "post", "auth",
    "发送手机验证码",
    "向指定手机号发送短信验证码，有效期 5 分钟。同一手机号有发送频率限制。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["phone"], {"phone": _str_("手机号码")}),
            example={"phone": "13800138000"},
        ),
    },
    responses={
        "200": _ok_response("验证码已发送", _obj(["expires_in"], {"expires_in": _int_("有效期（秒）")}), example={"expires_in": 300}),
        "429": {"description": "发送过于频繁，需等待冷却"},
    },
)

_r(
    "/api/auth/login/phone/verify", "post", "auth",
    "校验手机验证码并登录",
    "提交手机号和收到的验证码完成登录。新用户自动注册。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["phone", "code"], {"phone": _str_("手机号码"), "code": _str_("短信验证码")}),
            example={"phone": "13800138000", "code": "888888"},
        ),
    },
    responses={
        "200": _ok_response("登录成功", _obj(
            ["access_token", "expires_in"],
            {
                "access_token": _str_("访问令牌"),
                "expires_in": _int_("有效期（秒）"),
                "is_new_user": _bool_("是否新注册用户"),
            },
        ), example={"access_token": "eyJ...", "expires_in": 86400, "is_new_user": False}),
        "401": _err("INVALID_CODE", "验证码错误或已过期", example={"error": "INVALID_CODE", "message": "验证码错误或已过期"}),
    },
)

_r(
    "/api/auth/passkey/options", "post", "auth",
    "获取 Passkey 配置",
    description="返回 WebAuthn 配置项，用于浏览器 passkey 注册/登录流程。",
    responses={
        "200": _ok_response("WebAuthn 配置", _obj([], {"publicKey": {"type": "object", "description": "WebAuthn PublicKeyCredentialRequestOptions"}})),
    },
)

_r(
    "/api/auth/passkey/login", "post", "auth",
    "Passkey 登录",
    "提交浏览器生成的 passkey credential 完成登录。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {"credential": {"type": "object", "description": "WebAuthn credential 响应"}}),
        ),
    },
    responses={
        "200": {"description": "登录成功，设置 auth cookie"},
        "401": _err("INVALID_CREDENTIAL", "Passkey 校验失败"),
    },
)

_r(
    "/api/auth/login/wechat/init", "post", "auth",
    "微信登录初始化",
    "获取微信扫码登录的二维码 URL 和 state 令牌。",
    requestBody={
        "required": False,
        "content": _json_content(_obj([], {"device_id": _str_("设备标识（可选）")}), example={}),
    },
    responses={
        "200": _ok_response("二维码已生成", _obj(
            ["state", "qr_url", "expires_in"],
            {"state": _str_("轮询令牌"), "qr_url": _str_("二维码 URL"), "expires_in": _int_("有效期（秒）")},
        ), example={"state": "wx_state_xxx", "qr_url": "https://...", "expires_in": 300}),
    },
)

_r(
    "/api/auth/login/wechat/poll", "get", "auth",
    "微信扫码轮询",
    "轮询检查用户是否已扫码确认。",
    parameters=[_param("state", "query", True, _str_(), "微信登录 state 令牌")],
    responses={
        "200": _ok_response("轮询结果", _obj(
            ["status"],
            {"status": _str_("状态", enum=["pending", "scanned", "confirmed", "expired"]), "code": _str_("授权码（confirmed 时返回）")},
        ), example={"status": "pending"}),
    },
)

_r(
    "/api/auth/login/wechat/callback", "post", "auth",
    "微信登录回调",
    "提交扫码确认后的授权码完成登录。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["state", "code"], {"state": _str_("轮询令牌"), "code": _str_("微信授权码")}),
            example={"state": "wx_state_xxx", "code": "auth_code_xxx"},
        ),
    },
    responses={
        "200": _ok_response("登录成功", _obj(
            ["access_token", "expires_in"],
            {
                "access_token": _str_("访问令牌"),
                "expires_in": _int_("有效期（秒）"),
                "is_new_user": _bool_("是否新用户"),
                "nickname": _str_("微信昵称"),
            },
        ), example={"access_token": "eyJ...", "expires_in": 86400, "is_new_user": True, "nickname": "WeChat昵称"}),
    },
)

_r(
    "/api/health", "get", "auth",
    "健康检查",
    "返回服务健康状态、运行中会话数、活跃流数等信息。支持深度检查。",
    parameters=[_param("deep", "query", False, _str_(), "设为 1/true/yes/on 启用深度检查")],
    responses={
        "200": _ok_response("服务健康", _obj([], {
            "status": _str_("ok | degraded"),
            "sessions": _int_("活跃会话数"),
            "active_streams": _int_("活跃 SSE 流数"),
            "active_runs": _int_("活跃运行数"),
            "uptime_seconds": {"type": "number", "description": "服务运行秒数"},
        }), example={"status": "ok", "sessions": 3, "active_streams": 1, "active_runs": 2, "uptime_seconds": 12345.67}),
    },
)

_r(
    "/api/auth/onboarding/create-enterprise", "post", "auth",
    "创建企业并入驻",
    "完成初始化后创建企业空间，当前用户成为企业 owner。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["name"], {"name": _str_("企业名称"), "slug": _str_("企业标识（URL 友好短名）")}),
            example={"name": "Acme AI Lab", "slug": "acme-ai-lab"},
        ),
    },
    responses={
        "201": _ok_response("创建成功", _obj(
            ["enterprise_id", "name", "slug", "role"],
            {"enterprise_id": _str_(), "name": _str_(), "slug": _str_(), "role": _str_(enum=["owner"])},
        ), example={"enterprise_id": "ent_xxx", "name": "Acme AI Lab", "slug": "acme-ai-lab", "role": "owner"}),
    },
)

_r(
    "/api/auth/onboarding/join-enterprise", "post", "auth",
    "加入企业",
    "通过邀请码加入已有企业。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["invite_code"], {"invite_code": _str_("邀请码")}),
            example={"invite_code": "INV-DEMO"},
        ),
    },
    responses={
        "200": _ok_response("加入成功", _obj(
            ["enterprise_id", "name", "slug", "role"],
            {"enterprise_id": _str_(), "name": _str_(), "slug": _str_(), "role": _str_()},
        ), example={"enterprise_id": "ent_xxx", "name": "Acme AI Lab", "slug": "acme-ai-lab", "role": "member"}),
        "404": _err("INVITE_NOT_FOUND", "邀请码无效"),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 2. Onboarding
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/onboarding/probe", "post", "onboarding",
    "探测 Provider 可用模型",
    "用提供的 base_url 和 api_key 测试 LLM provider 连通性，返回可用模型列表。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["provider", "base_url"], {
                "provider": _str_("provider 类型，如 openai"),
                "base_url": _str_("API base URL"),
                "api_key": _str_("API key（可选）"),
            }),
            example={"provider": "openai", "base_url": "https://api.openai.com/v1", "api_key": "sk-..."},
        ),
    },
    responses={
        "200": _ok_response("探测成功", _obj(["ok"], {
            "ok": _bool_("是否成功"),
            "models": _arr(_obj(["id", "label"], {"id": _str_(), "label": _str_()}), "可用模型列表"),
        }), example={"ok": True, "models": [{"id": "gpt-4o", "label": "GPT-4o"}]}),
        "400": _err("PROBE_FAILED", "探测失败", example={"ok": False, "error": "Connection refused", "detail": "无法连接到 base_url"}),
    },
)

_r(
    "/api/onboarding/status", "get", "onboarding",
    "初始化状态",
    "获取当前系统初始化状态，包括 cfg 配置、provider 信息等。",
    responses={
        "200": _ok_response("初始化状态", _obj([], {
            "status": {"type": "object", "description": "当前初始化状态对象"},
        })),
    },
)

_r(
    "/api/onboarding/setup", "post", "onboarding",
    "应用初始化配置",
    "设置 provider、model、api_key 等初始化参数。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["provider"], {
                "provider": _str_("provider 类型"),
                "model": _str_("默认模型（可选）"),
                "api_key": _str_("API key（可选）"),
                "base_url": _str_("base URL（可选）"),
            }),
            example={"provider": "openai", "model": "gpt-4o", "api_key": "sk-..."},
        ),
    },
    responses={
        "200": _ok_response("配置成功", _obj(["ok"], {"ok": _bool_(), "provider": _str_(), "model": _str_()}), example={"ok": True, "provider": "openai", "model": "gpt-4o"}),
    },
)

_r(
    "/api/onboarding/complete", "post", "onboarding",
    "完成初始化",
    "标记初始化流程为已完成。后续不再显示引导界面。",
    requestBody={"required": False, "content": _json_content(_obj([], {}))},
    responses={"200": _ok_response("已标记完成", _obj(["ok"], {"ok": _bool_()}), example={"ok": True})},
)

_r(
    "/api/onboarding/oauth/start", "post", "onboarding",
    "启动 OAuth 授权流程",
    "发起第三方平台 OAuth 授权（如 openai-codex、anthropic）。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["provider"], {"provider": _str_("OAuth provider 代码")}),
            example={"provider": "anthropic"},
        ),
    },
    responses={
        "200": _ok_response("OAuth flow 已启动", _obj(
            ["flow_id", "status"],
            {"flow_id": _str_("流程 ID"), "user_code": _str_("用户验证码"), "verification_uri": _str_("验证 URL"), "status": _str_()},
        )),
    },
)

_r(
    "/api/onboarding/oauth/poll", "get", "onboarding",
    "轮询 OAuth 流程状态",
    "查询 OAuth 授权流程是否完成。",
    parameters=[_param("flow_id", "query", True, _str_(), "OAuth flow ID")],
    responses={
        "200": _ok_response("轮询结果", _obj(
            ["status"],
            {"status": _str_(enum=["pending", "completed", "failed"]), "token": _str_("完成时返回的 token")},
        ), example={"status": "pending"}),
    },
)

_r(
    "/api/onboarding/oauth/cancel", "post", "onboarding",
    "取消 OAuth 流程",
    "取消进行中的 OAuth 授权流程。",
    requestBody={
        "required": True,
        "content": _json_content(_obj(["flow_id"], {"flow_id": _str_("OAuth flow ID")}), example={"flow_id": "flow_xxx"}),
    },
    responses={"200": _ok_response("已取消", _obj(["ok"], {"ok": _bool_()}), example={"ok": True})},
)

# ═══════════════════════════════════════════════════════════════════════════════
# 3. Workbench & Office
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/workbench", "get", "workbench",
    "获取工作台聚合视图",
    "返回企业前台工作台聚合数据：企业信息、员工列表、会话列表、导航、权限、空态等。",
    responses={
        "200": _ok_response("工作台聚合数据", _obj([], {
            "enterprise": {"type": ["object", "null"], "description": "当前企业信息"},
            "employees": _arr({"type": "object"}, "员工列表"),
            "my_team": {"type": "object", "description": "我的团队"},
            "conversations": _arr({"type": "object"}, "会话列表"),
            "navigation": {"type": "object", "description": "导航结构"},
            "task_status_digest": {"type": "object", "description": "任务状态摘要"},
            "permissions": {"type": "object", "description": "当前用户权限"},
            "empty_state": {"type": ["object", "null"], "description": "空态引导"},
        }), example={
            "enterprise": None, "employees": [],
            "empty_state": {"code": "NO_ENTERPRISE", "title": "还没有企业空间", "message": "当前还没有可用的企业工作台。"},
        }),
    },
)

_r(
    "/api/team/workbench/state", "post", "workbench",
    "更新工作台展示状态",
    "标记会话已读、切换置顶、更新员工星标等展示态操作（不改变业务主状态）。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "employee_id": _str_("员工 ID（星标操作时使用）"),
                "conversation_id": _str_("会话 ID（标记已读时使用）"),
                "is_starred": _bool_("是否星标"),
                "mark_read": _bool_("是否标记已读"),
                "pin": _bool_("是否置顶"),
            }),
            example={"conversation_id": "conv_demo", "mark_read": True},
        ),
    },
    responses={
        "200": _ok_response("状态更新成功", _obj([], {
            "ok": _bool_(), "enterprise_id": _str_(), "user_id": _str_(),
            "employee_id": _str_(), "is_starred": _bool_(), "conversation_id": _str_(), "mark_read": _bool_(), "unread_count": _int_(),
        }), example={"ok": True}),
    },
)

_r(
    "/api/team/office/scene", "get", "workbench",
    "获取办公区场景视图",
    "返回办公区当前场景快照，含场景信息和在线员工列表。",
    responses={
        "200": _ok_response("办公区场景快照", _obj([], {
            "scene": {"type": "object", "description": "场景配置"},
            "employees": _arr({"type": "object"}, "在线员工列表"),
            "refresh_cursor": _int_("刷新游标"),
        }), example={"scene": {"name": "开放办公区"}, "employees": [], "refresh_cursor": 12}),
    },
)

_r(
    "/api/team/office/feed", "get", "workbench",
    "获取办公区动态流",
    "返回办公区实时动态事件流（非 SSE——按需分页拉取）。",
    responses={
        "200": _ok_response("办公区动态流", _obj(["items"], {
            "items": _arr({"type": "object"}, "动态条目"),
            "queue": _arr({"type": "object"}, "待消费队列"),
            "generated_cursor": _int_("生成游标"),
            "refresh_hint_ms": _int_("建议刷新间隔（毫秒）"),
        }), example={"items": [], "queue": [], "generated_cursor": 18, "refresh_hint_ms": 3000}),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 4. Knowledge Bases
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/knowledge-bases", "get", "knowledge-base",
    "获取知识库列表",
    "返回企业下所有知识库，含文档数统计。",
    responses={
        "200": _ok_response("知识库列表", _obj(["knowledge_bases"], {
            "knowledge_bases": _arr(_obj(
                ["knowledge_base_id", "name", "status", "document_count"],
                {
                    "knowledge_base_id": _str_("知识库 ID"),
                    "name": _str_("名称"),
                    "description": _str_("描述"),
                    "status": _str_("状态"),
                    "document_count": _int_("文档数"),
                },
            )),
        }), example={"knowledge_bases": []}),
    },
)

_r(
    "/api/team/knowledge-bases", "post", "knowledge-base",
    "创建知识库",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["name"], {"name": _str_("知识库名称"), "description": _str_("描述")}),
            example={"name": "新知识库", "description": "用于新员工资料"},
        ),
    },
    responses={
        "201": _ok_response("创建成功", _obj(
            ["knowledge_base_id", "name", "description", "status", "document_count"],
            {
                "knowledge_base_id": _str_(), "name": _str_(), "description": _str_(),
                "status": _str_(), "document_count": _int_(),
            },
        ), example={"knowledge_base_id": "kb_xxx", "name": "新知识库", "description": "用于新员工资料", "status": "active", "document_count": 0}),
        "400": _err("MISSING_NAME", "缺少知识库名称", example={"error": "MISSING_NAME", "message": "知识库名称不能为空"}),
    },
)

_r(
    "/api/team/knowledge-bases/{id}/search", "get", "knowledge-base",
    "搜索/问答知识库",
    "基于知识库进行语义检索，返回匹配文档和 AI 生成的回答。",
    parameters=[
        _id_param(),
        _param("q", "query", True, _str_(), "查询内容"),
    ],
    responses={
        "200": _ok_response("检索成功", _obj(
            ["knowledge_base_id", "query", "answer", "citations", "items"],
            {
                "knowledge_base_id": _str_(),
                "query": _str_("原始查询"),
                "answer": _str_("AI 生成回答"),
                "citations": _arr(_obj(["title"], {"title": _str_("引用标题")}), "引用来源"),
                "items": _arr(_obj(["document_id"], {"document_id": _str_()}), "匹配文档"),
            },
        ), example={
            "knowledge_base_id": "kb_xxx", "query": "入职",
            "answer": "已命中《入职手册》相关知识。",
            "citations": [{"title": "入职手册"}],
            "items": [{"document_id": "doc_xxx"}],
        }),
        "400": _err("MISSING_QUERY", "缺少查询内容", example={"error": "MISSING_QUERY", "message": "缺少 q 参数"}),
    },
)

_r(
    "/api/team/knowledge-bases/{id}/documents", "post", "knowledge-base",
    "向知识库挂载文档",
    "将已上传的附件（asset）关联到指定知识库，触发文档摄入。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["asset_id"], {"asset_id": _str_("资产 ID"), "display_name": _str_("文档显示名称"), "title": _str_("文档标题")}),
            example={"asset_id": "ast_001", "display_name": "FAQ"},
        ),
    },
    responses={
        "201": _ok_response("挂载成功", _obj(
            ["document_id", "status"],
            {"document_id": _str_(), "status": _str_(), "ingestion_job_id": _str_("摄入任务 ID")},
        )),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 5. Talent Market & Templates
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/talent-market/templates", "get", "talent-market",
    "获取人才市场模板列表（前台）",
    "返回可供招募的员工模板列表，支持搜索、标签筛选、分页。",
    parameters=[
        _param("q", "query", False, _str_(), "搜索关键词"),
        _param("tag", "query", False, _str_(), "标签筛选"),
        _param("source_marketplace", "query", False, _str_(), "市场来源"),
        _param("page", "query", False, _int_(), "页码"),
        _param("page_size", "query", False, _int_(), "每页条数"),
    ],
    responses={
        "200": _ok_response("模板列表", _obj(
            ["items", "page", "page_size", "total", "has_more"],
            {
                "items": _arr({"type": "object"}, "模板列表"),
                "page": _int_(), "page_size": _int_(), "total": _int_(), "has_more": _bool_(),
                "facets": {"type": "object", "description": "分面聚合"},
            },
        )),
    },
)

_r(
    "/api/team/talent-market/templates/{id}", "get", "talent-market",
    "获取模板详情（前台）",
    description="返回单个员工模板的完整信息，含技能、知识库绑定、连接器要求等。",
    parameters=[_id_param()],
    responses={
        "200": _ok_response("模板详情", _obj(
            ["template_id", "name", "category", "description", "default_skills", "default_memory_config", "price_tier"],
            {
                "template_id": _str_(), "name": _str_(), "category": _str_(), "description": _str_(),
                "default_skills": _arr(_str_(), "默认技能列表"),
                "default_model_ref": {"type": "object", "description": "默认模型配置"},
                "default_memory_config": {"type": "object", "description": "默认记忆配置"},
                "knowledge_bindings": _arr({"type": "object"}, "推荐知识库绑定"),
                "connector_requirements": _arr({"type": "object"}, "推荐连接器"),
                "price_tier": _str_("计费层级"),
                "tags": _arr(_str_(), "标签"),
            },
        )),
    },
)

_r(
    "/api/team/templates", "get", "talent-market",
    "获取管理端模板列表",
    description="返回后台管理用的员工模板列表（含未发布模板）。",
    parameters=[
        _param("q", "query", False, _str_(), "搜索关键词"),
        _param("page", "query", False, _int_(), "页码"),
        _param("page_size", "query", False, _int_(), "每页条数"),
    ],
    responses={
        "200": _ok_response("模板列表", _obj(
            ["items", "page", "page_size", "total", "has_more"],
            {"items": _arr({"type": "object"}), "page": _int_(), "page_size": _int_(), "total": _int_(), "has_more": _bool_()},
        )),
    },
)

_r(
    "/api/team/templates/{id}", "get", "talent-market",
    "获取管理端模板详情",
    parameters=[_id_param()],
    responses={
        "200": _ok_response("模板详情", _obj(
            ["template_id", "name", "category", "description"],
            {
                "template_id": _str_(), "name": _str_(), "category": _str_(), "description": _str_(),
                "default_skills": _arr(_str_()),
                "default_model_ref": {"type": "object"},
                "knowledge_bindings": _arr({"type": "object"}),
                "connector_requirements": _arr({"type": "object"}),
                "tags": _arr(_str_()),
            },
        )),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 6. Recruitment
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/recruitments", "post", "talent-market",
    "从模板招募员工",
    "基于人才市场模板招募新员工实例，自动创建 profile、创建私聊会话。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["template_id"], {
                "template_id": _str_("模板 ID"),
                "display_name": _str_("员工显示名称（可选，默认用模板名）"),
                "idempotency_key": _str_("幂等键"),
                "model_provider": _str_("模型 provider"),
                "model_name": _str_("模型名"),
            }),
            example={"template_id": "tpl_marketing_v1", "display_name": "My Analyst", "idempotency_key": "recruit-001"},
        ),
    },
    responses={
        "201": _ok_response("招募成功", _obj(
            ["order_id", "status", "employee_id", "profile_name"],
            {
                "order_id": _str_("招募订单 ID"), "status": _str_(),
                "employee_id": _str_("新员工 ID"), "profile_name": _str_("Hermes profile 名"),
                "conversation_id": _str_("自动创建的私聊 ID"),
                "navigation": {"type": "object", "description": "前端跳转信息"},
            },
        )),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 7. Conversations & Groups
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/conversations/{id}", "get", "conversation",
    "获取会话详情",
    "返回私聊/群聊会话详情，含消息分页列表。",
    parameters=[
        _id_param(),
        _param("cursor", "query", False, _int_(), "分页游标（numeric），默认 0"),
        _param("limit", "query", False, _int_(), "每页条数，默认 20，最大 100"),
    ],
    responses={
        "200": _ok_response("会话详情", _obj(
            ["conversation_id", "conversation_type", "status", "messages"],
            {
                "conversation_id": _str_(), "conversation_type": _str_("private | group"),
                "employee_ref": {"type": "object"}, "status": _str_(),
                "display_state": _str_(), "created_at": _str_(),
                "latest_run": {"type": "object"}, "message_count": _int_(),
                "last_message_preview": _str_(),
                "messages": _obj(["items", "next_cursor", "has_more"], {
                    "items": _arr({"type": "object"}), "next_cursor": _int_(), "has_more": _bool_(),
                }),
                "employee_summary": {"type": "object"},
            },
        )),
    },
)

_r(
    "/api/team/group-conversations/{id}", "get", "conversation",
    "获取群聊详情",
    "返回群聊完整信息：成员列表、最新 run、timeline、编排决策树等。",
    parameters=[_id_param()],
    responses={
        "200": _ok_response("群聊详情", _obj(
            ["conversation_id", "conversation_type", "title", "status", "member_count", "members", "timeline"],
            {
                "conversation_id": _str_(), "conversation_type": _str_(), "title": _str_(),
                "status": _str_(), "display_state": _str_(), "default_route_hint": _str_(),
                "member_count": _int_(), "members": _arr({"type": "object"}, "成员列表"),
                "latest_run": {"type": "object"}, "timeline": {"type": "object"},
                "latest_route_decision": {"type": "object"}, "task_tree": {"type": "object"},
                "latest_run_summary": {"type": "object"},
            },
        )),
    },
)

_r(
    "/api/team/employees/{id}/conversations", "get", "conversation",
    "获取员工关联会话列表",
    description="返回指定员工参与的所有私聊会话列表。",
    parameters=[_id_param()],
    responses={
        "200": _ok_response("员工关联会话列表", _obj(["items"], {
            "items": _arr({"type": "object"}, "会话列表"),
            "employee_id": _str_(), "total": _int_(),
        }), example={"employee_id": "emp_demo", "items": [], "total": 0}),
    },
)

_r(
    "/api/team/group-conversations", "post", "conversation",
    "创建群聊会话",
    description="创建群聊并指定初始成员。支持自由讨论(free)和规则编排(orchestrated)两种协作模式。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["title", "member_employee_ids"], {
                "title": _str_("群聊标题"),
                "member_employee_ids": _arr(_str_(), "初始成员员工 ID 列表"),
                "created_by": _str_("创建者员工 ID"),
                "collaboration_mode": _str_("协作模式：free（自由讨论，默认）| orchestrated（规则编排）", enum=["free", "orchestrated"]),
                "orchestration_brief": _str_("编排模式下 planner 预设指令；orchestrated 时必填"),
            }),
            example={"title": "预算评审群", "member_employee_ids": ["emp_member", "emp_planner"]},
        ),
    },
    responses={
        "201": _ok_response("创建成功", _obj(
            ["conversation_id", "title", "member_count", "status", "navigation"],
            {
                "conversation_id": _str_(), "title": _str_(), "member_count": _int_(),
                "status": _str_(), "collaboration_mode": _str_(enum=["free", "orchestrated"]),
                "navigation": {"type": "object"},
            },
        ), example={
            "conversation_id": "group_new", "title": "预算评审群",
            "member_count": 2, "status": "active", "collaboration_mode": "free",
            "navigation": {"conversation": "/app/group/group_new"},
        }),
    },
)

_r(
    "/api/team/group-conversations/{id}/members", "post", "conversation",
    "新增群成员",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["employee_id"], {"employee_id": _str_("员工 ID")}),
            example={"employee_id": "emp_planner"},
        ),
    },
    responses={
        "200": _ok_response("新增成功", _obj(["employee_id", "status"], {"employee_id": _str_(), "status": _str_()})),
    },
)

_r(
    "/api/team/group-conversations/{id}/members/{mid}", "delete", "conversation",
    "移除群成员",
    parameters=[
        _param("id", "path", True, _str_(), "群聊 ID"),
        _param("mid", "path", True, _str_(), "成员 ID"),
    ],
    responses={"200": {"description": "移除成功"}},
)

_r(
    "/api/team/group-conversations/{id}", "delete", "conversation",
    "归档群聊",
    description="将群聊归档（软删除），归档后的群聊不再出现在消息列表中。",
    parameters=[_id_param()],
    responses={"200": {"description": "归档成功"}},
)

_r(
    "/api/team/group-conversations/{id}/messages", "post", "conversation",
    "发送群聊消息",
    "向群聊发送消息，触发多 Agent 协作编排或自由讨论。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "message": _obj(["text"], {"text": _str_("消息文本")}),
                "text": _str_("消息文本（简写，等同 message.text）"),
                "route_hint": _str_("路由提示，默认 auto"),
                "idempotency_key": _str_("幂等键"),
                "sender_id": _str_("发送者员工 ID"),
                "goal": _str_("目标描述"),
                "attachments": _arr({"type": "object"}, "附件"),
                "mentions": _arr(_str_(), "@提及的员工 ID"),
            }),
            example={"text": "@planner 请拆分今天的回归任务"},
        ),
    },
    responses={
        "200": _ok_response("消息已接收", _obj(
            ["accepted", "conversation_id", "run_id"],
            {"accepted": _bool_(), "conversation_id": _str_(), "run_id": _str_(), "message_id": _str_()},
        ), example={"accepted": True, "conversation_id": "group_ops", "run_id": "run_xxx", "message_id": "msg_001"}),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 8. Org
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/org/tree", "get", "org",
    "获取组织架构树",
    "返回企业部门树、未分配成员及组织结构统计信息。",
    responses={
        "200": _ok_response("组织架构树", _obj([], {
            "enterprise": {"type": "object", "description": "企业信息"},
            "departments": _arr({"type": "object"}, "部门列表（含嵌套子部门）"),
            "unassigned_members": _arr({"type": "object"}, "未分配部门成员"),
            "stats": {"type": "object", "description": "组织统计"},
        })),
    },
)

_r(
    "/api/team/org/assignments/{id}", "patch", "org",
    "更新组织分配",
    description="调整员工所属部门、职位、可见范围等组织分配信息。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "department_id": _str_("目标部门 ID"),
                "position_title": _str_("职位名称"),
                "visibility_scope": _str_("可见范围", enum=["enterprise", "department", "private"]),
            }),
            example={"department_id": "dept_sales", "position_title": "销售总监"},
        ),
    },
    responses={
        "200": _ok_response("更新成功", _obj([], {"department_id": _str_(), "position_title": _str_(), "visibility_scope": _str_()})),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 9. Runs
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/runs", "post", "run",
    "创建一次运行",
    "发起一次员工私聊执行。成功后通过 SSE timeline 和 events 分页接口获取运行过程。\n\n"
    "如果 `create_new=True`，会强制创建新私聊会话（不复用已有会话）。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["employee_id", "conversation_id", "message"], {
                "employee_id": _str_("员工 ID"),
                "conversation_id": _str_("会话 ID"),
                "message": _obj(["text"], {
                    "text": _str_("消息文本"),
                    "attachments": _arr(_obj(["asset_id", "preview_url"], {
                        "asset_id": _str_(), "preview_url": _str_(),
                    }), "附件列表"),
                }),
                "message_text": _str_("消息文本（替代 message.text）"),
                "idempotency_key": _str_("幂等键"),
                "create_new": _bool_("是否创建新会话，默认 false 复用已有"),
            }),
            example={"employee_id": "emp_test", "conversation_id": "conv_test", "message": {"text": "Hello"}, "idempotency_key": "run-001"},
        ),
    },
    responses={
        "201": _ok_response("运行已创建", _obj(
            ["run_id", "status", "conversation_id", "stream_url", "events_url", "runtime_handle"],
            {
                "run_id": _str_(), "status": _str_(enum=["queued"]), "conversation_id": _str_(),
                "stream_url": _str_("SSE 流地址"), "events_url": _str_("事件分页地址"),
                "runtime_handle": _obj(["kind", "profile_name", "session_id"], {
                    "kind": _str_(), "profile_name": _str_(), "session_id": _str_(),
                }),
            },
        ), example={
            "run_id": "run_xxx", "status": "queued", "conversation_id": "conv_test",
            "stream_url": "/api/team/runs/run_xxx/stream?cursor=0",
            "events_url": "/api/team/runs/run_xxx/events?cursor=0",
            "runtime_handle": {"kind": "session", "profile_name": "emp_test", "session_id": "sess_xxx"},
        }),
        "402": _err("INSUFFICIENT_BALANCE", "余额不足", example={"error": "INSUFFICIENT_BALANCE", "recharge_required": True, "message": "余额不足，请充值"}),
        "404": _err("EMPLOYEE_NOT_FOUND", "员工不存在"),
    },
)

_r(
    "/api/team/runs/{id}/retry", "post", "run",
    "重试运行",
    "对已完成的运行发起重试，使用原始或新的消息文本重新执行。",
    parameters=[_id_param()],
    requestBody={
        "required": False,
        "content": _json_content(
            _obj([], {"idempotency_key": _str_("幂等键"), "message_text": _str_("重试消息文本（可选，默认复用原始消息）")}),
            example={"idempotency_key": "retry-001"},
        ),
    },
    responses={
        "200": _ok_response("重试已创建", _obj(
            ["run_id", "conversation_id"],
            {
                "run_id": _str_(), "retry_of_run_id": _str_("被重试的原始 run ID"),
                "conversation_id": _str_(), "runtime_handle": {"type": "object"},
            },
        )),
    },
)

_r(
    "/api/team/runs/{id}/abort", "post", "run",
    "中断运行",
    "中断正在执行的运行。支持指定中断原因。",
    parameters=[_id_param()],
    requestBody={
        "required": False,
        "content": _json_content(
            _obj([], {"reason": _str_("中断原因，如 user_cancelled")}),
            example={"reason": "user_cancelled"},
        ),
    },
    responses={
        "200": _ok_response("中断结果", _obj(
            ["run_id", "aborted"],
            {"run_id": _str_(), "status": _str_(), "aborted": _bool_(), "event_cursor": _int_()},
        ), example={"run_id": "run_xxx", "status": "aborted", "aborted": True, "event_cursor": 42}),
    },
)

_r(
    "/api/team/runs/{id}/stream", "get", "run",
    "订阅 Run Timeline SSE",
    "返回 text/event-stream。客户端只消费 `event: timeline`，使用 numeric cursor 断线续传。\n\n"
    "两种模式：① Active stream（运行中）— 长连接 SSE，15s 心跳；② Inactive stream（运行结束）— 短拉返回 DB 历史。",
    parameters=[
        _id_param(),
        _param("cursor", "query", False, _int_(), "起始游标（numeric），默认 0"),
    ],
    responses={
        "200": {
            "description": "SSE timeline stream",
            "content": {
                "text/event-stream": {
                    "schema": {"type": "string"},
                    "example": (
                        "event: timeline\n"
                        'data: {"event_id":"evt_xxx","event_cursor":1,'
                        '"run_id":"run_xxx","event_type":"run_started",'
                        '"source_type":"session","source_id":"sess_xxx",'
                        '"event_ts":"2026-06-15T12:00:00Z"}\n\n'
                    ),
                }
            },
        },
        "404": _err("RUN_NOT_FOUND", "运行不存在", example={"error": "RUN_NOT_FOUND", "message": "Run not found"}),
    },
)

_r(
    "/api/team/runs/{id}/events", "get", "run",
    "获取 Run 事件分页列表",
    "按 cursor 分页拉取运行事件（非 SSE）。",
    parameters=[
        _id_param(),
        _param("cursor", "query", False, _int_(), "起始游标，默认 0"),
        _param("limit", "query", False, _int_(), "每页条数，默认 100"),
    ],
    responses={
        "200": _ok_response("事件列表", _obj(
            ["run_id", "events", "next_cursor", "has_more"],
            {
                "run_id": _str_(), "events": _arr({"type": "object"}, "事件列表"),
                "next_cursor": _int_("下一页游标"), "has_more": _bool_("是否还有更多"),
            },
        )),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 10. Uploads
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/uploads", "post", "upload",
    "上传附件",
    "上传文本内容或 base64 编码的二进制文件作为资产。返回 asset_id 供后续挂载知识库使用。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["name"], {
                "name": _str_("文件名"),
                "content_text": _str_("UTF-8 文本内容"),
                "content_base64": _str_("base64 编码内容"),
                "mime_type": _str_("MIME 类型"),
                "size": _int_("文件大小（字节）"),
            }),
            example={"name": "faq.txt", "mime_type": "text/plain", "content_text": "Hello"},
        ),
    },
    responses={
        "201": _ok_response("上传成功", _obj(
            ["asset_id", "name"],
            {
                "asset_id": _str_("资产 ID"), "name": _str_(), "size": _int_(),
                "mime_type": _str_(), "storage_key": _str_(), "preview_url": _str_("预览 URL"),
            },
        ), example={"asset_id": "ast_new", "name": "faq.txt", "preview_url": "/api/team/uploads/ast_new/preview"}),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 11. Employees
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/employees", "get", "employee",
    "获取员工列表",
    description="返回企业下所有员工列表，支持按状态筛选。",
    parameters=[_param("status", "query", False, _str_(), "状态筛选")],
    responses={
        "200": _ok_response("员工列表", _obj(
            ["employees", "total", "page", "limit"],
            {
                "employees": _arr({"type": "object"}, "员工列表"),
                "total": _int_(), "page": _int_(), "limit": _int_(),
                "effective_role": _str_("当前用户的有效角色"),
            },
        )),
    },
)

_r(
    "/api/team/employees", "post", "employee",
    "创建员工",
    "手动创建员工并自动初始化 Hermes profile 和私聊会话。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["display_name"], {
                "display_name": _str_("员工显示名称"),
                "role_name": _str_("角色名"),
                "template_id": _str_("基于模板创建（可选）"),
                "model_provider": _str_("模型 provider"),
                "model_name": _str_("模型名"),
            }),
            example={"display_name": "市场新人", "role_name": "市场专员"},
        ),
    },
    responses={
        "201": _ok_response("创建成功", _obj(
            ["employee_id", "conversation_id", "status"],
            {
                "employee_id": _str_(), "profile_name": _str_(), "conversation_id": _str_(),
                "display_name": _str_(), "role_name": _str_(), "status": _str_(),
                "navigation": {"type": "object"},
            },
        )),
    },
)

_r(
    "/api/team/employees/{id}", "get", "employee",
    "获取员工详情",
    "返回员工完整信息：profile 配置、技能、知识库绑定、连接器绑定、用量摘要、定时任务等。",
    parameters=[_id_param()],
    responses={
        "200": _ok_response("员工详情", _obj(
            ["employee_id", "display_name", "role_name", "status", "presence", "profile_config", "usage_summary", "created_at"],
            {
                "employee_id": _str_(), "display_name": _str_(), "role_name": _str_(),
                "status": _str_(), "presence": _str_(),
                "profile_config": {"type": "object", "description": "Hermes profile 配置"},
                "usage_summary": {"type": "object"}, "run_summary": {"type": "object"},
                "scheduled_jobs": _arr({"type": "object"}, "定时任务列表"),
                "bindings_summary": _arr({"type": "object"}, "知识库/连接器绑定摘要"),
                "created_at": _str_(),
            },
        )),
    },
)

_r(
    "/api/team/employees/{id}", "delete", "employee",
    "删除员工",
    description="删除员工及其关联 profile。",
    parameters=[_id_param()],
    responses={"200": _ok_response("已删除", _obj(["employee_id", "status"], {"employee_id": _str_(), "status": _str_()}), example={"employee_id": "emp_xxx", "status": "deleted"})},
)

_r(
    "/api/team/employees/{id}", "patch", "employee",
    "更新员工",
    "更新员工属性：名称、状态、模型配置、知识库绑定、连接器绑定、技能增减等。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "display_name": _str_("显示名称"),
                "status": _str_("状态"),
                "model_provider": _str_("模型 provider"),
                "model_name": _str_("模型名"),
                "knowledge_base_ids": _arr(_str_(), "知识库 ID 列表（完全替换）"),
                "connector_ids": _arr(_str_(), "连接器 ID 列表（完全替换）"),
                "skills_add": _arr(_str_(), "新增技能列表"),
                "skills_remove": _arr(_str_(), "移除技能列表"),
            }),
            example={"display_name": "新名称", "knowledge_base_ids": ["kb_1", "kb_2"]},
        ),
    },
    responses={"200": _ok_response("更新成功", _obj([], {"employee_id": _str_(), "status": _str_()}), example={"employee_id": "emp_xxx", "status": "active"})},
)

_r(
    "/api/team/employees/export", "get", "employee",
    "导出员工列表",
    description="以 CSV 格式导出员工列表。",
    parameters=[_param("status", "query", False, _str_(), "状态筛选")],
    responses={
        "200": {"description": "CSV 文件下载", "content": {"text/csv": {"schema": {"type": "string"}}}},
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 12. Skills
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/skills/catalog", "get", "skill",
    "获取技能市场目录",
    description="返回技能目录，支持搜索、标签筛选、分页。",
    parameters=[
        _param("q", "query", False, _str_(), "搜索关键词"),
        _param("tag", "query", False, _str_(), "标签筛选"),
        _param("source_marketplace", "query", False, _str_(), "市场来源"),
        _param("installed_only", "query", False, _bool_(), "仅已安装"),
        _param("page", "query", False, _int_(), "页码"),
        _param("page_size", "query", False, _int_(), "每页条数"),
    ],
    responses={
        "200": _ok_response("技能目录", _obj(
            ["items"],
            {"items": _arr({"type": "object"}), "facets": {"type": "object"}, "pagination": {"type": "object"}},
        ), example={"items": [], "page": 1, "page_size": 20, "total": 0}),
    },
)

_r(
    "/api/team/skills/installs", "get", "skill",
    "获取已安装技能列表",
    description="返回企业下已安装的技能列表，含安装状态和绑定员工信息。",
    responses={
        "200": _ok_response("已安装技能列表", _obj(["items"], {"items": _arr({"type": "object"})}), example={"items": []}),
    },
)

_r(
    "/api/team/skills/installs", "post", "skill",
    "安装技能",
    "从技能市场安装技能到企业，可按 scope 分配给全员或指定员工。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["skill_code"], {
                "skill_code": _str_("技能代码"),
                "version": _str_("版本号（可选）"),
                "scope_mode": _str_("分配范围：enterprise | selected"),
                "employee_ids": _arr(_str_(), "指定员工 ID（scope_mode=selected 时必填）"),
                "config": {"type": "object", "description": "技能配置"},
            }),
            example={"skill_code": "skill.crm.sync", "scope_mode": "enterprise"},
        ),
    },
    responses={
        "201": _ok_response("安装成功", _obj(["install_id", "status"], {"install_id": _str_(), "status": _str_()})),
    },
)

_r(
    "/api/team/skills/installs/{id}", "patch", "skill",
    "更新已安装技能",
    description="启用/禁用已安装技能或调整分配范围。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "enabled": _bool_("是否启用"),
                "scope_mode": _str_("分配范围"),
                "employee_ids": _arr(_str_(), "指定员工 ID"),
                "config": {"type": "object"},
            }),
            example={"enabled": False},
        ),
    },
    responses={"200": _ok_response("更新成功", _obj(["install_id", "status"], {"install_id": _str_(), "status": _str_()}))},
)

_r(
    "/api/team/skills/installs/{id}", "delete", "skill",
    "卸载技能",
    description="从企业卸载指定技能。",
    parameters=[_id_param()],
    responses={"200": {"description": "卸载成功"}},
)

# ═══════════════════════════════════════════════════════════════════════════════
# 13. Billing
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/billing/balance", "get", "billing",
    "获取企业余额",
    description="返回企业账户余额、token 余额、低余额预警信息。",
    responses={
        "200": _ok_response("余额信息", _obj(
            ["balance", "balance_cents", "low_balance_warning"],
            {
                "balance": _str_("余额（格式化字符串）"), "balance_cents": _int_("余额（分）"),
                "token_balance": _int_("token 余额"), "low_balance_warning": _bool_("是否低余额"),
                "low_balance_threshold_cents": _int_("低余额阈值（分）"), "warning_enabled": _bool_("预警开关"),
            },
        ), example={"balance": "0.00", "balance_cents": 0, "token_balance": 0, "low_balance_warning": True, "warning_enabled": True}),
    },
)

_r(
    "/api/team/billing/usage/overview", "get", "billing",
    "获取企业用量概览",
    description="返回企业用量概览：总费用、总 token、趋势图、按员工分布。",
    responses={
        "200": _ok_response("企业用量概览", _obj(
            ["summary"],
            {
                "summary": {"type": "object", "description": "用量摘要"},
                "trend": _arr({"type": "object"}, "趋势数据点"),
                "by_employee": _arr({"type": "object"}, "按员工分布"),
            },
        ), example={"summary": {"total_cost": 120.5, "total_tokens": 998877}, "trend": [], "by_employee": []}),
    },
)

_r(
    "/api/team/billing/usage/records", "get", "billing",
    "获取企业用量明细",
    description="分页查询用量明细记录。",
    parameters=[
        _param("page", "query", False, _int_(), "页码"),
        _param("page_size", "query", False, _int_(), "每页条数"),
        _param("employee_id", "query", False, _str_(), "按员工筛选"),
        _param("from", "query", False, _str_(), "起始日期"),
        _param("to", "query", False, _str_(), "截止日期"),
        _param("format", "query", False, _str_(), "设为 csv 触发导出"),
    ],
    responses={
        "200": _ok_response("用量明细分页列表", _obj(
            ["items", "total"],
            {"items": _arr({"type": "object"}), "total": _int_(), "page": _int_(), "page_size": _int_()},
        ), example={"items": [], "total": 0, "page": 1, "page_size": 20}),
    },
)

_r(
    "/api/team/billing/usage/records/export", "get", "billing",
    "导出用量明细",
    description="以 CSV 格式导出企业用量明细。",
    parameters=[
        _param("employee_id", "query", False, _str_(), "按员工筛选"),
        _param("from", "query", False, _str_(), "起始日期"),
        _param("to", "query", False, _str_(), "截止日期"),
    ],
    responses={
        "200": {"description": "CSV 文件下载", "content": {"text/csv": {"schema": {"type": "string"}}}},
    },
)

_r(
    "/api/team/billing/recharges", "get", "billing",
    "获取充值记录",
    description="返回企业充值历史记录。",
    responses={
        "200": _ok_response("充值记录", _obj(
            ["items", "total"],
            {"enterprise_id": _str_(), "items": _arr({"type": "object"}, "充值记录"), "total": _int_(), "balance": {"type": "object"}},
        )),
    },
)

_r(
    "/api/team/billing/recharges", "post", "billing",
    "发起充值",
    "为企业账户充值。当前支持 mock_pay 测试支付。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["amount", "payment_method"], {
                "amount": _int_("充值金额（元）"),
                "amount_cents": _int_("充值金额（分）"),
                "payment_method": _str_("支付方式", enum=["mock_pay", "alipay", "wechat_pay", "bank_transfer"]),
                "idempotency_key": _str_("幂等键"),
            }),
            example={"amount": 100, "payment_method": "mock_pay", "idempotency_key": "recharge-001"},
        ),
    },
    responses={
        "201": _ok_response("充值成功", _obj(
            ["recharge_id", "status", "mock_provider", "token_credited"],
            {
                "recharge_id": _str_(), "order_no": _str_("订单号"), "amount": _int_(),
                "amount_cents": _int_(), "payment_method": _str_(), "status": _str_(),
                "token_credited": _int_("充值 token 数"), "mock_provider": _bool_("是否为测试支付"),
                "idempotency_key": _str_(), "completed_at": _str_(),
            },
        )),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 14. Connectors
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/connectors", "get", "connector",
    "获取连接器列表",
    description="返回企业下所有连接器及可用连接器类型定义。",
    responses={
        "200": _ok_response("连接器列表与定义", _obj(
            ["connectors", "definitions"],
            {"connectors": _arr({"type": "object"}, "连接器列表"), "definitions": _arr({"type": "object"}, "连接器类型定义")},
        ), example={"connectors": [], "definitions": []}),
    },
)

_r(
    "/api/team/connectors", "post", "connector",
    "创建连接器",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["name", "provider_code"], {
                "name": _str_("连接器名称"),
                "provider_code": _str_("provider 代码"),
                "type": _str_("连接器类型"),
                "credential_ref": _str_("凭据引用"),
                "config": {"type": "object", "description": "连接器配置"},
            }),
            example={"name": "Test Slack", "provider_code": "slack", "type": "oauth_connector"},
        ),
    },
    responses={
        "201": _ok_response("创建成功", _obj(["connector_id", "status"], {"connector_id": _str_(), "status": _str_()})),
    },
)

_r(
    "/api/team/connectors/{id}", "get", "connector",
    "获取连接器详情",
    description="返回连接器完整信息、凭据遮罩、员工授权列表。",
    parameters=[_id_param()],
    responses={
        "200": _ok_response("连接器详情", _obj(
            ["connector_id", "credential_ref", "credential_mask", "credential_state", "config", "employee_grants"],
            {
                "connector_id": _str_(), "credential_ref": _str_(), "credential_mask": _str_("凭据脱敏显示"),
                "credential_state": _str_(), "config": {"type": "object"},
                "employee_grants": _arr({"type": "object"}, "员工授权列表"),
            },
        )),
    },
)

_r(
    "/api/team/connectors/{id}", "patch", "connector",
    "更新连接器",
    description="更新连接器名称、配置或凭据。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "name": _str_("连接器名称"),
                "config": {"type": "object"},
                "credential_input": {"type": "object", "description": "凭据更新输入"},
            }),
            example={"name": "Updated Slack", "config": {"tenant_hint": "acme"}},
        ),
    },
    responses={
        "200": _ok_response("更新成功", _obj([], {"status": _str_(), "credential_state": _str_(), "rotation_version": _int_()})),
    },
)

_r(
    "/api/team/connectors/{id}", "delete", "connector",
    "删除连接器",
    parameters=[_id_param()],
    responses={"200": {"description": "删除成功"}},
)

_r(
    "/api/team/connectors/{id}/test", "post", "connector",
    "测试连接器",
    description="对连接器执行连通性测试。",
    parameters=[_id_param()],
    requestBody={
        "required": False,
        "content": _json_content(_obj([], {"dry_run": _bool_("是否仅模拟测试")}), example={"dry_run": True}),
    },
    responses={
        "200": _ok_response("测试结果", _obj(
            ["connector_id", "status"],
            {"connector_id": _str_(), "status": _str_(), "message": _str_()},
        )),
    },
)

_r(
    "/api/team/connectors/{id}/grants", "patch", "connector",
    "更新连接器授权",
    description="批量授予或撤销员工对连接器的使用授权。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["grant", "revoke"], {
                "grant": _arr({"type": "object"}, "新增授权列表"),
                "revoke": _arr({"type": "object"}, "撤销授权列表"),
            }),
            example={"grant": [{"employee_id": "emp_1"}], "revoke": []},
        ),
    },
    responses={
        "200": _ok_response("授权调整结果", _obj(
            ["granted", "revoked", "errors"],
            {"granted": _arr({"type": "object"}), "revoked": _arr({"type": "object"}), "errors": _arr({"type": "object"})},
        )),
    },
)

_r(
    "/api/team/connectors/{id}/status", "get", "connector",
    "获取连接器状态",
    parameters=[_id_param()],
    responses={
        "200": _ok_response("连接器状态", _obj(
            ["connector_id", "status"],
            {"connector_id": _str_(), "status": _str_(), "last_test_result": {"type": "object"}},
        )),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 15. LLM Providers & Models
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/llm-providers", "get", "llm",
    "获取企业 LLM Provider 列表",
    description="返回企业下配置的所有 LLM provider，含每个 provider 下的模型列表。",
    responses={
        "200": _ok_response("Provider 列表", _obj(
            ["providers"],
            {"providers": _arr({"type": "object"}, "Provider 列表（含 models 字段）")},
        ), example={"providers": []}),
    },
)

_r(
    "/api/team/llm-providers", "post", "llm",
    "创建企业 LLM Provider",
    "添加一个新的 LLM provider 配置（如 openai、anthropic 等）。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["provider_key"], {
                "provider_key": _str_("provider 标识"),
                "display_name": _str_("显示名"),
                "api_key": _str_("API key"),
                "base_url": _str_("API base URL"),
                "transport": _str_("传输方式"),
            }),
            example={"provider_key": "openai", "display_name": "OpenAI Prod", "base_url": "https://api.openai.com/v1"},
        ),
    },
    responses={
        "201": _ok_response("创建成功", _obj(["provider_id", "status"], {"provider_id": _str_(), "status": _str_()})),
    },
)

_r(
    "/api/team/llm-providers/{id}", "patch", "llm",
    "更新 LLM Provider",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "display_name": _str_(), "api_key": _str_(), "base_url": _str_(), "transport": _str_(),
            }),
            example={"display_name": "Updated Provider"},
        ),
    },
    responses={"200": _ok_response("更新成功", _obj(["provider_id", "status"], {"provider_id": _str_(), "status": _str_()}))},
)

_r(
    "/api/team/llm-providers/{id}", "delete", "llm",
    "删除 LLM Provider",
    parameters=[_id_param()],
    responses={"200": {"description": "删除成功"}},
)

_r(
    "/api/team/llm-providers/{id}/models", "post", "llm",
    "添加模型到 Provider",
    description="为指定 provider 注册一个可用模型。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["model_id", "model_name"], {
                "model_id": _str_("模型标识"), "model_name": _str_("模型显示名"),
                "config_json": {"type": "object", "description": "模型配置"},
            }),
            example={"model_id": "gpt-4o", "model_name": "GPT-4o"},
        ),
    },
    responses={"201": _ok_response("添加成功", _obj(["model_id", "status"], {"model_id": _str_(), "status": _str_()}))},
)

_r(
    "/api/team/llm-models/{id}", "delete", "llm",
    "删除模型",
    description="从 provider 中移除指定模型。",
    parameters=[_id_param()],
    responses={"200": {"description": "删除成功"}},
)

_r(
    "/api/team/llm-models", "get", "llm",
    "获取全部模型扁平列表",
    description="返回所有 provider 下所有模型的扁平列表，用于员工选择模型的下拉框。",
    responses={
        "200": _ok_response("模型列表", _obj(["models"], {"models": _arr({"type": "object"})}), example={"models": []}),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 16. Collaboration
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/collaboration-template", "get", "collaboration",
    "获取群聊协作编排模板",
    description="返回企业群聊协作编排的默认模板：planner、subtask、aggregate 提示词配置。",
    responses={
        "200": _ok_response("协作模板", _obj([], {
            "defaults": {"type": "object"}, "placeholders": _arr(_str_()), "template": {"type": "object"},
        }), example={"defaults": {}, "placeholders": [], "template": {}}),
    },
)

_r(
    "/api/team/collaboration-template", "post", "collaboration",
    "保存群聊协作编排模板",
    "更新编排提示词模板。POST 语义（非 PUT）。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "name": _str_("模板名称"),
                "planner_prompt": _str_("Planner 提示词"),
                "subtask_prompt": _str_("Subtask 提示词"),
                "aggregate_prompt": _str_("Aggregate 提示词"),
            }),
            example={"name": "默认编排", "planner_prompt": "请先拆解任务，再逐条执行。"},
        ),
    },
    responses={
        "200": _ok_response("保存成功", _obj(["saved"], {"saved": _bool_(), "template": {"type": "object"}}), example={"saved": True, "template": {}}),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 17. Solutions
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/solutions", "get", "solution",
    "获取行业方案列表",
    description="返回企业已安装/可用的行业方案列表。",
    responses={
        "200": _ok_response("行业方案列表", _obj(["solutions"], {"solutions": _arr({"type": "object"}), "total": _int_()}), example={"solutions": [], "total": 0}),
    },
)

_r(
    "/api/team/solutions/{id}/apply", "post", "solution",
    "应用行业方案",
    "一键应用行业方案：按方案模板批量创建员工和知识库。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["mode"], {
                "mode": _str_("应用模式，如 full"),
                "department_id": _str_("目标部门 ID"),
                "idempotency_key": _str_("幂等键"),
            }),
            example={"mode": "full", "department_id": "dept_sales", "idempotency_key": "apply-001"},
        ),
    },
    responses={
        "200": _ok_response("应用结果", _obj(
            ["apply_record_id"],
            {
                "apply_record_id": _str_("应用记录 ID"),
                "created_employee_ids": _arr(_str_(), "新创建的员工 ID"),
                "created_knowledge_base_ids": _arr(_str_(), "新创建的知识库 ID"),
            },
        )),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 18. Memories
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/memories", "get", "memory",
    "获取记忆列表",
    description="分页查询企业员工记忆，支持按员工、类别、标签、审核状态等维度筛选。",
    parameters=[
        _param("employee_id", "query", False, _str_(), "员工 ID"),
        _param("q", "query", False, _str_(), "搜索关键词"),
        _param("category", "query", False, _str_(), "类别筛选"),
        _param("tag", "query", False, _str_(), "标签筛选"),
        _param("source_type", "query", False, _str_(), "来源类型"),
        _param("review_status", "query", False, _str_(), "审核状态"),
        _param("visibility_scope", "query", False, _str_(), "可见范围"),
        _param("page", "query", False, _int_(), "页码"),
        _param("page_size", "query", False, _int_(), "每页条数"),
        _param("sort_by", "query", False, _str_(), "排序字段"),
        _param("sort_order", "query", False, _str_(), "排序方向 asc/desc"),
    ],
    responses={
        "200": _ok_response("记忆分页结果", _obj(
            ["items", "page", "page_size", "total", "has_more", "sort_by", "sort_order"],
            {
                "items": _arr({"type": "object"}, "记忆列表"),
                "page": _int_(), "page_size": _int_(), "total": _int_(),
                "has_more": _bool_(), "sort_by": _str_(), "sort_order": _str_(),
            },
        ), example={"items": [], "page": 1, "page_size": 20, "total": 0, "has_more": False, "sort_by": "importance", "sort_order": "desc"}),
    },
)

_r(
    "/api/team/memories", "post", "memory",
    "创建记忆",
    "为指定员工创建一条记忆条目。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["employee_id", "content"], {
                "employee_id": _str_("员工 ID"),
                "content": _str_("记忆内容"),
                "category": _str_("类别"),
                "importance": _int_("重要性 1-5"),
                "tags": _arr(_str_(), "标签"),
                "visibility_scope": _str_("可见范围"),
            }),
            example={"employee_id": "emp_test", "content": "Customer prefers concise weekly reports", "category": "preference", "importance": 5, "tags": ["vip", "reporting"], "visibility_scope": "admin_only"},
        ),
    },
    responses={
        "201": _ok_response("创建成功", _obj(
            ["memory_id", "employee_id", "content", "importance", "source_type", "visibility_scope", "review", "tags"],
            {
                "memory_id": _str_(), "employee_id": _str_(), "content": _str_(),
                "importance": _int_(), "source_type": _str_(), "visibility_scope": _str_(),
                "runtime_ref": {"type": "object"}, "review": {"type": "object"},
                "tags": _arr(_str_()),
            },
        )),
    },
)

_r(
    "/api/team/memories/{id}", "patch", "memory",
    "更新记忆",
    description="修改记忆内容、重要性、标签或提交审核意见。",
    parameters=[_id_param()],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "content": _str_("记忆内容"),
                "importance": _int_("重要性"),
                "tags": _arr(_str_(), "标签"),
                "review": {"type": "object", "description": "审核信息 {decision, comment, corrected_content}"},
            }),
            example={"content": "Updated note", "importance": 4, "tags": ["updated"], "review": {"decision": "corrected", "comment": "修正了一个事实错误"}},
        ),
    },
    responses={"200": _ok_response("更新成功", _obj([], {"content": _str_(), "importance": _int_(), "tags": _arr(_str_()), "review": {"type": "object"}}))},
)

_r(
    "/api/team/memories/{id}", "delete", "memory",
    "删除记忆",
    parameters=[_id_param()],
    responses={"200": {"description": "删除成功"}},
)

# ═══════════════════════════════════════════════════════════════════════════════
# 19. Settings & Audit
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/team/settings", "get", "settings",
    "获取企业设置",
    description="返回企业设置：名称、邀请码、通知策略、低余额阈值、管理员邀请列表等。",
    responses={
        "200": _ok_response("企业设置", _obj(
            ["enterprise_id", "name", "invite_code", "notification_policy", "admin_invites"],
            {
                "enterprise_id": _str_(), "name": _str_(), "invite_code": _str_("邀请码"),
                "notification_policy": {"type": "object", "description": "通知策略配置"},
                "admin_invites": _arr({"type": "object"}, "管理员邀请列表"),
                "low_balance_threshold_cents": _int_(), "warning_enabled": _bool_(),
                "contact_phone": _str_(), "contact_wechat": _str_(),
                "logo_url": _str_(), "help_doc_url": _str_(), "version_label": _str_(),
            },
        ), example={
            "enterprise_id": "ent_test", "name": "Test Corp", "invite_code": "INV-DEMO",
            "notification_policy": {"employee_task_completed": True}, "admin_invites": [],
        }),
    },
)

_r(
    "/api/team/settings", "patch", "settings",
    "更新企业设置",
    description="部分更新企业设置字段，支持更新通知策略、低余额阈值等。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "name": _str_("企业名称"),
                "contact_phone": _str_("联系电话"),
                "contact_wechat": _str_("联系微信"),
                "logo_url": _str_("Logo URL"),
                "help_doc_url": _str_("帮助文档 URL"),
                "notification_policy": {"type": "object", "description": "通知策略"},
                "low_balance_threshold_cents": _int_("低余额阈值（分）"),
                "warning_enabled": _bool_("预警开关"),
                "version_label": _str_("版本标签"),
            }),
            example={"name": "Updated Corp", "low_balance_threshold_cents": 8800},
        ),
    },
    responses={"200": _ok_response("更新后的企业设置", _obj([], {"name": _str_(), "contact_phone": _str_(), "notification_policy": {"type": "object"}}))},
)

_r(
    "/api/team/audit-events", "get", "settings",
    "获取审计事件",
    description="分页查询企业审计事件日志。",
    parameters=[
        _param("limit", "query", False, _int_(), "每页条数，默认 100"),
        _param("target_type", "query", False, _str_(), "审计目标类型"),
        _param("target_id", "query", False, _str_(), "审计目标 ID"),
    ],
    responses={
        "200": _ok_response("审计事件列表", _obj(
            ["items", "total"],
            {"enterprise_id": _str_(), "items": _arr({"type": "object"}, "审计事件"), "total": _int_(), "effective_role": _str_()},
        )),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 20. Enterprise Admin
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/enterprise-admin/invites", "post", "enterprise-admin",
    "创建管理员邀请",
    description="创建一个管理员邀请，生成邀请码供被邀请人加入企业。需 `manage_employees` 权限。",
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["phone", "role", "permissions"], {
                "phone": _str_("被邀请人手机号"),
                "role": _str_("角色", enum=["enterprise_admin", "finance_admin", "member"]),
                "permissions": {"type": "object", "description": "权限配置"},
                "idempotency_key": _str_("幂等键"),
                "message": _str_("邀请消息"),
            }),
            example={"phone": "13900003333", "role": "enterprise_admin", "permissions": {"employees": True, "audit": True}, "idempotency_key": "invite-001"},
        ),
    },
    responses={
        "201": _ok_response("邀请创建成功", _obj(
            ["invite_id", "status", "phone"],
            {
                "invite_id": _str_(), "status": _str_(), "phone": _str_(),
                "role": _str_(), "permissions": {"type": "object"}, "invite_code": _str_(),
                "idempotency_key": _str_(), "invited_by": _str_(), "message": _str_(), "created_at": _str_(),
            },
        )),
    },
)

_r(
    "/api/enterprise-admin/invites/{id}", "delete", "enterprise-admin",
    "撤销管理员邀请",
    description="撤销一个待接受的管理员邀请。需 `manage_employees` 权限。",
    parameters=[_id_param()],
    responses={
        "200": _ok_response("已撤销", _obj(["invite_id", "status"], {"invite_id": _str_(), "status": _str_()}), example={"invite_id": "inv_xxx", "status": "revoked"}),
    },
)

# ═══════════════════════════════════════════════════════════════════════════════
# 21. System Admin
# ═══════════════════════════════════════════════════════════════════════════════

_r(
    "/api/system-admin/health", "get", "system-admin",
    "系统健康概览",
    description="返回平台级系统健康状态。需 `system_read` 权限。",
    parameters=[_param("role", "query", True, _str_(), "角色参数，需为 system_admin 或 system_operator")],
    responses={"200": {"description": "系统健康数据"}},
)

_r(
    "/api/system-admin/enterprises", "get", "system-admin",
    "获取企业账号列表",
    description="分页查询并管理平台所有企业账号。需 `system_read` 权限。",
    parameters=[
        _param("role", "query", True, _str_(), "角色参数"),
        _param("page", "query", False, _int_(), "页码，默认 1"),
        _param("limit", "query", False, _int_(), "每页条数，默认 20"),
        _param("name", "query", False, _str_(), "按名称搜索"),
        _param("status", "query", False, _str_(), "按状态筛选"),
        _param("created_from", "query", False, _str_(), "创建时间起（YYYY-MM-DD）"),
        _param("created_to", "query", False, _str_(), "创建时间止（YYYY-MM-DD）"),
    ],
    responses={
        "200": _ok_response("企业账号分页列表", _obj(
            ["items"],
            {"items": _arr({"type": "object"}), "total": _int_(), "page": _int_(), "limit": _int_(), "has_more": _bool_()},
        ), example={"items": [], "total": 0, "page": 1, "limit": 20, "has_more": False}),
    },
)

_r(
    "/api/system-admin/enterprises/{id}", "get", "system-admin",
    "获取企业详情",
    description="返回单个企业的完整信息。需 `system_read` 权限。",
    parameters=[_id_param(), _param("role", "query", True, _str_(), "角色参数")],
    responses={
        "200": _ok_response("企业详情", _obj(
            ["id", "name", "slug"],
            {
                "id": _str_(), "name": _str_(), "slug": _str_(),
                "status": _str_(), "owner_user_id": _str_(), "default_workspace_id": _str_(),
                "archive_reason": _str_(), "created_at": _str_(), "updated_at": _str_(),
            },
        )),
    },
)

_r(
    "/api/system-admin/enterprises/{id}/quota", "get", "system-admin",
    "获取企业配额",
    description="返回企业的员工配额、存储配额和 API 速率限制。",
    parameters=[_id_param(), _param("role", "query", True, _str_(), "角色参数")],
    responses={
        "200": _ok_response("企业配额详情", _obj([], {
            "enterprise_id": _str_(),
            "quota": {"type": "object", "description": "配额详情 {employee_quota, storage_quota_mb, api_rate_limit}"},
        }), example={"enterprise_id": "ent_001", "quota": {"employee_quota": 50, "storage_quota_mb": 1024, "api_rate_limit": 100}}),
    },
)

_r(
    "/api/system-admin/enterprises/export", "get", "system-admin",
    "导出企业账号列表",
    description="以 CSV 格式导出企业数据。",
    parameters=[
        _param("role", "query", True, _str_(), "角色参数"),
        _param("name", "query", False, _str_(), "按名称筛选"),
        _param("status", "query", False, _str_(), "按状态筛选"),
        _param("created_from", "query", False, _str_(), "创建时间起"),
        _param("created_to", "query", False, _str_(), "创建时间止"),
    ],
    responses={"200": {"description": "CSV 导出", "content": {"text/csv": {"schema": {"type": "string"}}}}},
)

_r(
    "/api/system-admin/enterprises", "post", "system-admin",
    "创建企业",
    description="平台管理员手动创建企业账号。需 `system_write` 权限。",
    parameters=[_param("role", "query", True, _str_(), "角色参数")],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["name", "owner_user_id"], {
                "name": _str_("企业名称"),
                "slug": _str_("企业标识"),
                "owner_user_id": _str_("负责人用户 ID"),
            }),
            example={"name": "新企业", "slug": "new-enterprise", "owner_user_id": "user_001"},
        ),
    },
    responses={
        "201": _ok_response("创建成功", _obj(["id", "enterprise_id", "slug", "name", "status", "owner_user_id"], {
            "id": _str_(), "enterprise_id": _str_(), "slug": _str_(), "name": _str_(), "status": _str_(), "owner_user_id": _str_(),
        })),
    },
)

_r(
    "/api/system-admin/enterprises/{id}/actions", "post", "system-admin",
    "执行企业治理动作",
    description="对企业执行管理动作：封禁、解封、充值、通知。需 `system_write` 权限。",
    parameters=[_id_param(), _param("role", "query", True, _str_(), "角色参数")],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["action"], {
                "action": _str_("治理动作", enum=["suspend", "ban", "reactivate", "unban", "recharge", "notify"]),
                "reason": _str_("操作原因"),
                "amount": _int_("充值金额（元）"),
                "amount_cents": _int_("充值金额（分）"),
                "message": _str_("通知消息内容"),
            }),
            example={"action": "ban", "reason": "policy violation"},
        ),
    },
    responses={
        "200": _ok_response("动作执行成功", _obj(
            ["enterprise_id", "action", "status", "message", "audit_event_id"],
            {"enterprise_id": _str_(), "action": _str_(), "status": _str_(), "message": _str_(), "audit_event_id": _str_()},
        )),
    },
)

_r(
    "/api/system-admin/finance/overview", "get", "system-admin",
    "平台财务总览",
    description="返回跨企业财务汇总概览。需 `system_read` 权限。",
    parameters=[
        _param("role", "query", True, _str_(), "角色参数"),
        _param("period_start", "query", False, _str_(), "统计起始日期（YYYY-MM-DD）"),
        _param("period_end", "query", False, _str_(), "统计截止日期（YYYY-MM-DD）"),
    ],
    responses={
        "200": _ok_response("平台财务总览", _obj(
            ["summary", "trend"],
            {"summary": {"type": "object"}, "trend": _arr({"type": "object"}), "top_enterprises": _arr({"type": "object"})},
        )),
    },
)

_r(
    "/api/system-admin/finance/reports", "get", "system-admin",
    "平台财务报表",
    description="返回平台级财务报表数据。需 `system_read` 权限。",
    parameters=[
        _param("role", "query", True, _str_(), "角色参数"),
        _param("period_start", "query", False, _str_(), "统计起始日期"),
        _param("period_end", "query", False, _str_(), "统计截止日期"),
    ],
    responses={"200": {"description": "财务报表数据"}},
)

_r(
    "/api/system-admin/templates", "get", "system-admin",
    "获取系统模板列表",
    description="返回平台级员工模板。需 `system_read` 权限。",
    parameters=[_param("role", "query", True, _str_(), "角色参数")],
    responses={
        "200": _ok_response("系统模板列表", _obj(["items"], {"items": _arr({"type": "object"})}), example={"items": []}),
    },
)

_r(
    "/api/system-admin/templates", "post", "system-admin",
    "创建系统模板",
    description="创建平台级员工模板。需 `system_write` 权限。",
    parameters=[_param("role", "query", True, _str_(), "角色参数")],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["name", "role_name"], {
                "name": _str_("模板名称"),
                "role_name": _str_("角色标识"),
                "category_code": _str_("类别代码"),
                "default_model_ref": _str_("默认模型"),
                "description": _str_("描述"),
            }),
            example={"name": "运营专员", "role_name": "ops_agent", "category_code": "ops"},
        ),
    },
    responses={"201": _ok_response("创建成功", _obj(["template_id", "status"], {"template_id": _str_(), "status": _str_()}))},
)

_r(
    "/api/system-admin/templates/{id}", "patch", "system-admin",
    "更新系统模板",
    description="更新模板信息或发布/下架。需 `system_write` 权限。",
    parameters=[_id_param(), _param("role", "query", True, _str_(), "角色参数")],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "name": _str_(), "role_name": _str_(), "description": _str_(), "category_code": _str_(),
                "publish_action": _str_("发布动作：publish | unpublish"),
            }),
            example={"name": "更新后的模板", "publish_action": "publish"},
        ),
    },
    responses={"200": _ok_response("更新成功", _obj(["template_id", "status"], {"template_id": _str_(), "status": _str_()}))},
)

_r(
    "/api/system-admin/solutions", "get", "system-admin",
    "获取系统方案列表",
    description="返回平台级行业方案列表。需 `system_read` 权限。",
    parameters=[_param("role", "query", True, _str_(), "角色参数")],
    responses={
        "200": _ok_response("系统方案列表", _obj(["items"], {"items": _arr({"type": "object"})}), example={"items": []}),
    },
)

_r(
    "/api/system-admin/solutions", "post", "system-admin",
    "创建系统方案",
    description="创建平台级行业方案。需 `system_write` 权限。",
    parameters=[_param("role", "query", True, _str_(), "角色参数")],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj(["name", "template_ids"], {
                "name": _str_("方案名称"),
                "template_ids": _arr(_str_(), "关联模板 ID 列表"),
                "description": _str_("方案描述"),
            }),
            example={"name": "零售增长方案", "template_ids": ["tpl_ops", "tpl_sales"]},
        ),
    },
    responses={"201": _ok_response("创建成功", _obj(["solution_id", "status"], {"solution_id": _str_(), "status": _str_()}))},
)

_r(
    "/api/system-admin/solutions/{id}", "patch", "system-admin",
    "更新系统方案",
    description="更新方案信息或发布/下架。需 `system_write` 权限。",
    parameters=[_id_param(), _param("role", "query", True, _str_(), "角色参数")],
    requestBody={
        "required": True,
        "content": _json_content(
            _obj([], {
                "name": _str_(), "description": _str_(), "template_ids": _arr(_str_()),
                "publish_action": _str_("发布动作：publish | unpublish"),
            }),
            example={"name": "更新后的方案", "publish_action": "publish"},
        ),
    },
    responses={"200": _ok_response("更新成功", _obj(["solution_id", "status"], {"solution_id": _str_(), "status": _str_()}))},
)


# ═══════════════════════════════════════════════════════════════════════════════
# Spec builder — operates on _API_REGISTRY, no source scanning
# ═══════════════════════════════════════════════════════════════════════════════


def _version() -> str:
    try:
        from api.updates import WEBUI_VERSION
        return str(WEBUI_VERSION)
    except Exception:
        return "dev"


def build_openapi_spec() -> dict:
    """Build a complete OpenAPI 3.0 document from the hand-curated API registry."""
    paths: dict[str, dict] = {}
    tags_seen: set[str] = set()

    for entry in _API_REGISTRY:
        path = entry["path"]
        method = entry["method"]
        tag = entry["tag"]
        tags_seen.add(tag)

        op = {
            "tags": [tag],
            "summary": entry["summary"],
            "description": entry.get("description") or "",
            "responses": entry.get("responses") or {"200": {"description": "OK"}},
        }

        if entry.get("requestBody"):
            op["requestBody"] = entry["requestBody"]

        params = list(entry.get("parameters") or [])
        # Auto-add {id} path parameter if not explicitly defined
        if "{id}" in path and not any(p.get("name") == "id" and p.get("in") == "path" for p in params):
            params.insert(0, _id_param())
        if params:
            op["parameters"] = params

        ops = paths.setdefault(path, {})
        ops[method] = op

    # Sort paths alphabetically
    sorted_paths = dict(sorted(paths.items()))

    return {
        "openapi": "3.0.3",
        "info": {
            "title": "AI Team Backend API",
            "version": _version(),
            "description": (
                "AI Team 前端实际调用的后端 API 接口文档。"
                "只收录 Team Panel 前端（`app/static/aiteam/`）正在使用的接口，"
                "每个接口均包含完整出入参、查询参数和示例。"
            ),
        },
        "tags": [{"name": t, "description": _TAG_DESCRIPTIONS.get(t, "")} for t in sorted(tags_seen)],
        "paths": sorted_paths,
    }


_TAG_DESCRIPTIONS = {
    "auth": "认证与用户 — 登录、注册、企业入驻",
    "onboarding": "初始化引导 — Provider 探测、配置初始化",
    "workbench": "工作台与办公区 — 聚合视图、状态管理、动态流",
    "knowledge-base": "知识库 — CRUD、文档挂载、语义检索",
    "talent-market": "人才市场与模板 — 模板浏览、员工招募",
    "conversation": "会话与群聊 — 私聊详情、群聊管理、消息发送",
    "org": "组织架构 — 部门树、人员分配",
    "run": "运行 — 创建、重试、中断、SSE 流、事件分页",
    "upload": "上传 — 附件/文件资产管理",
    "employee": "员工 — CRUD、详情、导出",
    "skill": "技能 — 市场目录、安装、配置",
    "billing": "计费 — 余额、用量、充值",
    "connector": "连接器 — 外部服务接入、凭据管理、授权",
    "llm": "LLM Provider 与模型 — Provider 配置、模型管理",
    "collaboration": "协作编排 — 群聊编排模板管理",
    "solution": "行业方案 — 浏览、一键应用",
    "memory": "记忆 — 员工记忆 CRUD",
    "settings": "设置与审计 — 企业设置、审计日志",
    "enterprise-admin": "企业后台 — 管理员邀请",
    "system-admin": "系统后台 — 企业治理、平台财务、模板与方案管理",
}


# ── HTML rendering (unchanged from original) ──────────────────────────────────


def _operation_detail_html(method: str, path: str, operation: dict) -> str:
    summary = html.escape(str(operation.get("summary") or f"{method.upper()} {path}"))
    description = html.escape(str(operation.get("description") or ""))
    tags = ", ".join(operation.get("tags") or [])
    tag = html.escape(tags or "other")
    op_id = html.escape(f"{method}-{path}".replace("/", "-").replace("{", "").replace("}", ""))

    parts = [
        f'<section class="operation" id="{op_id}">',
        '<div class="operation-heading">',
        f'<span class="method method-{html.escape(method)}">{html.escape(method.upper())}</span>',
        f'<code>{html.escape(path)}</code>',
        f'<span class="tag">{tag}</span>',
        '</div>',
        f"<h3>{summary}</h3>",
    ]
    if description:
        parts.append(f"<p>{description}</p>")

    for title, key in (("Path / Query 参数", "parameters"), ("请求体", "requestBody"), ("响应", "responses")):
        value = operation.get(key)
        if not value:
            continue
        rendered = html.escape(_pretty(value))
        parts.extend([f"<h4>{title}</h4>", f"<pre>{rendered}</pre>"])

    parts.append("</section>")
    return "\n".join(parts)


def _pretty(value: object) -> str:
    import json
    return json.dumps(value, ensure_ascii=False, indent=2)


def _docs_body_html(spec: dict) -> str:
    operation_count = sum(len(methods) for methods in spec["paths"].values())
    nav = []
    sections = []
    for path, methods in spec["paths"].items():
        for method, operation in methods.items():
            op_id = html.escape(f"{method}-{path}".replace("/", "-").replace("{", "").replace("}", ""))
            nav.append(
                '<a class="nav-item" href="#{op_id}">'
                '<span class="method method-{method}">{method_label}</span>'
                '<code>{path}</code>'
                '</a>'.format(
                    op_id=op_id,
                    method=html.escape(method),
                    method_label=html.escape(method.upper()),
                    path=html.escape(path),
                )
            )
            sections.append(_operation_detail_html(method, path, operation))

    title = html.escape(spec["info"]["title"])
    version = html.escape(str(spec["info"]["version"]))
    description = html.escape(spec["info"].get("description", ""))
    return f"""
  <header>
    <p class="eyebrow">AI Team Backend API</p>
    <h1>{title}</h1>
    <p class="description">{description}</p>
    <div class="meta">
      <span>Version: <strong>{version}</strong></span>
      <span>Paths: <strong>{len(spec["paths"])}</strong></span>
      <span>Operations: <strong>{operation_count}</strong></span>
      <a href="/api/openapi.json">OpenAPI JSON</a>
    </div>
  </header>
  <main>
    <aside>
      <div class="aside-title">接口目录</div>
      {''.join(nav)}
    </aside>
    <div class="content">
      {''.join(sections)}
    </div>
  </main>
"""


_DOCS_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>AI Team API Docs</title>
  <style>
    :root {
      --bg: #f6f3ec;
      --panel: #fffdf8;
      --ink: #1f2933;
      --muted: #64748b;
      --line: #d8d1c2;
      --accent: #0f766e;
      --get: #2563eb;
      --post: #0f766e;
      --patch: #b45309;
      --put: #7c3aed;
      --delete: #dc2626;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(135deg, rgba(15, 118, 110, 0.10), transparent 28rem),
        linear-gradient(315deg, rgba(180, 83, 9, 0.08), transparent 24rem),
        var(--bg);
      font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      padding: 32px 36px 24px;
      border-bottom: 1px solid var(--line);
    }
    .eyebrow {
      margin: 0 0 6px;
      color: var(--accent);
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 44px);
      line-height: 1.08;
    }
    h3 { margin: 12px 0 8px; font-size: 18px; }
    h4 { margin: 16px 0 8px; color: var(--muted); font-size: 13px; }
    .description {
      max-width: 980px;
      margin: 14px 0 0;
      color: var(--muted);
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }
    .meta span, .meta a {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255, 253, 248, .72);
      color: var(--ink);
      text-decoration: none;
    }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 360px) 1fr;
      gap: 24px;
      padding: 24px 36px 48px;
    }
    aside {
      position: sticky;
      top: 18px;
      align-self: start;
      max-height: calc(100vh - 36px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 253, 248, .82);
    }
    .aside-title {
      position: sticky;
      top: 0;
      padding: 14px 14px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      font-weight: 700;
    }
    .nav-item {
      display: grid;
      grid-template-columns: 62px 1fr;
      gap: 8px;
      align-items: center;
      padding: 9px 14px;
      color: var(--ink);
      text-decoration: none;
      border-bottom: 1px solid rgba(216, 209, 194, .55);
    }
    .nav-item:hover { background: rgba(15, 118, 110, .08); }
    code {
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .content {
      display: grid;
      gap: 16px;
      min-width: 0;
    }
    .operation {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 253, 248, .92);
      padding: 18px;
      scroll-margin-top: 20px;
    }
    .operation-heading {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .tag {
      color: var(--muted);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
    }
    .method {
      display: inline-flex;
      justify-content: center;
      min-width: 54px;
      padding: 3px 7px;
      border-radius: 5px;
      color: white;
      font-weight: 800;
      font-size: 11px;
      letter-spacing: .02em;
    }
    .method-get { background: var(--get); }
    .method-post { background: var(--post); }
    .method-patch { background: var(--patch); }
    .method-put { background: var(--put); }
    .method-delete { background: var(--delete); }
    pre {
      overflow: auto;
      max-height: 520px;
      margin: 0;
      padding: 14px;
      border-radius: 7px;
      background: #17202a;
      color: #f8fafc;
      font-size: 12px;
      line-height: 1.45;
    }
    @media (max-width: 900px) {
      header { padding: 24px 18px 18px; }
      main { grid-template-columns: 1fr; padding: 18px; }
      aside { position: static; max-height: 360px; }
    }
  </style>
</head>
<body>
__API_DOCS_BODY__
</body>
</html>
"""


def swagger_ui_html() -> str:
    """Return a self-contained API docs page backed by the OpenAPI spec."""
    return _DOCS_HTML_TEMPLATE.replace("__API_DOCS_BODY__", _docs_body_html(build_openapi_spec()))
