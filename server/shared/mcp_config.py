"""MCP 配置粘贴解析（Python 版）。

与 ``web/shared/src/contracts/mcp-config.ts`` / ``clients/desktop/src/lib/mcpConfigImport.ts`` 同一份规则：
只接受 streamable HTTP 远程服务；stdio / sse / 带 command 的条目被拒绝并说明原因；令牌类请求头
（Authorization 或名称含 key / token / secret）只用来判断 ``auth=bearer`` 与请求头名，**令牌值丢弃**，
不会出现在返回值里。修改规则须三处同步。

企业端模型帮装（设计 2026-11-20 §4.5 ``parse_mcp_config`` 工具）用它解析管理员粘贴或模型找到的配置。
"""

from __future__ import annotations

import json
import math
import re
from typing import Any
from urllib.parse import urlsplit

REF_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_ACCEPTED_TYPES = {"streamablehttp", "streamable-http", "streamable_http", "http"}
_SECRET_HEADER_RE = re.compile(r"^authorization$|key|token|secret", re.IGNORECASE)
_MIN_TIMEOUT = 1_000
_MAX_TIMEOUT = 300_000
_ONLY_HTTP = "只支持 streamable HTTP 远程服务"
_UNNAMED = "（未命名）"


def suggest_mcp_ref(name: str) -> str:
    """名称 → 合规标识建议（小写字母开头，只含小写字母、数字、- 或 _）。"""
    ref = re.sub(r"[^a-z0-9_-]+", "-", name.strip().lower())
    ref = re.sub(r"-{2,}", "-", ref).strip("-_")
    if not re.match(r"^[a-z]", ref):
        ref = f"mcp-{ref}".rstrip("-")
    return ref[:64].rstrip("-_") or "mcp"


def _timeout(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value) if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip()) else None
    except ValueError:
        return None
    if number is None or not math.isfinite(number) or number <= 0:
        return None
    ms = number * 1000 if number < _MIN_TIMEOUT else number  # 有的客户端以秒为单位（如 60）
    return min(max(round(ms), _MIN_TIMEOUT), _MAX_TIMEOUT)


def _http_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        return None
    return parts.geturl() if parts.path else parts._replace(path="/").geturl()


def _candidate(name: str, entry: dict[str, Any]) -> dict[str, Any]:
    label = name or _UNNAMED
    raw_type = entry.get("type") if isinstance(entry.get("type"), str) else entry.get("transport")
    kind = raw_type.strip().lower() if isinstance(raw_type, str) else ""
    if "command" in entry or kind == "stdio":
        return {"name": label, "reason": f"本地命令（stdio）无法在平台使用：{_ONLY_HTTP}"}
    if kind == "sse":
        return {"name": label, "reason": f"SSE 传输不受支持：{_ONLY_HTTP}"}
    if kind and kind not in _ACCEPTED_TYPES:
        return {"name": label, "reason": f"不支持的类型 {kind}：{_ONLY_HTTP}"}
    raw_url = entry.get("url") if entry.get("url") is not None else entry.get("serverUrl")
    url = _http_url(raw_url)
    if url is None:
        return {"name": label, "reason": "缺少 url" if raw_url is None else "url 不是有效的 http(s) 地址"}

    auth: str | None = None
    auth_header = ""
    dropped_secret = False
    ignored: list[str] = []
    headers = entry.get("headers")
    if isinstance(headers, dict):
        for header, value in headers.items():
            secret = bool(_SECRET_HEADER_RE.search(str(header)))
            has_value = isinstance(value, str) and value.strip() != ""
            if secret and auth is None:
                auth = "bearer"
                auth_header = "" if str(header).lower() == "authorization" else str(header)
                dropped_secret = dropped_secret or has_value
            else:
                dropped_secret = dropped_secret or (secret and has_value)
                ignored.append(str(header))
    trimmed = name.strip()
    if trimmed and REF_RE.match(trimmed):
        ref = trimmed
    else:
        parts = urlsplit(url)
        segments = [item for item in parts.path.split("/") if item]
        ref = suggest_mcp_ref(trimmed or (segments[-1] if segments else "") or (parts.hostname or "").split(".")[0] or "mcp")
    out: dict[str, Any] = {
        "name": trimmed, "ref": ref, "ref_adjusted": bool(trimmed) and ref != trimmed, "url": url,
        "dropped_secret": dropped_secret, "ignored_headers": ignored,
    }
    timeout = _timeout(entry.get("timeout", entry.get("timeout_ms", entry.get("timeoutMs"))))
    if timeout is not None:
        out["timeout_ms"] = timeout
    if auth:
        out.update(auth=auth, auth_header=auth_header)
    return out


def _looks_like_entry(value: dict[str, Any]) -> bool:
    return any(key in value for key in ("url", "serverUrl", "type", "transport", "command", "headers"))


def _parse_json(text: str) -> Any:
    for attempt in (text, f"{{{text}}}", "{" + re.sub(r",\s*$", "", text) + "}"):
        try:
            return json.loads(attempt)
        except ValueError:
            continue
    return None


def parse_mcp_config(text: str) -> dict[str, Any]:
    """返回 ``{"ok": True, "servers": [...], "rejected": [...]}`` 或 ``{"ok": False, "error": "..."}``。"""
    text = text.strip()
    if not text:
        return {"ok": False, "error": "请粘贴 MCP 配置或链接"}
    if re.match(r"^https?://", text, re.IGNORECASE) and not re.search(r"\s", text):
        result = _candidate("", {"url": text})
        return {"ok": False, "error": result["reason"]} if "reason" in result else {"ok": True, "servers": [result], "rejected": []}
    parsed = _parse_json(text)
    if not isinstance(parsed, dict):
        return {"ok": False, "error": "无法识别：请粘贴 JSON 配置（如 {\"mcpServers\": {…}}）或 https 链接"}
    wrapper = parsed.get("mcpServers") if isinstance(parsed.get("mcpServers"), dict) else (
        parsed.get("servers") if isinstance(parsed.get("servers"), dict) else None
    )
    if wrapper is not None:
        entries = list(wrapper.items())
    elif _looks_like_entry(parsed):
        entries = [("", parsed)]
    else:
        entries = list(parsed.items())
    servers: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    for name, value in entries:
        if not isinstance(value, dict):
            rejected.append({"name": name or _UNNAMED, "reason": "不是 MCP 配置对象"})
            continue
        result = _candidate(str(name), value)
        (rejected if "reason" in result else servers).append(result)
    if not servers and not rejected:
        return {"ok": False, "error": "配置里没有 MCP 服务"}
    return {"ok": True, "servers": servers, "rejected": rejected}
