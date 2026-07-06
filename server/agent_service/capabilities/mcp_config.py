"""把快照中的 knowledge/memory/connector refs 转成 RunSpec.mcp_config（AITEAM-692 / M3）。

核心入口：``snapshot_to_mcp_config(snapshot, registry)`` -> ``MCPConfigDerivation``。

装配流程：
1. 按 kind 在 registry 找每个 ref 对应的 MCP server 模板；
2. 做运行前健康检查（``check_capability_health``）；
3. 按失败策略分桶：
   - knowledge 不可用 -> blocked（阻断 run）；
   - memory 不可用 -> degraded（继续，不阻断）；
   - connector 不可用 -> blocked（明确失败）；
4. 通过的条目 -> McpServerConfig（env 从宿主 env 解析，不落盘/日志，D18）；
5. 产出 MCPConfigDerivation（mcp_config + blocked + degraded + health_results）。

本函数只产出推导结果、不抛错；调用方按 ``blocked`` 决定是否阻断 run（见 ``assert_capability_ready``）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from shared.contracts.runspec import McpServerConfig
from shared.contracts.snapshot import EmployeeExecutionSnapshot

from .exceptions import ConnectorCapabilityError, KnowledgeUnavailable
from .health import (
    CapabilityHealth,
    HealthStatus,
    check_capability_health,
    resolve_env_for_entries,
)
from .registry import CapabilityEntry, CapabilityKind, CapabilityRegistry


@dataclass
class MCPConfigDerivation:
    """snapshot_to_mcp_config 的产出。"""

    mcp_config: list[McpServerConfig] = field(default_factory=list)
    degraded: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    health_results: list[CapabilityHealth] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """是否无阻断（可安全发起 run）。"""
        return not self.blocked


def snapshot_to_mcp_config(
    snapshot: EmployeeExecutionSnapshot,
    registry: CapabilityRegistry,
) -> MCPConfigDerivation:
    """把快照的 knowledge/memory/connector refs -> 中立 mcp_config。

    失败策略（issue 设计）：
    - 知识库不可用 -> blocked（阻断 run）；
    - memory 不可用 -> degraded（run 仍可发起）；
    - connector 不可用（缺条目 / CLI 不可达 / 凭据缺失）-> blocked（明确失败）。

    本函数只收集结果不抛错；调用方通过 ``assert_capability_ready`` 把 blocked 转异常。
    """
    derivation = MCPConfigDerivation()

    entries_to_resolve: list[tuple[CapabilityEntry, str]] = []

    for ref in snapshot.knowledge_refs or []:
        entry = registry.lookup(CapabilityKind.KNOWLEDGE, ref)
        if entry is None:
            derivation.blocked.append(f"knowledge:{ref}")
            derivation.health_results.append(
                _not_ready_health(ref, ref, "no registry entry")
            )
            continue
        health = check_capability_health(entry, ref=ref)
        derivation.health_results.append(health)
        if health.status == HealthStatus.READY:
            entries_to_resolve.append((entry, ref))
        else:
            derivation.blocked.append(f"knowledge:{ref}")

    for ref in _memory_refs(snapshot.memory_policy):
        entry = registry.lookup(CapabilityKind.MEMORY, ref)
        if entry is None:
            derivation.degraded.append(f"memory:{ref}")
            continue
        health = check_capability_health(entry, ref=ref)
        derivation.health_results.append(health)
        if health.status == HealthStatus.READY:
            entries_to_resolve.append((entry, ref))
        else:
            derivation.degraded.append(f"memory:{ref}")

    for ref in snapshot.connector_refs or []:
        entry = registry.lookup(CapabilityKind.CONNECTOR, ref)
        if entry is None:
            derivation.blocked.append(f"connector:{ref}")
            derivation.health_results.append(
                _not_ready_health(ref, ref, "no registry entry")
            )
            continue
        health = check_capability_health(entry, ref=ref)
        derivation.health_results.append(health)
        if health.status == HealthStatus.READY:
            entries_to_resolve.append((entry, ref))
        else:
            derivation.blocked.append(f"connector:{ref}")

    # env 解析（D18：仅从宿主 env 取值，不落盘/日志）
    entries_only = [e for e, _ in entries_to_resolve]
    resolved = resolve_env_for_entries(entries_only)

    # 构造 McpServerConfig（env 合并静态模板 + 解析凭据；同名 server 去重）
    seen_names: set[str] = set()
    for entry, _ in entries_to_resolve:
        if entry.name in seen_names:
            continue
        seen_names.add(entry.name)
        env: dict[str, str] = dict(entry.env)
        for name in entry.required_env:
            if name in resolved:
                env[name] = resolved[name]
        derivation.mcp_config.append(
            McpServerConfig(
                name=entry.name,
                command=entry.command,
                args=list(entry.args),
                env=env,
                url=entry.url,
            )
        )

    return derivation


def assert_capability_ready(derivation: MCPConfigDerivation) -> None:
    """把 blocked 转异常，让 orchestrator 决定阻断 run。

    优先级：knowledge 不可用先报；其次 connector。
    """
    if derivation.ok:
        return
    knowledge_blocked = [r for r in derivation.blocked if r.startswith("knowledge:")]
    connector_blocked = [r for r in derivation.blocked if r.startswith("connector:")]
    if knowledge_blocked:
        raise KnowledgeUnavailable(
            f"knowledge capability unavailable (will block run): {knowledge_blocked}"
        )
    if connector_blocked:
        raise ConnectorCapabilityError(
            connector_id=", ".join(connector_blocked),
            reason=f"connector capability unavailable (will block run): {connector_blocked}",
        )


def _not_ready_health(name: str, ref: str, reason: str) -> CapabilityHealth:
    return CapabilityHealth(
        name=name, kind=CapabilityKind.KNOWLEDGE, ref=ref,
        status=HealthStatus.NOT_READY, reason=reason,
    )


def _memory_refs(memory_policy: dict | None | str) -> list[str]:
    """从 memory_policy 提取 ref 列表。

    memory_policy 可能是 dict（含 policy_id / provider 等）、字符串或空；
    当 dict 缺可识别 id 时回退 "default" 模板。
    """
    if not memory_policy:
        return []
    if isinstance(memory_policy, str):
        return [memory_policy] if memory_policy.strip() else []
    policy_id = (
        memory_policy.get("policy_id")
        or memory_policy.get("provider")
        or memory_policy.get("id")
    )
    return [str(policy_id)] if policy_id else ["default"]
