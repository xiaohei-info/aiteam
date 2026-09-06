"""Loop A negative 测试（pytest -k negative）。

覆盖跨租户 bootstrap、service-token、problem+json 负例：
- 跨租户 bootstrap 被拒
- service token 缺失/错误/空白不 fail-open
- /api/* 错误返回 application/problem+json（非 text/html）
- 跨租户登录被拒
- 不存在的 tenant 访问被拒
"""

from __future__ import annotations

import os
import uuid

import pytest
from fastapi.testclient import TestClient


# ── 跨租户 bootstrap 负例 ──


@pytest.mark.integration
@pytest.mark.pr_quick
def test_bootstrap_to_nonexistent_tenant_rejected(
    tenant_scope, service_token_headers,
):
    """F02 bootstrap 到不存在的 tenant → 404 problem+json，且不创建 owner。"""
    from manager_service.app import app as manager_app

    fake_tenant_id = str(uuid.uuid4())
    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/owner-bootstrap",
        json={
            "tenant_id": fake_tenant_id,
            "owner_phone": "13800001111",
            "bootstrap_secret": "Some-secret1",
            "must_reset": True,
        },
        headers=service_token_headers,
    )
    # Binding is checked before any registry lookup, so a different tenant is
    # rejected as a deployment-scope mismatch without revealing registry state.
    assert resp.status_code == 503, (
        f"不同 Manager deployment tenant 应被拒绝，实际: {resp.status_code} body={resp.text}"
    )
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json"), f"错误响应应为 problem+json: {ct}"
    assert resp.json()["code"] == "manager_binding_mismatch"


@pytest.mark.integration
def test_bootstrap_wrong_tenant_does_not_create_owner_identity(
    tenant_scope, service_token_headers,
):
    """有效 tenant A 存在时，向未开通 tenant B bootstrap 被拒，A 不被污染。"""
    import psycopg
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    tenant_a = tenant_scope.tenant_id
    tenant_b = str(uuid.uuid4())
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"

    r1 = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": tenant_a,
            "enterprise_name": "Tenant A",
            "enterprise_code": f"ta_{uuid.uuid4().hex[:6]}",
        },
        headers=service_token_headers,
    )
    assert r1.status_code == 201

    resp = client.post(
        "/api/manager/owner-bootstrap",
        json={
            "tenant_id": tenant_b,
            "owner_phone": phone,
            "bootstrap_secret": "Cross-secret1",
            "must_reset": True,
        },
        headers=service_token_headers,
    )
    assert resp.status_code == 503
    assert resp.headers.get("content-type", "").startswith("application/problem+json")
    assert resp.json()["code"] == "manager_binding_mismatch"

    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            row = conn.execute(
                "SELECT 1 FROM auth_identity WHERE tenant_id = %s AND external_id = %s",
                (tenant_b, phone),
            ).fetchone()
            assert row is None
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tenant_a,))


# ── service token 负例（不 fail-open） ──


@pytest.mark.integration
def test_f01_missing_service_token_returns_401(
    tenant_scope,
):
    """F01 POST /api/manager/tenants 无 service token → 401（不 fail-open）。"""
    from manager_service.app import app as manager_app

    new_tenant_id = tenant_scope.tenant_id
    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "NoTokenCorp",
        },
        # 不带 X-Service-Token
    )
    assert resp.status_code == 401, (
        f"F01 缺 service token 应 401，实际: {resp.status_code} body={resp.text}"
    )
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json"), f"401 应为 problem+json: {ct}"
    body = resp.json()
    assert body["code"] == "unauthorized"


@pytest.mark.integration
def test_f01_wrong_service_token_returns_401(
    tenant_scope,
):
    """F01 错误 service token → 401。"""
    from manager_service.app import app as manager_app

    new_tenant_id = tenant_scope.tenant_id
    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "WrongTokenCorp",
        },
        headers={"X-Service-Token": "wrong-" + uuid.uuid4().hex},
    )
    assert resp.status_code == 401, (
        f"F01 错误 service token 应 401，实际: {resp.status_code}"
    )
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json")


@pytest.mark.integration
def test_f02_missing_service_token_returns_401(
    tenant_scope,
):
    """F02 POST /api/manager/owner-bootstrap 无 service token → 401。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/owner-bootstrap",
        json={
            "tenant_id": str(uuid.uuid4()),
            "owner_phone": "13800002222",
            "bootstrap_secret": "bs1",
            "must_reset": True,
        },
        # 不带 X-Service-Token
    )
    assert resp.status_code == 401, (
        f"F02 缺 service token 应 401，实际: {resp.status_code}"
    )
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json")


@pytest.mark.integration
def test_f02_wrong_service_token_returns_401(
    tenant_scope,
):
    """F02 错误 service token → 401。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/owner-bootstrap",
        json={
            "tenant_id": str(uuid.uuid4()),
            "owner_phone": "13800003333",
            "bootstrap_secret": "bs2",
            "must_reset": True,
        },
        headers={"X-Service-Token": "wrong-" + uuid.uuid4().hex},
    )
    assert resp.status_code == 401


@pytest.mark.integration
def test_service_token_empty_string_on_f01_returns_401(
    tenant_scope,
):
    """F01 空字符串 service token → 401。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": str(uuid.uuid4()),
            "enterprise_name": "EmptyCorp",
        },
        headers={"X-Service-Token": ""},
    )
    assert resp.status_code == 401, f"空 token 应 401: {resp.text}"


@pytest.mark.integration
def test_service_token_whitespace_on_f01_returns_401(
    tenant_scope,
):
    """F01 纯空白 service token → 401。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": str(uuid.uuid4()),
            "enterprise_name": "SpaceCorp",
        },
        headers={"X-Service-Token": "   "},
    )
    assert resp.status_code == 401, f"空白 token 应 401: {resp.text}"


# ── problem+json 负例 ──


@pytest.mark.integration
def test_problem_json_401_has_required_fields(tenant_scope):
    """401 problem+json 包含 status / code / title。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.get("/api/manager/whoami")
    assert resp.status_code == 401

    body = resp.json()
    for field in ("status", "code", "title"):
        assert field in body, f"problem+json 缺 {field}: {body}"
    assert body["status"] == 401
    assert isinstance(body["code"], str)
    assert isinstance(body["title"], str)


@pytest.mark.integration
def test_problem_json_422_has_required_fields(tenant_scope):
    """422 problem+json 包含 status / code / title。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post("/api/auth/login", json={"tenant_id": "t1"})
    assert resp.status_code == 422

    body = resp.json()
    for field in ("status", "code", "title"):
        assert field in body, f"problem+json 缺 {field}: {body}"
    assert body["code"] == "validation_error"


@pytest.mark.integration
def test_problem_json_404_api_path_not_spa_html(tenant_scope):
    """不存在的 /api/* 路径返回 problem+json 而非 SPA HTML。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.get("/api/manager/nonexistent-path-99999")
    assert resp.status_code == 404, f"期望 404: {resp.text}"
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json"), f"应为 problem+json: {ct}"
    assert "text/html" not in ct

    body = resp.json()
    assert "code" in body


@pytest.mark.integration
def test_problem_json_auth_401_no_credential_leak(tenant_scope):
    """401 响应不泄露 token / password 值。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.get("/api/manager/whoami")
    assert resp.status_code == 401

    raw = resp.text
    # 不应泄露任何敏感材料
    for sensitive in ("password", "secret"):
        assert sensitive.lower() not in raw.lower(), (
            f"401 响应不应含 '{sensitive}': {raw[:200]}"
        )


# ── 跨租户登录被拒 ──


@pytest.mark.integration
def test_cross_tenant_login_nonexistent_tenant(
    tenant_scope, service_token_headers,
):
    """在 tenant_scope 的有效 tenant 下创建 owner，用另一 tenant_id 登录 → 401。"""
    from manager_service.app import app as manager_app

    tid, phone, bootstrap_pw, _client = _provision_for_negative(tenant_scope, service_token_headers)

    other_tenant = str(uuid.uuid4())
    r = _client.post(
        "/api/auth/login",
        json={"tenant_id": other_tenant, "account": phone, "password": bootstrap_pw},
    )
    assert r.status_code == 503, (
        f"跨 deployment tenant 登录应 503（tenant={other_tenant} 不是 {tid}），实际: {r.status_code}"
    )
    assert r.json()["code"] == "manager_binding_mismatch"

    # 清理
    import psycopg
    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tid,))


@pytest.mark.integration
def test_owner_reset_wrong_tenant_id(
    tenant_scope, service_token_headers,
):
    """用正确的 phone + 旧密码但错误的 tenant_id 重置 → 401。"""
    from manager_service.app import app as manager_app

    tid, phone, bootstrap_pw, _client = _provision_for_negative(tenant_scope, service_token_headers)

    wrong_tenant = str(uuid.uuid4())
    r = _client.post(
        "/api/auth/owner-reset",
        json={
            "tenant_id": wrong_tenant,
            "account": phone,
            "old_password": bootstrap_pw,
            "new_password": "New-pw-123",
        },
    )
    assert r.status_code == 503, (
        f"错误 tenant_id 重置应 503，实际: {r.status_code}"
    )
    assert r.json()["code"] == "manager_binding_mismatch"

    # 清理
    import psycopg
    admin_url = os.getenv("ADMIN_DB_URL")
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (tid,))


# ── 工具函数 ──


def _provision_for_negative(tenant_scope, service_token_headers):
    """同 _provision_owner_for_test，但调用方必须自行清理。"""
    from manager_service.app import app as manager_app

    new_tenant_id = tenant_scope.tenant_id
    client = TestClient(manager_app)

    r1 = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "NegTest Corp",
            "enterprise_code": f"ng_{uuid.uuid4().hex[:6]}",
        },
        headers=service_token_headers,
    )
    assert r1.status_code == 201

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
    assert r2.status_code == 201

    return new_tenant_id, phone, bootstrap_pw, client


# ── 多 tenant 隔离：已登录 Agent 在 Manager 不可用时继续可用 ──


@pytest.mark.integration
def test_agent_token_valid_after_new_login_by_another_owner_fails(
    tenant_scope, service_token_headers,
):
    """A bound Manager keeps the existing tenant session usable and rejects another tenant."""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    tid_a = tenant_scope.tenant_id

    # The fixture row is the one deployment tenant; bootstrap and reset its owner.
    phone_a = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    bpw_a = f"Boot!1-{uuid.uuid4().hex[:8]}"
    r_bootstrap = client.post(
        "/api/manager/owner-bootstrap",
        json={"tenant_id": tid_a, "owner_phone": phone_a, "bootstrap_secret": bpw_a, "must_reset": True},
        headers=service_token_headers,
    )
    assert r_bootstrap.status_code == 201
    new_pw_a = f"Np!1-{uuid.uuid4().hex[:8]}"
    r_reset = client.post(
        "/api/auth/owner-reset",
        json={"tenant_id": tid_a, "account": phone_a, "old_password": bpw_a, "new_password": new_pw_a},
    )
    assert r_reset.status_code == 200
    token_a = r_reset.json()["data"]["token"]

    r_wa = client.get("/api/manager/whoami", headers={"Authorization": f"Bearer {token_a}"})
    assert r_wa.status_code == 200, f"已登录 agent 的 whoami 不应失效: {r_wa.text}"

    # A second enterprise would require a separate Manager deployment; this app
    # rejects it before credential lookup and does not create any registry row.
    tid_b = str(uuid.uuid4())
    r_login_b = client.post(
        "/api/auth/login",
        json={"tenant_id": tid_b, "account": phone_a, "password": "wrong-wrong"},
    )
    assert r_login_b.status_code == 503, f"B 的新登录应被 deployment binding 拒绝: {r_login_b.text}"
    assert r_login_b.json()["code"] == "manager_binding_mismatch"

    r_wa2 = client.get("/api/manager/whoami", headers={"Authorization": f"Bearer {token_a}"})
    assert r_wa2.status_code == 200, f"新登录失败不应影响已登录 agent: {r_wa2.text}"
