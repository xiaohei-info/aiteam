"""#173 验收：agent_service 按配置装配真实 runtime + loop 自启动接线。"""

import pytest

from agent_gateway.drivers.hermes import HermesAcpDriver
from agent_gateway.acp_executor import AcpClientExecutor
from agent_gateway.drivers.fake_runtime import FakeDriver
from agent_service.mainline.factory import build_mainline_service


def test_runtime_selection_wires_real_driver_and_executor(tmp_path):
    svc = build_mainline_service(runtime_selection="hermes", runs_root=str(tmp_path))
    runner = svc._runner
    assert isinstance(runner._driver, HermesAcpDriver)
    assert isinstance(runner._executor, AcpClientExecutor)
    # 沙箱已注入（隔离工作目录在 runs_root 下）。
    assert runner._executor._sandbox is not None
    assert runner._executor._sandbox.runs_root == str(tmp_path)


def test_runtime_env_passthrough_injects_credentials_into_sandbox(tmp_path, monkeypatch):
    """§13 凭据最小注入：放行的 env 变量名从宿主取值注入沙箱 extra_env；未放行的不泄漏。"""
    monkeypatch.setenv("NEWAPI_API_KEY", "secret-xyz")
    monkeypatch.setenv("UNRELATED_SECRET", "should-not-leak")
    svc = build_mainline_service(
        runtime_selection="codex", runs_root=str(tmp_path),
        runtime_env_passthrough=("NEWAPI_API_KEY", "MISSING_KEY"),
    )
    sandbox = svc._runner._executor._sandbox
    assert sandbox.extra_env == {"NEWAPI_API_KEY": "secret-xyz"}  # 缺失的不注入、无关的不泄漏


def test_default_uses_fake_runtime():
    svc = build_mainline_service()
    assert isinstance(svc._runner._driver, FakeDriver)


def test_unknown_runtime_selection_raises():
    with pytest.raises(ValueError, match="unknown runtime_selection"):
        build_mainline_service(runtime_selection="nope")


def test_explicit_executor_driver_overrides_runtime_selection():
    """显式注入优先（测试/自定义编排器路径）。"""
    svc = build_mainline_service(driver=FakeDriver())
    assert isinstance(svc._runner._driver, FakeDriver)


def test_loop_autostart_registers_startup_handler(monkeypatch):
    from agent_service.app import build_app

    monkeypatch.setenv("APP_TIER", "agent")
    monkeypatch.setenv("AGENT_LOOP_AUTOSTART", "1")
    app = build_app()
    assert len(app.router.on_startup) >= 1
    assert len(app.router.on_shutdown) >= 1


def test_no_loop_autostart_by_default(monkeypatch):
    from agent_service.app import build_app

    monkeypatch.setenv("APP_TIER", "agent")
    monkeypatch.delenv("AGENT_LOOP_AUTOSTART", raising=False)
    app = build_app()
    assert app.router.on_startup == []
