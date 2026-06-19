"""OpenClaw Driver（JSON 模式 stream，06 §7.3 / §7.5.3）。

绑定 `JsonStreamCliExecutor`。B 类能力按 §7.5.3 翻译为 flag；A 类经 mcp_config 注入。
原始事件取 OpenClaw JSON stream 的 `event` 判别字。
"""

from __future__ import annotations

from shared.contracts.events import RuntimeEventType
from shared.contracts.gateway import RuntimeCapability
from shared.contracts.runspec import RunSpec

from .base import _BaseDriver, materialize_mcp_config


class OpenClawJsonStreamDriver(_BaseDriver):
    runtime_name = "openclaw"
    cli_path = "openclaw"
    # OpenClaw 特有越权/破隔离 flag：禁经 custom_args 透传。
    extra_arg_denylist = frozenset({"--config", "--no-sandbox", "--yolo"})

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(
            runtime=self.runtime_name,
            supports_native_skills=False,
            supports_native_memory=False,
            supports_resume=False,  # 暂无 resume，能力声明显式 False（不静默假装支持）
            supports_mcp=True,
            system_prompt_injection="flag",
            model_catalog_mode="static",
        )

    def build_command(self, run_spec: RunSpec) -> list[str]:
        cmd = [self.cli_path, "--json"]
        if run_spec.model:
            cmd += ["--model", run_spec.model]
        if run_spec.system_prompt:
            cmd += ["--system", run_spec.system_prompt]
        mcp_path = materialize_mcp_config(run_spec.mcp_config)
        if mcp_path:
            cmd += ["--mcp-config", mcp_path]
        # resume 不支持：即使 RunSpec 带 resume_session_id 也不翻译（能力声明已 False）。
        cmd += self.filter_custom_args(run_spec.custom_args)
        return cmd

    def _map_raw(self, raw: dict) -> tuple[RuntimeEventType, dict] | None:
        kind = raw.get("event")
        if kind == "start":
            return "status", {"state": "running"}
        if kind == "message_delta":
            return "text_delta", {"text": raw.get("text", "")}
        if kind == "thinking_delta":
            return "reasoning_delta", {"text": raw.get("text", "")}
        if kind == "tool_use":
            return "tool_call_started", {
                "tool_id": raw.get("tool_id"),
                "name": raw.get("name"),
                "input": raw.get("input", {}),
            }
        if kind == "tool_result":
            return "tool_call_completed", {
                "tool_id": raw.get("tool_id"),
                "output": raw.get("result", ""),
                "is_error": bool(raw.get("is_error")),
            }
        if kind == "done":
            return "completed", {"final_text": raw.get("text", "")}
        if kind == "error":
            return "error", {"message": raw.get("message", "")}
        return None

    def extract_session_id(self, raw: object) -> str | None:
        if isinstance(raw, dict):
            return raw.get("session_id")
        return None

    def extract_usage(self, raw: object) -> dict | None:
        if isinstance(raw, dict) and isinstance(raw.get("usage"), dict):
            return raw["usage"]
        return None
