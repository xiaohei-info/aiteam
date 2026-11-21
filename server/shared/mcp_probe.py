"""«登记 MCP» probe shared by Operator and Manager: reads an MCP server's auth requirement and tool list
(design 2026-11-18 §3.11; Manager enterprise MCP, design 2026-11-20 §4.4).

SSRF guard: https only; every connection resolves the host and refuses private / loopback / link-local /
multicast / reserved / documentation addresses, then connects to the vetted address itself (TLS still verifies
the original host name), so a DNS answer cannot change between the check and the connect. No redirects, no
ambient proxies, a 10 s overall deadline and 1 MiB per response. `test_token` is used for this one probe only:
never stored, logged or echoed.
"""

from __future__ import annotations

import json
import re
import time
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.platform_mcp import (
    MAX_MCP_TIMEOUT_MS,
    MAX_MCP_TOOLS,
    MCP_TOOL_RE,
    MIN_MCP_TIMEOUT_MS,
    validate_mcp_auth_header,
    validate_mcp_url,
)
from shared.net_guard import Blocked, Fetch, FetchFailed, pinned_fetch, public_addresses  # noqa: F401 (re-exported)

PROBE_DEADLINE_S = 10.0
MAX_BODY_BYTES = 1024 * 1024
_PROTOCOL_VERSION = "2025-06-18"
_MAX_TOOL_PAGES = 5


class McpProbeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=1024, description="MCP 端点地址（streamable HTTP，仅 https）。")
    timeout_ms: int | None = Field(default=None, ge=MIN_MCP_TIMEOUT_MS, le=MAX_MCP_TIMEOUT_MS, description="探测超时（毫秒）；最长 10000。")
    auth_header: str = Field(default="", max_length=64, description="携带测试令牌的请求头名；空表示 Authorization: Bearer。")
    test_token: str | None = Field(default=None, max_length=8192, description="只用于这一次探测的令牌；不保存、不记日志、不回显。")


class McpProbeResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["ok", "needs_oauth", "needs_token", "unreachable"] = Field(description="ok 已读到工具；needs_oauth 需要成员在服务方网页登录（管理端无法代为登录，工具可留空）；needs_token 需要访问令牌；unreachable 无法连接。")
    auth: Literal["none", "oauth", "bearer"] = Field(description="建议的鉴权方式。")
    tools: list[str] = Field(default_factory=list, description="读到的工具名（最多 50 个）。")
    scopes_supported: list[str] = Field(default_factory=list, description="oauth：服务方声明支持的权限范围。")
    scope: str = Field(default="", description="oauth：服务方要求的权限范围（来自 401 质询）。")
    auth_host: str = Field(default="", description="oauth：服务方登录页主机名。")
    dynamic_registration: bool = Field(default=False, description="oauth：服务方是否支持自动注册应用；不支持时需填写应用编号。")
    server_name: str = Field(default="", description="服务自报名称。")
    token_rejected: bool = Field(default=False, description="带了测试令牌但被服务方拒绝。")
    detail: str = Field(default="", description="给管理员看的说明。")


# The SSRF guard lives in shared/net_guard.py (also used by Manager's custom imports); names kept for callers.
ProbeBlocked = Blocked
ProbeFailed = FetchFailed


def _pinned_fetch() -> Fetch:
    return pinned_fetch(max_bytes=MAX_BODY_BYTES)


def _rpc_message(status: int, headers: dict[str, str], body: bytes, request_id: int) -> dict:
    if status < 200 or status >= 300:
        raise ProbeFailed(f"服务返回 HTTP {status}")
    text = body.decode("utf-8", errors="replace")
    candidates: list[str] = []
    if "text/event-stream" in headers.get("content-type", ""):
        for event in re.split(r"\r?\n\r?\n", text):
            data = "\n".join(line[5:].lstrip() for line in event.splitlines() if line.startswith("data:"))
            if data:
                candidates.append(data)
    else:
        candidates.append(text)
    for raw in candidates:
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        if isinstance(message, dict) and message.get("id") == request_id:
            if "error" in message:
                raise ProbeFailed("服务返回了 MCP 错误")
            result = message.get("result")
            if isinstance(result, dict):
                return result
    raise ProbeFailed("不是 MCP（streamable HTTP）服务")


def _challenge(headers: dict[str, str]) -> dict[str, str]:
    value = headers.get("www-authenticate", "")
    return {k.lower(): v for k, v in re.findall(r'([A-Za-z_]+)="([^"]*)"', value)}


def _json(fetch: Fetch, url: str, deadline: float) -> dict | None:
    try:
        status, _headers, body = fetch("GET", url, {"accept": "application/json"}, None, deadline)
    except ProbeFailed:
        return None
    if status != 200:
        return None
    try:
        data = json.loads(body)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _discover_oauth(fetch: Fetch, url: str, challenge: dict[str, str], deadline: float) -> dict | None:
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    candidates = [challenge["resource_metadata"]] if challenge.get("resource_metadata") else []
    candidates += [f"{origin}/.well-known/oauth-protected-resource{parts.path.rstrip('/')}", f"{origin}/.well-known/oauth-protected-resource"]
    resource = next((doc for doc in (_json(fetch, item, deadline) for item in candidates) if doc), None)
    servers = resource.get("authorization_servers") if resource else None
    issuer = servers[0] if isinstance(servers, list) and servers and isinstance(servers[0], str) else origin
    issuer_parts = urlsplit(issuer)
    issuer_origin, issuer_path = f"{issuer_parts.scheme}://{issuer_parts.netloc}", issuer_parts.path.rstrip("/")
    for meta_url in (
        f"{issuer_origin}/.well-known/oauth-authorization-server{issuer_path}",
        f"{issuer_origin}/.well-known/openid-configuration{issuer_path}",
        f"{issuer.rstrip('/')}/.well-known/openid-configuration",
    ):
        meta = _json(fetch, meta_url, deadline)
        if not meta:
            continue
        endpoint = meta.get("authorization_endpoint")
        if isinstance(endpoint, str) and endpoint.startswith("https://"):
            scopes = (resource or {}).get("scopes_supported") or meta.get("scopes_supported") or []
            return {
                "auth_host": urlsplit(endpoint).hostname or "",
                "scopes_supported": [s for s in scopes if isinstance(s, str)][:50],
                "dynamic_registration": isinstance(meta.get("registration_endpoint"), str),
            }
    return None


def probe_mcp(request: McpProbeRequest, fetch: Fetch | None = None) -> McpProbeResult:
    try:
        url = validate_mcp_url(request.url)
        header = validate_mcp_auth_header(request.auth_header)
    except ValueError as exc:
        return McpProbeResult(status="unreachable", auth="none", detail=str(exc))
    fetch = fetch or _pinned_fetch()
    deadline = time.monotonic() + min(PROBE_DEADLINE_S, (request.timeout_ms or 10_000) / 1000)
    token = request.test_token or ""
    headers = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
    if token:
        headers.update({header: token} if header else {"authorization": f"Bearer {token}"})
    initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": _PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "aiteam-operator-probe", "version": "1.0.0"}}}
    try:
        status, response_headers, body = fetch("POST", url, headers, json.dumps(initialize).encode(), deadline)
        if status in (401, 403):
            oauth = _discover_oauth(fetch, url, _challenge(response_headers), deadline) if status == 401 else None
            if oauth:
                return McpProbeResult(
                    status="needs_oauth", auth="oauth", scope=_challenge(response_headers).get("scope", ""), **oauth,
                    detail="该服务需要成员在服务方网页用自己的账号登录；管理端无法代为登录，工具名可留空，以成员登录后实际工具为准。",
                )
            return McpProbeResult(
                status="needs_token", auth="bearer", token_rejected=bool(token),
                detail="服务方拒绝了测试令牌。" if token else "该服务需要访问令牌；可填写一个测试令牌读取工具（令牌不会保存）。",
            )
        if 300 <= status < 400:
            raise ProbeFailed("服务返回了重定向，探测不跟随重定向")
        info = _rpc_message(status, response_headers, body, 1)
        session = response_headers.get("mcp-session-id")
        version = info.get("protocolVersion") if isinstance(info.get("protocolVersion"), str) else _PROTOCOL_VERSION
        follow = {**headers, "mcp-protocol-version": version, **({"mcp-session-id": session} if session else {})}
        fetch("POST", url, follow, json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode(), deadline)
        tools: list[str] = []
        cursor: str | None = None
        for page in range(_MAX_TOOL_PAGES):
            params = {"cursor": cursor} if cursor else {}
            status, list_headers, list_body = fetch("POST", url, follow, json.dumps({"jsonrpc": "2.0", "id": 2 + page, "method": "tools/list", "params": params}).encode(), deadline)
            result = _rpc_message(status, list_headers, list_body, 2 + page)
            for item in result.get("tools") or []:
                tool = item.get("name") if isinstance(item, dict) else None
                if isinstance(tool, str) and MCP_TOOL_RE.match(tool) and tool not in tools:
                    tools.append(tool)
            cursor = result.get("nextCursor") if isinstance(result.get("nextCursor"), str) else None
            if not cursor or len(tools) >= MAX_MCP_TOOLS:
                break
        server = info.get("serverInfo")
        reported = server.get("name") if isinstance(server, dict) else None
        name = reported if isinstance(reported, str) else ""
        return McpProbeResult(status="ok", auth="bearer" if token else "none", tools=tools[:MAX_MCP_TOOLS], server_name=name[:120],
                              detail="" if tools else "服务没有提供工具。")
    except (ProbeBlocked, ProbeFailed) as exc:
        return McpProbeResult(status="unreachable", auth="none", detail=str(exc))
