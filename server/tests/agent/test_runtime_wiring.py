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


# ── AITEAM-688 M0：生产 Fake 禁用 + 缺 runtime fail-fast ──────────────────────

def test_production_no_runtime_raises(tmp_path):
    """生产模式未配置 AGENT_RUNTIME → build_mainline_service fail-fast（禁止静默 Fake）。"""
    import pytest
    with pytest.raises(ValueError, match="AGENT_RUNTIME"):
        build_mainline_service(production=True, runs_root=str(tmp_path))


def test_production_explicit_fake_raises(tmp_path):
    """生产模式显式选 fake runtime → fail-fast。"""
    import pytest
    with pytest.raises(ValueError, match="[Ff]ake"):
        build_mainline_service(runtime_selection="fake", production=True, runs_root=str(tmp_path))


def test_production_unknown_runtime_raises(tmp_path):
    """生产模式未知 runtime → fail-fast（get_driver 已报错，生产模式下同样拒绝）。"""
    import pytest
    with pytest.raises(ValueError):
        build_mainline_service(runtime_selection="nope", production=True, runs_root=str(tmp_path))


def test_production_real_runtime_builds_runner(tmp_path, monkeypatch):
    """生产模式配真实 runtime（CLI 探测允许通过）→ 正常装配真实 runner，不回退 Fake。"""
    import agent_gateway.drivers.base as base_mod
    monkeypatch.setattr(base_mod.shutil, "which", lambda _p: "/usr/local/bin/hermes")
    svc = build_mainline_service(runtime_selection="hermes", production=True, runs_root=str(tmp_path))
    from agent_gateway.drivers.hermes import HermesAcpDriver
    assert isinstance(svc._runner._driver, HermesAcpDriver)


def test_production_real_runtime_cli_missing_raises(tmp_path, monkeypatch):
    """生产模式配真实 runtime 但 CLI 不在 PATH → fail-fast（启动期 CLI 校验）。"""
    import pytest
    import agent_gateway.drivers.base as base_mod
    monkeypatch.setattr(base_mod.shutil, "which", lambda _p: None)
    with pytest.raises(ValueError, match="CLI|not found|runtime_not_ready"):
        build_mainline_service(runtime_selection="hermes", production=True, runs_root=str(tmp_path))


def test_dev_no_runtime_still_fake_by_default():
    """dev/test 未配 runtime 仍回退 Fake（行为不变，验收矩阵：dev 允许 Fake）。"""
    svc = build_mainline_service()
    assert isinstance(svc._runner._driver, FakeDriver)
