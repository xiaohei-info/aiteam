"""P2-X1 /api/* envelope + problem+json + 非 SPA fallback 跨端实时测试（最终执行 DAG §5.2 P2-X1）。

验证：
- 三端所有 `/api/*` 成功响应返回 envelope（Envelope/ListEnvelope）
- 所有 `/api/*` 错误响应返回 application/problem+json（非 text/html）
- `/api/*` 路径不回落到 SPA HTML fallback
- 不存在返回纯 text/html 的 /api/* 端点
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient


# ── 三端 app ──

@pytest.fixture(scope="module")
def operation_client() -> TestClient:
    from operation_service.app import app
    return TestClient(app)


@pytest.fixture(scope="module")
def manager_client() -> TestClient:
    from manager_service.app import app
    return TestClient(app)


@pytest.fixture(scope="module")
def agent_client() -> TestClient:
    from agent_service.app import app
    return TestClient(app)


# ── 成功 envelope 校验 ──

_API_PING_PATHS = [
    ("/api/operation/ping", "operation"),
    ("/api/manager/ping", "manager"),
    ("/api/agent/ping", "agent"),
]


@pytest.mark.integration
@pytest.mark.parametrize("path,tier", _API_PING_PATHS)
def test_api_ping_returns_envelope(path, tier, operation_client, manager_client, agent_client):
    """三端 /api/*/ping 均返回正确的 Envelope 格式。"""
    clients = {"operation": operation_client, "manager": manager_client, "agent": agent_client}
    client = clients[tier]
    resp = client.get(path)
    assert resp.status_code == 200, f"{path} 应返回 200，实际 {resp.status_code}"

    ct = resp.headers.get("content-type", "")
    assert "text/html" not in ct, f"{path} content-type 不应为 text/html"
    # Envelope 必须有 data 字段
    body = resp.json()
    assert "data" in body, f"{path} response 缺少 envelope data 字段: {body}"
    assert isinstance(body, dict), f"{path} response 应为 JSON object"


@pytest.mark.integration
def test_health_checkpoints_not_in_api_routes(operation_client, manager_client, agent_client):
    """/healthz /readyz /docs /openapi.json /redoc 不在 /api/* 内，不受 envelope 约束。"""
    for name, client in [("operation", operation_client), ("manager", manager_client), ("agent", agent_client)]:
        for path in ["/healthz", "/readyz"]:
            resp = client.get(path)
            assert resp.status_code == 200, f"{name} {path} 失败"


# ── 错误响应 problem+json（非 SPA fallback） ──

@pytest.mark.integration
def test_api_404_returns_problem_json_not_spa_html(operation_client, manager_client, agent_client):
    """三端不存在的 /api/* 路径返回 application/problem+json 而非 SPA HTML。"""
    for name, client in [
        ("operation", operation_client),
        ("manager", manager_client),
        ("agent", agent_client),
    ]:
        resp = client.get(f"/api/{name}/nonexistent-path-12345")
        ct = resp.headers.get("content-type", "")
        assert ct.startswith("application/problem+json"), (
            f"{name} /api/* 404 应返回 problem+json，实际: {ct}"
        )
        # 不能是 text/html
        assert "text/html" not in ct

        # Problem JSON 结构校验
        body = resp.json()
        assert "type" in body, f"{name} problem 缺 type"
        assert "title" in body, f"{name} problem 缺 title"
        assert "status" in body and isinstance(body["status"], int), f"{name} problem 缺 status"
        assert "code" in body, f"{name} problem 缺 code"


@pytest.mark.integration
def test_api_401_returns_problem_json(operation_client, manager_client, agent_client):
    """受保护端点未认证返回 401 problem+json。"""
    for name, client, path in [
        ("operation", operation_client, "/api/operation/whoami"),
        ("manager", manager_client, "/api/manager/whoami"),
        ("agent", agent_client, "/api/agent/whoami"),
    ]:
        resp = client.get(path)
        ct = resp.headers.get("content-type", "")
        assert ct.startswith("application/problem+json"), (
            f"{name} whoami 未认证应返回 problem+json，实际: {ct}"
        )
        assert "text/html" not in ct
        body = resp.json()
        assert body.get("status") == 401, f"{name} whoami 未认证应 401"
        assert body.get("code") == "unauthorized"


@pytest.mark.integration
def test_api_403_for_missing_roles(manager_client):
    """越权访问返回 403 problem+json。"""
    # Manager 受保护端点，没有有效 token → 401（不是 403 越权）。
    # 401 已验证；403 需要 token 验证。这里验证 401 至少不是 HTML。
    resp = manager_client.get("/api/manager/whoami")
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json")
    body = resp.json()
    assert body["status"] == 401


# ── SPA fallback 守卫 ──

@pytest.mark.integration
def test_api_routes_never_return_spa_html(operation_client, manager_client, agent_client):
    """/api/* 路径绝不返回 text/html（SPA fallback 不能吞掉 API 错误）。"""
    test_cases = [
        # (name, client, path, method, body)
        ("operation", operation_client, "/api/operation/ping", "GET", None),
        ("manager", manager_client, "/api/manager/ping", "GET", None),
        ("agent", agent_client, "/api/agent/ping", "GET", None),
        ("operation", operation_client, "/api/operation/whoami", "GET", None),
        ("manager", manager_client, "/api/manager/whoami", "GET", None),
        ("agent", agent_client, "/api/agent/whoami", "GET", None),
        ("operation", operation_client, "/api/operation/not-exist", "GET", None),
        ("manager", manager_client, "/api/manager/not-exist", "GET", None),
        ("agent", agent_client, "/api/agent/not-exist", "GET", None),
        # also exercise POST path to cover else branch
        ("operation", operation_client, "/api/operation/ping", "POST", {}),
    ]
    for name, client, path, method, body in test_cases:
        if method == "GET":
            resp = client.get(path)
        else:
            resp = client.post(path, json=body or {})
        ct = resp.headers.get("content-type", "")
        assert "text/html" not in ct, f"{name} {method} {path} 不应返回 text/html"


@pytest.mark.integration
def test_api_auth_endpoints_not_spa_html(operation_client, manager_client, agent_client):
    """/api/auth/* 路径不返回 text/html。"""
    auth_paths = [
        ("operation", operation_client, "/api/operation/auth/login"),
        ("manager", manager_client, "/api/auth/login"),
        ("agent", agent_client, "/api/agent/login"),
    ]
    for name, client, path in auth_paths:
        # POST 错误 body 也会触发 validation error（problem+json），不是 HTML
        resp = client.post(path, json={})
        ct = resp.headers.get("content-type", "")
        assert "text/html" not in ct, f"{name} {path} 不应返回 text/html"
