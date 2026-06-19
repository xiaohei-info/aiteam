"""Claude Code Driver（JSONL / stream-json，06 §7.3 / §7.5.3）。

绑定 `JsonStreamCliExecutor`。B 类能力按 §7.5.3 翻译为 Claude Code flag：
- system_prompt → `--append-system-prompt`
- model        → `--model <id>`
- thinking_level→ `--effort`
- mcp_config   → 写 run 作用域临时文件 → `--mcp-config`（§7.5.4 规则 5，不碰共享 profile）
- resume       → `--resume <sid>`
A 类能力统一经 mcp_config 注入（§7.5.2），不在此另开旁路。
"""

from __future__ import annotations

from shared.contracts.events import RuntimeEventType
from shared.contracts.gateway import RuntimeCapability
from shared.contracts.runspec import RunSpec

from .base import _BaseDriver, materialize_mcp_config


class ClaudeCodeJsonStreamDriver(_BaseDriver):
    runtime_name = "claude_code"
    cli_path = "claude"

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(
            runtime=self.runtime_name,
            supports_native_skills=True,  # Claude Code 原生 skill/agent 机制
            supports_native_memory=False,  # 记忆走 mem0 MCP（D17）
            supports_resume=True,
            supports_mcp=True,
            system_prompt_injection="flag",  # --append-system-prompt
            model_catalog_mode="static",
        )

    def build_command(self, run_spec: RunSpec) -> list[str]:
        cmd = [self.cli_path, "--print", "--output-format", "stream-json", "--verbose"]
        if run_spec.system_prompt:
            cmd += ["--append-system-prompt", run_spec.system_prompt]
        if run_spec.model:
            cmd += ["--model", run_spec.model]
        if run_spec.thinking_level:
            cmd += ["--effort", run_spec.thinking_level]
        mcp_path = materialize_mcp_config(run_spec.mcp_config)
        if mcp_path:
            cmd += ["--mcp-config", mcp_path]
        if run_spec.resume_session_id:
            cmd += ["--resume", run_spec.resume_session_id]
        cmd += self.filter_custom_args(run_spec.custom_args)
        return cmd

    def _map_raw(self, raw: dict) -> tuple[RuntimeEventType, dict] | None:
        kind = raw.get("type")
        if kind == "system" and raw.get("subtype") == "init":
            return "status", {"state": "running"}
        if kind == "assistant":
            return self._map_assistant(raw.get("message", {}))
        if kind == "user":  # tool_result 回灌
            return self._map_tool_result(raw.get("message", {}))
        if kind == "result":
            if raw.get("is_error") or raw.get("subtype") not in (None, "success"):
                return "error", {"message": raw.get("result") or raw.get("subtype")}
            return "completed", {"final_text": raw.get("result", "")}
        return None

    @staticmethod
    def _map_assistant(message: dict) -> tuple[RuntimeEventType, dict] | None:
        for block in message.get("content", []):
            btype = block.get("type")
            if btype == "text":
                return "text_delta", {"text": block.get("text", "")}
            if btype == "thinking":
                return "reasoning_delta", {"text": block.get("thinking", "")}
            if btype == "tool_use":
                return "tool_call_started", {
                    "tool_id": block.get("id"),
                    "name": block.get("name"),
                    "input": block.get("input", {}),
                }
        return None

    @staticmethod
    def _map_tool_result(message: dict) -> tuple[RuntimeEventType, dict] | None:
        for block in message.get("content", []):
            if block.get("type") == "tool_result":
                return "tool_call_completed", {
                    "tool_id": block.get("tool_use_id"),
                    "output": block.get("content", ""),
                    "is_error": bool(block.get("is_error", False)),
                }
        return None

    def extract_session_id(self, raw: object) -> str | None:
        if isinstance(raw, dict):
            return raw.get("session_id")
        return None

    def extract_usage(self, raw: object) -> dict | None:
        if isinstance(raw, dict) and isinstance(raw.get("usage"), dict):
            return raw["usage"]
        return None
