"""P1-F2 契约：身份 / service-token fixture（integration，真 PG）。

锁住 closeout DAG P1-F2 acceptance：覆盖 operator/manager/agent/service-token/cross-tenant
actor；service token 负例不 fail-open。
无 DB_URL/ADMIN_DB_URL 时整组 skip。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from shared.contracts.enums import EnterpriseRole, PlatformRole
from tests.integration.fixtures.identities import build_service_token_probe_app

pytestmark = pytest.mark.integration


def test_actor_matrix_roles_and_scope(
    operator_admin, manager_owner, manager_member, agent_user, cross_tenant_actor
):
    assert operator_admin.roles == [PlatformRole.SYSTEM_ADMIN.value]
    assert operator_admin.tenant_id is None  # 平台账号无 tenant 作用域

    assert manager_owner.roles == [EnterpriseRole.OWNER.value]
    assert manager_member.roles == [EnterpriseRole.MEMBER.value]
    assert agent_user.roles == [EnterpriseRole.MEMBER.value]

    # owner / member / agent 同一租户；cross_tenant_actor 在另一租户。
    assert manager_owner.tenant_id == manager_member.tenant_id == agent_user.tenant_id
    assert cross_tenant_actor.tenant_id != manager_owner.tenant_id


def test_manager_token_verifies_with_tenant_key(manager_owner, tenant_scope):
    """签发的 RS256 token 能被本租户验签器验回（Manager 私钥/公钥闭环，D23）。"""
    from manager_service.keys import TenantKeyStore

    verifier = TenantKeyStore(tenant_scope.admin_url).verifier(tenant_scope.tenant_id)
    claims = verifier.verify(manager_owner.token)
    assert claims.tenant_id == tenant_scope.tenant_id
    assert EnterpriseRole.OWNER.value in claims.roles
    assert manager_owner.auth_header["Authorization"] == f"Bearer {manager_owner.token}"


def test_cross_tenant_token_rejected_by_target_verifier(cross_tenant_actor, tenant_scope):
    """跨租户 actor 的 token 不被目标租户验签器接受（kid 不属本租户 -> 拒）。"""
    from shared.errors import Unauthorized
    from manager_service.keys import TenantKeyStore

    verifier = TenantKeyStore(tenant_scope.admin_url).verifier(tenant_scope.tenant_id)
    with pytest.raises(Unauthorized):
        verifier.verify(cross_tenant_actor.token)


def test_service_token_negative_does_not_fail_open():
    """生产模式（强密钥）下缺/错 X-Service-Token -> 401，绝不 fail-open。"""
    app = build_service_token_probe_app("prod-strong-secret")
    client = TestClient(app, raise_server_exceptions=False)

    assert client.get("/svc/ping").status_code == 401  # 缺 token
    assert client.get("/svc/ping", headers={"X-Service-Token": "wrong"}).status_code == 401
    assert (
        client.get("/svc/ping", headers={"X-Service-Token": "prod-strong-secret"}).status_code
        == 200
    )


def test_service_token_unconfigured_fail_closed_401():
    """未配置 SERVICE_TOKEN（expected=None）=> fail-closed 拒绝（AITEAM-331 B2）。

    旧合同：未配置 => `_is_dev_mode(None)=True` => fail-open 放行。修复后 fail-closed：未配置
    SERVICE_TOKEN 代表生产误配置，必须 401。真正的 dev profile 唯一允许 `dev-service-token-placeholder`
    （由 build_service_token_probe_app("dev-service-token-placeholder") 显式声明）。
    """
    app = build_service_token_probe_app(None)
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/svc/ping").status_code == 401


def test_service_token_dev_placeholder_fail_open():
    """dev 占位值 `dev-service-token-placeholder` 在显式 dev profile 下 fail-open（AITEAM-331 B2）。"""
    app = build_service_token_probe_app("dev-service-token-placeholder", aiteam_env="development")
    client = TestClient(app, raise_server_exceptions=False)
    # 占位值：无 X-Service-Token → fail-open（日志提醒，不阻断）。
    assert client.get("/svc/ping").status_code == 200


def test_service_token_headers_fixtures(service_token_headers, bad_service_token_headers):
    assert "X-Service-Token" in service_token_headers
    assert bad_service_token_headers["X-Service-Token"].startswith("wrong-")
