"""运营端 FastAPI 应用。业务路由由 Track O 工单（11 §4）填入；认证面见 routes_auth。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from shared.app_factory import create_app, mount_frontend
from shared.auth import RS256TokenVerifier, require_claims
from shared.config import load_settings
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope

from .auth_service import build_operation_auth_service
from .routes_auth import router as auth_router
from .routes_catalog import router as catalog_router, router_pull as catalog_pull_router
from .routes_enterprise import router as enterprise_router
from .routes_rollup import router as rollup_router
from .routes_admin import build_admin_router

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


settings = load_settings("operation")
app = create_app(settings, router)
# 启动即应用运营库迁移（fail-fast；/readyz 绿时 schema 必已就绪）。原为首请求经 get_repository
# 惰性触发——服务"健康"但库空、首个请求才建表；改为启动阶段一次性 provision（幂等，get_repository
# 的惰性调用仍在，作二次幂等兜底）。无 ADMIN_DB_URL 的骨架/测试态 → 内部 no-op（契约不破）。
if settings.admin_db_url:
    from .repository import apply_migrations as _apply_oper_migrations

    _apply_oper_migrations(settings.admin_db_url, settings.app_rw_password)
# 系统账号认证服务 + 受保护端点共享验签器（挂 app.state 供业务路由运行时读取）。
app.state._operation_auth = _auth
app.state._token_verifier = _verifier
# 认证面（/api/operation/auth/*）：系统账号登录。
app.include_router(auth_router)
app.include_router(enterprise_router)
# Manager 拉取端点（服务间调用，05 F06/F07）必须先于管理路由注册：
# 管理路由含贪婪 `GET /{catalog_type}/{template_id}`，会吞掉 `/catalog/pull/expert-templates`
# 等列举端点（catalog_type="pull"），导致服务间调用错命中用户鉴权 → 401。
app.include_router(catalog_pull_router)
app.include_router(catalog_router)
app.include_router(rollup_router)
# ---- 功能补全：S01 账号管理 + S03 方案统计 + S04 财务管理 + 系统健康 ----
app.include_router(build_admin_router(_verifier))
# 前端静态托管（含 SPA fallback catch-all）必须在所有 API 路由 include 之后最后挂载（#257）。
mount_frontend(app, settings.tier)
