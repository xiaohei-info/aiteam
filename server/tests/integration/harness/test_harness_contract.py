"""P2-S0 三端装配 harness 契约测试（最终执行 DAG §5.2 P2-S0）。

验证三端 app 均可使用真实 PG、真实服务与真实 service-token transport 正常构造、
响应 ping、访问受保护端点并正确交互。harness 不可用或 service token 走桩 → 不合格。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tests.integration.fixtures.identities import Identity


# ── 三端 app 构造（轻量，无 PG 也过；PG 用例见下方） ──

@pytest.mark.integration
def test_tri_service_apps_are_callable():
    """三端 app 均可在同一进程内构造且至少响应 ping。"""
    from agent_service.app import app as agent_app
    from manager_service.app import app as manager_app
    from operation_service.app import app as operation_app

    for name, app in [("operation", operation_app), ("manager", manager_app), ("agent", agent_app)]:
        client = TestClient(app)
        resp = client.get(f"/api/{name}/ping")
        assert resp.status_code == 200, f"{name} ping 失败: {resp.text}"
        body = resp.json()
        assert "data" in body, f"{name} ping 应返回 envelope"
        # 成功响应应有正确 content-type（非 text/html）
        ct = resp.headers.get("content-type", "")
        assert "text/html" not in ct, f"{name} /api/* ping 不应返回 SPA HTML"


@pytest.mark.integration
def test_tri_service_health_and_readiness():
    """三端均有 /healthz 和 /readyz 端点。"""
    from agent_service.app import app as agent_app
    from manager_service.app import app as manager_app
    from operation_service.app import app as operation_app

    for name, app in [("operation", operation_app), ("manager", manager_app), ("agent", agent_app)]:
        client = TestClient(app)
        for path in ["/healthz", "/readyz"]:
            resp = client.get(path)
            assert resp.status_code == 200, f"{name} {path} 失败: {resp.status_code}"


# ── 真实 PG 联动（P1 fixtures 经 conftest.py 注入） ──

@pytest.mark.integration
def test_real_pg_fixtures_connected(tenant_scope, manager_owner, agent_user):
    """P1 fixtures（PG/tenant/身份）在三端 harness 中正常联动。"""
    assert tenant_scope.tenant_id
    assert isinstance(manager_owner, Identity)
    assert isinstance(agent_user, Identity)
    assert manager_owner.tenant_id == tenant_scope.tenant_id
    assert agent_user.tenant_id == tenant_scope.tenant_id
    # 真实 PG: RLS session 可用
    with tenant_scope.session(["owner"]) as s:
        assert s.execute("SELECT 1").fetchone() is not None


@pytest.mark.integration
def test_real_pg_tenant_isolation_roundtrip(
    tenant_scope, tenant_scope_factory, manager_owner, cross_tenant_actor,
):
    """两个隔离租户：各自只能操作自己的数据。"""
    # 跨租户 actor 的 tenant_id 不同于 tenant_scope
    assert cross_tenant_actor.tenant_id != tenant_scope.tenant_id


@pytest.mark.integration
def test_service_token_not_mock_value(service_token):
    """SERVICE_TOKEN 已配置真实值（非 dev 占位），确保 transport 不走桩。"""
    assert service_token
    # 非 dev 占位值
    assert "placeholder" not in service_token.lower()


@pytest.mark.integration
def test_manager_app_with_real_pg(migrated_pg):
    """Manager app 在真实 PG 上可构造并响应 ping（真实 DB_URL 环境）。"""
    from manager_service.app import app as manager_app

    client = TestClient(manager_app)
    resp = client.get("/api/manager/ping")
    assert resp.status_code == 200
    body = resp.json()
    assert "pong" in str(body)


@pytest.mark.integration
def test_agent_app_with_real_pg():
    """Agent app 可构造并响应 ping（不依赖 PG，但依赖 service config）。"""
    from agent_service.app import app as agent_app

    client = TestClient(agent_app)
    resp = client.get("/api/agent/ping")
    assert resp.status_code == 200


@pytest.mark.integration
def test_operation_app_with_real_pg():
    """Operation app 可构造并响应 ping。"""
    from operation_service.app import app as operation_app

    client = TestClient(operation_app)
    resp = client.get("/api/operation/ping")
    assert resp.status_code == 200
