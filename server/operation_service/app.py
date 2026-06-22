"""运营端 FastAPI 应用。业务路由由 Track O 工单（11 §4）填入；认证面见 routes_auth。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from shared.app_factory import create_app
from shared.auth import RS256TokenVerifier, require_claims
from shared.config import load_settings
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope

from .auth_service import build_operation_auth_service
from .routes_auth import router as auth_router
from .routes_catalog import router as catalog_router
from .routes_enterprise import router as enterprise_router
from .routes_rollup import router as rollup_router

# 系统账号认证（§9.2）：Operation 自持系统级 RSA key，自签自验系统 token（D23 RS256）。
_auth = build_operation_auth_service()
# 静态 RS256 验签器（Operation 单 key，无需 kid 动态解析）。
_verifier = RS256TokenVerifier.from_public_pems({_auth.kid: _auth.signer.public_pem()})

router = APIRouter(prefix="/api/operation", tags=["operation"])


@router.get("/ping", summary="liveness ping（演示 envelope）", operation_id="operation_ping")
async def ping() -> Envelope[dict]:
    return Envelope[dict](data={"pong": True})


@router.get("/whoami", summary="解出当前身份（受保护端点 401/200）", operation_id="operation_whoami")
async def whoami(claims: TokenClaims = Depends(require_claims(_verifier))) -> Envelope[TokenClaims]:
    return Envelope[TokenClaims](data=claims)


app = create_app(load_settings("operation"), router)
# 系统账号认证服务 + 受保护端点共享验签器（挂 app.state 供业务路由运行时读取）。
app.state._operation_auth = _auth
app.state._token_verifier = _verifier
# 认证面（/api/operation/auth/*）：系统账号登录。
app.include_router(auth_router)
app.include_router(enterprise_router)
app.include_router(catalog_router)
app.include_router(rollup_router)
