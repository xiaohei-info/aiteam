"""Agent 端本地 capability registry（AITEAM-692 / M3）。

把「知识库 / 记忆策略 / 连接器」三类能力的中立引用（refs）映射为本地 MCP server 配置
（name / command / args / url / required_env / health_check 口径）。
装配结果写入 ``RunSpec.mcp_config``（06 §7.5.2 A 类能力统一注入通道）。

registry 是 Agent 本地真相：它描述「本 agent 可用的 MCP server 模板」，不持有运行时凭据本体，
凭据名（required_env）由 ``resolve_env_for_entries()`` 在 run 准备阶段从宿主 env 解析，
用完即弃、不落盘/不落日志（D18）。
"""

from __future__ import annotations

import os
from enum import Enum
from typing import Mapping

from pydantic import BaseModel, ConfigDict, Field


class CapabilityKind(str, Enum):
    """能力种类。决定失败策略：knowledge 阻断 / memory 降级 / connector 明确失败。"""

    KNOWLEDGE = "knowledge"
    MEMORY = "memory"
    CONNECTOR = "connector"


class HealthCheck(BaseModel):
    """MCP server 健康检查描述（运行前探测用）。

    mode=command：尝试通过 CLI 探测（``shutil.which`` 或 ``<command> --version``），
    仅验证本地可启动；不做真实 RPC/MCP handshake（真实连通性由 MCP server 自身保证）。
    mode=url：预留（连接型 MCP 的 endpoint 探测），当前仅做 env 存在性校验。
    mode=none：跳过探测（信任声明）。
    """

    model_config = ConfigDict(extra="forbid")

    mode: str = Field(default="command", description="command | url | none")
    command: str | None = Field(default=None, description="mode=command 时探测用的可执行体")
    url_env: str | None = Field(default=None, description="mode=url 时端点所在 env var 名")
    args: list[str] = Field(default_factory=list, description="探测命令参数（如 ['--version']）")


class CapabilityEntry(BaseModel):
    """registry 中一个能力条目（MCP server 模板，不含凭据本体）。"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="MCP server 名（写入 mcp_config.name，runtime 侧复用）")
    kind: CapabilityKind = Field(description="knowledge | memory | connector")
    display_name: str = Field(default="", description="展示名 / 诊断信息用")
    command: str | None = Field(default=None, description="本地启动命令；连接型可空")
    args: list[str] = Field(default_factory=list, description="启动命令参数")
    env: dict[str, str] = Field(
        default_factory=dict,
        description="静态 env（探测/运行所需常量）；凭据名不在此处落地——走 required_env",
    )
    required_env: list[str] = Field(
        default_factory=list,
        description="运行所需 env var 名（从宿主 os.environ 解析，不落盘/日志 D18）",
    )
    url: str | None = Field(default=None, description="连接型 MCP 的 endpoint（可选）")
    health_check: HealthCheck = Field(default_factory=HealthCheck)
    enabled: bool = Field(default=True, description="开关：禁用则跳过该能力")

    def needs_env(self) -> bool:
        """是否有需要从宿主 env 解析的凭据名。"""
        return bool(self.required_env)


class CapabilityRegistry:
    """Agent 本地能力 registry：按 (kind, ref) 查找 MCP server 模板。

    默认 registry 中每个 (kind, ref) 一个条目——knowledge 按 knowledge_space_id、memory 按
    policy_id、connector 按 connector_id 索引。模板级复用（多个 ref 共用同一 MCP server 命令）
    由调用方自行注册多个 (kind, ref) 指向同名模板即可。

    使用方式::

        reg = CapabilityRegistry.default()
        entry = reg.lookup(CapabilityKind.KNOWLEDGE, "kb-frontend")
    """

    def __init__(self, entries: Mapping[tuple[CapabilityKind, str], CapabilityEntry]) -> None:
        self._entries: dict[tuple[CapabilityKind, str], CapabilityEntry] = dict(entries)

    # ---- 查询 ----

    def lookup(self, kind: CapabilityKind, ref: str) -> CapabilityEntry | None:
        """按 (kind, ref) 查条目；找不到或 disabled 返回 None。"""
        entry = self._entries.get((kind, ref))
        if entry is None:
            return None
        return entry if entry.enabled else None

    def lookup_required(self, kind: CapabilityKind, ref: str) -> CapabilityEntry:
        """按 (kind, ref) 查条目；找不到抛 CapabilityUnavailable。"""
        entry = self.lookup(kind, ref)
        if entry is None:
            raise CapabilityUnavailable(f"no capability registered for {kind.value}:{ref!r}")
        return entry

    def all_entries(self) -> list[CapabilityEntry]:
        """列出所有启用的条目（供诊断/自检接口）。"""
        return [e for e in self._entries.values() if e.enabled]

    def refs_for_kind(self, kind: CapabilityKind) -> list[str]:
        """列出本 registry 中已登记、已启用的某 kind 的 ref 列表。"""
        return [k[1] for k, e in self._items() if k[0] == kind]

    def _items(self) -> list[tuple[tuple[CapabilityKind, str], CapabilityEntry]]:
        return [(k, v) for k, v in self._entries.items() if v.enabled]

    # ---- 默认 registry ----
    # 默认模板：覆盖常见本地 MCP server（LightRAG/mem0/典型 connector）。
    # 生产可经环境变量覆写命令/args/所需 env；服务端下发扩展留作 follow-up。

    @classmethod
    def default(cls) -> "CapabilityRegistry":
        """构造默认 registry。含 knowledge(LightRAG) / memory(mem0) / 常见 connector 模板。"""
        entries: dict[tuple[CapabilityKind, str], CapabilityEntry] = {}

        # knowledge：LightRAG。每个 knowledge_space_id 一条目。
        for kid in ("default",):
            entries[(CapabilityKind.KNOWLEDGE, kid)] = CapabilityEntry(
                name="lightrag",
                kind=CapabilityKind.KNOWLEDGE,
                display_name="LightRAG 本地知识检索",
                command=os.getenv("AITEAM_LIGHTRAG_CMD", "lightrag-mcp"),
                args=_cmd_args("AITEAM_LIGHTRAG_ARGS"),
                env={"LIGHTRAG_WORKSPACE_DIR": os.getenv("AITEAM_LIGHTRAG_DIR", "~/.aiteam/lightrag")},
                required_env=_csv_list(os.getenv("AITEAM_LIGHTRAG_REQUIRED_ENV", "")),
                health_check=HealthCheck(mode="command", command=os.getenv("AITEAM_LIGHTRAG_CMD", "lightrag-mcp")),
            )

        # memory：mem0 / OpenMemory。每个 policy_id 一条目。
        for mid in ("default",):
            entries[(CapabilityKind.MEMORY, mid)] = CapabilityEntry(
                name="mem0",
                kind=CapabilityKind.MEMORY,
                display_name="mem0 / OpenMemory 本地记忆",
                command=os.getenv("AITEAM_MEM0_CMD", "mem0-mcp"),
                args=_cmd_args("AITEAM_MEM0_ARGS"),
                env={"MEM0_DIR": os.getenv("AITEAM_MEM0_DIR", "~/.aiteam/mem0")},
                required_env=_csv_list(os.getenv("AITEAM_MEM0_REQUIRED_ENV", "")),
                health_check=HealthCheck(mode="command", command=os.getenv("AITEAM_MEM0_CMD", "mem0-mcp")),
            )

        # connector：按 connector_id 静态登记预设；凭据走 CONNECTOR_<ID>_TOKEN（D18）。
        for cid, cmd in (("slack", "slack-mcp"), ("notion", "notion-mcp"), ("github", "github-mcp")):
            entries[(CapabilityKind.CONNECTOR, cid)] = CapabilityEntry(
                name=cid,
                kind=CapabilityKind.CONNECTOR,
                display_name=f"{cid} connector",
                command=cmd,
                required_env=[f"CONNECTOR_{cid.upper()}_TOKEN"],
                health_check=HealthCheck(mode="command", command=cmd),
            )

        return cls(entries=entries)


def _cmd_args(env_var: str) -> list[str]:
    """从环境变量解析命令行参数（分号/空白分隔），用于可配置的 MCP 启动参数。"""
    raw = os.getenv(env_var, "").strip()
    if not raw:
        return []
    return [a for a in raw.replace(";", " ").split() if a]


def _csv_list(raw: str) -> list[str]:
    """逗号分隔 → 去空字符串列表。"""
    if not raw:
        return []
    return [x.strip() for x in raw.split(",") if x.strip()]


from .exceptions import CapabilityUnavailable  # noqa: E402,F811
