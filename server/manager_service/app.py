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
# 认证面（/api/auth/*）：登录/重置/JWKS（03 §9）。与业务路由分前缀挂载。
app.include_router(auth_router)
# employee/expert 配置（/api/manager/employees/*，M2）。verifier 由本端持有闭包注入。
app.include_router(build_employee_router(_verifier))
# 成员/部门/角色（/api/manager/members/* 等，M1）。
app.include_router(member_router)
# member_grant 授权（/api/manager/grants/*，M1）。
app.include_router(grants_router)
