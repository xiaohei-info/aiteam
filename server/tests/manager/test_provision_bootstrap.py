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


def _client(
    db_url: str | None,
    admin_db_url: str | None = None,
) -> TestClient:
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_tenant import router as tenant_router
    from manager_service.routes_bootstrap import router as bootstrap_router

    settings = Settings(
        tier="manager", service_name="aiteam-manager-service",
        db_url=db_url, admin_db_url=admin_db_url,
        # AITEAM-331 B2：未配置 SERVICE_TOKEN 不再 fail-open；显式 dev 占位值维持 dev profile。
        service_token="dev-service-token-placeholder",
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

    plaintext = "Bootstrap-plaintext-secret1"
    stored = hash_password(plaintext)  # 模拟 provision_owner 落库值（单次 scrypt）
    # 正链路：明文验过
    assert verify_password(plaintext, stored) is True
    # 双重 hash 红线：sha256(明文) 必然验不过（若 routes_bootstrap 传 hash 给 provision_owner，
    # 则落库是 scrypt(sha256(secret))，用户输明文验不过——这正是被修复的 bug）。
    assert verify_password(hashlib.sha256(plaintext.encode()).hexdigest(), stored) is False


# ---- integration：真 PG 端到端 ----

@pytest.mark.integration
def test_provision_tenant_and_owner_bootstrap_e2e(migrated_db, admin_url):
    # Stage A keeps F01/F02 HTTP fail-closed. Existing-tenant owner provision
    # still uses AuthService (single scrypt) so login can recover without the gate.
    import hashlib
    import psycopg
    from manager_service.auth_service import build_auth_service
    from manager_service.security import verify_password

    db_url = migrated_db
    tenant_id = str(uuid.uuid4())
    client = _client(db_url, admin_db_url=admin_url)
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    bootstrap_secret = "Bootstrap-plaintext-secret-123"
    slug = f"tc_{uuid.uuid4().hex[:6]}"

    r = client.post("/api/manager/tenants", json={
        "enterprise_id": str(uuid.uuid4()),
        "tenant_id": tenant_id,
        "enterprise_name": "TestCo",
        "enterprise_code": slug,
    })
    assert r.status_code == 503
    assert r.json()["code"] == "multitenancy_phase_pending"
    r2 = client.post("/api/manager/owner-bootstrap", json={
        "tenant_id": tenant_id,
        "owner_phone": phone,
        "bootstrap_secret": bootstrap_secret,
    })
    assert r2.status_code == 503
    assert r2.json()["code"] == "multitenancy_phase_pending"
    assert bootstrap_secret not in r2.text

    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (tenant_id, enterprise_slug, enterprise_code) VALUES (%s, %s, %s)",
            (tenant_id, slug, slug),
        )
    build_auth_service(db_url, admin_dsn=admin_url).provision_owner(
        tenant_id, phone=phone, bootstrap_password=bootstrap_secret,
    )
    with psycopg.connect(admin_url, autocommit=True) as conn:
        stored = conn.execute(
            "SELECT secret FROM auth_identity WHERE external_id = %s", (phone,)
        ).fetchone()[0]
    assert stored.startswith("scrypt$")
    assert verify_password(bootstrap_secret, stored) is True
    assert verify_password(hashlib.sha256(bootstrap_secret.encode()).hexdigest(), stored) is False
