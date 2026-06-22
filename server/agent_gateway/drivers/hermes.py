"""Hermes Driver（ACP / JSON-RPC over stdio，06 §7.3 / §7.5.3）。

绑定 `AcpExecutor`，取代旧 WebUI loopback 执行链（§7.3：旧 HERMES_WEBUI_* / app/.env 一概不用）。
B 类能力经 ACP **协议字段/RPC** 注入（非 flag、非文件）：
- system_prompt → ACP session 参数（session/new 的 systemPrompt）
- model        → ACP `session/set_model` RPC（build_command 不带 model flag）
- mcp_config   → 经 ACP 注入（不写共享 profile；§7.5.4 规则 5）
persona/记忆/知识统一走协议 + MCP，**不再写 SOUL.md/MEMORY.md/skills/config.yaml**（D16/§7.5.5）。
原始事件取 ACP `session/update` 通知的 `sessionUpdate` 判别字。
"""

from __future__ import annotations

from shared.contracts.events import RuntimeEventType
from shared.contracts.gateway import RuntimeCapability
from shared.contracts.runspec import RunSpec

from .base import _BaseDriver


class HermesAcpDriver(_BaseDriver):
    runtime_name = "hermes"
    executor_family = "acp"
    cli_path = "hermes"

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(
            runtime=self.runtime_name,
            supports_native_skills=True,  # Hermes skills runtime（Driver 内经协议封装）
            supports_native_memory=False,  # 记忆走 mem0 MCP（D17）
            supports_resume=True,
            supports_mcp=True,
            system_prompt_injection="protocol",  # ACP session 参数，非 flag/文件
            model_catalog_mode="dynamic",  # 经 ACP/CLI 列模型
        )

    def build_command(self, run_spec: RunSpec) -> list[str]:
        # ACP runtime：启动只拉起协议端点，B 类配置走握手/RPC 注入，不进命令行。
        cmd = [self.cli_path, "acp"]
        cmd += self.filter_custom_args(run_spec.custom_args)
        return cmd

    def _map_raw(self, raw: dict) -> tuple[RuntimeEventType, dict] | None:
        # ACP 用 JSON-RPC 通知：method=session/update，params.update 携 sessionUpdate 判别字。
        if raw.get("method") != "session/update":
            return None
        update = raw.get("params", {}).get("update", {})
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            return "text_delta", {"text": _content_text(update.get("content"))}
        if kind == "agent_thought_chunk":
            return "reasoning_delta", {"text": _content_text(update.get("content"))}
        if kind == "tool_call":
            return "tool_call_started", {
                "tool_id": update.get("toolCallId"),
                "name": update.get("title") or update.get("kind"),
                "input": update.get("rawInput", {}),
            }
        if kind == "tool_call_update":
            status = update.get("status")
            if status in ("completed", "failed"):
                return "tool_call_completed", {
                    "tool_id": update.get("toolCallId"),
                    "output": _content_text(update.get("content")),
                    "is_error": status == "failed",
                }
            return None
        return None

    def extract_session_id(self, raw: object) -> str | None:
        if isinstance(raw, dict):
            params = raw.get("params", {})
            if isinstance(params, dict) and params.get("sessionId"):
                return params["sessionId"]
            result = raw.get("result", {})
            if isinstance(result, dict):
                return result.get("sessionId")
        return None

    def extract_usage(self, raw: object) -> dict | None:
        # ACP 在 result/通知里以 usage/_meta.usage 透出 token 计量。
        if isinstance(raw, dict):
            for holder in (raw.get("result"), raw.get("params"), raw):
                if isinstance(holder, dict) and isinstance(holder.get("usage"), dict):
                    return holder["usage"]
        return None


def _content_text(content: object) -> str:
    """ACP content block（{type:text,text:..} 或其列表）取文本。"""
    if isinstance(content, dict):
        return content.get("text", "")
    if isinstance(content, list):
        return "".join(c.get("text", "") for c in content if isinstance(c, dict))
    if isinstance(content, str):
        return content
    return ""
