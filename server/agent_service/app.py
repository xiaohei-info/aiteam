"""用户端 FastAPI 应用骨架。本地主链/群聊/Loop/pull 由 Track A 工单（11 §4）逐步填入。

注意：默认仅 localhost 监听，不暴露非 localhost 入站（00 §4.2.3）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from shared.app_factory import create_app
from shared.auth import DevTokenService, require_claims
from shared.config import load_settings
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope

# ⚠️ 骨架期 DevTokenService；生产用户端只持公钥/JWKS 本地验签，绝不持签发密钥（03 §9.5/D23）。
_verifier = DevTokenService()

router = APIRouter(prefix="/api/agent", tags=["agent"])


@router.get("/ping", summary="liveness ping（演示 envelope）", operation_id="agent_ping")
async def ping() -> Envelope[dict]:
    return Envelope[dict](data={"pong": True})


@router.get("/whoami", summary="解出当前身份（演示受保护端点 401/200）", operation_id="agent_whoami")
async def whoami(claims: TokenClaims = Depends(require_claims(_verifier))) -> Envelope[TokenClaims]:
    return Envelope[TokenClaims](data=claims)


app = create_app(load_settings("agent"), router)
