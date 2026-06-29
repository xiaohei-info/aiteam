"""企业端 FastAPI 应用骨架。业务路由由 Track M 工单（11 §4）逐步填入。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from shared.app_factory import create_app, mount_frontend
from shared.auth import DynamicRS256TokenVerifier, RejectingTokenVerifier, require_claims
from shared.config import load_settings
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope

from .keys import TenantKeyStore
from .routes_auth import router as auth_router
from .routes_bootstrap import router as bootstrap_router
from .routes_capability import build_capability_router
from .routes_employee import build_employee_router
from .routes_grants import router as grants_router
from .routes_knowledge_space import build_knowledge_space_router
from .routes_member import router as member_router
from .routes_provider import build_provider_credential_router
from .routes_recruit import build_recruit_router
from .routes_snapshot import build_snapshot_router
from .routes_tenant import router as tenant_router
from .routes_usage_audit_quota import build_usage_audit_quota_router
from .operator_catalog import FakeOperatorCatalogClient, OperatorCatalogClient


def _build_operator_catalog():
    """构造 Operator 目录拉取客户端（05 F06/F07，#176）。

    有 operator_url → OperatorCatalogClient（真实 HTTP 客户端）；
    无 operator_url → FakeOperatorCatalogClient（测试/骨架期内存 fake）。
    """
    settings = load_settings("manager")
    operator_url = settings.operator_url
    if not operator_url:
        # dev/测试环境未配置 OPERATOR_URL，使用 Fake 客户端
        return FakeOperatorCatalogClient()
    # 生产环境，使用真实 HTTP 客户端
    return OperatorCatalogClient(
        base_url=operator_url,
        service_identity=settings.service_name,
        service_token=settings.service_token,
    )


def _build_verifier():
    """构造受保护端点验签器（D23 RS256）。

    有 admin_db_url → DynamicRS256TokenVerifier：从 token header kid 解析 tenant_id，
    经 TenantKeyStore（admin 连接）查公钥验签。无 admin_db_url → RejectingTokenVerifier
    恒 401（密钥库未配置不静默放行；dev 无 DB 时受保护端点本就需要 DB 才有意义）。
    """
    settings = load_settings("manager")
    admin_dsn = settings.admin_db_url
    if not admin_dsn:
        return RejectingTokenVerifier("manager signing key store unconfigured (ADMIN_DB_URL)")
    key_store = TenantKeyStore(admin_dsn)
    return DynamicRS256TokenVerifier(key_store.public_pem_for_kid)


_verifier = _build_verifier()

router = APIRouter(prefix="/api/manager", tags=["manager"])


@router.get("/ping", summary="liveness ping（演示 envelope）", operation_id="manager_ping")
async def ping() -> Envelope[dict]:
    return Envelope[dict](data={"pong": True})


@router.get("/whoami", summary="解出当前身份（演示受保护端点 401/200）", operation_id="manager_whoami")
async def whoami(claims: TokenClaims = Depends(require_claims(_verifier))) -> Envelope[TokenClaims]:
    return Envelope[TokenClaims](data=claims)


settings = load_settings("manager")
app = create_app(settings, router)
# 受保护端点共享的 token 验签器（挂 app.state 供业务路由引用，03 §9.6）。
app.state._token_verifier = _verifier
# Operator 目录拉取端口（05 F06/F07，#176）。有 OPERATOR_URL → 真实客户端；无 → Fake。
app.state._operator_catalog = _build_operator_catalog()
# 认证面（/api/auth/*）：登录/重置/JWKS（03 §9）。与业务路由分前缀挂载。
app.include_router(auth_router)
# employee/expert 配置（/api/manager/employees/*，M2）。verifier 由本端持有闭包注入。
app.include_router(build_employee_router(_verifier))
# 成员/部门/角色（/api/manager/members/* 等，M1）。
app.include_router(member_router)
# member_grant 授权（/api/manager/grants/*，M1）。
app.include_router(grants_router)
# 知识空间/RAG 管理面（/api/manager/knowledge-spaces/*，M3）。verifier 由本端持有闭包注入。
app.include_router(build_knowledge_space_router(_verifier))
# 技能/连接器/记忆策略 目录（/api/manager/skills|connectors|memory-policies/*，M4）。
app.include_router(build_capability_router(_verifier))
# provider 凭据/AI Relay 管理面（/api/manager/provider-credentials/*，M5）。
app.include_router(build_provider_credential_router(_verifier))
# 招募专家/应用方案（/api/manager/recruit/*，M6，F06/F07，D12）。Operator 目录拉取先 mock。
app.include_router(build_recruit_router(_verifier))
# usage/audit rollup + 软配额治理（/api/manager/usage/*、/audits、/quota-policies/*，M8）。
app.include_router(build_usage_audit_quota_router(_verifier))
# 执行快照生成（/api/manager/snapshots，M7，05 F11 / D5）。Agent 主动拉取，用户端本地冻结。
app.include_router(build_snapshot_router(_verifier))
# F01/F02 控制面收端（Operator→Manager 云侧调用，05 §5.1 D4）。无 token 校验（服务间调用）。
app.include_router(tenant_router)
app.include_router(bootstrap_router)
# 前端静态托管（含 SPA fallback catch-all）必须在所有 API 路由 include 之后最后挂载（#257），
# 否则 catch-all `GET /{full_path:path}` 会遮蔽后注册的 GET API 路由（如 jwks）→ 404。
mount_frontend(app, settings.tier)
