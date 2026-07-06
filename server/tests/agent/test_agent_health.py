"""AITEAM-688 (M0)：/api/agent/health 暴露 runtime readiness + 生产 fail-fast。"""

import os

import pytest
from fastapi.testclient import TestClient

from agent_service.app import build_app


@pytest.fixture
def agent_env(monkeypatch):
    """把 env 设进 monkeypatch（pytest 自动还原），build_app 与请求期读到同一值。"""
    monkeypatch.setenv("APP_TIER", "agent")
    # 默认清掉 runtime/env，单个测试再覆盖。
    monkeypatch.delenv("AGENT_RUNTIME", raising=False)
    monkeypatch.delenv("AITEAM_ENV", raising=False)
    return monkeypatch


def test_agent_health_returns_runtime_readiness_dev(agent_env):
    """dev（无 AGENT_RUNTIME）：/api/agent/health 返回 ready + runtime=fake + capabilities。"""
    app = build_app()
    c = TestClient(app)
    r = c.get("/api/agent/health")
    assert r.status_code == 200
    body = r.json()["data"]
    assert body["status"] == "ready"
    assert body["runtime"] == "fake"
    assert body["health"] is not None
    assert body["health"]["capabilities"] is not None


def test_production_missing_runtime_fails_fast(agent_env):
    """生产未配 AGENT_RUNTIME：build_app 启动 fail-fast（不静默 Fake）。"""
    agent_env.setenv("AITEAM_ENV", "production")
    with pytest.raises(ValueError, match="AGENT_RUNTIME"):
        build_app()


def test_production_explicit_fake_fails_fast(agent_env):
    """生产显式选 fake runtime：build_app 启动 fail-fast。"""
    agent_env.setenv("AITEAM_ENV", "production")
    agent_env.setenv("AGENT_RUNTIME", "fake")
    with pytest.raises(ValueError, match="[Ff]ake"):
        build_app()


def test_agent_health_includes_capabilities_for_known_runtime(agent_env, monkeypatch):
    """配了真实 runtime（CLI 探测放行）→ health 透出 capabilities + cli_available。"""
    import agent_gateway.drivers.base as base_mod
    monkeypatch.setattr(base_mod.shutil, "which", lambda _p: "/usr/local/bin/codex")
    agent_env.setenv("AGENT_RUNTIME", "codex")
    app = build_app()
    c = TestClient(app)
    r = c.get("/api/agent/health")
    body = r.json()["data"]
    assert body["runtime"] == "codex"
    assert body["health"]["capabilities"]["runtime"] == "codex"
    assert body["health"]["cli_available"] is True


def test_agent_health_known_runtime_cli_missing(agent_env, monkeypatch):
    """已知 runtime 但 CLI 缺失 → health runtime_not_ready（CLI 不可用）。"""
    import agent_gateway.drivers.base as base_mod
    monkeypatch.setattr(base_mod.shutil, "which", lambda _p: None)
    agent_env.setenv("AGENT_RUNTIME", "hermes")
    app = build_app()
    c = TestClient(app)
    r = c.get("/api/agent/health")
    body = r.json()["data"]
    assert body["status"] == "runtime_not_ready"
    assert body["health"]["cli_available"] is False


def test_agent_health_production_valid_runtime_ready(agent_env, monkeypatch):
    """生产配真实 runtime 且 CLI 可用 → health ready。"""
    import agent_gateway.drivers.base as base_mod
    monkeypatch.setattr(base_mod.shutil, "which", lambda _p: "/usr/local/bin/codex")
    agent_env.setenv("AITEAM_ENV", "production")
    agent_env.setenv("AGENT_RUNTIME", "codex")
    app = build_app()
    c = TestClient(app)
    r = c.get("/api/agent/health")
    body = r.json()["data"]
    assert body["status"] == "ready"
    assert body["runtime"] == "codex"
