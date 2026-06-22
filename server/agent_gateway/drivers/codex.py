"""Codex Driver（自定义 JSON-RPC over stdio，06 §7.3 / §7.5.3）。

绑定 `JsonRpcStdioExecutor`（Codex app-server）。B 类能力按 §7.5.3 翻译：
- model        → `--model <id>`（空则 CLI 默认）
- thinking_level→ `-c model_reasoning_effort=<level>`（Codex 用 -c 覆盖配置）
- mcp_config   → 经 Codex MCP 入口（不写共享 profile）
- resume       → `resume <sid>`
原始事件取 `codex/event` 通知的 `msg.type` 判别字。
"""

from __future__ import annotations

from shared.contracts.events import RuntimeEventType
from shared.contracts.gateway import RuntimeCapability
from shared.contracts.runspec import RunSpec

from .base import _BaseDriver


class CodexJsonRpcDriver(_BaseDriver):
    runtime_name = "codex"
    executor_family = "json_rpc_stdio"
    cli_path = "codex"
    # Codex 特有越权 flag：`-c` 可任意覆盖配置（含 sandbox/审批策略），
    # `--sandbox`/`--full-auto`/`--dangerously-bypass-approvals-and-sandbox` 直接破隔离/审批。
    # 这些只禁 custom_args 透传；Driver 自身受控使用 `-c` 注入 thinking_level 不受影响
    # （build_command 在 filter 之后追加）。
    extra_arg_denylist = frozenset(
        {
            "-c",
            "--config",
            "--sandbox",
            "-s",
            "--full-auto",
            "--dangerously-bypass-approvals-and-sandbox",
            "--ask-for-approval",
            "-a",
        }
    )

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(
            runtime=self.runtime_name,
            supports_native_skills=False,  # 技能降级走 MCP（§7.5.2）
            supports_native_memory=False,
            supports_resume=True,
            supports_mcp=True,
            system_prompt_injection="protocol",  # 经 app-server 入参注入
            model_catalog_mode="dynamic",
        )

    def build_command(self, run_spec: RunSpec) -> list[str]:
        cmd = [self.cli_path, "app-server"]
        if run_spec.model:
            cmd += ["--model", run_spec.model]
        if run_spec.thinking_level:
            cmd += ["-c", f"model_reasoning_effort={run_spec.thinking_level}"]
        if run_spec.resume_session_id:
            cmd += ["resume", run_spec.resume_session_id]
        cmd += self.filter_custom_args(run_spec.custom_args)
        return cmd

    def _map_raw(self, raw: dict) -> tuple[RuntimeEventType, dict] | None:
        if raw.get("method") != "codex/event":
            return None
        msg = raw.get("params", {}).get("msg", {})
        mtype = msg.get("type")
        if mtype == "task_started":
            return "status", {"state": "running"}
        if mtype == "agent_message_delta":
            return "text_delta", {"text": msg.get("delta", "")}
        if mtype == "agent_reasoning_delta":
            return "reasoning_delta", {"text": msg.get("delta", "")}
        if mtype == "exec_command_begin":
            return "command_started", {
                "call_id": msg.get("call_id"),
                "command": msg.get("command", []),
            }
        if mtype == "exec_command_end":
            return "command_output", {
                "call_id": msg.get("call_id"),
                "stdout": msg.get("stdout", ""),
                "exit_code": msg.get("exit_code"),
            }
        if mtype == "token_count":
            return "usage", msg.get("info", {}) or {}
        if mtype == "task_complete":
            return "completed", {"final_text": msg.get("last_agent_message", "")}
        if mtype == "error":
            return "error", {"message": msg.get("message", "")}
        return None

    def extract_session_id(self, raw: object) -> str | None:
        if isinstance(raw, dict):
            params = raw.get("params", {})
            if isinstance(params, dict):
                msg = params.get("msg", {})
                if isinstance(msg, dict) and msg.get("session_id"):
                    return msg["session_id"]
                if params.get("session_id"):
                    return params["session_id"]
        return None

    def extract_usage(self, raw: object) -> dict | None:
        if isinstance(raw, dict):
            msg = raw.get("params", {}).get("msg", {})
            if isinstance(msg, dict) and msg.get("type") == "token_count":
                return msg.get("info", {}) or {}
        return None
