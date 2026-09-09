"""运营端 FastAPI 应用。业务路由由 Track O 工单（11 §4）填入；认证面见 routes_auth。"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

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
from .routes_platform_provider import router as platform_provider_router
from .routes_skill_market import router as skill_market_router
from .routes_admin import build_admin_router
from .platform_provider_service import newapi_urls

# 先加载配置并应用运营库迁移，再构建认证。迁移含 operation_signing_key 表，且签名密钥要
# 从该表加载/落库——故迁移必须先于 build_operation_auth_service 执行（fail-fast；/readyz 绿
# 时 schema 必已就绪）。无 ADMIN_DB_URL 的骨架/测试态 → 内部 no-op（契约不破）。
def _validate_production_startup(current_settings) -> None:
    if not current_settings.is_production:
        return
    if os.getenv("AITEAM_COMPOSE_MODE") == "1":
        raise RuntimeError("production control-plane Docker Compose is unsupported; use the local/systemd deployment")
    _, public_relay_url = newapi_urls(production=True)
    if not public_relay_url:
        raise ValueError("NEWAPI_PUBLIC_BASE_URL is required in production")


settings = load_settings("operation")
_validate_production_startup(settings)
if settings.admin_db_url:
    from .repository import apply_migrations as _apply_oper_migrations

    _apply_oper_migrations(settings.admin_db_url, settings.app_rw_password)

# 系统账号认证（§9.2）：Operation 自持系统级 RSA key，自签自验系统 token（D23 RS256）。
# 密钥来源优先级：env 显式配置 > DB 持久化（自动生成并固定，重启/多实例稳定）> 临时（无 DB）。
_auth = build_operation_auth_service(admin_db_url=settings.admin_db_url)
# 静态 RS256 验签器（Operation 单 key，无需 kid 动态解析）。
_verifier = RS256TokenVerifier.from_public_pems({_auth.kid: _auth.signer.public_pem()})

class PingOut(BaseModel):
    """运营端存活探针结果。"""

    pong: bool = Field(description="固定存活探针结果。")


router = APIRouter(prefix="/api/operation", tags=["operation"])


@router.get("/ping", summary="liveness ping（演示 envelope）", description="返回运营端固定存活结果。", operation_id="operation_ping", response_model=Envelope[PingOut])
async def ping() -> Envelope[PingOut]:
    return Envelope[PingOut](data=PingOut(pong=True))


@router.get("/whoami", summary="解出当前身份（受保护端点 401/200）", operation_id="operation_whoami")
async def whoami(claims: TokenClaims = Depends(require_claims(_verifier))) -> Envelope[TokenClaims]:
    return Envelope[TokenClaims](data=claims)


app = create_app(settings, router)
# 系统账号认证服务 + 受保护端点共享验签器（挂 app.state 供业务路由运行时读取）。
app.state._operation_auth = _auth
app.state._token_verifier = _verifier
# 认证面（/api/operation/auth/*）：系统账号登录。
app.include_router(auth_router)
app.include_router(enterprise_router)
# Platform Provider/model/rate routes precede greedy catalog routes.
app.include_router(platform_provider_router)
# Manager 拉取端点（服务间调用，05 F06/F07）必须先于管理路由注册：
# 管理路由含贪婪 `GET /{catalog_type}/{template_id}`，会吞掉 `/catalog/pull/expert-templates`
# 等列举端点（catalog_type="pull"），导致服务间调用错命中用户鉴权 → 401。
app.include_router(catalog_pull_router)
app.include_router(catalog_router)
app.include_router(rollup_router)
app.include_router(skill_market_router)
# ---- 功能补全：S01 账号管理 + S03 方案统计 + S04 财务管理 + 系统健康 ----
app.include_router(build_admin_router(_verifier))
# 前端静态托管（含 SPA fallback catch-all）必须在所有 API 路由 include 之后最后挂载（#257）。
mount_frontend(app, settings.tier)
