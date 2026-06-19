"""三端共用的 FastAPI app 工厂（09 §14.2；02 §10.3）。

统一装配：可观测中间件、problem+json 异常处理、健康/就绪端点、OpenAPI 文档入口。
各端服务只需提供自己的 APIRouter（前缀 /api/<tier>），不重复造壳（CLAUDE/AGENTS §3.10 底座统一）。
"""

from __future__ import annotations

from fastapi import APIRouter, FastAPI

from shared.config import Settings
from shared.errors import install_exception_handlers
from shared.observability import RequestContextMiddleware, configure_logging


def create_app(settings: Settings, router: APIRouter) -> FastAPI:
    configure_logging(settings.service_name, settings.log_level)

    app = FastAPI(
        title=f"AI Team {settings.tier} service",
        docs_url="/docs" if settings.expose_public_docs else None,
        redoc_url="/redoc" if settings.expose_public_docs else None,
        openapi_url="/openapi.json",
    )
    app.state.settings = settings

    app.add_middleware(RequestContextMiddleware)
    install_exception_handlers(app)

    @app.get("/healthz", tags=["infra"], summary="liveness")
    async def healthz() -> dict:  # noqa: ANN202
        return {"status": "ok", "service": settings.service_name}

    @app.get("/readyz", tags=["infra"], summary="readiness")
    async def readyz() -> dict:  # noqa: ANN202
        # 只校验本端依赖；上端不可达按"可降级 pull"对待，不致本端 not-ready（CLAUDE/AGENTS §13）。
        return {"status": "ready", "service": settings.service_name}

    app.include_router(router)
    return app
