"""企业端「让模型帮我找」：管理员描述需求，模型用只读工具找技能 / MCP 候选（设计 2026-11-20 §4.5，裁决 D/E）。

D18 的唯一例外：Manager 用本企业选定的平台模型、经本企业 Relay 令牌做一次**有界**工具循环
（≤ 6 轮、≤ 12 次工具调用、≤ 90 秒、单次输出 ≤ 4k tokens），只返回候选，不安装、不落库：
需求原文、模型输出、工具结果都不写库、不进日志。候选里的链接必须出现在本次工具结果（或管理员给的链接）里，
否则丢弃——模型不能编造地址。

用量：每次调用写一条 ``usage_rollup``（``summary_id = manager-assist-<uuid>``、``member_id`` = 企业最早在职
owner、``employee_id`` = NULL），与 Agent 上报同一条事务性投递链路到 Operator；另写企业审计
``capability_assist.invoked``（发起人、模型、token 数，不含内容）。

Relay 地址拼接与成员 Agent（Pi SDK）一致：``base_url``（以 ``/v1`` 结尾）+ ``chat/completions`` /
``responses``；Anthropic SDK 自带 ``/v1/messages``，因此是 ``base_url + /v1/messages``。
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from shared import net_guard
from shared.contracts.platform_provider import PricingSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import (
    AppError,
    Forbidden,
    NotFound,
    ServiceUnavailable,
    TooManyRequests,
    ValidationProblem,
)
from shared.mcp_config import parse_mcp_config
from shared.mcp_probe import McpProbeRequest, McpProbeResult, probe_mcp
from shared.skill_import import clawhub_url_parts

from .provider_credential_service import _list_platform_catalog, _safe_runtime_relay_url
from .skill_import_service import ImportRequest, SkillImportService, clawhub_base_url

logger = logging.getLogger(__name__)

MAX_ROUNDS = 6
MAX_TOOL_CALLS = 12
DEADLINE_SECONDS = 90.0
MAX_OUTPUT_TOKENS = 4096
MAX_RESULT_CHARS = 6000
MAX_CANDIDATES = 8
_SEARCH_LIMIT = 8
_FETCH_LIMIT = 1024 * 1024
_ADMIN_ROLES = {"owner", "enterprise_admin"}
_PROTOCOLS = {"openai-completions", "openai-responses", "anthropic-messages"}

SYSTEM_PROMPT = """你是企业 AI 员工平台的「能力查找助手」。管理员会描述想给员工增加的能力，你只负责找候选：
- 技能（skill）：一组说明文档与资料，来自 ClawHub 或 GitHub。
- MCP：远程工具服务（只支持 streamable HTTP 的 https 地址）。
规则：
1. 只用工具查找与核实；不要凭记忆给出链接。候选里的 url 必须原样来自搜索结果或管理员给的链接（GitHub 仓库下的子路径也可以），否则会被丢弃。
2. 搜索到的条目最好用 inspect_link 核实一次（技能看是否能导入、安全扫描结果；MCP 看鉴权方式与工具）。inspect_link 只能核实上面这些链接。
3. 管理员贴的 MCP 配置已在服务端解析好；parse_mcp_config 只帮你看懂配置格式，它返回的地址不能当作候选。令牌会被丢弃，不要索要或复述令牌。
4. 找到 1–5 个合适的候选后调用 propose 结束；确实找不到时也调用 propose，candidates 留空并在 notes 说明原因。
5. 你不能安装任何东西，管理员会在界面上逐个检查后自己安装。回答用简体中文。"""

_TOOLS: list[dict[str, Any]] = [
    {"name": "search_clawhub", "description": "在 ClawHub 技能市场按关键词搜索技能，按下载量排序。",
     "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "关键词，中英文均可"}}, "required": ["query"]}},
    {"name": "search_github", "description": "在 GitHub 搜索可能是技能集或 MCP 服务的仓库，按星标排序。",
     "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "关键词，建议英文"}}, "required": ["query"]}},
    {"name": "inspect_link", "description": "核实一个 https 链接：能作为技能导入时返回技能名称、说明、文件数和安全扫描；否则按 MCP 地址连接一次，返回鉴权方式与工具。只读，不会导入。",
     "parameters": {"type": "object", "properties": {"url": {"type": "string", "description": "https 链接"}}, "required": ["url"]}},
    {"name": "parse_mcp_config", "description": "解析 MCP 配置 JSON 或链接（Claude / Cursor / VS Code 格式），返回可用的服务地址与鉴权方式；令牌值会被丢弃。",
     "parameters": {"type": "object", "properties": {"config": {"type": "string", "description": "配置原文"}}, "required": ["config"]}},
    {"name": "propose", "description": "给出最终候选并结束查找。",
     "parameters": {"type": "object", "properties": {
         "candidates": {"type": "array", "items": {"type": "object", "properties": {
             "kind": {"type": "string", "enum": ["skill", "mcp"]},
             "source": {"type": "string", "enum": ["clawhub", "github", "url", "config"]},
             "title": {"type": "string"}, "summary": {"type": "string"}, "reason": {"type": "string", "description": "为什么适合管理员的需求"},
             "url": {"type": "string", "description": "技能链接或 MCP 地址，必须来自工具结果"},
         }, "required": ["kind", "source", "title", "url"]}},
         "notes": {"type": "string", "description": "给管理员的补充说明"},
     }, "required": ["candidates"]}},
]


class AssistModelUnavailable(AppError):
    status, code, title = 502, "assist_model_unavailable", "Bad Gateway"


_MODEL_GONE = "本企业没有这个模型，请重新选择"


def _from_operation(call: Callable[[], Any]) -> Any:
    """Operation 目录 / Relay access 调用：不存在 → 404；限流原样；其余（含运营端的 401/403、5xx、连不上）→ 503。

    运营端的 401/403 是服务间身份问题，不能原样返回给管理员（前端会当成登录失效）。
    """
    try:
        return call()
    except NotFound as exc:
        raise NotFound(_MODEL_GONE) from exc
    except TooManyRequests:
        raise
    except Exception as exc:
        raise ServiceUnavailable("运营端暂时不可用，取不到企业的模型，请稍后再试") from exc


class RelayError(Exception):
    """模型服务调用失败；消息可直接给管理员看，不含响应内容。"""


@dataclass
class AssistRequest:
    requirement: str
    provider_id: str
    model_id: str
    link: str = ""
    config_json: str = ""


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class Turn:
    text: str
    calls: list[ToolCall]
    input_tokens: int = 0
    output_tokens: int = 0
    cache_tokens: int = 0


# ---- Relay：三种协议各一个最小的工具调用适配 ----

def _arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


class _ChatCompletions:
    path = "chat/completions"

    def __init__(self, model: str, system: str, user: str):
        self._model = model
        self._messages: list[dict[str, Any]] = [{"role": "system", "content": system}, {"role": "user", "content": user}]

    def body(self) -> dict[str, Any]:
        tools = [{"type": "function", "function": tool} for tool in _TOOLS]
        return {"model": self._model, "messages": self._messages, "tools": tools, "max_tokens": MAX_OUTPUT_TOKENS}

    def parse(self, data: dict[str, Any]) -> Turn:
        message = ((data.get("choices") or [{}])[0] or {}).get("message") or {}
        raw_calls = [item for item in message.get("tool_calls") or [] if isinstance(item, dict)]
        calls = [ToolCall(str(item.get("id") or f"call_{index}"), str((item.get("function") or {}).get("name") or ""),
                          _arguments((item.get("function") or {}).get("arguments"))) for index, item in enumerate(raw_calls)]
        self._messages.append({"role": "assistant", "content": message.get("content"), **({"tool_calls": raw_calls} if raw_calls else {})})
        usage = data.get("usage") or {}
        cached = _int((usage.get("prompt_tokens_details") or {}).get("cached_tokens"))
        return Turn(str(message.get("content") or ""), calls, max(_int(usage.get("prompt_tokens")) - cached, 0),
                    _int(usage.get("completion_tokens")), cached)

    def add_results(self, results: list[tuple[ToolCall, str]]) -> None:
        self._messages.extend({"role": "tool", "tool_call_id": call.id, "content": output} for call, output in results)


class _Responses:
    path = "responses"

    def __init__(self, model: str, system: str, user: str):
        self._model = model
        self._system = system
        self._input: list[dict[str, Any]] = [{"role": "user", "content": user}]

    def body(self) -> dict[str, Any]:
        tools = [{"type": "function", **tool} for tool in _TOOLS]
        return {"model": self._model, "instructions": self._system, "input": self._input, "tools": tools,
                "max_output_tokens": MAX_OUTPUT_TOKENS, "store": False}

    def parse(self, data: dict[str, Any]) -> Turn:
        texts: list[str] = []
        calls: list[ToolCall] = []
        for item in data.get("output") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "message":
                texts.extend(str(part.get("text") or "") for part in item.get("content") or [] if isinstance(part, dict))
            elif item.get("type") == "function_call":
                call_id = str(item.get("call_id") or item.get("id") or f"call_{len(calls)}")
                calls.append(ToolCall(call_id, str(item.get("name") or ""), _arguments(item.get("arguments"))))
                self._input.append({"type": "function_call", "call_id": call_id, "name": item.get("name"), "arguments": item.get("arguments") or "{}"})
        usage = data.get("usage") or {}
        cached = _int((usage.get("input_tokens_details") or {}).get("cached_tokens"))
        return Turn("".join(texts), calls, max(_int(usage.get("input_tokens")) - cached, 0), _int(usage.get("output_tokens")), cached)

    def add_results(self, results: list[tuple[ToolCall, str]]) -> None:
        self._input.extend({"type": "function_call_output", "call_id": call.id, "output": output} for call, output in results)


class _AnthropicMessages:
    path = "v1/messages"

    def __init__(self, model: str, system: str, user: str):
        self._model = model
        self._system = system
        self._messages: list[dict[str, Any]] = [{"role": "user", "content": user}]

    def body(self) -> dict[str, Any]:
        tools = [{"name": tool["name"], "description": tool["description"], "input_schema": tool["parameters"]} for tool in _TOOLS]
        return {"model": self._model, "system": self._system, "messages": self._messages, "tools": tools, "max_tokens": MAX_OUTPUT_TOKENS}

    def parse(self, data: dict[str, Any]) -> Turn:
        blocks = [block for block in data.get("content") or [] if isinstance(block, dict) and block.get("type") in {"text", "tool_use"}]
        calls = [ToolCall(str(block.get("id") or f"call_{index}"), str(block.get("name") or ""), _arguments(block.get("input")))
                 for index, block in enumerate(blocks) if block.get("type") == "tool_use"]
        self._messages.append({"role": "assistant", "content": blocks or [{"type": "text", "text": ""}]})
        usage = data.get("usage") or {}
        return Turn("".join(str(block.get("text") or "") for block in blocks if block.get("type") == "text"), calls,
                    _int(usage.get("input_tokens")), _int(usage.get("output_tokens")), _int(usage.get("cache_read_input_tokens")))

    def add_results(self, results: list[tuple[ToolCall, str]]) -> None:
        self._messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call.id, "content": output} for call, output in results
        ]})


_ADAPTERS = {"openai-completions": _ChatCompletions, "openai-responses": _Responses, "anthropic-messages": _AnthropicMessages}


class RelayClient:
    def __init__(self, *, base_url: str, token: str, protocol: str, model: str, http: httpx.Client):
        self._url_base = base_url.rstrip("/") + "/"
        self._token = token
        self._protocol = protocol
        self._model = model
        self._http = http

    def conversation(self, system: str, user: str):
        return _ADAPTERS[self._protocol](self._model, system, user)

    def step(self, conversation, *, timeout_s: float) -> Turn:
        headers = {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"}
        if self._protocol == "anthropic-messages":
            headers.update({"x-api-key": self._token, "anthropic-version": "2023-06-01"})
        try:
            response = self._http.post(self._url_base + conversation.path, json=conversation.body(), headers=headers,
                                       timeout=max(timeout_s, 1.0))
        except httpx.TimeoutException as exc:
            raise RelayError("模型响应超时") from exc
        except httpx.HTTPError as exc:
            raise RelayError("连不上模型服务") from exc
        if response.status_code in (401, 403):
            raise RelayError("企业的模型访问被拒绝，请联系平台运营")
        if response.status_code == 429:
            raise RelayError("模型服务请求太频繁或额度不足，请稍后再试")
        if response.status_code >= 400:
            raise RelayError(f"模型服务返回 HTTP {response.status_code}")
        try:
            data = response.json()
        except ValueError as exc:
            raise RelayError("模型服务返回了无法识别的内容") from exc
        if not isinstance(data, dict):
            raise RelayError("模型服务返回了无法识别的内容")
        return conversation.parse(data)


# ---- 只读工具 ----

def _normalize_url(value: str) -> str:
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return value.strip()
    return parts._replace(scheme=parts.scheme.lower(), netloc=parts.netloc.lower(), fragment="").geturl().rstrip("/")


def _is_github_repo(url: str) -> bool:
    parts = urlsplit(url)
    return parts.netloc.lower() == "github.com" and len([p for p in parts.path.split("/") if p]) == 2


class AssistTools:
    """模型可调的只读工具。记录可信链接（候选与 inspect_link 只能用这些）和技能安全扫描结果。

    可信链接只有三种：管理员给的链接、管理员贴的配置里的地址、搜索工具结构化返回的条目地址（及 ClawHub
    同名候选）。工具结果正文（技能说明、仓库描述、模型调用 parse_mcp_config 的回显）里出现的链接都不算——
    那些文字可能来自第三方或模型自己，算进去就等于允许模型编造地址、或让 Manager 去请求任意地址。
    """

    def __init__(self, ctx: TenantContext, *, import_service: SkillImportService,
                 probe: Callable[[McpProbeRequest], McpProbeResult], fetch: net_guard.Fetch,
                 clawhub_base: str, github_base: str, deadline: float):
        self._ctx = ctx
        self._import = import_service
        self._probe = probe
        self._fetch = fetch
        self._clawhub = clawhub_base.rstrip("/")
        self._github = github_base.rstrip("/")
        self._deadline = deadline
        self.seen_urls: set[str] = set()
        self._trusted_repos: set[str] = set()  # github.com 仓库地址：其下子路径也可信
        self.security: dict[str, dict[str, Any]] = {}
        self.inspected: dict[str, str] = {}

    def run(self, name: str, arguments: dict[str, Any]) -> str:
        handlers = {"search_clawhub": self._search_clawhub, "search_github": self._search_github,
                    "inspect_link": self._inspect_link, "parse_mcp_config": self._parse_config}
        handler = handlers.get(name)
        if handler is None:
            return json.dumps({"error": f"没有工具 {name}"}, ensure_ascii=False)
        try:
            result = handler(arguments)
        except (net_guard.Blocked, net_guard.FetchFailed, ValidationProblem, NotFound, AppError) as exc:
            result = {"error": str(exc) or "失败"}
        except Exception:
            logger.exception("capability_assist.tool_failed", extra={"tool": name})
            result = {"error": "工具执行失败"}
        text = json.dumps(result, ensure_ascii=False)
        return text if len(text) <= MAX_RESULT_CHARS else text[:MAX_RESULT_CHARS] + "…（已截断）"

    def trust(self, url: str, *, repo: bool = False) -> None:
        key = _normalize_url(url)
        self.seen_urls.add(key)
        if repo:
            self._trusted_repos.add(key)

    def is_trusted(self, url: str) -> bool:
        key = _normalize_url(url)
        return key in self.seen_urls or any(key.startswith(repo + "/") and ".." not in key[len(repo):]
                                            for repo in self._trusted_repos)

    def parse_admin_config(self, config: str) -> str:
        """管理员贴的配置：服务端解析，地址记为可信；只有不含令牌的结果交给模型。"""
        result = self._parse_config({"config": config})
        for server in result.get("servers") or []:
            self.trust(server["url"])
        return json.dumps(result, ensure_ascii=False)

    def _remaining(self) -> float:
        return max(min(self._deadline - time.monotonic(), 15.0), 1.0)

    def _json(self, url: str, headers: dict[str, str] | None = None) -> Any:
        _, _, body = net_guard.get(url, fetch=self._fetch, timeout_s=self._remaining(),
                                   headers={"Accept": "application/json", **(headers or {})})
        try:
            return json.loads(body)
        except ValueError as exc:
            raise net_guard.FetchFailed("对方返回的不是 JSON") from exc

    @staticmethod
    def _query(arguments: dict[str, Any]) -> str:
        query = str(arguments.get("query") or "").strip()
        if not query:
            raise ValidationProblem("query 不能为空")
        return query[:200]

    def _search_clawhub(self, arguments: dict[str, Any]) -> dict[str, Any]:
        body = self._json(f"{self._clawhub}/api/v1/search?q={quote(self._query(arguments))}&limit={_SEARCH_LIMIT}")
        hits = []
        for item in (body or {}).get("results") or []:
            if not isinstance(item, dict):
                continue
            slug = item.get("slug") if isinstance(item.get("slug"), str) else ""
            reference = (item.get("install") or {}).get("reference") if isinstance(item.get("install"), dict) else None
            owner = reference.split("/")[0] if isinstance(reference, str) and "/" in reference else ""
            if not slug or not owner:
                continue
            hits.append({"name": slug, "owner": owner, "summary": str(item.get("description") or "")[:300],
                         "downloads": item.get("downloads") if isinstance(item.get("downloads"), int) else None,
                         "url": f"{self._clawhub}/{owner}/skills/{slug}"})
        for hit in hits:
            self.trust(hit["url"])
        return {"results": hits}

    def _search_github(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = quote(f"{self._query(arguments)} (claude-skill OR claude-skills OR \"SKILL.md\" OR mcp server)")
        body = self._json(f"{self._github}/search/repositories?q={query}&sort=stars&order=desc&per_page={_SEARCH_LIMIT}",
                          {"Accept": "application/vnd.github+json"})
        hits = []
        for item in (body or {}).get("items") or []:
            full_name = item.get("full_name") if isinstance(item, dict) else None
            if not isinstance(full_name, str) or "/" not in full_name:
                continue
            hits.append({"name": full_name, "summary": str(item.get("description") or "")[:300],
                         "stars": item.get("stargazers_count") if isinstance(item.get("stargazers_count"), int) else None,
                         "url": f"https://github.com/{full_name}"})
        for hit in hits:
            self.trust(hit["url"], repo=True)
        return {"results": hits}

    def _inspect_link(self, arguments: dict[str, Any]) -> dict[str, Any]:
        url = str(arguments.get("url") or "").strip()
        if not url.startswith("https://"):
            raise ValidationProblem("只能核实 https 链接")
        if not self.is_trusted(url):
            raise ValidationProblem("只能核实搜索结果或管理员给的链接")
        clawhub = clawhub_url_parts(url, base_url=self._clawhub) is not None
        try:
            preview = self._import.preview(self._ctx, ImportRequest(source="clawhub" if clawhub else "url", url=url))
        except AppError as exc:
            if clawhub:
                raise
            skill_error = str(exc)
            result = self._probe(McpProbeRequest(url=url))
            self.inspected[_normalize_url(url)] = "mcp"
            return {"kind": "mcp", "status": result.status, "auth": result.auth, "tools": result.tools[:30],
                    "server_name": result.server_name, "detail": result.detail, "not_a_skill": skill_error}
        self.inspected[_normalize_url(url)] = "skill"
        return self._skill_summary(url, preview)

    def _skill_summary(self, url: str, preview: dict[str, Any]) -> dict[str, Any]:
        clawhub = preview.get("clawhub") or {}
        if clawhub.get("candidates"):
            for candidate in clawhub["candidates"]:
                if clawhub_url_parts(str(candidate.get("url") or ""), base_url=self._clawhub) is not None:
                    self.trust(candidate["url"])
            return {"kind": "skill", "needs_owner": True, "candidates": clawhub["candidates"]}
        security = clawhub.get("security")
        if isinstance(security, dict):
            self.security[_normalize_url(url)] = security
        items = [preview["preview"]] if "preview" in preview else preview.get("scan") or []
        return {"kind": "skill", **({"security": security} if security else {}), "skills": [{
            "name": item.get("name"), "description": str(item.get("description") or "")[:300], "version": item.get("version"),
            "importable": item.get("ok"), **({"reason": item.get("reason")} if item.get("reason") else {}),
            "file_count": item.get("file_count"), "skipped_count": len(item.get("skipped") or []),
        } for item in items[:10]]}

    def _parse_config(self, arguments: dict[str, Any]) -> dict[str, Any]:
        result = parse_mcp_config(str(arguments.get("config") or "")[:20_000])
        if not result["ok"]:
            return {"error": result["error"]}
        return {"servers": [{key: item[key] for key in ("ref", "url", "auth", "auth_header", "timeout_ms", "dropped_secret") if key in item}
                            for item in result["servers"]], "rejected": result["rejected"]}


# ---- 服务 ----

UsageSink = Callable[[TenantContext, dict[str, Any]], None]
OwnerLookup = Callable[[TenantContext], str | None]


@dataclass
class _Run:
    candidates: list[dict[str, Any]] = field(default_factory=list)
    notes: str = ""
    incomplete: bool = False
    error: str = ""
    rounds: int = 0
    tool_calls: int = 0
    relay_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_tokens: int = 0


class CapabilityAssistService:
    def __init__(self, *, operator: Any, import_service: SkillImportService, usage_sink: UsageSink,
                 owner_lookup: OwnerLookup, audit: Any = None, http: httpx.Client | None = None,
                 fetch: net_guard.Fetch | None = None, probe: Callable[[McpProbeRequest], McpProbeResult] | None = None,
                 clawhub_base: str | None = None, github_base: str | None = None):
        self._operator = operator
        self._import = import_service
        self._usage_sink = usage_sink
        self._owner_lookup = owner_lookup
        self._audit = audit
        self._http = http
        self._fetch = fetch
        self._probe = probe or probe_mcp
        self._clawhub = clawhub_base or clawhub_base_url()
        self._github = github_base or (os.environ.get("AITEAM_GITHUB_API_BASE_URL") or "https://api.github.com").rstrip("/")

    def run(self, ctx: TenantContext, request: AssistRequest) -> dict[str, Any]:
        if not set(ctx.roles) & _ADMIN_ROLES:
            raise Forbidden("让模型帮忙找能力需要 owner 或 enterprise_admin")
        requirement = request.requirement.strip()
        if not requirement:
            raise ValidationProblem("请描述想增加的能力")
        link = request.link.strip()
        if link and not link.startswith("https://"):
            raise ValidationProblem("链接须为 https")
        pricing = self._pricing(ctx, request.provider_id, request.model_id)
        relay = self._relay(ctx, request.provider_id, request.model_id)
        started = time.monotonic()
        deadline = started + DEADLINE_SECONDS
        tools = AssistTools(ctx, import_service=self._import, probe=self._probe,
                            fetch=self._fetch or net_guard.pinned_fetch(max_bytes=_FETCH_LIMIT),
                            clawhub_base=self._clawhub, github_base=self._github, deadline=deadline)
        if link:
            tools.trust(link, repo=_is_github_repo(link))
        # The admin's config is parsed here; only the token-free result reaches the model.
        config = tools.parse_admin_config(request.config_json) if request.config_json.strip() else ""
        run = _Run()
        try:
            self._loop(relay, tools, run, self._user_message(requirement, link, config), deadline)
        finally:
            duration_ms = int((time.monotonic() - started) * 1000)
            if run.relay_calls:
                self._record(ctx, request, run, pricing, duration_ms)
        if run.error and not run.rounds:
            raise AssistModelUnavailable(run.error)
        candidates, dropped = self._accept(run.candidates, tools)
        return {
            "candidates": candidates, "notes": run.notes[:2000], "incomplete": run.incomplete, "dropped": dropped,
            **({"error": run.error} if run.error else {}),
            "rounds": run.rounds, "tool_calls": run.tool_calls,
            "usage": self._usage_view(run, pricing),
        }

    # -- 循环 --

    @staticmethod
    def _user_message(requirement: str, link: str, parsed_config: str) -> str:
        parts = [f"需求：{requirement[:2000]}"]
        if link:
            parts.append(f"管理员给的链接：{link}")
        if parsed_config:
            parts.append(f"管理员粘贴了 MCP 配置，服务端解析结果（令牌已丢弃）：\n{parsed_config}")
        return "\n\n".join(parts)

    def _loop(self, relay: RelayClient, tools: AssistTools, run: _Run, user: str, deadline: float) -> None:
        conversation = relay.conversation(SYSTEM_PROMPT, user)
        while True:
            if run.rounds >= MAX_ROUNDS or time.monotonic() >= deadline:
                run.incomplete = True
                return
            run.relay_calls += 1
            try:
                turn = relay.step(conversation, timeout_s=deadline - time.monotonic())
            except RelayError as exc:
                run.error = str(exc)
                run.incomplete = run.rounds > 0
                return
            run.rounds += 1
            run.input_tokens += turn.input_tokens
            run.output_tokens += turn.output_tokens
            run.cache_tokens += turn.cache_tokens
            if not turn.calls:
                run.notes = turn.text.strip()
                return
            proposal = next((call for call in turn.calls if call.name == "propose"), None)
            if proposal is not None:
                raw = proposal.arguments.get("candidates")
                run.candidates = [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
                run.notes = str(proposal.arguments.get("notes") or turn.text or "").strip()
                return
            results: list[tuple[ToolCall, str]] = []
            for call in turn.calls:
                if run.tool_calls >= MAX_TOOL_CALLS or time.monotonic() >= deadline:
                    results.append((call, json.dumps({"error": "工具调用次数或时间已用完，请立即调用 propose 给出已有候选"}, ensure_ascii=False)))
                    continue
                run.tool_calls += 1
                results.append((call, tools.run(call.name, call.arguments)))
            conversation.add_results(results)

    # -- 候选校验：链接必须来自本次工具结果 --

    @staticmethod
    def _accept(raw: list[dict[str, Any]], tools: AssistTools) -> tuple[list[dict[str, Any]], int]:
        accepted: list[dict[str, Any]] = []
        dropped = 0
        seen: set[str] = set()
        for item in raw:
            kind, source = item.get("kind"), item.get("source")
            url = str(item.get("url") or "").strip()
            key = _normalize_url(url)
            if (kind not in {"skill", "mcp"} or source not in {"clawhub", "github", "url", "config"}
                    or not url.startswith("https://") or not tools.is_trusted(url) or key in seen):
                dropped += 1
                continue
            seen.add(key)
            candidate = {
                "kind": kind, "source": source, "url": url,
                "title": str(item.get("title") or url)[:120], "summary": str(item.get("summary") or "")[:500],
                "reason": str(item.get("reason") or "")[:500], "verified": key in tools.inspected,
            }
            if key in tools.security:
                candidate["security"] = tools.security[key]
            accepted.append(candidate)
            if len(accepted) >= MAX_CANDIDATES:
                break
        return accepted, dropped

    # -- 模型、Relay、价格 --

    def _catalog_item(self, ctx: TenantContext, provider_id: str, model_id: str) -> dict[str, Any]:
        catalog = _from_operation(lambda: _list_platform_catalog(self._operator, ctx.tenant_id))
        for item in catalog.get("models") or []:
            model = item.get("model") if isinstance(item, dict) else None
            if isinstance(model, dict) and model.get("provider_id") == provider_id and model.get("model_id") == model_id \
                    and model.get("status") == "published":
                return item
        raise NotFound(_MODEL_GONE)

    def _pricing(self, ctx: TenantContext, provider_id: str, model_id: str) -> PricingSnapshot | None:
        rate = self._catalog_item(ctx, provider_id, model_id).get("rate")
        if not isinstance(rate, dict) or rate.get("pricing_status") != "known":
            return None
        try:
            return PricingSnapshot(**{key: rate.get(key) for key in PricingSnapshot.model_fields if key in rate})
        except ValueError:
            return None

    def _relay(self, ctx: TenantContext, provider_id: str, model_id: str) -> RelayClient:
        resolved = _from_operation(
            lambda: self._operator.resolve_tenant_access(tenant_id=ctx.tenant_id, provider_id=provider_id, model_ids=[model_id]))
        access = resolved.get("access") if isinstance(resolved, dict) else None
        allowed = access.get("allowed_model_ids") if isinstance(access, dict) else None
        protocol = resolved.get("api_protocol") if isinstance(resolved, dict) else None
        if not isinstance(allowed, list) or model_id not in allowed or protocol not in _PROTOCOLS:
            raise NotFound(_MODEL_GONE)
        base_url = _safe_runtime_relay_url(resolved.get("relay_base_url"))
        return RelayClient(base_url=base_url, token=str(resolved["relay_token"]), protocol=str(protocol), model=model_id,
                           http=self._http or httpx.Client(follow_redirects=False))

    @staticmethod
    def _cost(run: _Run, pricing: PricingSnapshot | None) -> Decimal | None:
        if pricing is None:
            return None
        if pricing.billing_mode == "request":
            return None if pricing.request_usd is None else (pricing.request_usd * run.relay_calls).quantize(Decimal("0.000001"))
        if pricing.input_usd_per_million is None or pricing.output_usd_per_million is None:
            return None
        cache_rate = pricing.cache_read_usd_per_million if pricing.cache_read_usd_per_million is not None else pricing.input_usd_per_million
        total = (Decimal(run.input_tokens) * pricing.input_usd_per_million + Decimal(run.cache_tokens) * cache_rate
                 + Decimal(run.output_tokens) * pricing.output_usd_per_million) / Decimal(1_000_000)
        return total.quantize(Decimal("0.000001"))

    def _usage_view(self, run: _Run, pricing: PricingSnapshot | None) -> dict[str, Any]:
        cost = self._cost(run, pricing)
        return {"input_tokens": run.input_tokens + run.cache_tokens, "output_tokens": run.output_tokens,
                "cost": str(cost) if cost is not None else None, "pricing_status": "known" if cost is not None else "unknown"}

    # -- 用量与审计：不含需求、输出、工具结果 --

    def _record(self, ctx: TenantContext, request: AssistRequest, run: _Run, pricing: PricingSnapshot | None, duration_ms: int) -> None:
        cost = self._cost(run, pricing)
        now = datetime.now(UTC)
        start = now.replace(minute=0, second=0, microsecond=0)
        tokens = run.input_tokens + run.cache_tokens + run.output_tokens
        owner = self._owner_lookup(ctx) or ctx.user_id
        payload = {
            "summary_id": f"manager-assist-{uuid.uuid4()}", "tenant_id": ctx.tenant_id, "member_id": owner, "employee_id": None,
            "window_start": start, "window_end": start + timedelta(hours=1),
            "run_count": 1, "prompt_count": 1, "settled_count": 0 if run.error else 1, "error_count": 1 if run.error else 0,
            "token_total": tokens, "input_tokens": run.input_tokens, "output_tokens": run.output_tokens, "cache_tokens": run.cache_tokens,
            "cost_total": cost, "pricing_version": pricing.pricing_version if cost is not None and pricing else None,
            "pricing_status": "known" if cost is not None else "unknown", "currency": "USD",
            "duration_seconds_total": duration_ms // 1000, "duration_ms_total": duration_ms,
        }
        try:
            self._usage_sink(ctx, payload)
        except Exception:
            logger.exception("capability_assist.usage_failed", extra={"summary_id": payload["summary_id"]})
        logger.info("capability_assist.invoked", extra={
            "rounds": run.rounds, "tool_calls": run.tool_calls, "tokens": tokens, "duration_ms": duration_ms,
            "incomplete": run.incomplete, "failed": bool(run.error),
        })
        if self._audit is not None:
            self._audit.record(
                ctx, actor=ctx.user_id, action="capability_assist.invoked", resource_type="platform_model",
                resource_id=f"{request.provider_id}/{request.model_id}",
                detail=f"rounds={run.rounds} tool_calls={run.tool_calls} input_tokens={run.input_tokens + run.cache_tokens} "
                       f"output_tokens={run.output_tokens} candidates={len(run.candidates)}{' failed' if run.error else ''}",
            )


def earliest_owner(router: Any, ctx: TenantContext) -> str | None:
    """本企业最早在职的 owner（多 owner 时取最早，待决策 #1）。"""
    with router.session(ctx) as session:
        row = session.execute(
            "SELECT id::text FROM app_user WHERE status = 'active' AND 'owner' = ANY(roles) ORDER BY created_at, id LIMIT 1",
        ).fetchone()
    return str(row[0]) if row else None
