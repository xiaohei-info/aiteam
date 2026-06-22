"""OpenCode Driver（JSONL / JSON stream，06 §7.3 / §7.5.3）。

绑定 `JsonStreamCliExecutor`。B 类能力按 §7.5.3 翻译为 flag；A 类经 mcp_config 注入。
原始事件取 OpenCode JSON stream 的 `type` 判别字（part/message 事件族）。
"""

from __future__ import annotations

from shared.contracts.events import RuntimeEventType
from shared.contracts.gateway import RuntimeCapability
from shared.contracts.runspec import RunSpec

from .base import _BaseDriver, materialize_mcp_config


class OpenCodeJsonStreamDriver(_BaseDriver):
    runtime_name = "opencode"
    executor_family = "json_stream_cli"
    cli_path = "opencode"
    # OpenCode 特有越权/破隔离 flag：禁经 custom_args 透传。
    extra_arg_denylist = frozenset({"--config", "--permission", "--agent-config"})

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(
            runtime=self.runtime_name,
            supports_native_skills=False,
            supports_native_memory=False,
            supports_resume=True,
            supports_mcp=True,
            system_prompt_injection="flag",
            model_catalog_mode="dynamic",
        )

    def build_command(self, run_spec: RunSpec) -> list[str]:
        cmd = [self.cli_path, "run", "--print-logs", "--output-format", "json"]
        if run_spec.model:
            cmd += ["--model", run_spec.model]
        if run_spec.system_prompt:
            cmd += ["--system-prompt", run_spec.system_prompt]
        mcp_path = materialize_mcp_config(run_spec.mcp_config)
        if mcp_path:
            cmd += ["--mcp-config", mcp_path]
        if run_spec.resume_session_id:
            cmd += ["--session", run_spec.resume_session_id]
        cmd += self.filter_custom_args(run_spec.custom_args)
        return cmd

    def _map_raw(self, raw: dict) -> tuple[RuntimeEventType, dict] | None:
        kind = raw.get("type")
        if kind == "session.start":
            return "status", {"state": "running"}
        if kind == "text":
            return "text_delta", {"text": raw.get("text", "")}
        if kind == "reasoning":
            return "reasoning_delta", {"text": raw.get("text", "")}
        if kind == "tool.start":
            return "tool_call_started", {
                "tool_id": raw.get("id"),
                "name": raw.get("tool"),
                "input": raw.get("input", {}),
            }
        if kind == "tool.end":
            return "tool_call_completed", {
                "tool_id": raw.get("id"),
                "output": raw.get("output", ""),
                "is_error": bool(raw.get("error")),
            }
        if kind == "session.end":
            if raw.get("error"):
                return "error", {"message": raw["error"]}
            return "completed", {"final_text": raw.get("text", "")}
        return None

    def extract_session_id(self, raw: object) -> str | None:
        if isinstance(raw, dict):
            return raw.get("sessionID") or raw.get("session_id")
        return None

    def extract_usage(self, raw: object) -> dict | None:
        if isinstance(raw, dict) and isinstance(raw.get("usage"), dict):
            return raw["usage"]
        return None
