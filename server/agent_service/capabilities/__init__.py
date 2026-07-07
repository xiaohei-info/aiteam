"""Agent 端本地能力装配（M2 技能缓存 + M3 MCP capability）。

M2：本地能力持久缓存 + per-run 投影。
   - 技能真相在 Manager（capability_catalog）；本包只做 SkillCache + SkillProjector；
   - 缓存只复制授权专家引用的技能包；撤销授权后由 GrantsService.sync 清理；
   - 投影只写 workDir，绝不写 runtime 共享 profile（D16）。

M3：装配快照中的 knowledge_refs / memory_policy / connector_refs -> 中立 ``RunSpec.mcp_config``
（06 §7.5.2 A 类能力统一经 mcp_config 注入）。
铁律：
- 本模块只做「snapshot -> McpServerConfig」装配 + 运行前健康检查 + 失败策略；
  不发起连接器对外调用 / 知识库真实检索（红线，执行归 Driver + MCP server）。
- connector/provider secret 通过 env 注入（AGENT_RUNTIME_ENV_PASSTHROUGH），
  **不明文落盘、不落日志、不落 DB**（D18）。
- 知识库不可用阻断提示；memory 不可用可降级继续；connector 按能力类型明确失败。
"""

from .exceptions import (
    CapabilityError,
    CapabilityUnavailable,
    ConnectorCapabilityError,
    KnowledgeUnavailable,
)
from .health import (
    CapabilityHealth,
    HealthStatus,
    check_capability_health,
    resolve_env_for_entries,
)
from .mcp_config import (
    MCPConfigDerivation,
    assert_capability_ready,
    snapshot_to_mcp_config,
)
from .registry import CapabilityEntry, CapabilityKind, CapabilityRegistry, HealthCheck

__all__ = [
    # registry
    "CapabilityRegistry",
    "CapabilityEntry",
    "CapabilityKind",
    "HealthCheck",
    # mcp_config
    "snapshot_to_mcp_config",
    "MCPConfigDerivation",
    "assert_capability_ready",
    # health
    "CapabilityHealth",
    "HealthStatus",
    "check_capability_health",
    "resolve_env_for_entries",
    # exceptions
    "CapabilityError",
    "CapabilityUnavailable",
    "KnowledgeUnavailable",
    "ConnectorCapabilityError",
]
