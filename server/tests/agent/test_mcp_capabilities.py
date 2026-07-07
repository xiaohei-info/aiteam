"""AITEAM-692 / M3 验收：Knowledge / Memory / Connector MCP 能力装配。

覆盖矩阵：
- 本地 capability registry 能通过 (kind, ref) 查找模板 / 找不到抛错；
- snapshot_to_mcp_config 把 knowledge/memory/connector refs 转成 RunSpec.mcp_config；
- 运行前健康检查（CLI 可用性 / env 解析 / mode=url / mode=none / mode=command）；
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
    CapabilityHealth,
    CapabilityRegistry,
    HealthStatus,
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

    def test_default_registry_constructs_and_lookups(self):
        """默认 registry 构造 + 按 (kind, ref) 查询。"""
        reg = CapabilityRegistry.default()
        assert reg.lookup(CapabilityKind.KNOWLEDGE, "default") is not None
        assert reg.lookup(CapabilityKind.MEMORY, "default") is not None
        assert reg.lookup(CapabilityKind.CONNECTOR, "slack") is not None
        assert reg.lookup(CapabilityKind.CONNECTOR, "notion") is not None
        assert reg.lookup(CapabilityKind.CONNECTOR, "github") is not None
        # 未登记的反查
        assert reg.lookup(CapabilityKind.KNOWLEDGE, "nope") is None
        # refs_for_kind 只列已启用的
        assert "default" in reg.refs_for_kind(CapabilityKind.KNOWLEDGE)
        assert "slack" in reg.refs_for_kind(CapabilityKind.CONNECTOR)

    def test_env_override_changes_command(self):
        """环境变量可覆写默认 registry 的启动命令。"""
        with mock.patch.dict(os.environ, {"AITEAM_LIGHTRAG_CMD": "custom-lr"}):
            reg = CapabilityRegistry.default()
        entry = reg.lookup(CapabilityKind.KNOWLEDGE, "default")
        assert entry.command == "custom-lr"

    def test_csv_list_and_cmd_args_helpers(self):
        from agent_service.capabilities.registry import _csv_list, _cmd_args
        assert _csv_list("") == []
        assert _csv_list("a, b ,c") == ["a", "b", "c"]
        assert _cmd_args("UNSET_VAR_XYZ") == []
    def test_csv_list_and_cmd_args_with_values(self):
        with mock.patch.dict(os.environ, {"MY_ARGS": "a ; b c"}, clear=True):
            from agent_service.capabilities.registry import _cmd_args, _csv_list
            assert _cmd_args("MY_ARGS") == ["a", "b", "c"]
            assert _csv_list("x,y") == ["x", "y"]



    def test_needs_env_returns_true_when_required(self):
        e = _kind_entry(CapabilityKind.CONNECTOR, "slack", required_env=["X"])
        assert e.needs_env() is True

    def test_needs_env_returns_false_when_empty(self):
        e = _kind_entry(CapabilityKind.CONNECTOR, "slack")
        assert e.needs_env() is False


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
        snap = _make_snapshot(connector_refs=["unknown-c"])
        reg = _registry()
        out = snapshot_to_mcp_config(snap, reg)
        assert out.ok is False
        assert "connector:unknown-c" in out.blocked
        with pytest.raises(ConnectorCapabilityError):
            assert_capability_ready(out)

    def test_knowledge_unknown_blocks(self):
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
        assert cfg.env.get("MEM0_TOKEN") == "tok-123"

    def test_missing_env_blocks_connector(self):
        """connector CLI 可达但凭据缺失 → blocked。"""
        reg = _registry({
            (CapabilityKind.CONNECTOR, "slack"): _kind_entry(
                CapabilityKind.CONNECTOR, "slack", name="slack",
                command="python", required_env=["CONNECTOR_SLACK_TOKEN"],
            ),
        })
        snap = _make_snapshot(connector_refs=["slack"])
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


    def test_healthy_connector_produces_mcp_config(self):
        """connector 健康时进入 mcp_config 并携带解析出的凭据。"""
        reg = _registry({
            (CapabilityKind.CONNECTOR, "slack"): _kind_entry(
                CapabilityKind.CONNECTOR, "slack", name="slack",
                command="python", required_env=["CONNECTOR_SLACK_TOKEN"],
            ),
        })
        snap = _make_snapshot(connector_refs=["slack"])
        with mock.patch.dict(os.environ, {"CONNECTOR_SLACK_TOKEN": "secret-tok"}):
            with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
                out = snapshot_to_mcp_config(snap, reg)
        assert out.ok is True
        slack = next(c for c in out.mcp_config if c.name == "slack")
        assert slack.env.get("CONNECTOR_SLACK_TOKEN") == "secret-tok"

    def test_same_named_capabilities_deduplicated(self):
        """多个 ref 映射同名 server 时只生成一条 McpServerConfig。"""
        reg = _registry({
            (CapabilityKind.MEMORY, "pol-a"): _kind_entry(
                CapabilityKind.MEMORY, "pol-a", name="mem0", command="python",
            ),
            (CapabilityKind.MEMORY, "pol-b"): _kind_entry(
                CapabilityKind.MEMORY, "pol-b", name="mem0", command="python",
            ),
        })
        snap = _make_snapshot()
        # 两个 refs 需要 memory_policy 同时包含两者 — 通过 extension 测试更直接
        # 此处改用直接 memory 双 refs 因 _memory_refs 只取一个；改为 knowledge 双 refs
        snap = _make_snapshot()
        reg = _registry({
            (CapabilityKind.KNOWLEDGE, "kb-1"): _kind_entry(
                CapabilityKind.KNOWLEDGE, "kb-1", name="lightrag", command="python",
            ),
            (CapabilityKind.KNOWLEDGE, "kb-2"): _kind_entry(
                CapabilityKind.KNOWLEDGE, "kb-2", name="lightrag", command="python",
            ),
        })
        snap = _make_snapshot(knowledge_refs=["kb-1", "kb-2"])
        with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
            out = snapshot_to_mcp_config(snap, reg)
        names = [c.name for c in out.mcp_config]
        assert names.count("lightrag") == 1  # 同名去重


# ---- 3. health -------------------------------------------------------------------------


class TestHealthCheck:
    def test_command_mode_ready(self):
        e = _kind_entry(CapabilityKind.CONNECTOR, "slack", command="python", required_env=["X"])
        with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
            with mock.patch.dict(os.environ, {"X": "v"}):
                h = check_capability_health(e, ref="slack")
        assert h.status == HealthStatus.READY
        assert h.cli_available is True
        assert h.env_missing == []

    def test_command_mode_cli_missing(self):
        e = _kind_entry(CapabilityKind.KNOWLEDGE, "kb", command="lightrag-mcp")
        with mock.patch("agent_service.capabilities.health.shutil.which", return_value=None):
            h = check_capability_health(e, ref="kb")
        assert h.status == HealthStatus.NOT_READY
        assert h.cli_available is False
        assert "not found" in (h.reason or "")

    def test_command_mode_env_missing(self):
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

    def test_mode_none_env_missing(self):
        e = CapabilityEntry(
            name="x", kind=CapabilityKind.MEMORY, command=None,
            required_env=["Y"], health_check=HealthCheck(mode="none"),
        )
        env_patch = {k: v for k, v in os.environ.items() if k != "Y"}
        with mock.patch.dict(os.environ, env_patch, clear=True):
            h = check_capability_health(e, ref="x")
        assert h.status == HealthStatus.NOT_READY
        assert "Y" in h.env_missing

    def test_mode_url_endpoint_present(self):
        """health_check.mode=url，endpoint env 存在 → ready。"""
        e = CapabilityEntry(
            name="x", kind=CapabilityKind.CONNECTOR, command=None,
            health_check=HealthCheck(mode="url", url_env="MY_ENDPOINT"),
        )
        with mock.patch.dict(os.environ, {"MY_ENDPOINT": "https://x"}):
            h = check_capability_health(e, ref="x")
        assert h.status == HealthStatus.READY
        assert h.cli_available is True

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

    def test_command_mode_no_command_declared(self):
        """mode=command 但 command 与 hc.command 都缺失 → not_ready。"""
        e = CapabilityEntry(
            name="x", kind=CapabilityKind.CONNECTOR, command=None,
            health_check=HealthCheck(mode="command", command=None),
        )
        h = check_capability_health(e, ref="x")
        assert h.status == HealthStatus.NOT_READY
        assert h.cli_available is False

    def test_command_mode_cli_version_best_effort(self):
        """CLI 可达时 best-effort 探测版本号。"""
        e = _kind_entry(CapabilityKind.CONNECTOR, "slack", command="python")
        with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
            with mock.patch("agent_service.capabilities.health.subprocess.run") as run_mock:
                run_mock.return_value = mock.MagicMock(stdout="Python 3.13.0", stderr="", returncode=0)
                h = check_capability_health(e, ref="slack")
        assert h.status == HealthStatus.READY
        assert h.cli_version == "Python 3.13.0"

    def test_command_mode_probe_returns_falsy(self):
        """CLI --version 输出空行 → cli_version None 仍 ready。"""
        e = _kind_entry(CapabilityKind.CONNECTOR, "slack", command="python")
        with mock.patch("agent_service.capabilities.health.shutil.which", return_value="/usr/bin/python"):
            with mock.patch("agent_service.capabilities.health.subprocess.run") as run_mock:
                run_mock.return_value = mock.MagicMock(stdout="", stderr="", returncode=0)
                h = check_capability_health(e, ref="slack")
        assert h.status == HealthStatus.READY
        assert h.cli_version is None


# ---- 4. env 解析（D18）------------------------------------------------------------------


class TestResolveEnv:
    def test_resolves_only_existing_env(self):
        e = _kind_entry(CapabilityKind.CONNECTOR, "slack", required_env=["HAS_X", "NO_Y"])
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
    import sys
    this_dir = os.path.dirname(os.path.abspath(__file__))
    mainline_dir = os.path.join(this_dir, "mainline")
    if mainline_dir not in sys.path:
        sys.path.insert(0, mainline_dir)
    from test_execution_orchestrator import FrozenGrantsClient, FakeGrantsService, _make_projection
    client = FrozenGrantsClient()
    client.snapshots["emp-1"] = snapshot
    gs = FakeGrantsService()
    gs.client.snapshots["emp-1"] = snapshot
    gs._svc._client.snapshots["emp-1"] = snapshot
    gs.projections.upsert(_make_projection("emp-1", "v1"))
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
        with mock.patch.dict(os.environ, {"LIGHTRAG_KEY": "lr-secret"}):
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
        with mock.patch.dict(os.environ, {"LIGHTRAG_KEY": "lr-secret"}):
            with mock.patch("agent_service.capabilities.health.shutil.which", return_value=None):
                orch = _build_orch(self._registry(), self._snapshot())
                with pytest.raises(KnowledgeUnavailable):
                    orch.prepare_private_run(_FakeConv("emp-1"), tenant_id="t1")

    def test_orchestrator_without_registry_skips_mcp(self):
        orch = _build_orch(None, self._snapshot())
        prepared = orch.prepare_private_run(_FakeConv("emp-1"), tenant_id="t1")
        assert prepared.mcp_derivation is None
        assert prepared.run_spec.mcp_config == []
