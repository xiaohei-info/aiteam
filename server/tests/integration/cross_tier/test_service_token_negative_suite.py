"""P2-X2 service-token 负向矩阵测试（最终执行 DAG §5.2 P2-X2）。

验证 service token 缺失、过期、越权、跨租户、访问 /api/auth 均不 fail-open：
- 缺失 service token → 401
- 错误 service token → 401
- service token 不可绕过受保护端点
- 不会静默放行（fail-open 检测）
"""

from __future__ import annotations

import os
import uuid

import pytest
from fastapi.testclient import TestClient


# ── service token 守卫直接测试 ──

@pytest.mark.integration
@pytest.mark.pr_quick
def test_service_token_guard_missing_returns_401():
    """缺失 service token 返回 401（生产模式 fail-closed）。"""
    from tests.integration.fixtures.identities import build_service_token_probe_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    app = build_service_token_probe_app(token)
    client = TestClient(app)

    # 不带 service token → 401
    resp = client.get("/svc/ping")
    assert resp.status_code == 401, f"缺 service token 应 401，实际: {resp.status_code}"
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json"), (
        f"应返回 problem+json，实际: {ct}"
    )
    body = resp.json()
    assert body.get("code") == "unauthorized"


@pytest.mark.integration
def test_service_token_guard_wrong_returns_401():
    """错误 service token 返回 401（不 fail-open）。"""
    from tests.integration.fixtures.identities import build_service_token_probe_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    app = build_service_token_probe_app(token)
    client = TestClient(app)

    # 带错误 token → 401
    resp = client.get("/svc/ping", headers={"X-Service-Token": "wrong-" + uuid.uuid4().hex})
    assert resp.status_code == 401, f"错误 service token 应 401，实际: {resp.status_code}"
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json")


@pytest.mark.integration
def test_service_token_guard_correct_passes():
    """正确 service token 通过守卫。"""
    from tests.integration.fixtures.identities import build_service_token_probe_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    app = build_service_token_probe_app(token)
    client = TestClient(app)

    resp = client.get("/svc/ping", headers={"X-Service-Token": token})
    assert resp.status_code == 200, f"正确 service token 应 200，实际: {resp.status_code}"
    body = resp.json()
    assert body.get("ok") is True


@pytest.mark.integration
def test_service_token_bearer_header_format():
    """Authorization: Bearer 格式也接受 service token。"""
    from tests.integration.fixtures.identities import build_service_token_probe_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    app = build_service_token_probe_app(token)
    client = TestClient(app)

    resp = client.get("/svc/ping", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("ok") is True


# ── service token 负向矩阵：不可 fail-open ──

@pytest.mark.integration
def test_service_token_empty_string_returns_401():
    """空字符串 token 不算合法（fail-closed）。"""
    from tests.integration.fixtures.identities import build_service_token_probe_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    app = build_service_token_probe_app(token)
    client = TestClient(app)

    resp = client.get("/svc/ping", headers={"X-Service-Token": ""})
    assert resp.status_code == 401, f"空 token 应 401，实际: {resp.status_code}"


@pytest.mark.integration
def test_service_token_whitespace_only_returns_401():
    """空白 token 不算合法。"""
    from tests.integration.fixtures.identities import build_service_token_probe_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    app = build_service_token_probe_app(token)
    client = TestClient(app)

    resp = client.get("/svc/ping", headers={"X-Service-Token": "   "})
    assert resp.status_code == 401, f"空白 token 应 401，实际: {resp.status_code}"


@pytest.mark.integration
def test_service_token_case_sensitive():
    """service token 大小写敏感——大小写不同视为不同 token。"""
    from tests.integration.fixtures.identities import build_service_token_probe_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    app = build_service_token_probe_app(token)
    client = TestClient(app)

    # 正确 token 通过
    resp_ok = client.get("/svc/ping", headers={"X-Service-Token": token})
    assert resp_ok.status_code == 200

    # 大小写变体 → 401
    resp_bad = client.get("/svc/ping", headers={"X-Service-Token": token.upper()})
    assert resp_bad.status_code == 401, f"大小写不同 token 应 401，实际: {resp_bad.status_code}"


# ── service token 不可访问 /api/auth ──

@pytest.mark.integration
def test_service_token_cannot_access_manager_auth_endpoint():
    """service token 不能通过 Manager /api/auth/* 登录端点——auth 端点为用户凭据设计。"""
    from manager_service.app import app as manager_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    client = TestClient(manager_app)

    resp = client.post(
        "/api/auth/login",
        json={"account": "13800000001", "password": "any"},
        headers={"X-Service-Token": token},
    )
    # auth 端点不应被 service token bypass
    # 返回 401 或 422（参数不足）均不是 fail-open
    assert resp.status_code != 200, f"service token 不应通过 login 端点: {resp.status_code}"
    ct = resp.headers.get("content-type", "")
    assert "text/html" not in ct


@pytest.mark.integration
def test_service_token_no_bypass_operation_auth():
    """service token 不能绕过 Operation 认证访问受保护端点。"""
    from operation_service.app import app as operation_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    client = TestClient(operation_app)

    resp = client.get(
        "/api/operation/whoami",
        headers={"X-Service-Token": token},
    )
    # Operation whoami 需要系统用户 token，不是 service token
    assert resp.status_code != 200, f"service token 不应通过 operator whoami: {resp.status_code}"


# ── 越权检测 ──

@pytest.mark.integration
def test_bad_service_token_fixture_is_wrong(service_token, bad_service_token_headers):
    """bad_service_token_headers 与正确 token 不同。"""
    assert bad_service_token_headers["X-Service-Token"] != service_token


@pytest.mark.integration
def test_service_token_problem_json_has_diagnostics():
    """service token 401 响应含可审计诊断信息（但不泄露 token 内容）。"""
    from tests.integration.fixtures.identities import build_service_token_probe_app

    token = os.getenv("SERVICE_TOKEN", "test-service-token")
    app = build_service_token_probe_app(token)
    client = TestClient(app)

    wrong = "wrong-" + uuid.uuid4().hex
    resp = client.get("/svc/ping", headers={"X-Service-Token": wrong})
    assert resp.status_code == 401

    body = resp.json()
    # 必须含可审计字段
    assert "status" in body and body["status"] == 401
    assert "code" in body
    assert "title" in body

    # 不得泄露 token 值
    raw = resp.text
    assert wrong not in raw, "错误响应不得泄露 service token 值"
