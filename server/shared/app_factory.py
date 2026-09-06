"""三端共用的 FastAPI app 工厂（09 §14.2；02 §10.3）。

统一装配：可观测中间件、problem+json 异常处理、健康/就绪端点、OpenAPI 文档入口。
各端服务只需提供自己的 APIRouter（前缀 /api/<tier>），不重复造壳（CLAUDE/AGENTS §3.10 底座统一）。

前端静态托管由各端 app.py 在**所有 API 路由注册之后**显式调用 ``mount_frontend(app, tier)``
完成——绝不在 create_app 内部挂载，否则 SPA fallback catch-all ``GET /{full_path:path}``
会遮蔽此后才 include 的 GET API 路由（#257）。
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from shared.config import Settings
from shared.errors import AppError, NotFound, install_exception_handlers
from shared.observability import RequestContextMiddleware, configure_logging
from shared.openapi import install_openapi_enrichment

logger = logging.getLogger(__name__)


class _ManagerBindingRequired(AppError):
    status, code, title = 503, "manager_binding_required", "Manager Binding Required"


class _ManagerBindingUnavailable(AppError):
    status, code, title = 503, "manager_binding_unavailable", "Manager Binding Unavailable"


class HealthResponse(BaseModel):
    """Standard liveness/readiness response."""

    status: str = Field(description="服务状态。")
    service: str = Field(description="服务名称。")


def create_app(settings: Settings, router: APIRouter) -> FastAPI:
    configure_logging(settings.service_name, settings.log_level)

    app = FastAPI(
        title=f"AI Team {settings.tier} service",
        description=(
            "AI Team v1 "
            + ("运营端" if settings.tier == "operation" else "企业端")
            + " API；响应遵循统一 envelope 与 problem+json 契约。"
        ),
        docs_url="/docs" if settings.expose_public_docs else None,
        redoc_url="/redoc" if settings.expose_public_docs else None,
        openapi_url="/openapi.json",
    )
    app.state.settings = settings

    app.add_middleware(RequestContextMiddleware)
    install_exception_handlers(app)
    # Apply the shared OpenAPI policy after router inclusion; the wrapper defers
    # generation until the first request so every mounted endpoint is visible.
    install_openapi_enrichment(app, settings.tier)

    @app.get("/healthz", tags=["infra"], summary="liveness", description="检查服务进程是否存活。", response_model=HealthResponse)
    async def healthz() -> HealthResponse:
        return HealthResponse(status="ok", service=settings.service_name)

    readyz_responses = (
        {503: {"description": "Manager 尚未绑定唯一部署企业；返回 problem+json。"}}
        if settings.tier == "manager" else {}
    )

    @app.get(
        "/readyz",
        tags=["infra"],
        summary="readiness",
        description="检查本端数据库和本地依赖是否可用。",
        response_model=HealthResponse,
        responses=readyz_responses,
    )
    async def readyz() -> HealthResponse:
        # 只校验本端依赖；上端不可达按"可降级 pull"对待，不致本端 not-ready（CLAUDE/AGENTS §13）。
        # A Manager without an explicit deployment tenant is not ready: there
        # is no safe tenant to bind, and readiness must not imply that a random
        # tenant_registry row will be used.
        if settings.tier == "manager":
            if not getattr(settings, "manager_tenant_id", None):
                raise _ManagerBindingRequired("Manager deployment tenant binding is required")
            if getattr(app.state, "_manager_binding_ready", True) is False:
                raise _ManagerBindingUnavailable("Manager deployment tenant binding is unavailable")
        return HealthResponse(status="ready", service=settings.service_name)

    app.include_router(router)

    # 注意：前端静态托管（含 SPA fallback catch-all）不在此处挂载——由各端 app.py 在
    # 所有 include_router 之后最后调用 mount_frontend(app, settings.tier)（#257）。
    # 若在此挂载，后注册的 GET API 路由会被 catch-all 遮蔽 → 404。

    return app


def mount_frontend(app: FastAPI, tier: str) -> None:
    """挂载本端前端静态产物到根路径。

    必须在各端 app.py 的**所有 API 路由 include 之后**最后调用（#257）：
    SPA fallback 注册 catch-all ``GET /{full_path:path}``，Starlette 按注册顺序匹配，
    若在 API 路由之前注册，后注册的 GET API 路由会被遮蔽。

    Args:
        app: FastAPI 应用实例
        tier: 端标识（operation / manager / agent）

    前端访问：
    - / → index.html（SPA 入口）
    - /assets/* → 静态资源（JS/CSS/图片等）
    - API 调用仍走 /api/<tier>/* 不受影响
    """
    # 计算前端构建产物路径：server/../web/<tier>/dist
    server_dir = Path(__file__).parent.parent  # server/
    frontend_dist = server_dir.parent / "web" / tier / "dist"

    if not frontend_dist.exists():
        logger.warning(
            f"前端构建产物不存在，跳过静态托管: {frontend_dist} "
            f"(运行 'cd web && pnpm build' 构建前端)"
        )
        return

    # 挂载静态资源目录（/assets/*, /favicon.ico 等）
    app.mount(
        "/assets",
        StaticFiles(directory=str(frontend_dist / "assets")),
        name="static_assets",
    )

    # 根路径返回 index.html（SPA 入口）
    @app.get("/", include_in_schema=False)
    async def serve_spa_root() -> FileResponse:
        return FileResponse(frontend_dist / "index.html")

    # SPA 路由回退：只服务前端路由；保留后端路径继续返回 problem+json。
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa_fallback(full_path: str) -> FileResponse:
        if full_path.startswith(("api/", "healthz", "readyz", "docs", "redoc", "openapi.json")):
            raise NotFound(f"route not found: /{full_path}")
        return FileResponse(frontend_dist / "index.html")

    logger.info(f"前端静态托管已启用: {frontend_dist} -> / (tier={tier})")
