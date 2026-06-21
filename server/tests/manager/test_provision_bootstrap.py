"""F01/F02 HTTP 收端验收（02 §10/§11；05 §5.1 D4）。

非 integration：无 admin_db → 503 problem+json（不静默）。
integration（真 PG）：POST /api/manager/tenants 建 tenant_registry 行；
POST /api/manager/owner-bootstrap 落 owner 凭据；幂等重放不报错。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings


def _client(db_url: str | None, admin_db_url: str | None = None) -> TestClient:
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_tenant import router as tenant_router
    from manager_service.routes_bootstrap import router as bootstrap_router

    settings = Settings(
        tier="manager", service_name="aiteam-manager-service",
        db_url=db_url, admin_db_url=admin_db_url,
    )
    app = create_app(settings, manager_router)
    app.include_router(tenant_router)
    app.include_router(bootstrap_router)
    return TestClient(app)


# ---- 非 integration：无 DB → 503 problem+json ----

def test_provision_tenant_no_admin_db_returns_503():
    client = _client(None)
    resp = client.post("/api/manager/tenants", json={
        "enterprise_id": "e1", "tenant_id": str(uuid.uuid4()),
        "enterprise_name": "E1", "enterprise_code": "e1",
    })
    assert resp.status_code == 503
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert resp.json()["code"] == "manager_admin_db_unconfigured"


def test_owner_bootstrap_no_db_returns_503():
    client = _client(None)
    resp = client.post("/api/manager/owner-bootstrap", json={
        "tenant_id": str(uuid.uuid4()),
        "owner_phone": "13800000001",
        "bootstrap_secret": "plain-secret-xyz",
    })
    assert resp.status_code == 503
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert resp.json()["code"] == "manager_admin_db_unconfigured"


def test_provision_tenant_body_not_contain_secrets():
    """响应体不含敏感材料（02 §11.2）。"""
    client = _client(None)
    resp = client.post("/api/manager/tenants", json={
        "enterprise_id": "e2", "tenant_id": str(uuid.uuid4()),
        "enterprise_name": "E2",
    })
    body = resp.text
    assert "bootstrap" not in body
    assert "password" not in body


def test_bootstrap_contract_carries_plaintext_not_hash():
    """CRITICAL 回归（#100 review）：F02 契约字段是明文 bootstrap_secret，不是 bootstrap_secret_hash。

    根因：旧链路 Operator 发 sha256(secret)，Manager 再 scrypt(sha256(secret)) 落库，
    owner 首登输明文 secret 验不过。修复后 Operator 发明文，Manager 单次 scrypt。
    本测试静态断言契约字段，防止回退到双重 hash 设计。
    """
    from pydantic import TypeAdapter
    from shared.contracts.crosstier import OwnerBootstrapSync

    schema = TypeAdapter(OwnerBootstrapSync)
    fields = OwnerBootstrapSync.model_fields
    # 修复后字段名：bootstrap_secret（明文），不是 bootstrap_secret_hash（hash）
    assert "bootstrap_secret" in fields
    assert "bootstrap_secret_hash" not in fields


def test_hash_single_source_of_truth_no_double_hash():
    """CRITICAL 回归（#100 review）：auth_service 单一 hash 真相源。

    证明：provision_owner 接明文，落库值 scrypt(明文)；verify_password(明文, 落库) 通过；
    verify_password(sha256(明文), 落库) 必然不通过（证明 Manager 没有在 scrypt 之上再做 sha256）。
    无 DB：直接用 security.hash_password 模拟 provision_owner 内部行为。
    """
    import hashlib

    from manager_service.security import hash_password, verify_password

    plaintext = "bootstrap-plaintext-secret"
    stored = hash_password(plaintext)  # 模拟 provision_owner 落库值（单次 scrypt）
    # 正链路：明文验过
    assert verify_password(plaintext, stored) is True
    # 双重 hash 红线：sha256(明文) 必然验不过（若 routes_bootstrap 传 hash 给 provision_owner，
    # 则落库是 scrypt(sha256(secret))，用户输明文验不过——这正是被修复的 bug）。
    assert verify_password(hashlib.sha256(plaintext.encode()).hexdigest(), stored) is False


# ---- integration：真 PG 端到端 ----

@pytest.mark.integration
def test_provision_tenant_and_owner_bootstrap_e2e(migrated_db, admin_url):
    # 复用 conftest 夹具（migrated_db 已 apply_migrations 并返回业务 DSN；admin_url 为管理 DSN）。
    # 统一经夹具读 DB_URL/ADMIN_DB_URL（#103），不再自取旧名 env——杜绝变量名漂移导致 CI 静默 skip。
    import psycopg

    db_url = migrated_db
    client = _client(db_url, admin_db_url=admin_url)

    tenant_id = str(uuid.uuid4())
    enterprise_id = str(uuid.uuid4())
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    bootstrap_secret = "bootstrap-plaintext-secret-123"  # 明文（TLS 服务间）；Manager 单次 scrypt

    # F01：建 tenant
    r = client.post("/api/manager/tenants", json={
        "enterprise_id": enterprise_id,
        "tenant_id": tenant_id,
        "enterprise_name": "TestCo",
        "enterprise_code": f"tc_{uuid.uuid4().hex[:6]}",
    })
    assert r.status_code == 201
    assert r.json()["data"]["tenant_id"] == tenant_id

    # 验 tenant_registry 行已落控制面库
    with psycopg.connect(admin_url) as conn:
        row = conn.execute(
            "SELECT tenant_id FROM tenant_registry WHERE tenant_id = %s::uuid",
            (tenant_id,),
        ).fetchone()
    assert row is not None

    # F01 幂等：重放同 tenant_id 不报错
    r2 = client.post("/api/manager/tenants", json={
        "enterprise_id": enterprise_id,
        "tenant_id": tenant_id,
        "enterprise_name": "TestCo",
    })
    assert r2.status_code == 201

    # F02：落 owner 凭据（传明文，Manager 单次 scrypt）
    r = client.post("/api/manager/owner-bootstrap", json={
        "tenant_id": tenant_id,
        "owner_phone": phone,
        "bootstrap_secret": bootstrap_secret,
    })
    assert r.status_code == 201
    body = r.json()["data"]
    assert body["tenant_id"] == tenant_id
    assert "user_id" in body
    # 响应体不含明文凭据
    assert bootstrap_secret not in r.text

    # F02 幂等：重放返回 201（idempotent=true）
    r3 = client.post("/api/manager/owner-bootstrap", json={
        "tenant_id": tenant_id,
        "owner_phone": phone,
        "bootstrap_secret": bootstrap_secret,
    })
    assert r3.status_code == 201
    assert r3.json()["data"].get("idempotent") is True

    # ── CRITICAL 回归：双重 hash 断链已修复 ──────────────────────────────────────
    # 直接直读 auth_identity 拿落库 scrypt hash，用明文 secret 验证 verify_password 通过。
    from manager_service.security import verify_password

    with psycopg.connect(admin_url, autocommit=True) as conn:
        stored = conn.execute(
            "SELECT secret FROM auth_identity WHERE external_id = %s", (phone,)
        ).fetchone()[0]
    assert stored.startswith("scrypt$")  # 确认是 Manager 单次 scrypt，非双重 hash
    assert verify_password(bootstrap_secret, stored) is True  # 明文 secret 能验过
    # 双重 hash 断链红线：sha256(secret) 必然验不过
    import hashlib
    assert verify_password(hashlib.sha256(bootstrap_secret.encode()).hexdigest(), stored) is False
