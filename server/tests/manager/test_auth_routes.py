"""Manager 认证路由验收（02 envelope/problem+json；03 §9.6 公开端点 401/403）。

- 非 integration：未配置 DB → 503 problem+json（不静默放行）。
- integration：HTTP 端到端 owner 重置 → 登录 → JWKS 验签。
"""

import os
import uuid

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings


def _client(db_url: str | None, admin_db_url: str | None = None) -> TestClient:
    # 用注入的 settings 重建 app，避免依赖进程环境变量。
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router

    settings = Settings(
        tier="manager", service_name="aiteam-manager-service",
        db_url=db_url, admin_db_url=admin_db_url,
    )
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    return TestClient(app)


def test_login_without_db_returns_503_problem_json():
    client = _client(None)
    resp = client.post("/api/auth/login", json={"tenant_id": "t1", "account": "u", "password": "p"})
    assert resp.status_code == 503
    assert resp.headers["content-type"].startswith("application/problem+json")
    body = resp.json()
    assert body["code"] == "manager_db_unconfigured"
    assert "password" not in str(body)  # 错误体不回显凭据


@pytest.mark.integration
def test_owner_reset_login_jwks_over_http():
    db_url = os.getenv("DB_URL")
    admin_url = os.getenv("ADMIN_DB_URL")
    app_rw_password = os.getenv("APP_RW_PASSWORD")
    if not db_url or not admin_url:
        pytest.skip("DB_URL/ADMIN_DB_URL 未设置")
    from shared.auth import RS256TokenVerifier
    from shared.db import apply_migrations
    import psycopg

    # 迁移走管理连接（#60）；tenant_registry 控制面表写入亦走管理连接。
    apply_migrations(admin_url, app_rw_password=app_rw_password)
    slug = f"ent_http_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        tid = str(conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id", (slug,)
        ).fetchone()[0])

    # 直接经 service 落 owner bootstrap（控制面侧职责），再走 HTTP 重置/登录。
    from manager_service.auth_service import build_auth_service
    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    build_auth_service(db_url, admin_dsn=admin_url).provision_owner(
        tid, phone=phone, bootstrap_password="boot-Pass-1"
    )

    client = _client(db_url, admin_db_url=admin_url)

    # 首登直接 login 应 403（需重置）
    r = client.post("/api/auth/login", json={"tenant_id": tid, "account": phone, "password": "boot-Pass-1"})
    assert r.status_code == 403

    # 重置
    r = client.post("/api/auth/owner-reset", json={
        "tenant_id": tid, "account": phone, "old_password": "boot-Pass-1", "new_password": "fresh-Pass-2",
    })
    assert r.status_code == 200
    token = r.json()["data"]["token"]

    # 登录
    r = client.post("/api/auth/login", json={"tenant_id": tid, "account": phone, "password": "fresh-Pass-2"})
    assert r.status_code == 200

    # JWKS 验签
    jwks = client.get(f"/api/auth/{tid}/jwks.json").json()
    claims = RS256TokenVerifier.from_jwks(jwks).verify(token)
    assert claims.tenant_id == tid
    assert "owner" in claims.roles

    # 错误密码 401
    r = client.post("/api/auth/login", json={"tenant_id": tid, "account": phone, "password": "nope"})
    assert r.status_code == 401
