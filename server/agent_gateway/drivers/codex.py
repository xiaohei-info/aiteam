"""Codex Driver（codex app-server JSON-RPC over stdio，06 §7.3 / §7.5.3）。

绑定 `CodexAppServerExecutor`（经 JSON-RPC 客户端双向驱动 `codex app-server`）。
B 类能力经 **turn/start 协议字段**注入（非 flag、非文件，D16），故 build_command 只拉起
协议端点，不带 model/effort/resume flag：
- model         → turn/start `model`
- thinking_level→ turn/start `effort`（codex ReasoningEffort：none|minimal|low|medium|high|xhigh）
- system_prompt → thread/start `developerInstructions`
- resume        → thread/resume（执行器侧，非 cmdline）

生产归一在 `codex_executor.map_codex_notification`（单一事实源）；本 Driver 的 parse_event
直接委托该纯函数，供契约/诊断与非客户端路径校验。
"""

from __future__ import annotations

from shared.contracts.events import RuntimeEventType
from shared.contracts.gateway import RuntimeCapability
from shared.contracts.runspec import RunSpec

from ..codex_executor import map_codex_notification
from .base import _BaseDriver


class CodexJsonRpcDriver(_BaseDriver):
    runtime_name = "codex"
    executor_family = "json_rpc_stdio"
    cli_path = "codex"
    # Codex 特有越权 flag：`-c` 可任意覆盖配置（含 sandbox/审批策略），
    # `--sandbox`/`--full-auto`/`--dangerously-bypass-approvals-and-sandbox` 直接破隔离/审批。
    # 仅禁 custom_args 透传；B 类配置由执行器经 turn/start 协议字段注入，不走 cmdline。
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
            supports_resume=True,  # codex 原生支持 thread/resume；执行器侧装载待接（resume_session_id 尚未注入）

            supports_mcp=True,
            system_prompt_injection="protocol",  # thread/start developerInstructions
            model_catalog_mode="dynamic",  # turn/start model 覆盖 + model/list RPC
            thinking_level_injection="protocol",  # turn/start effort（ReasoningEffort 枚举）
        )

    def build_command(self, run_spec: RunSpec) -> list[str]:
        # app-server 只拉起 JSON-RPC 端点；B 类（model/effort/system_prompt/resume）走协议注入。
        cmd = [self.cli_path, "app-server"]
        cmd += self.filter_custom_args(run_spec.custom_args)
        return cmd

    def _map_raw(self, raw: dict) -> tuple[RuntimeEventType, dict] | None:
        method = raw.get("method")
        if not method:
            return None
        return map_codex_notification(method, raw.get("params") or {})

    def extract_session_id(self, raw: object) -> str | None:
        if isinstance(raw, dict):
            params = raw.get("params", {})
            if isinstance(params, dict):
                thread = params.get("thread")
                if isinstance(thread, dict) and thread.get("id"):
                    return thread["id"]
                if params.get("threadId"):
                    return params["threadId"]
        return None

    def extract_usage(self, raw: object) -> dict | None:
        if isinstance(raw, dict) and raw.get("method") == "thread/tokenUsage/updated":
            total = (raw.get("params", {}).get("tokenUsage") or {}).get("total")
            if isinstance(total, dict):
                return dict(total)
        return None
