"""AITEAM-688 (M0): runtime readiness 与生产 Fake 禁用规则。

覆盖：
- 未配置 runtime：dev 允许 Fake；生产 not_ready（AGENT_RUNTIME 未配置）。
- 未知 runtime：not_ready（不在 DRIVER_REGISTRY）。
- 生产显式选 fake：not_ready（生产禁止 Fake runtime）。
- 已知 runtime：按 driver.runtime_health() 透出 CLI/capabilities。
"""

import pytest

from agent_gateway.runtime_readiness import (
    RuntimeReadiness,
    check_runtime_readiness,
)
from agent_gateway.drivers import DRIVER_REGISTRY, FakeDriver, get_driver


def test_dev_no_runtime_is_ready_with_fake():
    r = check_runtime_readiness(None, production=False)
    assert r.status == "ready"
    assert r.runtime == "fake"
    assert r.reason is None


def test_production_no_runtime_is_not_ready():
    r = check_runtime_readiness(None, production=True)
    assert r.status == "runtime_not_ready"
    assert "AGENT_RUNTIME" in (r.reason or "")


def test_production_unknown_runtime_is_not_ready():
    r = check_runtime_readiness("does-not-exist", production=True)
    assert r.status == "runtime_not_ready"
    assert "unknown" in (r.reason or "").lower()


def test_production_explicit_fake_is_not_ready():
    r = check_runtime_readiness("fake", production=True)
    assert r.status == "runtime_not_ready"
    assert "fake" in (r.reason or "").lower()


def test_dev_explicit_fake_is_ready():
    r = check_runtime_readiness("fake", production=False)
    assert r.status == "ready"
    assert r.runtime == "fake"


def test_known_runtime_reports_driver_health_and_capabilities():
    # 选一个真实 runtime（不依赖 CLI 是否安装）：health 字段结构由 driver.runtime_health() 决定。
    selection = "hermes"
    r = check_runtime_readiness(selection, production=False)
    assert r.runtime == selection
    assert r.health is not None
    assert r.health.capabilities is not None
    assert r.health.capabilities.runtime == selection


def test_known_runtime_with_missing_cli_reports_not_ready(monkeypatch):
    """已知 runtime 但 CLI 不在 PATH：readiness = runtime_not_ready（CLI 不可用）。"""
    import agent_gateway.drivers.base as base_mod

    def _no_which(_path):
        return None

    monkeypatch.setattr(base_mod.shutil, "which", _no_which)
    r = check_runtime_readiness("hermes", production=False)
    assert r.status == "runtime_not_ready"
    assert r.health is not None
    assert r.health.cli_available is False


def test_runtime_readiness_model_serializable():
    r = check_runtime_readiness("fake", production=False)
    d = r.model_dump(mode="json")
    assert d["status"] in ("ready", "runtime_not_ready")


def test_check_uses_registry_drivers():
    """readiness 覆盖注册表内每个 runtime，均能返回结构化结果（不抛异常）。"""
    for name in DRIVER_REGISTRY:
        r = check_runtime_readiness(name, production=False)
        assert isinstance(r, RuntimeReadiness)
        assert r.runtime == name


def test_fake_driver_runtime_health_always_ready():
    d = FakeDriver()
    h = d.runtime_health()
    assert h.status == "ready"
    assert h.runtime == "fake"
    assert h.capabilities is not None


def test_real_driver_runtime_health_exposes_cli_and_caps():
    d = get_driver("claude_code")
    h = d.runtime_health()
    assert h.runtime == "claude_code"
    assert h.cli_path == "claude"
    # CLI 在测试机可能存在也可能不存在，但字段必须返回布尔。
    assert isinstance(h.cli_available, bool)
    assert h.capabilities is not None
    assert h.capabilities.runtime == "claude_code"
