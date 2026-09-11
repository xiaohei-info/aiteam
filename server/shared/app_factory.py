"""三端共用的 FastAPI app 工厂（09 §14.2；02 §10.3）。

统一装配：可观测中间件、problem+json 异常处理、健康/就绪端点、OpenAPI 文档入口。
各端服务只需提供自己的 APIRouter（前缀 /api/<tier>），不重复造壳（CLAUDE/AGENTS §3.10 底座统一）。

前端静态托管由各端 app.py 在**所有 API 路由注册之后**显式调用 ``mount_frontend(app, tier)``
完成——绝不在 create_app 内部挂载，否则 SPA fallback catch-all ``GET /{full_path:path}``
会遮蔽此后才 include 的 GET API 路由（#257）。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from shared.config import Settings
from shared.errors import NotFound, ServiceUnavailable, install_exception_handlers
from shared.observability import RequestContextMiddleware, RequestMetrics, configure_logging
from shared.openapi import install_openapi_enrichment

logger = logging.getLogger(__name__)

_READINESS_RELATIONS = {
    "operation": "enterprise_account",
    "manager": "tenant_registry",
}
_READINESS_CONNECT_TIMEOUT_SECONDS = 5
_READINESS_ROLE_SQL = (
    "SELECT current_user, session_user, rolsuper, rolbypassrls "
    "FROM pg_roles WHERE rolname = current_user"
)


def _readiness_target(settings: Settings) -> tuple[str, str]:
    """Return the operational DSN and required schema relation for one control plane."""
    if settings.tier == "manager":
        # Manager has two local connection boundaries: app_rw serves tenant SQL,
        # while the admin DSN serves control-plane schema and signing keys.
        if not settings.db_url or not settings.admin_db_url:
            raise ServiceUnavailable("本端数据库连接未完整配置")
        return settings.db_url, _READINESS_RELATIONS[settings.tier]
    # Operation readiness probes the app_rw business DSN; ADMIN_DB_URL is only
    # for migrations and signing-key administration.
    if not settings.db_url:
        raise ServiceUnavailable("本端业务数据库未配置")
    return settings.db_url, _READINESS_RELATIONS[settings.tier]


def _readiness_targets(settings: Settings) -> tuple[tuple[str, str, str], ...]:
    """Return local readiness probes as (dsn, relation, boundary) tuples."""
    dsn, relation = _readiness_target(settings)
    targets = [(dsn, relation, "business")]
    if settings.tier == "manager":
        # _readiness_target already fails closed when either boundary is absent.
        assert settings.admin_db_url is not None
        targets.append((settings.admin_db_url, relation, "management"))
    return tuple(targets)


def _check_readiness_role(conn: object, settings: Settings, boundary: str) -> None:
    """Enforce direct connection identity without exposing role details."""
    if not settings.is_production:
        return
    role = conn.execute(_READINESS_ROLE_SQL).fetchone()  # type: ignore[attr-defined]
    direct = bool(role) and role[0] == role[1]
    if boundary == "business":
        valid = direct and role[0] == "app_rw" and role[2] is False and role[3] is False
        detail = "本端业务数据库角色不符合 app_rw 隔离要求"
    else:
        # The admin boundary must remain a direct, distinct migration/admin
        # identity; it must never silently fall back to app_rw.
        valid = direct and role[0] != "app_rw"
        detail = "本端管理数据库角色不符合管理连接隔离要求"
    if not valid:
        logger.warning(
            "local database readiness check failed: service=%s reason=%s",
            settings.service_name,
            "business_role" if boundary == "business" else "admin_role",
        )
        raise ServiceUnavailable(detail)


def _check_local_readiness(settings: Settings) -> None:
    """Check only this service's local database boundaries and schema.

    This deliberately does not inspect MANAGER_TENANT_ID or any upstream service:
    tenant selection is request/JWT scoped, and upstream outages are a degraded
    dependency rather than a reason for the local control plane to claim it is
    not ready.
    """
    try:
        targets = _readiness_targets(settings)
    except ServiceUnavailable:
        logger.warning("local database readiness check failed: service=%s reason=unconfigured", settings.service_name)
        raise

    try:
        import psycopg

        for dsn, relation, boundary in targets:
            with psycopg.connect(
                dsn,
                autocommit=True,
                connect_timeout=_READINESS_CONNECT_TIMEOUT_SECONDS,
            ) as conn:
                _check_readiness_role(conn, settings, boundary)
                row = conn.execute(
                    "SELECT to_regclass(%s)",
                    (f"public.{relation}",),
                ).fetchone()
            if not row or row[0] is None:
                logger.warning(
                    "local database readiness check failed: service=%s reason=schema_missing boundary=%s",
                    settings.service_name,
                    boundary,
                )
                raise ServiceUnavailable("本端数据库 schema 尚未就绪")
    except ServiceUnavailable:
        # Preserve explicit role/schema failures while keeping the response free
        # of DSNs and other connection details.
        raise
    except Exception as exc:  # noqa: BLE001 - readiness must fail closed without exposing DSN details
        logger.warning("local database readiness check failed: service=%s reason=unreachable", settings.service_name)
        raise ServiceUnavailable("本端数据库不可用") from exc


class HealthResponse(BaseModel):
    """Standard liveness/readiness response."""

    status: str = Field(description="服务状态。")
    service: str = Field(description="服务名称。")


def create_app(settings: Settings, router: APIRouter) -> FastAPI:
    if settings.is_production and os.getenv("AITEAM_COMPOSE_MODE") == "1":
        raise ValueError("production control-plane Docker Compose is unsupported; use the local/systemd deployment")
    if settings.is_production and settings.expose_public_docs:
        raise ValueError("production control-plane services must disable public OpenAPI docs")
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
        openapi_url="/openapi.json" if (not settings.is_production or settings.expose_public_docs) else None,
    )
    app.state.settings = settings
    # Metrics are process-local and intentionally contain only low-cardinality
    # HTTP labels; no request body, query string, tenant id, or runtime event is
    # retained.
    app.state.metrics = RequestMetrics()

    app.add_middleware(RequestContextMiddleware)
    install_exception_handlers(app)
    # Apply the shared OpenAPI policy after router inclusion; the wrapper defers
    # generation until the first request so every mounted endpoint is visible.
    install_openapi_enrichment(app, settings.tier)

    @app.get("/healthz", tags=["infra"], summary="liveness", description="检查服务进程是否存活。", response_model=HealthResponse)
    async def healthz(request: Request) -> HealthResponse:
        runtime_settings = request.app.state.settings
        return HealthResponse(status="ok", service=runtime_settings.service_name)

    @app.get(
        "/readyz",
        tags=["infra"],
        summary="readiness",
        description="检查本端数据库和本地依赖是否可用。Manager 不要求 MANAGER_TENANT_ID。",
        response_model=HealthResponse,
    )
    async def readyz(request: Request) -> HealthResponse:
        # 只校验本端依赖；上端不可达按"可降级 pull"对待，不致本端 not-ready（CLAUDE/AGENTS §13）。
        # Read settings from app state at request time so dependency-injected test
        # apps and any explicit runtime settings replacement are evaluated by the
        # same source as the rest of the application.
        # Manager tenants are session-scoped; leftover MANAGER_TENANT_ID is not a
        # readiness pin and registry first-row inference is forbidden.
        runtime_settings = request.app.state.settings
        _check_local_readiness(runtime_settings)
        return HealthResponse(status="ready", service=runtime_settings.service_name)

    @app.get(
        "/metrics",
        tags=["infra"],
        summary="metrics",
        description="返回不含请求内容、租户标识或运行时事件的低基数 Prometheus 指标。",
        include_in_schema=True,
        response_class=PlainTextResponse,
    )
    async def metrics(request: Request) -> Response:
        collector = request.app.state.metrics
        return PlainTextResponse(
            content=collector.render(),
            media_type="text/plain; version=0.0.4",
        )

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
    async def serve_spa_fallback(request: Request, full_path: str) -> FileResponse:
        reserved_namespace = (
            full_path == "api"
            or full_path.startswith("api/")
            or full_path == "metrics"
            or full_path.startswith("metrics/")
        )
        if reserved_namespace or full_path.startswith(("healthz", "readyz", "docs", "redoc", "openapi.json")):
            # Keep both problem detail and the generated instance free from the
            # caller-controlled path (which may contain a token or prompt text).
            request.scope["path"] = "/__not_found__"
            request.scope["raw_path"] = b"/__not_found__"
            raise NotFound("route not found")
        return FileResponse(frontend_dist / "index.html")

    logger.info(f"前端静态托管已启用: {frontend_dist} -> / (tier={tier})")
