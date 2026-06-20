"""企业端 FastAPI 应用骨架。业务路由由 Track M 工单（11 §4）逐步填入。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from shared.app_factory import create_app
from shared.auth import DevTokenService, require_claims
from shared.config import load_settings
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope

from .routes_auth import router as auth_router
from .routes_employee import build_employee_router
from .routes_member import router as member_router
from .routes_grants import router as grants_router
from .routes_knowledge_space import build_knowledge_space_router
from .routes_provider import build_provider_credential_router
from .routes_recruit import build_recruit_router
from .operator_catalog import FakeOperatorCatalogClient
from .routes_usage_audit_quota import build_usage_audit_quota_router
from .routes_snapshot import build_snapshot_router

# ⚠️ 骨架期 DevTokenService（仅 /whoami 演示）；生产受保护端点用 tenant 公钥/JWKS 验签（D23）。
_verifier = DevTokenService()

router = APIRouter(prefix="/api/manager", tags=["manager"])


@router.get("/ping", summary="liveness ping（演示 envelope）", operation_id="manager_ping")
async def ping() -> Envelope[dict]:
    return Envelope[dict](data={"pong": True})


@router.get("/whoami", summary="解出当前身份（演示受保护端点 401/200）", operation_id="manager_whoami")
async def whoami(claims: TokenClaims = Depends(require_claims(_verifier))) -> Envelope[TokenClaims]:
    return Envelope[TokenClaims](data=claims)


app = create_app(load_settings("manager"), router)
# 受保护端点共享的 token 验签器（挂 app.state 供业务路由引用，03 §9.6）。
app.state._token_verifier = _verifier
# Operator 目录拉取端口（05 F06/F07，本卡 Operator 侧先 mock；生产注入真实 OperatorCatalogClient）。
app.state._operator_catalog = FakeOperatorCatalogClient()
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
from .routes_capability import build_capability_router  # noqa: E402
app.include_router(build_capability_router(_verifier))
# provider 凭据/AI Relay 管理面（/api/manager/provider-credentials/*，M5）。
app.include_router(build_provider_credential_router(_verifier))
# 招募专家/应用方案（/api/manager/recruit/*，M6，F06/F07，D12）。Operator 目录拉取先 mock。
app.include_router(build_recruit_router(_verifier))
# usage/audit rollup + 软配额治理（/api/manager/usage/*、/audits、/quota-policies/*，M8）。
app.include_router(build_usage_audit_quota_router(_verifier))
# 执行快照生成（/api/manager/snapshots，M7，05 F11 / D5）。Agent 主动拉取，用户端本地冻结。
app.include_router(build_snapshot_router(_verifier))
