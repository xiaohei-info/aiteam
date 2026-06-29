"""P1-F7 失败诊断 helper（最终执行 DAG §5.1 P1-F7、§8 诊断纪律）。

目的：失败后能定位到层级（auth/tenant/outbox/rollup/browser/api/pg），但**绝不**输出
secret / provider key / 会话正文 / 文件正文 / 工具 I/O 明细（DAG §8 统一诊断纪律）。

设计（消除边界判断的"好品味"）：诊断记录只接受**允许清单**字段；任何字典 dump（如 token
claims、problem+json 捕获）先过 redact() 按敏感键名脱敏。两道防线叠加：
1. 结构层：FailureDiagnostics 只持结构化定位字段，没有"塞会话正文"的口子。
2. 值层：redact() 递归把敏感键名的值替换为 [REDACTED]，且 problem+json 只取 type/title/status。

纯逻辑、无 DB（dump_tenant_state 接受已取出的标量，不自连 PG）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

REDACTED = "[REDACTED]"

# 敏感键名子串（小写匹配）——命中即整值脱敏。覆盖 secret/token/凭据/私钥/授权头。
SENSITIVE_KEY_SUBSTRINGS: tuple[str, ...] = (
    "secret",
    "password",
    "passwd",
    "token",
    "authorization",
    "cookie",
    "session",
    "private_pem",
    "private_key",
    "privatekey",
    "api_key",
    "apikey",
    "credential",
    "provider_key",
    "signing_key",
    "access_key",
)

# 会话正文 / 文件正文 / 工具 I/O 明细键名子串——诊断绝不携带这些内容（DAG §8/C2）。
FORBIDDEN_CONTENT_SUBSTRINGS: tuple[str, ...] = (
    "message_text",
    "messages",
    "transcript",
    "conversation_text",
    "content",
    "prompt",
    "completion",
    "file_content",
    "file_body",
    "tool_input",
    "tool_output",
    "tool_io",
    "raw_payload",
)


class DiagnosticLayer(str, Enum):
    """失败层级（DAG §8 失败 artifact 与诊断路径）。"""

    PG = "pg"
    AUTH = "auth"
    TENANT = "tenant"
    GRANTS = "grants"
    OUTBOX = "outbox"
    ROLLUP = "rollup"
    API = "api"
    BROWSER = "browser"


def _is_sensitive(key: str) -> bool:
    k = key.lower()
    return any(s in k for s in SENSITIVE_KEY_SUBSTRINGS)


def _is_forbidden_content(key: str) -> bool:
    k = key.lower()
    return any(s in k for s in FORBIDDEN_CONTENT_SUBSTRINGS)


def redact(value: Any, _key: str | None = None) -> Any:
    """递归脱敏：敏感键名 -> [REDACTED]；会话/文件/工具内容键名 -> 整键丢弃。

    - dict：逐键处理；命中 FORBIDDEN_CONTENT 的键直接 **不保留**（连键名都不进诊断）；
      命中 SENSITIVE 的键保留键名但值替换为 [REDACTED]（保留"这里有个密钥"的定位价值）。
    - list/tuple：逐元素递归（继承父键判定）。
    - 标量：按父键判定；非敏感原样返回。
    """
    if _key is not None and _is_sensitive(_key):
        return REDACTED
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if _is_forbidden_content(str(k)):
                continue  # 会话/文件/工具正文：连键带值一并丢弃
            if _is_sensitive(str(k)):
                out[k] = REDACTED
            else:
                out[k] = redact(v, str(k))
        return out
    if isinstance(value, (list, tuple)):
        return [redact(v, _key) for v in value]
    return value


_BEARER_RE = re.compile(r"\b([Bb]earer)\s+\S+")
_SENSITIVE_PAIR_RE = re.compile(
    r"\b([A-Za-z0-9_-]*(?:" + "|".join(SENSITIVE_KEY_SUBSTRINGS) + r")[A-Za-z0-9_-]*)\s*([=:])\s*[^\s&#\"',;]+",
    re.IGNORECASE,
)


def redact_text(text: str | None) -> str | None:
    """自由文本脱敏（如 summary）：清洗 `Bearer xxx` 与敏感 `key=value` / `key: value`。

    与 web/e2e/support/diagnostics.ts redactText 同口径——summary 可能夹带 secret 字面量。
    """
    if not text:
        return text
    text = _BEARER_RE.sub(lambda m: f"{m.group(1)} {REDACTED}", text)
    text = _SENSITIVE_PAIR_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", text)
    return text


def capture_problem_json(status: int, body: Any) -> dict[str, Any]:
    """从 application/problem+json 响应只取定位字段（type/title/status）。

    刻意丢弃 detail/instance 等可能回带会话/资源正文的字段（DAG §8）。
    body 为非 dict（如 text/html 误返回）时只记录 status 与类型标记，不回带正文。
    """
    if not isinstance(body, dict):
        return {"status": status, "problem_json": False}
    return {
        "status": status,
        "problem_json": True,
        "type": body.get("type"),
        "title": body.get("title"),
    }


@dataclass
class FailureDiagnostics:
    """单次失败的结构化诊断记录（只持定位字段，无会话/文件/工具正文口子）。

    fields:
      layer       失败层级（DiagnosticLayer）
      summary     一句话定位（不含正文，调用方自保证）
      tenant_id   涉及租户（脱敏无意义，UUID 非敏感）
      current_user 当前 DB 角色（如 app_rw）——证明连接身份，非凭据
      problem     capture_problem_json() 的输出
      context     任意附加定位字典，**经 redact() 脱敏后存储**
    """

    layer: DiagnosticLayer
    summary: str
    tenant_id: str | None = None
    current_user: str | None = None
    problem: dict[str, Any] | None = None
    context: dict[str, Any] = field(default_factory=dict)

    def add_context(self, **kwargs: Any) -> "FailureDiagnostics":
        """追加定位上下文，进入前过 redact()（敏感键脱敏、正文键丢弃）。"""
        cleaned = redact(dict(kwargs))
        self.context.update(cleaned)
        return self

    def to_dict(self) -> dict[str, Any]:
        """导出可记录的诊断字典（再次整体 redact，纵深防御）。"""
        record = {
            "layer": self.layer.value,
            "summary": redact_text(self.summary),
            "tenant_id": self.tenant_id,
            "current_user": self.current_user,
            "problem": self.problem,
            "context": self.context,
        }
        return redact(record)


def assert_no_sensitive_leak(record: Any, secrets: tuple[str, ...] = ()) -> None:
    """断言诊断记录里不含任何给定 secret 字面量，也不含会话/文件/工具内容键名。

    供契约测试与诊断自检使用：把已知 secret 值与禁止键名在序列化文本里反查。
    命中即 AssertionError——失败诊断泄露敏感内容是 B3 级阻断。
    """
    import json

    text = json.dumps(record, ensure_ascii=False, default=str)
    lowered = text.lower()
    for s in secrets:
        if s and s in text:
            raise AssertionError(f"诊断记录泄露 secret 字面量: {s!r}")
    for key in FORBIDDEN_CONTENT_SUBSTRINGS:
        if key in lowered:
            raise AssertionError(f"诊断记录携带被禁内容键名: {key!r}")
