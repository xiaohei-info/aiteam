"""#219：Agent 端按 MANAGER_URL 装配真实跨端客户端验收。

验证：
1. 配置 MANAGER_URL 后，build_app() 自动装配三个真实客户端（login/grants/usage）
2. 未配置 MANAGER_URL 时，装配占位客户端（dev/离线降级，D14）
3. 装配逻辑与 Manager 侧 _build_operator_catalog 模式对齐
"""

import os
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_service.app import (
    _build_grants_client,
    _build_manager_login_client,
    _build_usage_client,
    build_app,
)
from agent_service.auth.manager_client import RealManagerLoginClient, UnconfiguredManagerClient
from agent_service.grants.client import ServiceClientGrantsClient, UnconfiguredGrantsClient
from agent_service.usage.client import ServiceClientUsageClient, UnconfiguredUsageClient


def test_manager_login_client_assembly_with_manager_url():
    """配置 MANAGER_URL 后，_build_manager_login_client 装配真实客户端。"""
    # 禁用环境代理避免测试时尝试连接真实网络
    env_vars = {
        "APP_TIER": "agent",
        "MANAGER_URL": "http://manager.local:8001",
        "SERVICE_TOKEN": "test-token",
        "HTTP_PROXY": "",
        "HTTPS_PROXY": "",
        "ALL_PROXY": "",
    }
    with patch.dict(os.environ, env_vars, clear=True):
        client = _build_manager_login_client()
        assert isinstance(client, RealManagerLoginClient)


def test_manager_login_client_assembly_without_manager_url():
    """未配置 MANAGER_URL 时，_build_manager_login_client 装配占位客户端。"""
    with patch.dict(os.environ, {"APP_TIER": "agent"}, clear=True):
        client = _build_manager_login_client()
        assert isinstance(client, UnconfiguredManagerClient)


def test_grants_client_assembly_with_manager_url():
    """配置 MANAGER_URL 后，_build_grants_client 装配真实客户端。"""
    env_vars = {
        "APP_TIER": "agent",
        "MANAGER_URL": "http://manager.local:8001",
        "SERVICE_TOKEN": "test-token",
        "HTTP_PROXY": "",
        "HTTPS_PROXY": "",
        "ALL_PROXY": "",
    }
    with patch.dict(os.environ, env_vars, clear=True):
        client = _build_grants_client()
        assert isinstance(client, ServiceClientGrantsClient)


def test_grants_client_assembly_without_manager_url():
    """未配置 MANAGER_URL 时，_build_grants_client 装配占位客户端。"""
    with patch.dict(os.environ, {"APP_TIER": "agent"}, clear=True):
        client = _build_grants_client()
        assert isinstance(client, UnconfiguredGrantsClient)


def test_usage_client_assembly_with_manager_url():
    """配置 MANAGER_URL 后，_build_usage_client 装配真实客户端。"""
    env_vars = {
        "APP_TIER": "agent",
        "MANAGER_URL": "http://manager.local:8001",
        "SERVICE_TOKEN": "test-token",
        "HTTP_PROXY": "",
        "HTTPS_PROXY": "",
        "ALL_PROXY": "",
    }
    with patch.dict(os.environ, env_vars, clear=True):
        client = _build_usage_client()
        assert isinstance(client, ServiceClientUsageClient)


def test_usage_client_assembly_without_manager_url():
    """未配置 MANAGER_URL 时，_build_usage_client 装配占位客户端。"""
    with patch.dict(os.environ, {"APP_TIER": "agent"}, clear=True):
        client = _build_usage_client()
        assert isinstance(client, UnconfiguredUsageClient)


def test_build_app_with_real_clients_when_manager_url_configured():
    """配置 MANAGER_URL 后，build_app() 默认装配全部真实客户端（端到端集成）。"""

    def mock_handler(request: httpx.Request) -> httpx.Response:
        # 模拟 Manager 各端点响应
        url = str(request.url)
        if "/auth/login" in url:
            return httpx.Response(200, json={"data": {"token": "test-token"}})
        if "/auth/" in url and "/jwks.json" in url:
            return httpx.Response(200, json={"keys": []})
        if "/grants/authorized-config" in url:
            return httpx.Response(200, json={"data": {"experts": [], "solutions": [], "revoked_ids": []}})
        if "/snapshots" in url:
            return httpx.Response(
                200,
                json={
                    "data": {
                        "snapshot": {
                            "employee_id": "e1",
                            "version": "v1",
                            "snapshot_version": "snap-1",
                            "display_name": "测试专家",
                        }
                    }
                },
            )
        if "/usage/upload" in url:
            return httpx.Response(204)
        return httpx.Response(404)

    env_vars = {
        "APP_TIER": "agent",
        "MANAGER_URL": "http://manager.local:8001",
        "SERVICE_TOKEN": "test-token",
        "HTTP_PROXY": "",
        "HTTPS_PROXY": "",
        "ALL_PROXY": "",
    }
    with patch.dict(os.environ, env_vars, clear=True):
        # 注意：这里不注入客户端，让 build_app() 自动装配
        with patch("shared.service_client.httpx.Client") as mock_client_cls:
            mock_transport = httpx.MockTransport(mock_handler)
            mock_client_cls.return_value = httpx.Client(transport=mock_transport)

            app = build_app()
            client = TestClient(app)

            # 验证 app 可启动
            resp = client.get("/api/agent/ping")
            assert resp.status_code == 200


def test_build_app_with_unconfigured_clients_when_no_manager_url():
    """未配置 MANAGER_URL 时，build_app() 装配占位客户端，app 仍可启动（D14 离线降级）。"""
    with patch.dict(os.environ, {"APP_TIER": "agent"}, clear=True):
        app = build_app()
        client = TestClient(app)

        # app 可启动、healthz 可用（不因 manager 未配而 not-ready）
        resp = client.get("/api/agent/ping")
        assert resp.status_code == 200


def test_explicit_client_injection_overrides_assembly():
    """显式注入客户端参数时，覆盖默认装配（测试可注入 stub）。"""

    class StubLoginClient:
        def login(self, req):
            return ("stub-token", {"keys": []})

    class StubGrantsClient:
        def pull_authorized_config(self, req):
            return type("Resp", (), {"experts": [], "solutions": [], "revoked_ids": []})()

        def pull_snapshot(self, req):
            return type(
                "Resp",
                (),
                {
                    "snapshot": {
                        "employee_id": "e1",
                        "version": "v1",
                        "snapshot_version": "snap-1",
                        "display_name": "测试专家",
                    }
                },
            )()

    class StubUsageClient:
        def upload(self, payload, *, idempotency_key):
            pass

    stub_login = StubLoginClient()
    stub_grants = StubGrantsClient()
    stub_usage = StubUsageClient()

    env_vars = {
        "APP_TIER": "agent",
        "MANAGER_URL": "http://manager.local:8001",
        "HTTP_PROXY": "",
        "HTTPS_PROXY": "",
        "ALL_PROXY": "",
    }
    with patch.dict(os.environ, env_vars, clear=True):
        # 即使配了 MANAGER_URL，显式注入优先
        app = build_app(
            manager_client=stub_login,
            grants_client=stub_grants,
            usage_client=stub_usage,
        )
        client = TestClient(app)

        resp = client.get("/api/agent/ping")
        assert resp.status_code == 200
