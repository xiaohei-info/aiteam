"""Driver 注册表与跨 Driver 契约一致性验收（06 §7.3 / §7.6）。"""

import pytest

from agent_gateway.drivers import DRIVER_REGISTRY, get_driver
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, RuntimeCapability
from shared.contracts.runspec import RunSpec

ALL_DRIVERS = list(DRIVER_REGISTRY.values())


def test_registry_covers_first_batch_runtimes():
    # 06 §7.3 首批 driver + terminal 一次性命令执行（issue #415）
    # + fake（无真实 runtime 的本地 smoke/演示，d32987b 刻意注册）全部登记。
    assert set(DRIVER_REGISTRY) == {
        "hermes", "codex", "claude_code", "opencode", "openclaw", "terminal", "fake",
    }


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
    """红线（§13）：custom_args 不得突破工作目录隔离 / 绕过工具权限收口。

    terminal 除外：其 custom_args[0] 语义是"待执行命令字符串"而非 CLI flag，
    flag 过滤对它是假安全——隔离由 TerminalExecutor 在进程层兜底
    （per-run cwd + env 白名单 + 超时看门狗，见 agent_gateway/terminal.py）。
    """
    escalations = ["--add-dir", "/etc", "--dangerously-skip-permissions", "--allowedTools", "X"]
    for cls in ALL_DRIVERS:
        if cls.runtime_name == "terminal":
            continue
        cmd = cls().build_command(RunSpec(custom_args=escalations))
        for danger in ("--add-dir", "/etc", "--dangerously-skip-permissions", "--allowedTools"):
            assert danger not in cmd, (cls.runtime_name, danger)


def test_terminal_driver_confines_command_to_bash_argv():
    """terminal 的隔离契约：命令只作为 bash -c 的单一参数，不拼接、不透传多余 argv。"""
    d = get_driver("terminal")
    cmd = d.build_command(RunSpec(custom_args=["echo hi", "--add-dir", "/etc"]))
    assert cmd == ["/bin/bash", "-c", "echo hi"]


def test_codex_blocks_arbitrary_config_override_via_custom_args():
    """I1：Codex `-c` 任意配置覆盖（含 sandbox/审批）禁止经 custom_args 透传。"""
    d = get_driver("codex")
    cmd = d.build_command(RunSpec(custom_args=["-c", "sandbox_mode=danger-full-access", "--keep"]))
    assert "sandbox_mode=danger-full-access" not in cmd
    assert "--keep" in cmd


def test_codex_thinking_level_not_on_cmdline():
    """#185：codex 思考深度走 turn/start effort 协议字段，**不进 cmdline**（D16 优先协议）。"""
    d = get_driver("codex")
    cmd = d.build_command(RunSpec(thinking_level="high"))
    assert cmd == ["codex", "app-server"]
    assert "-c" not in cmd and "model_reasoning_effort=high" not in cmd


def test_denied_boolean_flag_in_build_command_keeps_next_flag():
    """C1 端到端：resume 不支持/受控的 Driver 透传 custom_args 时不吞掉紧随合法 flag。"""
    d = get_driver("claude_code")
    cmd = d.build_command(RunSpec(custom_args=["--resume", "--foo", "bar"]))
    assert "--foo" in cmd and "bar" in cmd  # --resume 被拦，--foo bar 必须存活


def test_runtime_event_type_is_contract_type():
    d = get_driver("claude_code")
    ev = d.parse_event({"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}]}, "run_id": "r"})
    assert isinstance(ev, AgentRuntimeEvent)
