"""Terminal Driver（06 §7.3 / issue #415）。

把要执行的命令翻译为子进程启动参数，并把原始 stdout/stderr 文本块归一为脱敏后的
command_output 事件。**唯一翻译点**：网关核心与业务层不感知 shell 形态（D6）。

> 裁决（服从 §7.5.4 规则 2）：能力差异只活在 Driver；网关核心不碰 runtime 原生结构。
> 本 Driver 绑定 TerminalExecutor（一次性命令执行协议族），声明能力最小集。
> 命令通过 RunSpec.custom_args[0] 传入（中立规格透传），不引入私有字段。

安全：
- 默认走 bash -c 显式调用（不拆 argv），避免 shell 元字符转义漏洞由调用方承担；
- 输出脱敏在 parse_event 内完成（凭据/密钥/内网路径 pattern 替换为占位）。
"""

from __future__ import annotations

import re

from datetime import datetime, timezone
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, RuntimeCapability
from shared.contracts.runspec import RunSpec


# 输出脱敏 pattern：凭据 / 密钥 / token / 密码 / 内网绝对路径。
# 仅作 v1 基础脱敏，不全不漏（§13 的输出脱敏是硬约束，这里给可复核的最小集）。
_SANITIZE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # AWS / 通用 AKIA 风格 key
    (re.compile(r"AKIA[0-9A-Z]{16}"), "<REDACTED_AKIA>"),
    # xxx_API_KEY=/xxx_TOKEN=/xxx_SECRET= 的取值（到空白或行尾）
    (re.compile(
        r"((?:API_KEY|API_TOKEN|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)\s*[:=]\s*)[^\s]+",
        re.IGNORECASE,
    ), r"<_REDACTED>"),
    # Bearer <token>
    (re.compile(r"(Bearer\s+)\S+", re.IGNORECASE), r"<_REDACTED>"),
    # 内网绝对路径 /Users/<name>/... （避免泄露本地账号名+目录）
    (re.compile(r"/Users/[^/ \t\n]+"), "/Users/<user>"),
    (re.compile(r"/home/[^/ \t\n]+"), "/home/<user>"),
]


class TerminalDriver(Driver):
    """一次性 bash 命令执行驱动。runtime_selection="terminal" 时选中。"""

    runtime_name = "terminal"
    # 绑定一次性命令执行协议族。
    executor_family = "terminal"

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(
            runtime=self.runtime_name,
            supports_native_skills=False,
            supports_native_memory=False,
            supports_resume=False,
            supports_mcp=True,  # 文件/网络/MCP 命令经 mcp_config 注入（06 §7.5.2）
            system_prompt_injection="unsupported",
            model_catalog_mode="static",
            thinking_level_injection="unsupported",
        )

    def build_command(self, run_spec: RunSpec) -> list[str]:
        """把 RunSpec.custom_args[0] 的命令字符串翻译为子进程 argv。"""
        command = run_spec.custom_args[0] if run_spec.custom_args else ""
        return ["/bin/bash", "-c", str(command)]

    def parse_event(self, raw: object) -> AgentRuntimeEvent | None:
        """把 (stream, text) 文本块归一为脱敏后的 command_output 事件。"""
        if not isinstance(raw, tuple) or len(raw) != 2:
            return None
        stream, text = raw
        if not isinstance(stream, str) or not isinstance(text, str):
            return None
        sanitized = self._sanitize(text)
        if not sanitized:
            return None
        return AgentRuntimeEvent(
            event_id="",
            run_id="",
            seq=0,  # placeholder; Executor._stamp overrides with monotonic seq
            type="command_output",
            source=self.runtime_name,
            timestamp=datetime.now(timezone.utc),  # driver owns wall-clock semantics
            payload={"stream": stream, "data": sanitized},
        )

    def extract_session_id(self, raw: object) -> str | None:
        return None

    def extract_usage(self, raw: object) -> dict | None:
        return None

    # ---- 输出脱敏 ------------------------------------------------------

    @classmethod
    def _sanitize(cls, text: str) -> str:
        """对一块输出做脱敏替换。保留结构、仅替换敏感原子。"""
        if not text:
            return ""
        out = text
        for pattern, repl in _SANITIZE_PATTERNS:
            out = pattern.sub(repl, out)
        return out


__all__ = ["TerminalDriver"]
