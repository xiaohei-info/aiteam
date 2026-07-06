"""AITEAM-692 / M3 验收：Knowledge / Memory / Connector MCP 能力装配。

覆盖矩阵：
- 本地 capability registry 能通过 (kind, ref) 查找模板 / 找不到抛错；
- snapshot_to_mcp_config 把 knowledge/memory/connector refs 转成 RunSpec.mcp_config；
- 运行前健康检查（CLI 可用性 + env 解析）；
- 失败策略：知识库不可用阻断 / memory 不可用降级继续 / connector 明确失败；
- 凭据（required_env）从宿主 env 解析后写入 mcp_config.env，不落日志/DB；
- MCPConfigDerivation.ok 反映是否可发 run。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from unittest import mock

import pytest

from agent_service.capabilities import (
    HealthCheck,
    CapabilityEntry,
    CapabilityKind,
    CapabilityRegistry,
    MCPConfigDerivation,
    assert_capability_ready,
    check_capability_health,
    resolve_env_for_entries,
    snapshot_to_mcp_config,
)
from agent_service.capabilities.exceptions import (
    CapabilityUnavailable,
    ConnectorCapabilityError,
    KnowledgeUnavailable,
)
from agent_service.capabilities.health import CapabilityHealth, HealthStatus
from shared.contracts.runspec import McpServerConfig
from shared.contracts.snapshot import EmployeeExecutionSnapshot, ModelPolicy, RuntimePolicy


# ---- helpers ---------------------------------------------------------------------------


def _make_snapshot(
    knowledge_refs: list[str] | None = None,
    connector_refs: list[str] | None = None,
    memory_policy: dict | None = None,
) -> EmployeeExecutionSnapshot:
    return EmployeeExecutionSnapshot(
        employee_id="emp-1", version="v1", snapshot_version="snap-1",
        display_name="专家", persona="p",
        model_policy=ModelPolicy(model="m", provider_ref="r", thinking_level=None),
        runtime_policy=RuntimePolicy(),
        skills=[], tools=[],
        knowledge_refs=list(knowledge_refs) if knowledge_refs else [],
        connector_refs=list(connector_refs) if connector_refs else [],
        memory_policy=memory_policy,
    )


def _registry(
    entries: dict[tuple[CapabilityKind, str], CapabilityEntry] | None = None,
) -> CapabilityRegistry:
    return CapabilityRegistry(entries=entries or {})


def _kind_entry(
    kind: CapabilityKind,
    ref: str,
    *,
    name: str | None = None,
    command: str | None = "fake-cli",
    required_env: list[str] | None = None,
    health_check: HealthCheck | None = None,
    env: dict[str, str] | None = None,
    args: list[str] | None = None,
) -> CapabilityEntry:
    return CapabilityEntry(
        name=name or ref,
        kind=kind,
        command=command,
        required_env=required_env or [],
        health_check=health_check or HealthCheck(mode="command", command=command),
        env=env or {},
        args=args or [],
    )


# ---- 1. registry -----------------------------------------------------------------------


class TestRegistry:
    def test_lookup_returns_entry(self):
        entry = _kind_entry(CapabilityKind.KNOWLEDGE, "kb-1")
        reg = _registry({(CapabilityKind.KNOWLEDGE, "kb-1"): entry})
        assert reg.lookup(CapabilityKind.KNOWLEDGE, "kb-1") is entry

    def test_lookup_missing_returns_none(self):
        reg = _registry()
        assert reg.lookup(CapabilityKind.KNOWLEDGE, "kb-x") is None

    def test_lookup_required_missing_raises(self):
        reg = _registry()
        with pytest.raises(CapabilityUnavailable):
            reg.lookup_required(CapabilityKind.KNOWLEDGE, "kb-x")

    def test_lookup_disabled_returns_none(self):
        entry = _kind_entry(CapabilityKind.CONNECTOR, "slack").model_copy(update={"enabled": False})
        reg = _registry({(CapabilityKind.CONNECTOR, "slack"): entry})
        assert reg.lookup(CapabilityKind.CONNECTOR, "slack") is None


# ---- 2. snapshot_to_mcp_config --------------------------------------------------------


class TestSnapshotToMcpConfig:
    def test_no_refs_returns_empty_and_ok(self):
        snap = _make_snapshot()
        reg = _registry()
        out = snapshot_to_mcp_config(snap, reg)
        assert isinstance(out, MCPConfigDerivation)
        assert out.mcp_config == []
        assert out.degraded == []
        assert out.blocked == []
        assert out.ok is True

    def test_memory_unavailable_degrades(self):
        # memory 不在 registry → degraded（不阻断）
        snap = _make_snapshot(memory_policy={"policy_id": "mem-x"})
        reg = _registry()
        out = snapshot_to_mcp_config(snap, reg)
        assert out.ok is True
        assert out.degraded == ["memory:mem-x"]
        assert out.mcp_config == []

    def test_connector_unknown_blocks(self):
        # connector 不在 registry → blocked（阻断）
        snap = _make_snapshot(connector_refs=["unknown-c"])
        reg = _registry()
        out = snapshot_to_mcp_config(snap, reg)
        assert out.ok is False
        assert "connector:unknown-c" in out.blocked
        with pytest.raises(ConnectorCapabilityError):
            assert_capability_ready(out)

    def test_knowledge_unknown_blocks(self):
        # knowledge 不在 registry → blocked（阻断）
        snap = _make_snapshot(knowledge_refs=["unknown-kb"])
        reg = _registry()
        out = snapshot_to_mcp_config(snap, reg)
        assert out.ok is False
        assert "knowledge:unknown-kb" in out.blocked
        with pytest.raises(KnowledgeUnavailable):
            assert_capability_ready(out)

    def test_healthy_entries_produce_mcp_config(self):
        """健康（CLI 在 PATH、env 存在）的条目进入 mcp_config。"""
        reg = _registry({
            (CapabilityKind.MEMORY, "default"): _kind_entry(
                CapabilityKind.MEMORY, "default", name="mem0",
                command="python", required_env=["MEM0_TOKEN"],
            ),
        })
        snap = _make_snapshot(memory_policy={"policy_id": "default"})

        with mock.patch.dict(os.environ, {"MEM0_TOKEN": "tok-123"}):
            with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
                out = snapshot_to_mcp_config(snap, reg)

        assert out.ok is True
        assert len(out.mcp_config) == 1
        cfg = out.mcp_config[0]
        assert isinstance(cfg, McpServerConfig)
        assert cfg.name == "mem0"
        assert cfg.command == "python"
        # 凭据解析进 env（不落盘/日志的契约由调用方遵守；本断言只验证解析行为）
        assert cfg.env.get("MEM0_TOKEN") == "tok-123"

    def test_missing_env_blocks_connector(self):
        """connector CLI 可达但凭据缺失 → blocked 并说明缺失的 env。"""
        reg = _registry({
            (CapabilityKind.CONNECTOR, "slack"): _kind_entry(
                CapabilityKind.CONNECTOR, "slack", name="slack",
                command="python", required_env=["CONNECTOR_SLACK_TOKEN"],
            ),
        })
        snap = _make_snapshot(connector_refs=["slack"])
        # 不注入 CONNECTOR_SLACK_TOKEN → missing → blocked
        env_patch = {k: v for k, v in os.environ.items() if k != "CONNECTOR_SLACK_TOKEN"}
        with mock.patch.dict(os.environ, env_patch, clear=True):
            with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
                out = snapshot_to_mcp_config(snap, reg)
        assert out.ok is False
        assert "connector:slack" in out.blocked
        missing_report = next(r for r in out.health_results if r.ref == "slack")
        assert "CONNECTOR_SLACK_TOKEN" in missing_report.env_missing

    def test_cli_unavailable_blocks(self):
        """CLI 不在 PATH → not_ready → blocked。"""
        reg = _registry({
            (CapabilityKind.KNOWLEDGE, "kb-1"): _kind_entry(
                CapabilityKind.KNOWLEDGE, "kb-1", name="lightrag",
                command="lightrag-mcp",
            ),
        })
        snap = _make_snapshot(knowledge_refs=["kb-1"])
        with mock.patch("agent_service.capabilities.health.shutil.which", return_value=None):
            out = snapshot_to_mcp_config(snap, reg)
        assert out.ok is False
        assert "knowledge:kb-1" in out.blocked

    def test_mixed_memory_degraded_knowledge_healthy(self):
        """memory 缺条目（降级）+ knowledge 健康 → 仅 degraded 有内容。"""
        reg = _registry({
            (CapabilityKind.KNOWLEDGE, "kb-1"): _kind_entry(
                CapabilityKind.KNOWLEDGE, "kb-1", name="lightrag", command="python",
            ),
        })
        snap = _make_snapshot(
            knowledge_refs=["kb-1"], memory_policy={"policy_id": "nonexistent"},
        )
        with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
            out = snapshot_to_mcp_config(snap, reg)
        assert out.ok is True
        assert "memory:nonexistent" in out.degraded
        assert len(out.mcp_config) == 1


# ---- 3. health -------------------------------------------------------------------------


class TestHealthCheck:
    def test_command_mode_ready(self):
        """CLI 可达且 env 齐全 → ready。"""
        e = _kind_entry(CapabilityKind.CONNECTOR, "slack", command="python", required_env=["X"])
        with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
            with mock.patch.dict(os.environ, {"X": "v"}):
                h = check_capability_health(e, ref="slack")
        assert h.status == HealthStatus.READY
        assert h.cli_available is True
        assert h.env_missing == []

    def test_command_mode_cli_missing(self):
        """CLI 找不到 → not_ready。"""
        e = _kind_entry(CapabilityKind.KNOWLEDGE, "kb", command="lightrag-mcp")
        with mock.patch("agent_service.capabilities.health.shutil.which", return_value=None):
            h = check_capability_health(e, ref="kb")
        assert h.status == HealthStatus.NOT_READY
        assert h.cli_available is False
        assert "not found" in (h.reason or "")

    def test_command_mode_env_missing(self):
        """CLI 可达但 env 缺失 → not_ready + env_missing。"""
        e = _kind_entry(CapabilityKind.CONNECTOR, "slack", command="python", required_env=["MISSING_X"])
        env_patch = {k: v for k, v in os.environ.items() if k != "MISSING_X"}
        with mock.patch.dict(os.environ, env_patch, clear=True):
            with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
                h = check_capability_health(e, ref="slack")
        assert h.status == HealthStatus.NOT_READY
        assert "MISSING_X" in h.env_missing

    def test_mode_none_trusts_declaration(self):
        """health_check.mode=none → 仅 env 缺失视为 not_ready。"""
        e = CapabilityEntry(
            name="x", kind=CapabilityKind.MEMORY, command=None,
            required_env=[], health_check=HealthCheck(mode="none"),
        )
        h = check_capability_health(e, ref="x")
        assert h.status == HealthStatus.READY

    def test_mode_url_endpoint_missing(self):
        """health_check.mode=url，endpoint env 缺失 → not_ready。"""
        e = CapabilityEntry(
            name="x", kind=CapabilityKind.CONNECTOR, command=None,
            health_check=HealthCheck(mode="url", url_env="MY_ENDPOINT"),
        )
        env_patch = {k: v for k, v in os.environ.items() if k != "MY_ENDPOINT"}
        with mock.patch.dict(os.environ, env_patch, clear=True):
            h = check_capability_health(e, ref="x")
        assert h.status == HealthStatus.NOT_READY
        assert h.cli_available is False


# ---- 4. env 解析（D18）------------------------------------------------------------------


class TestResolveEnv:
    def test_resolves_only_existing_env(self):
        e = _kind_entry(
            CapabilityKind.CONNECTOR, "slack", required_env=["HAS_X", "NO_Y"],
        )
        with mock.patch.dict(os.environ, {"HAS_X": "value"}, clear=True):
            out = resolve_env_for_entries([e])
        assert out == {"HAS_X": "value"}

    def test_empty_required_returns_empty(self):
        e = _kind_entry(CapabilityKind.CONNECTOR, "slack", required_env=[])
        out = resolve_env_for_entries([e])
        assert out == {}

    def test_multiple_entries_merged(self):
        a = _kind_entry(CapabilityKind.CONNECTOR, "a", required_env=["A"])
        b = _kind_entry(CapabilityKind.CONNECTOR, "b", required_env=["B"])
        with mock.patch.dict(os.environ, {"A": "1", "B": "2"}, clear=True):
            out = resolve_env_for_entries([a, b])
        assert out == {"A": "1", "B": "2"}


# ---- 5. assert_capability_ready ---------------------------------------------------------


class TestAssertCapabilityReady:
    def test_ok_derivation_does_not_raise(self):
        d = MCPConfigDerivation(mcp_config=[], blocked=[], degraded=[], health_results=[])
        assert_capability_ready(d)  # 不抛

    def test_blocks_with_knowledge_first(self):
        d = MCPConfigDerivation(
            blocked=["knowledge:kb-1", "connector:slack"], degraded=[],
            health_results=[],
        )
        with pytest.raises(KnowledgeUnavailable):
            assert_capability_ready(d)

    def test_blocks_with_connector_when_no_knowledge(self):
        d = MCPConfigDerivation(
            blocked=["connector:slack"], degraded=[], health_results=[],
        )
        with pytest.raises(ConnectorCapabilityError) as exc:
            assert_capability_ready(d)
        assert "slack" in str(exc.value)


# ---- 6. orchestrator wiring ------------------------------------------------------------


class _FakeConv:
    def __init__(self, entry_employee_id):
        self.entry_employee_id = entry_employee_id


def _build_orch(registry, snapshot):
    """Build an ExecutionOrchestrator wired with an in-memory grants service + registry."""
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "mainline"))
    from test_execution_orchestrator import FrozenGrantsClient, FakeGrantsService, _make_projection
    client = FrozenGrantsClient()
    client.snapshots["emp-1"] = snapshot
    gs = FakeGrantsService()
    gs.client.snapshots["emp-1"] = snapshot
    gs._svc._client.snapshots["emp-1"] = snapshot
    gs.projections.upsert(_make_projection("emp-1", "v1"))
    # In-memory grants service uses real grants.service; set inner client
    gs._svc._client = client
    from agent_service.mainline.execution_orchestrator import ExecutionOrchestrator
    return ExecutionOrchestrator(
        grants=gs._svc, projections=gs.projections,
        tenant_id="t1", member_id="m1",
        capability_registry=registry,
    )


class TestOrchestratorWiring:
    """M1 + M3 编排：RunSpec.mcp_config 在装配后被填充。"""

    def _registry(self):
        entries = {
            (CapabilityKind.KNOWLEDGE, "default"): CapabilityEntry(
                name="lightrag", kind=CapabilityKind.KNOWLEDGE,
                command="lightrag-mcp", required_env=["LIGHTRAG_KEY"],
                args=["--serve"],
                health_check=HealthCheck(mode="command", command="lightrag-mcp"),
            ),
            (CapabilityKind.MEMORY, "default"): CapabilityEntry(
                name="mem0", kind=CapabilityKind.MEMORY,
                command="mem0-mcp",
                health_check=HealthCheck(mode="command", command="mem0-mcp"),
            ),
        }
        return CapabilityRegistry(entries=entries)

    def _snapshot(self):
        return EmployeeExecutionSnapshot(
            employee_id="emp-1", version="v1", snapshot_version="snap-1",
            display_name="E", persona="资深后端",
            model_policy=ModelPolicy(model="m", provider_ref=None, thinking_level=None),
            runtime_policy=RuntimePolicy(),
            knowledge_refs=["default"], memory_policy={"policy_id": "default"}, connector_refs=[],
        )

    def test_orchestrator_attaches_mcp_config_to_prepared_run(self):
        import agent_service.capabilities.health as health_mod
        with mock.patch.dict(os.environ, {"LIGHTRAG_KEY": "lr-secret"}):
            health_mod._OS_ENV = dict(os.environ)
            with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/x"):
                orch = _build_orch(self._registry(), self._snapshot())
                prepared = orch.prepare_private_run(_FakeConv("emp-1"), tenant_id="t1")
        assert prepared.mcp_derivation is not None
        names = {c.name for c in prepared.run_spec.mcp_config}
        assert "lightrag" in names
        assert "mem0" in names
        lr = next(c for c in prepared.run_spec.mcp_config if c.name == "lightrag")
        assert lr.env.get("LIGHTRAG_KEY") == "lr-secret"
        assert lr.args == ["--serve"]

    def test_orchestrator_blocks_when_knowledge_unavailable(self):
        import agent_service.capabilities.health as health_mod
        with mock.patch.dict(os.environ, {"LIGHTRAG_KEY": "lr-secret"}):
            health_mod._OS_ENV = dict(os.environ)
            with mock.patch("agent_service.capabilities.health.shutil.which", return_value=None):
                orch = _build_orch(self._registry(), self._snapshot())
                with pytest.raises(KnowledgeUnavailable):
                    orch.prepare_private_run(_FakeConv("emp-1"), tenant_id="t1")

    def test_orchestrator_without_registry_skips_mcp(self):
        orch = _build_orch(None, self._snapshot())
        prepared = orch.prepare_private_run(_FakeConv("emp-1"), tenant_id="t1")
        assert prepared.mcp_derivation is None
        assert prepared.run_spec.mcp_config == []
