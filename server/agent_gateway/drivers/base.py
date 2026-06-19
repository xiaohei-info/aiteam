"""Driver 公共底座（06 §7.3 / §7.5.4）。

收口所有 Driver 共享的中立机制，避免每个 runtime 各写一遍：

- `custom_args` denylist 过滤（§7.5.4 规则 4：防破坏协议/越权 flag）。
- 把 runtime 原始事件归一为 `AgentRuntimeEvent`（统一 event_id / seq / source / timestamp 包装，
  各 Driver 只需给出 `(type, payload)` 这条「净荷」）。
- run 作用域临时 MCP 配置 materialize（§7.5.4 规则 5：run 作用域临时产物，**不碰共享 profile**）。

铁律：Driver 只翻译 runtime 差异，不懂业务/权限对象（06 铁律 + CLAUDE/AGENTS §8）。
"""

from __future__ import annotations

import itertools
import json
import tempfile
from collections.abc import Iterable
from datetime import datetime, timezone

from shared.contracts.events import AgentRuntimeEvent, RuntimeEventType
from shared.contracts.gateway import Driver
from shared.contracts.runspec import McpServerConfig

# 全 Driver 通用的 custom_args denylist：禁止透传足以破坏协议族/越权的 flag。
# 个别 Driver 可在此基础上追加自己的危险 flag（见 `extra_arg_denylist`）。
# 注意：匹配前 flag 一律 `.lower()` 归一，故此处统一用小写拼写；camelCase 变体
# （如 `--allowedTools`）会被归一拦住，不会绕过。
_COMMON_ARG_DENYLIST: frozenset[str] = frozenset(
    {
        "--mcp-config",  # 能力注入只能由 Driver 经 mcp_config 收口，不许 custom_args 旁路
        "--mcp-server",
        "--add-dir",  # 突破工作目录隔离（§13 硬约束）：禁止经 custom_args 放开新目录
        "--dangerously-skip-permissions",  # 越权：绕过工具权限确认
        "--allowedtools",  # 归一后命中 --allowedTools / --allowed-tools 等变体
        "--allowed-tools",
        "--disallowedtools",
        "--disallowed-tools",
        "--permission-mode",  # 越权：改写工具权限收口
        "--system-prompt",  # persona 只能经 system_prompt 字段，不许 custom_args 覆盖
        "--append-system-prompt",
        "--resume",  # 续接只能经 resume_session_id 字段
        "--print",
        "-p",
    }
)


class _BaseDriver(Driver):
    """Driver 公共底座。子类声明 `runtime_name` 并实现 build_command / _map_raw。

    `parse_event` 在底座做统一包装；子类只实现纯映射 `_map_raw(raw) -> (type, payload) | None`。
    """

    runtime_name: str = "base"
    # 子类可追加自己 runtime 的危险 flag（如品牌特有的越权选项）。
    extra_arg_denylist: frozenset[str] = frozenset()

    def __init__(self) -> None:
        self._seq = itertools.count(1)

    # ---- custom_args 安全过滤（§7.5.4 规则 4）----

    def filter_custom_args(self, custom_args: Iterable[str]) -> list[str]:
        """剔除 denylist 命中的危险 flag（含其紧随的取值），其余原样透传。

        匹配大小写不敏感（flag 先 `.lower()` 归一，挡 camelCase 绕过）。被拦的
        boolean flag **不能无脑吞掉下一 token**：仅当下一 token 不以 `-` 开头时才视为
        它的取值并一并吞掉；否则那是另一个独立 flag，必须保留（否则反而破坏协议）。
        """
        denied = _COMMON_ARG_DENYLIST | {a.lower() for a in self.extra_arg_denylist}
        args = list(custom_args)
        out: list[str] = []
        i = 0
        while i < len(args):
            arg = args[i]
            flag = arg.split("=", 1)[0].lower()
            if flag in denied:
                # `--flag=value` 自带取值，丢 flag 即可。`--flag value`（无 =）才需看下一 token：
                # 下一 token 不以 `-` 开头 → 是取值，连带吞掉；以 `-` 开头 → 是另一个 flag，保留。
                if "=" not in arg and i + 1 < len(args) and not args[i + 1].startswith("-"):
                    i += 2
                else:
                    i += 1
                continue
            out.append(arg)
            i += 1
        return out

    # ---- 事件归一（统一包装，子类只给净荷）----

    def _wrap(self, run_id: str, type_: RuntimeEventType, payload: dict) -> AgentRuntimeEvent:
        n = next(self._seq)
        return AgentRuntimeEvent(
            event_id=f"{self.runtime_name}_{run_id}_{n}",
            run_id=run_id,
            seq=n,
            type=type_,
            source=self.runtime_name,
            timestamp=datetime.now(tz=timezone.utc),
            payload=payload,
        )

    def parse_event(self, raw: object) -> AgentRuntimeEvent | None:
        """把一条 runtime 原始事件归一为 AgentRuntimeEvent；无法映射返回 None。"""
        if not isinstance(raw, dict):
            return None
        mapped = self._map_raw(raw)
        if mapped is None:
            return None
        type_, payload = mapped
        run_id = str(raw.get("run_id") or raw.get("session_id") or "")
        return self._wrap(run_id, type_, payload)

    def _map_raw(self, raw: dict) -> tuple[RuntimeEventType, dict] | None:
        """子类实现：把原始事件映射为 (统一事件类型, 净荷)。无法映射返回 None。"""
        raise NotImplementedError


def materialize_mcp_config(mcp_config: list[McpServerConfig]) -> str | None:
    """把 mcp_config 写成 run 作用域临时文件，返回路径（§7.5.4 规则 5）。

    仅供「无协议内注入、只能吃配置文件」的 runtime（如 Claude Code `--mcp-config`）兜底用。
    **不写共享 profile**：落在系统临时目录的 run 作用域文件，调用方用后自清。空配置返回 None。
    """
    if not mcp_config:
        return None
    servers = {
        s.name: {
            k: v
            for k, v in {
                "command": s.command,
                "args": s.args,
                "env": s.env,
                "url": s.url,
            }.items()
            if v
        }
        for s in mcp_config
    }
    fd = tempfile.NamedTemporaryFile(
        mode="w", suffix=".mcp.json", prefix="aiteam_run_", delete=False, encoding="utf-8"
    )
    with fd:
        json.dump({"mcpServers": servers}, fd)
    return fd.name
