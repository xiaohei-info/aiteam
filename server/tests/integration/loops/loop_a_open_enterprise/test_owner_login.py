"""Loop A owner 登录/重置/whoami 测试（pytest -k owner_login）。

覆盖 03 §9.4 认证闭环：
- owner 首登强制重置（bootstrap → reset → login）
- owner 登录后 whoami 返回正确身份
- 重置后旧凭据失效、新凭据可登录
- 重复重置周期可验证
- Manager whoami 受保护端点 401 负例
"""

from __future__ import annotations

import os
import uuid

import pytest
from fastapi.testclient import TestClient


def _provision_owner_for_test(tenant_scope, service_token_headers):
    """工具：F01+F02 开通企业并 bootstrap owner，返回 (tenant_id, phone, bootstrap_pw, manager_client)。"""

    from manager_service.app import app as manager_app

    new_tenant_id = str(uuid.uuid4())
    client = TestClient(manager_app)

    # F01
    r1 = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "LoginTest Corp",
            "enterprise_code": f"lt_{uuid.uuid4().hex[:6]}",
        },
        headers=service_token_headers,
    )
    assert r1.status_code == 201, f"F01 failed: {r1.text}"

    # F02
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    bootstrap_pw = f"Boot!1-{uuid.uuid4().hex[:8]}"
    r2 = client.post(
        "/api/manager/owner-bootstrap",
        json={
            "tenant_id": new_tenant_id,
            "owner_phone": phone,
            "bootstrap_secret": bootstrap_pw,
            "must_reset": True,
        },
        headers=service_token_headers,
    )
    assert r2.status_code == 201, f"F02 failed: {r2.text}"

    return new_tenant_id, phone, bootstrap_pw, client


# ── 首登强制重置 ──


@pytest.mark.integration
def test_owner_first_login_with_bootstrap_returns_403_must_reset(
    tenant_scope, service_token_headers,
):
    """Owner 用 bootstrap 密码首次登录 → 403 (Forbidden: must_reset)。

    03 §9.4A：must_reset=true 时拒绝直接签发 token。
    """
    from manager_service.app import app as manager_app

    tid, phone, bootstrap_pw, _client = _provision_owner_for_test(tenant_scope, service_token_headers)

    # 尝试用 bootstrap 直接登录
    r = _client.post(
        "/api/auth/login",
        json={"tenant_id": tid, "account": phone, "password": bootstrap_pw},
    )
    assert r.status_code == 403, (
        f"首登未重置应返回 403，实际: {r.status_code} body={r.text}"
    )
    ct = r.headers.get("content-type", "")
    assert ct.startswith("application/problem+json"), f"403 应为 problem+json: {ct}"
    body = r.json()
    assert body["code"] == "password_reset_required"

    # 清理
    import psycopg
    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tid,))


@pytest.mark.integration
def test_owner_reset_then_login_success(
    tenant_scope, service_token_headers,
):
    """Owner 重置密码后登录成功。

    1. 用 bootstrap 密码调用 /api/auth/owner-reset 设新密码
    2. 用新密码调用 /api/auth/login 获得 token
    3. 验证 token 结构正确
    """
    tid, phone, bootstrap_pw, _client = _provision_owner_for_test(tenant_scope, service_token_headers)

    new_pw = f"Np!1-{uuid.uuid4().hex[:8]}"
    r = _client.post(
        "/api/auth/owner-reset",
        json={"tenant_id": tid, "account": phone, "old_password": bootstrap_pw, "new_password": new_pw},
    )
    assert r.status_code == 200, f"重置应返回 200: {r.text}"
    data = r.json()["data"]
    assert "token" in data
    assert "claims" in data
    assert data["claims"]["tenant_id"] == tid
    assert "owner" in data["claims"]["roles"]

    # 用新密码登录
    r2 = _client.post(
        "/api/auth/login",
        json={"tenant_id": tid, "account": phone, "password": new_pw},
    )
    assert r2.status_code == 200, f"登录应返回 200: {r2.text}"
    claims = r2.json()["data"]["claims"]
    assert claims["tenant_id"] == tid
    assert "owner" in claims["roles"]

    # 清理
    import psycopg
    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tid,))


# ── 凭据失效 ──


@pytest.mark.integration
def test_old_bootstrap_invalid_after_reset(
    tenant_scope, service_token_headers,
):
    """重置后旧 bootstrap 密码失效。

    03 §9.4A 验收："重置后旧凭据失效、新凭据可登录"。
    """
    tid, phone, bootstrap_pw, _client = _provision_owner_for_test(tenant_scope, service_token_headers)

    new_pw = f"Np!1-{uuid.uuid4().hex[:8]}"
    # 重置
    r = _client.post(
        "/api/auth/owner-reset",
        json={"tenant_id": tid, "account": phone, "old_password": bootstrap_pw, "new_password": new_pw},
    )
    assert r.status_code == 200

    # 旧凭据应失效
    r2 = _client.post(
        "/api/auth/login",
        json={"tenant_id": tid, "account": phone, "password": bootstrap_pw},
    )
    assert r2.status_code == 401, f"旧凭据应 401，实际: {r2.status_code}"

    # 新凭据有效
    r3 = _client.post(
        "/api/auth/login",
        json={"tenant_id": tid, "account": phone, "password": new_pw},
    )
    assert r3.status_code == 200

    # 清理
    import psycopg
    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tid,))


@pytest.mark.integration
def test_repeated_reset_login_cycle(
    tenant_scope, service_token_headers,
):
    """重复重置周期：重置多次，每次旧凭据失效、新凭据可登录。"""
    tid, phone, bootstrap_pw, _client = _provision_owner_for_test(tenant_scope, service_token_headers)

    current_pw = bootstrap_pw
    for i in range(2):
        new_pw = f"Np!1-{i}-{uuid.uuid4().hex[:6]}"
        r = _client.post(
            "/api/auth/owner-reset",
            json={"tenant_id": tid, "account": phone, "old_password": current_pw, "new_password": new_pw},
        )
        assert r.status_code == 200, f"第 {i} 次重置失败: {r.text}"

        # 旧凭据失效
        r_old = _client.post(
            "/api/auth/login",
            json={"tenant_id": tid, "account": phone, "password": current_pw},
        )
        assert r_old.status_code == 401, f"第 {i} 次重置后旧凭据应 401"

        # 新凭据有效
        r_new = _client.post(
            "/api/auth/login",
            json={"tenant_id": tid, "account": phone, "password": new_pw},
        )
        assert r_new.status_code == 200, f"第 {i} 次重置后新凭据应 200"

        current_pw = new_pw

    # 清理
    import psycopg
    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tid,))


# ── Manager whoami ──


@pytest.mark.integration
@pytest.mark.pr_quick
def test_owner_whoami_after_login(
    tenant_scope, service_token_headers,
):
    """Owner 登录后 /api/manager/whoami 返回正确身份。

    验收："Manager whoami tenant 等于开通目标 tenant"。
    """
    tid, phone, bootstrap_pw, _client = _provision_owner_for_test(tenant_scope, service_token_headers)

    new_pw = f"Np!1-{uuid.uuid4().hex[:8]}"
    # 重置
    r = _client.post(
        "/api/auth/owner-reset",
        json={"tenant_id": tid, "account": phone, "old_password": bootstrap_pw, "new_password": new_pw},
    )
    assert r.status_code == 200
    token = r.json()["data"]["token"]

    # whoami
    r2 = _client.get("/api/manager/whoami", headers={"Authorization": f"Bearer {token}"})
    assert r2.status_code == 200, f"whoami 应 200: {r2.text}"
    wdata = r2.json()["data"]
    assert wdata["tenant_id"] == tid, (
        f"whoami tenant_id={wdata['tenant_id']} 应等于开通目标 {tid}"
    )

    # 清理
    import psycopg
    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tid,))


@pytest.mark.integration
@pytest.mark.pr_quick
def test_manager_whoami_without_auth_returns_401(
    tenant_scope,
):
    """无 token 访问 /api/manager/whoami → 401 problem+json。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.get("/api/manager/whoami")
    assert resp.status_code == 401, f"whoami 无 token 应 401: {resp.text}"
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json"), f"401 应为 problem+json: {ct}"
    body = resp.json()
    assert body["code"] == "unauthorized"


# ── 登录/重置输入校验 ──


@pytest.mark.integration
def test_login_missing_fields_422(tenant_scope):
    """登录缺少必填字段 → 422。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post("/api/auth/login", json={"tenant_id": "t1"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "validation_error"


@pytest.mark.integration
def test_owner_reset_missing_fields_422(tenant_scope):
    """重置缺少必填字段 → 422。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post("/api/auth/owner-reset", json={"tenant_id": "t1"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "validation_error"


@pytest.mark.integration
def test_login_wrong_credentials_returns_401(tenant_scope, service_token_headers):
    """错误凭据登录 → 401。"""
    tid, phone, bootstrap_pw, _client = _provision_owner_for_test(tenant_scope, service_token_headers)

    r = _client.post(
        "/api/auth/login",
        json={"tenant_id": tid, "account": phone, "password": "wrong-wrong-wrong"},
    )
    assert r.status_code == 401
    assert r.json()["code"] == "unauthorized"

    # 清理
    import psycopg
    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tid,))


@pytest.mark.integration
def test_owner_reset_wrong_old_password_returns_401(tenant_scope, service_token_headers):
    """重置时旧密码错误 → 401。"""
    tid, phone, bootstrap_pw, _client = _provision_owner_for_test(tenant_scope, service_token_headers)

    r = _client.post(
        "/api/auth/owner-reset",
        json={
            "tenant_id": tid,
            "account": phone,
            "old_password": "wrong-old",
            "new_password": "New-one-123",
        },
    )
    assert r.status_code == 401
    assert r.json()["code"] == "unauthorized"

    # 清理
    import psycopg
    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tid,))
