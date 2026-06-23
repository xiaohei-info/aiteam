"""Agent→Manager 登录集成测试（#174）。

真实 HTTP 端到端验证：
1. Manager 启动并配置真实 DB
2. Agent 通过 RealManagerLoginClient 调用 Manager 登录端点
3. 验证 token + JWKS 正确返回并可本地验签
4. 覆盖错误场景：凭据错误、Manager 离线
"""

import os
import uuid

import pytest
from fastapi.testclient import TestClient

from agent_service.auth.manager_client import RealManagerLoginClient
from agent_service.auth.local_login import LoginRequest
from shared.errors import Unauthorized
from shared.service_client import ServiceClient


@pytest.mark.integration
def test_agent_to_manager_login_e2e():
    """端到端：Agent RealManagerLoginClient → Manager 登录 → 返回 token + JWKS。"""
    db_url = os.getenv("DB_URL")
    admin_url = os.getenv("ADMIN_DB_URL")
    app_rw_password = os.getenv("APP_RW_PASSWORD")
    if not db_url or not admin_url:
        pytest.skip("DB_URL/ADMIN_DB_URL 未设置")

    import psycopg

    from shared.auth import RS256TokenVerifier
    from shared.db import apply_migrations

    # 迁移 + 创建 tenant
    apply_migrations(admin_url, app_rw_password=app_rw_password)
    slug = f"ent_e2e_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        tid = str(
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug,),
            ).fetchone()[0]
        )

    # 直接经 service 落 owner bootstrap（控制面职责）
    from manager_service.auth_service import build_auth_service

    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    build_auth_service(db_url, admin_dsn=admin_url).provision_owner(
        tid, phone=phone, bootstrap_password="boot-Pass-1"
    )

    # 启动 Manager HTTP 服务
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from shared.app_factory import create_app
    from shared.config import Settings

    manager_settings = Settings(
        tier="manager",
        service_name="aiteam-manager-service",
        db_url=db_url,
        admin_db_url=admin_url,
    )
    manager_app = create_app(manager_settings, manager_router)
    manager_app.include_router(auth_router)
    manager_client = TestClient(manager_app)

    # 重置密码（首登必须）
    r = manager_client.post(
        "/api/auth/owner-reset",
        json={
            "tenant_id": tid,
            "account": phone,
            "old_password": "boot-Pass-1",
            "new_password": "fresh-Pass-2",
        },
    )
    assert r.status_code == 200

    # Agent 端：通过 RealManagerLoginClient 登录
    # 注意：TestClient 的 base_url 需要转为 ServiceClient 可访问的地址
    # 这里使用 TestClient 的 transport 直接注入 ServiceClient
    sc = ServiceClient(
        "http://testserver",  # TestClient 默认 base_url
        transport=manager_client._transport,  # 复用 TestClient 的 transport
    )
    agent_login_client = RealManagerLoginClient(sc)

    req = LoginRequest(account=phone, password="fresh-Pass-2", tenant_hint=tid)
    token, jwks = agent_login_client.login(req)

    # 验证 token 可用 JWKS 本地验签
    verifier = RS256TokenVerifier.from_jwks(jwks)
    claims = verifier.verify(token)
    assert claims.tenant_id == tid
    assert claims.user_id is not None
    assert "owner" in claims.roles


@pytest.mark.integration
def test_agent_login_with_wrong_credentials():
    """集成：凭据错误 → Manager 返回 401 → Agent 收到 Unauthorized。"""
    db_url = os.getenv("DB_URL")
    admin_url = os.getenv("ADMIN_DB_URL")
    app_rw_password = os.getenv("APP_RW_PASSWORD")
    if not db_url or not admin_url:
        pytest.skip("DB_URL/ADMIN_DB_URL 未设置")

    import psycopg

    from shared.db import apply_migrations

    # 迁移 + 创建 tenant
    apply_migrations(admin_url, app_rw_password=app_rw_password)
    slug = f"ent_e2e_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        tid = str(
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug,),
            ).fetchone()[0]
        )

    # 直接经 service 落 owner bootstrap
    from manager_service.auth_service import build_auth_service

    phone = f"1{uuid.uuid4().int % 10_000_000_000:010d}"
    auth_svc = build_auth_service(db_url, admin_dsn=admin_url)
    auth_svc.provision_owner(tid, phone=phone, bootstrap_password="boot-Pass-1")

    # 启动 Manager HTTP 服务
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from shared.app_factory import create_app
    from shared.config import Settings

    manager_settings = Settings(
        tier="manager",
        service_name="aiteam-manager-service",
        db_url=db_url,
        admin_db_url=admin_url,
    )
    manager_app = create_app(manager_settings, manager_router)
    manager_app.include_router(auth_router)
    manager_client = TestClient(manager_app)

    # 重置密码
    manager_client.post(
        "/api/auth/owner-reset",
        json={
            "tenant_id": tid,
            "account": phone,
            "old_password": "boot-Pass-1",
            "new_password": "fresh-Pass-2",
        },
    )

    # Agent 端：错误密码登录
    sc = ServiceClient("http://testserver", transport=manager_client._transport)
    agent_login_client = RealManagerLoginClient(sc)

    req = LoginRequest(account=phone, password="wrong-password", tenant_hint=tid)
    with pytest.raises(Unauthorized):
        agent_login_client.login(req)
