"""Loop A 企业开通 provision 测试（pytest -k provision）。

覆盖 F01+F02 真 PG 集成：
- Manager F01: POST /api/manager/tenants（service token 守卫）→ 建 tenant_registry + quota_policy
- Manager F02: POST /api/manager/owner-bootstrap（service token 守卫）→ 落 owner 凭据
- 全链：provision → owner whoami 返回正确 tenant_id
- 幂等：重复 F01/F02 不报错
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient


def _bound_manager_client(tenant_id: str) -> TestClient:
    """Use a fresh deployment binding for F01/F02 provisioning tests."""
    from manager_service.app import app as manager_app
    from tests.integration.fixtures.manager_binding import bind_manager_app

    bind_manager_app(tenant_id, manager_app)
    return TestClient(manager_app)


# ── F01 tenant provision ──


@pytest.mark.integration
@pytest.mark.pr_quick
def test_tenant_provision_creates_tenant_registry(
    tenant_scope, service_token_headers, migrated_pg, fresh_tenant_cleanup,
):
    """F01: POST /api/manager/tenants 创建 tenant 并落 tenant_registry + quota_policy。

    使用 tenant_scope fixture 提供的真实 PG 连接验证写入结果。
    """
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    enterprise_code = f"ent_{uuid.uuid4().hex[:8]}"

    client = _bound_manager_client(new_tenant_id)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "Test Corp",
            "enterprise_code": enterprise_code,
        },
        headers=service_token_headers,
    )
    assert resp.status_code == 201, f"F01 应返回 201，实际: {resp.status_code} body={resp.text}"
    data = resp.json()
    assert "data" in data
    assert data["data"]["tenant_id"] == new_tenant_id

    # 验证 tenant_registry 已落库
    import psycopg
    admin_url = tenant_scope.admin_url
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            row = conn.execute(
                "SELECT tenant_id, enterprise_slug, enterprise_code FROM tenant_registry WHERE tenant_id = %s",
                (new_tenant_id,),
            ).fetchone()
            assert row is not None, "tenant_registry 应存在"
            assert row[2] == enterprise_code



@pytest.mark.integration
def test_tenant_provision_has_envelope_and_problem_json_headers(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    """F01 响应结构：envelope data + content-type 正确。"""
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _bound_manager_client(new_tenant_id)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "EnvCorp",
            "enterprise_code": f"env_{uuid.uuid4().hex[:6]}",
        },
        headers=service_token_headers,
    )
    assert resp.status_code == 201
    ct = resp.headers.get("content-type", "")
    assert "text/html" not in ct, f"content-type 不应是 text/html: {ct}"
    body = resp.json()
    assert "data" in body
    assert body["data"]["tenant_id"] == new_tenant_id



@pytest.mark.integration
def test_tenant_provision_with_quota_policy(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    """F01: 带 initial_quota_policy 的开通——quota_policy 表落库。"""
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _bound_manager_client(new_tenant_id)
    resp = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "QuotaCorp",
            "enterprise_code": f"qt_{uuid.uuid4().hex[:6]}",
            "initial_quota_policy": {
                "policy_slug": "basic",
                "display_name": "Basic Plan",
                "scope": "tenant",
                "window_days": 30,
                "dimensions": {"cost_cap_usd": 50, "token_cap": 100000},
                "enforcement": "soft",
            },
        },
        headers=service_token_headers,
    )
    assert resp.status_code == 201

    # 验证 quota_policy 已落库
    import psycopg
    admin_url = tenant_scope.admin_url
    if admin_url:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (new_tenant_id,))
            row = conn.execute(
                "SELECT policy_slug, display_name, enforcement FROM quota_policy WHERE tenant_id = %s",
                (new_tenant_id,),
            ).fetchone()
            assert row is not None, "quota_policy 应存在"
            assert row[0] == "basic"



# ── F02 owner bootstrap ──


@pytest.mark.integration
@pytest.mark.pr_quick
def test_owner_bootstrap_creates_identity(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    """F02: POST /api/manager/owner-bootstrap 落 owner 凭据（must_reset=true）。

    先 F01 建 tenant，再 F02 bootstrap owner。
    """
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _bound_manager_client(new_tenant_id)

    # F01
    r1 = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "OwnerCorp",
            "enterprise_code": f"ow_{uuid.uuid4().hex[:6]}",
        },
        headers=service_token_headers,
    )
    assert r1.status_code == 201

    # F02
    owner_phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    bootstrap_secret = f"Bs!1-{uuid.uuid4().hex[:12]}"
    r2 = client.post(
        "/api/manager/owner-bootstrap",
        json={
            "tenant_id": new_tenant_id,
            "owner_phone": owner_phone,
            "bootstrap_secret": bootstrap_secret,
            "must_reset": True,
        },
        headers=service_token_headers,
    )
    assert r2.status_code == 201, f"F02 应返回 201，实际: {r2.status_code} body={r2.text}"
    data = r2.json()
    assert "data" in data
    assert data["data"]["tenant_id"] == new_tenant_id



@pytest.mark.integration
def test_owner_bootstrap_idempotent(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    """F02 可重复同步：重复 bootstrap 返回同一 user_id。"""
    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _bound_manager_client(new_tenant_id)

    # F01
    r1 = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "IdemCorp",
            "enterprise_code": f"id_{uuid.uuid4().hex[:6]}",
        },
        headers=service_token_headers,
    )
    assert r1.status_code == 201

    # F02 第一次
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    bs = f"Bs!1-{uuid.uuid4().hex[:12]}"
    r2a = client.post(
        "/api/manager/owner-bootstrap",
        json={"tenant_id": new_tenant_id, "owner_phone": phone, "bootstrap_secret": bs, "must_reset": True},
        headers=service_token_headers,
    )
    assert r2a.status_code == 201
    # 首次创建不应有 idempotent 标记
    assert not r2a.json()["data"].get("idempotent")

    # F02 第二次（重复/可重复 replace）
    r2b = client.post(
        "/api/manager/owner-bootstrap",
        json={"tenant_id": new_tenant_id, "owner_phone": phone, "bootstrap_secret": bs, "must_reset": True},
        headers=service_token_headers,
    )
    assert r2b.status_code == 201
    assert r2b.json()["data"]["user_id"] == r2a.json()["data"]["user_id"]



# ── 全链：provision → owner whoami ──


@pytest.mark.integration
def test_full_provision_chain_owner_whoami_returns_correct_tenant(
    tenant_scope, service_token_headers, fresh_tenant_cleanup,
):
    """全链验收：F01+F02 后 owner 登录 → whoami tenant_id 等于开通目标 tenant。

    用真实 auth 服务（manager_service.auth_service）完成 bootstrap → 登录 → whoami。
    """
    import os as _os
    admin_url = _os.getenv("ADMIN_DB_URL")
    db_url = _os.getenv("DB_URL")
    if not admin_url or not db_url:
        pytest.skip("ADMIN_DB_URL 和 DB_URL 均需配置")

    from manager_service.auth_service import LoginInput, OwnerResetInput, build_auth_service

    new_tenant_id = fresh_tenant_cleanup(str(uuid.uuid4()))
    client = _bound_manager_client(new_tenant_id)

    # F01: 建 tenant
    r1 = client.post(
        "/api/manager/tenants",
        json={
            "enterprise_id": str(uuid.uuid4()),
            "tenant_id": new_tenant_id,
            "enterprise_name": "FullChain Corp",
            "enterprise_code": f"fc_{uuid.uuid4().hex[:6]}",
        },
        headers=service_token_headers,
    )
    assert r1.status_code == 201

    # F02: bootstrap owner
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

    # 通过 AuthService 完成首登重置
    service = build_auth_service(db_url, admin_dsn=admin_url)
    from shared.errors import Forbidden
    with pytest.raises(Forbidden):
        service.login(LoginInput(tenant_id=new_tenant_id, account=phone, password=bootstrap_pw))

    new_pw = f"New!1-{uuid.uuid4().hex[:8]}"
    result = service.owner_reset(
        OwnerResetInput(tenant_id=new_tenant_id, account=phone, old_password=bootstrap_pw, new_password=new_pw)
    )
    assert result.claims.tenant_id == new_tenant_id
    assert "owner" in result.claims.roles

    # Manager whoami 用签发的 token
    whoami_resp = client.get(
        "/api/manager/whoami",
        headers={"Authorization": f"Bearer {result.token}"},
    )
    assert whoami_resp.status_code == 200, f"whoami 应 200: {whoami_resp.text}"
    wdata = whoami_resp.json()["data"]
    assert wdata["tenant_id"] == new_tenant_id, (
        f"whoami tenant_id={wdata['tenant_id']} 应等于开通目标 {new_tenant_id}"
    )



# ── 422 / validation ──


@pytest.mark.integration
def test_tenant_provision_missing_fields_422(tenant_scope, service_token_headers):
    """F01 缺少必填字段 → 422 problem+json。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/tenants",
        json={"tenant_id": "t-no-ent-id"},
        headers=service_token_headers,
    )
    assert resp.status_code == 422
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json"), f"422 应为 problem+json: {ct}"
    body = resp.json()
    assert body["code"] == "validation_error"


@pytest.mark.integration
def test_owner_bootstrap_missing_fields_422(tenant_scope, service_token_headers):
    """F02 缺少必填字段 → 422 problem+json。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.post(
        "/api/manager/owner-bootstrap",
        json={"tenant_id": "t1"},
        headers=service_token_headers,
    )
    assert resp.status_code == 422
    ct = resp.headers.get("content-type", "")
    assert ct.startswith("application/problem+json")
