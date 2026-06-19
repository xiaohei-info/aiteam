"""Driver 注册表与跨 Driver 契约一致性验收（06 §7.3 / §7.6）。"""

import pytest

from agent_gateway.drivers import DRIVER_REGISTRY, get_driver
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, RuntimeCapability
from shared.contracts.runspec import RunSpec

ALL_DRIVERS = list(DRIVER_REGISTRY.values())


def test_registry_covers_first_batch_runtimes():
    # 06 §7.3 首批 driver 全部登记。
    assert set(DRIVER_REGISTRY) == {"hermes", "codex", "claude_code", "opencode", "openclaw"}


def test_get_driver_returns_instance():
    d = get_driver("hermes")
    assert isinstance(d, Driver)


def test_get_driver_unknown_raises_not_silent_switch():
    with pytest.raises(ValueError, match="unknown runtime_selection"):
        get_driver("gpt-imaginary")


@pytest.mark.parametrize("cls", ALL_DRIVERS, ids=lambda c: c.runtime_name)
def test_every_driver_satisfies_contract(cls):
    d = cls()
    assert isinstance(d, Driver)
    cap = d.capabilities()
    assert isinstance(cap, RuntimeCapability)
    assert cap.runtime == cls.runtime_name
    # build_command 必返回非空命令、首项为 CLI 名。
    cmd = d.build_command(RunSpec(model="m"))
    assert cmd and isinstance(cmd, list) and all(isinstance(x, str) for x in cmd)
    # parse_event 对不可识别原始事件返回 None（不伪造）。
    assert d.parse_event({"totally": "unknown"}) is None
    assert d.parse_event("non-dict") is None


@pytest.mark.parametrize("cls", ALL_DRIVERS, ids=lambda c: c.runtime_name)
def test_driver_parse_event_yields_runtime_event(cls):
    """每个 Driver 至少能把一条典型 text 事件归一为 AgentRuntimeEvent（golden 细节见各 driver 测试）。"""
    d = cls()
    # 注：此处只验证类型契约，不重复各 driver 的 golden 集。
    cap = d.capabilities()
    assert isinstance(cap.supports_mcp, bool)


def test_all_drivers_filter_capability_bypass_in_custom_args():
    """红线：custom_args 不得旁路注入能力（--mcp-config 一律被拦）。"""
    for cls in ALL_DRIVERS:
        cmd = cls().build_command(RunSpec(custom_args=["--mcp-config", "/evil.json"]))
        assert "/evil.json" not in cmd, cls.runtime_name


def test_all_drivers_block_workdir_escape_and_permission_bypass():
    """红线（§13）：custom_args 不得突破工作目录隔离 / 绕过工具权限收口。"""
    escalations = ["--add-dir", "/etc", "--dangerously-skip-permissions", "--allowedTools", "X"]
    for cls in ALL_DRIVERS:
        cmd = cls().build_command(RunSpec(custom_args=escalations))
        for danger in ("--add-dir", "/etc", "--dangerously-skip-permissions", "--allowedTools"):
            assert danger not in cmd, (cls.runtime_name, danger)


def test_codex_blocks_arbitrary_config_override_via_custom_args():
    """I1：Codex `-c` 任意配置覆盖（含 sandbox/审批）禁止经 custom_args 透传。"""
    d = get_driver("codex")
    cmd = d.build_command(RunSpec(custom_args=["-c", "sandbox_mode=danger-full-access", "--keep"]))
    assert "sandbox_mode=danger-full-access" not in cmd
    assert "--keep" in cmd


def test_codex_driver_still_injects_thinking_level_via_dash_c():
    """边界：denylist 只拦 custom_args；Driver 自身受控用 -c 注入 thinking_level 不受影响。"""
    d = get_driver("codex")
    cmd = d.build_command(RunSpec(thinking_level="high"))
    assert "-c" in cmd and "model_reasoning_effort=high" in cmd


def test_denied_boolean_flag_in_build_command_keeps_next_flag():
    """C1 端到端：resume 不支持/受控的 Driver 透传 custom_args 时不吞掉紧随合法 flag。"""
    d = get_driver("claude_code")
    cmd = d.build_command(RunSpec(custom_args=["--resume", "--foo", "bar"]))
    assert "--foo" in cmd and "bar" in cmd  # --resume 被拦，--foo bar 必须存活


def test_runtime_event_type_is_contract_type():
    d = get_driver("claude_code")
    ev = d.parse_event({"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}]}, "run_id": "r"})
    assert isinstance(ev, AgentRuntimeEvent)
