"""运营端 FastAPI 应用骨架。业务路由由 Track O 工单（11 §4）逐步填入。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from shared.app_factory import create_app
from shared.auth import DevTokenService, require_claims
from shared.config import load_settings
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope

from .routes_catalog import router as catalog_router
from .routes_enterprise import router as enterprise_router

# ⚠️ 骨架期用 DevTokenService（仅 dev/测试）；生产替换为非对称验签（公钥/JWKS，03 §9.5/D23）。
_verifier = DevTokenService()

router = APIRouter(prefix="/api/operation", tags=["operation"])


@router.get("/ping", summary="liveness ping（演示 envelope）", operation_id="operation_ping")
async def ping() -> Envelope[dict]:
    return Envelope[dict](data={"pong": True})


@router.get("/whoami", summary="解出当前身份（演示受保护端点 401/200）", operation_id="operation_whoami")
async def whoami(claims: TokenClaims = Depends(require_claims(_verifier))) -> Envelope[TokenClaims]:
    return Envelope[TokenClaims](data=claims)


app = create_app(load_settings("operation"), router)
app.include_router(enterprise_router)
app.include_router(catalog_router)
