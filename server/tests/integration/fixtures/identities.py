"""P1-F2 身份 / service-token fixture（最终执行 DAG §5.1 P1-F2）。

覆盖后续三端测试所需的 actor 矩阵：
- operator_admin   ：平台运营管理员（PlatformRole.SYSTEM_ADMIN），无 tenant 作用域。
- manager_owner    ：企业 owner（EnterpriseRole.OWNER），tenant 作用域。
- manager_member   ：企业成员（EnterpriseRole.MEMBER），tenant 作用域。
- agent_user       ：Agent 端用户（Manager 签发 token，member 角色），tenant 作用域。
- cross_tenant_actor：另一租户的 owner——用于跨租户负向断言（不得看见目标租户数据）。
- service_token_headers / bad_service_token_headers：服务间共享密钥正/负头。

token 走真实 RS256（Manager 按 tenant 持私钥签发，用户端公钥验签，D23）：经
manager_service.keys.TenantKeyStore（管理连接 ensure 落 tenant_signing_key）。

铁律：service token 负例**不得 fail-open**——生产模式（强密钥）下缺/错 token 必须 401。
build_service_token_probe_app() 直接挂真实 verify_service_token 守卫，供契约测试硬验。
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field

import pytest

from shared.contracts.auth import TokenClaims
from shared.contracts.enums import EnterpriseRole, PlatformRole


@dataclass
class Identity:
    """一个签发好的测试身份。auth_header 直接用于受保护端点 Bearer 鉴权。"""

    user_id: str
    roles: list[str]
    tenant_id: str | None = None
    token: str | None = None
    auth_header: dict[str, str] = field(default_factory=dict)


def _sign(admin_url: str, tenant_id: str, roles: list[str], user_id: str) -> str:
    """用本 tenant 私钥签 RS256 token（ensure 落库，与端上验签器闭环）。"""
    from manager_service.keys import TenantKeyStore

    return TenantKeyStore(admin_url).signer(tenant_id).sign(
        TokenClaims(tenant_id=tenant_id, user_id=user_id, roles=roles, exp=9999999999)
    )


def make_identity(scope, roles: list[str], *, user_id: str | None = None) -> Identity:
    """在给定 tenant scope 内签发一个身份（tenant 作用域 actor 的统一工厂）。"""
    uid = user_id or str(uuid.uuid4())
    token = _sign(scope.admin_url, scope.tenant_id, roles, uid)
    return Identity(
        user_id=uid,
        roles=roles,
        tenant_id=scope.tenant_id,
        token=token,
        auth_header={"Authorization": f"Bearer {token}"},
    )


def build_service_token_probe_app(expected_token: str | None):
    """构造一个仅挂 verify_service_token 守卫的最小 FastAPI app（真实守卫，非桩）。

    供契约测试硬验"服务 token 负例不 fail-open"：生产模式（强密钥）下缺/错 token → 401。
    """
    from fastapi import Depends, FastAPI

    from shared.errors import install_exception_handlers
    from shared.service_token import verify_service_token

    app = FastAPI()
    # 统一 problem+json 错误出口：AppError(Unauthorized) -> 401，与真实三端口径一致。
    install_exception_handlers(app)

    class _Settings:
        service_token = expected_token

    app.state.settings = _Settings()

    @app.get("/svc/ping")
    def _ping(_guard=Depends(verify_service_token)) -> dict:
        return {"ok": True}

    return app


# ---- pytest fixtures ----


@pytest.fixture
def service_token() -> str:
    """当前进程配置的服务令牌（SERVICE_TOKEN）。"""
    return os.getenv("SERVICE_TOKEN", "test-service-token")


@pytest.fixture
def service_token_headers(service_token: str) -> dict[str, str]:
    """合法服务间调用头。"""
    return {"X-Service-Token": service_token}


@pytest.fixture
def bad_service_token_headers() -> dict[str, str]:
    """非法服务令牌头（负例：不得 fail-open）。"""
    return {"X-Service-Token": "wrong-" + uuid.uuid4().hex}


@pytest.fixture
def operator_admin() -> Identity:
    """平台运营管理员（无 tenant 作用域；不经 Manager tenant 私钥）。"""
    uid = str(uuid.uuid4())
    return Identity(user_id=uid, roles=[PlatformRole.SYSTEM_ADMIN.value], tenant_id=None)


@pytest.fixture
def manager_owner(tenant_scope) -> Identity:
    return make_identity(tenant_scope, [EnterpriseRole.OWNER.value])


@pytest.fixture
def manager_member(tenant_scope) -> Identity:
    return make_identity(tenant_scope, [EnterpriseRole.MEMBER.value])


@pytest.fixture
def agent_user(tenant_scope) -> Identity:
    """Agent 端用户：Manager 按同租户签发，member 角色。"""
    return make_identity(tenant_scope, [EnterpriseRole.MEMBER.value])


@pytest.fixture
def cross_tenant_actor(tenant_scope_factory) -> Identity:
    """另一独立租户的 owner——跨租户负向断言用。"""
    other = tenant_scope_factory("p1f2x")
    return make_identity(other, [EnterpriseRole.OWNER.value])
