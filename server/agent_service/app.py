"""用户端（Agent Service）FastAPI 应用（A0）。

本地登录（03 §9.4C）：公开 login 端点经 Manager 校验凭据，缓存 token + 验签材料，
此后本地无状态验签（whoami）。业务主链 / 群聊 / Loop / 用量上报 / 授权 / workspace /
terminal 等路由均已在此装配注册（各 service 自带 router）。

注意：默认仅 localhost 监听，不暴露非 localhost 入站（00 §4.2.3）；
用户端只持验签材料，绝不持可签发 token 的密钥（03 §9.5/D23）。
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request

from agent_service.auth.local_login import (
    LocalLoginService,
    LoginRequest,
    LoginResult,
    ManagerLoginClient,
    PasswordResetRequest,
)
from agent_service.auth.manager_client import (
    RealManagerLoginClient,
    UnconfiguredManagerClient,
)
from agent_service.auth.token_cache import InMemoryTokenCache
from agent_service.grants.client import (
    ManagerGrantsClient,
    ServiceClientGrantsClient,
    UnconfiguredGrantsClient,
)
from agent_service.grants.factory import build_grants_service
from agent_service.grants.routes import build_grants_router
from agent_service.grants.store import (
    InMemoryProjectionRepository,
    InMemorySolutionProjectionRepository,
    ProjectionRepository,
    SolutionProjectionRepository,
    SqliteProjectionRepository,
    SqliteSolutionProjectionRepository,
)
from agent_service.loop.factory import build_loop_service
from agent_service.loop.routes import build_loop_router
from agent_gateway.runtime_readiness import check_runtime_readiness
from agent_service.mainline.factory import build_execution_orchestrator, build_mainline_service
from agent_service.mainline.routes import build_mainline_router
from agent_service.mainline.service import MainlineService
from agent_service.usage.client import (
    ManagerUsageClient,
    ServiceClientUsageClient,
    UnconfiguredUsageClient,
)
from agent_service.usage.factory import build_run_usage_recorder, build_usage_service
from agent_service.usage.routes import build_usage_router
from agent_service.workspace.factory import build_workspace_service
from agent_service.workspace.marketplace_provider import ManagerMarketplaceProvider
from agent_service.workspace.routes import build_workspace_router
from agent_service.group_mgmt.routes import build_group_mgmt_router
from agent_service.group_mgmt.factory import build_group_mgmt_service
from agent_service.terminal.factory import build_terminal_service as _build_terminal_service
from agent_service.terminal.routes import build_terminal_router
from shared.app_factory import create_app, mount_frontend
from shared.config import load_settings
from shared.service_client import ServiceClient
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.errors import Unauthorized

# 用户端只持 Manager 下发的公钥/JWKS 做本地无状态验签（03 §9.5/D23）；唯一验签入口是
# LocalLoginService（经 token_cache 缓存的 JWKS）。whoami 复用 current_identity，
# 无独立 verifier——本进程内验签口径一致（登录缓存 RS256 token，whoami 同源验签）。


def build_router(login_service: LocalLoginService) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent"])

    @router.get("/ping", summary="liveness ping（演示 envelope）", operation_id="agent_ping")
    async def ping() -> Envelope[dict]:
        return Envelope[dict](data={"pong": True})

    @router.get(
        "/health",
        summary="runtime readiness（AITEAM-688）",
        description="返回当前部署 runtime 的就绪状态、CLI/capabilities；runtime_not_ready 时附原因。",
        operation_id="agent_health",
    )
    async def health(request: Request) -> Envelope[dict]:
        # 读 build_app 时冻结的 settings（app.state.settings），避免请求期 env 漂移。
        _s = getattr(request.app.state, "settings", None) or load_settings("agent")
        readiness = check_runtime_readiness(
            _s.agent_runtime, production=_s.is_production
        )
        return Envelope[dict](data=readiness.model_dump(mode="json"))

    @router.post("/login", summary="本地登录（首次在线取 token）", operation_id="agent_login")
    async def login(req: LoginRequest) -> Envelope[LoginResult]:
        # 公开端点（§9.6）：不挂 require_claims。校验在 Manager；用户端只缓存 + 本地验签。
        session = login_service.login(req)
        return Envelope[LoginResult](
            data=LoginResult(token=session.token, claims=session.claims)
        )

    @router.post(
        "/reset-password",
        summary="密码重置（首次登录强制重置 / 忘记密码）",
        operation_id="agent_reset_password",
    )
    async def reset_password(req: PasswordResetRequest) -> Envelope[LoginResult]:
        # 公开端点：不挂 require_claims。经 Manager owner-reset 校验旧密码 + 设新密码，
        # 缓存 token + JWKS，返回本地会话（与 login 对称）。
        session = login_service.reset_password(req)
        return Envelope[LoginResult](
            data=LoginResult(token=session.token, claims=session.claims)
        )

    @router.get("/whoami", summary="解出当前身份（本地无状态验签）", operation_id="agent_whoami")
    async def whoami() -> Envelope[TokenClaims]:
        # 复用 LocalLoginService 的本地 RS256 验签（JWKS 缓存）；无有效会话 → 401。
        claims = login_service.current_identity()
        if claims is None:
            raise Unauthorized("no valid local session")
        return Envelope[TokenClaims](data=claims)

    return router


def _manager_service_client(settings) -> ServiceClient:
    """构造指向 Manager 的窄通信 ServiceClient（服务身份 + 共享 token，03 §9.1）。"""
    return ServiceClient(
        base_url=settings.manager_url,
        service_identity=settings.service_name,
        service_token=settings.service_token,
    )


def _build_manager_login_client() -> ManagerLoginClient:
    """配置 MANAGER_URL → RealManagerLoginClient，否则占位（D14 离线降级，#219）。

    对齐 Manager 侧 _build_operator_catalog 装配模式。
    """
    settings = load_settings("agent")
    if not settings.manager_url:
        return UnconfiguredManagerClient()
    return RealManagerLoginClient(_manager_service_client(settings))


def _build_grants_client(token_provider=None) -> ManagerGrantsClient:
    """配置 MANAGER_URL → ServiceClientGrantsClient，否则占位（#219）。
    当 ``token_provider`` 给出时，pull 请求附带用户 Bearer token，通过 Manager 的
    ``require_Claims`` 鉴权。
    """
    settings = load_settings("agent")
    if not settings.manager_url:
        return UnconfiguredGrantsClient()
    sc = _manager_service_client(settings)
    sc._user_token_provider = token_provider
    return ServiceClientGrantsClient(sc, user_token_provider=token_provider)


def _build_usage_client() -> ManagerUsageClient:
    """配置 MANAGER_URL → ServiceClientUsageClient，否则占位（#219）。"""
    settings = load_settings("agent")
    if not settings.manager_url:
        return UnconfiguredUsageClient()
    return ServiceClientUsageClient(_manager_service_client(settings))


def _attach_usage_recorder(mainline, usage_service) -> None:
    """把 usage 回流钩子接到 mainline；mainline 若不支持（测试替身）则静默跳过。"""
    setter = getattr(mainline, "set_usage_recorder", None)
    if callable(setter):
        setter(build_run_usage_recorder(usage_service))


def _upload_dir() -> Path:
    """用户端上传文件本地目录。优先 AGENT_UPLOAD_DIR，其次 ~/.aiteam-agent/uploads。"""
    import os
    env = os.getenv("AGENT_UPLOAD_DIR")
    if env:
        return Path(env)
    return Path.home() / ".aiteam-agent" / "uploads"


def _build_marketplace_provider(login_service) -> ManagerMarketplaceProvider:
    """按 MANAGER_URL 装配人才市场 provider：配置 → Manager pull（AITEAM-672）。

    未配置 MANAGER_URL 时仍返回 provider，但 list_templates 会抛
    MarketplaceProviderError，表面真实部署配置错误而非静默降级假数据。
    模板列表端点 /marketplace/templates 会在每次请求前尝试一次 login 后的 sync，
    登录成功后才加载真实 Manager 目录。
    """
    settings = load_settings("agent")
    client = _manager_service_client(settings) if settings.manager_url else None
    # 与 grants client 同一模式：把 user_token_provider 挂到 ServiceClient 上，
    # 让 _headers() 自动附加 Authorization: Bearer <token>（AITEAM-672）。
    # ManagerMarketplaceProvider 只用 token_provider 做未登录→空列表判断，不再手传 headers。
    if client is not None:
        client._user_token_provider = login_service.current_token
    return ManagerMarketplaceProvider(
        service_client=client,
        token_provider=login_service.current_token,
    )


def build_app(
    *,
    manager_client: ManagerLoginClient | None = None,
    mainline_service: MainlineService | None = None,
    usage_client: ManagerUsageClient | None = None,
    grants_client: ManagerGrantsClient | None = None,
) -> FastAPI:
    """构造用户端 app。login/usage/grants 三客户端默认按 MANAGER_URL 装配（#219）：
    配置 MANAGER_URL → 经 ServiceClient 装配真实跨端客户端；未配置 → 占位客户端
    （dev/离线降级，D14）。测试可显式注入 stub 覆盖默认装配。

    workspace（工作台/市场/办公室/知识库/上传/组织树）与 group_mgmt（群聊 CRUD+消息）
    通过本地 SQLite 仓储真实落数据，消除 #267 所指的 stub/假成功。
    """
    from agent_service.local_db import apply_migrations, connect

    login_service = LocalLoginService(
        manager=manager_client or _build_manager_login_client(),
        cache=InMemoryTokenCache(),
    )
    settings = load_settings("agent")
    app = create_app(settings, build_router(login_service))
    # AGENT_DB_PATH→SQLite 本地库（重启不丢，#158/#159）；AGENT_RUNTIME→真实 runtime 装配（#173，
    # 注入子进程沙箱隔离）；都未配则内存 + Fake runtime（dev/测试默认，行为不变）。
    db = None
    if settings.agent_db_path:
        db = connect(settings.agent_db_path)
        apply_migrations(db)
    # 本地投影仓储：grants 与 workspace 共享同一套 loaded_expert_projections
    projections: ProjectionRepository = (
        SqliteProjectionRepository(db) if db else InMemoryProjectionRepository()
    )
    # B1: grants 与 mainline 共享同一 solution projection 仓储，避免 sync 与 create-conversation 跨 repo 不一致。
    shared_solutions: SolutionProjectionRepository = (
        SqliteSolutionProjectionRepository(db) if db else InMemorySolutionProjectionRepository()
    )
    mainline = mainline_service or build_mainline_service(
        db_path=settings.agent_db_path,
        runtime_selection=settings.agent_runtime,
        runs_root=settings.agent_runs_root,
        runtime_env_passthrough=settings.agent_runtime_env_passthrough,
        production=settings.is_production,
        solutions=shared_solutions,
    )
    app.include_router(build_mainline_router(mainline, identity_provider=login_service.current_identity))
    loop_service, _loop_scheduler = build_loop_service(mainline=mainline, db=db)
    app.include_router(build_loop_router(loop_service, _loop_scheduler))
    # workspace 在构建时注入 loop_service，供 office feed 聚合 scheduled jobs（issue #418）
    # 生产可配置自启动 loop 调度后台循环（#173）；默认否，dev/测试用手动触发端点。
    if settings.agent_loop_autostart:
        app.router.on_startup.append(_loop_scheduler.start)
        app.router.on_shutdown.append(_loop_scheduler.stop)
    usage_service = build_usage_service(client=usage_client or _build_usage_client(), db=db)
    # 闭环 C：把 run 终态 usage 回流进 outbox（D14：回流失败不阻断本地 run；mainline 侧已吞异常）。
    _attach_usage_recorder(mainline, usage_service)
    app.include_router(build_usage_router(usage_service))
    grants_service = build_grants_service(
        client=grants_client or _build_grants_client(login_service.current_token), db=db, projections=projections,
        solutions=shared_solutions,
    )
    # AITEAM-689 (M1)：专家快照驱动统一执行编排。注入 mainline 后私聊 start_run 自动
    # 据 entry_employee_id 派生 RunSpec；注入 group_mgmt 后群聊 @ 编排按被 @ 专家派生。
    orchestrator = build_execution_orchestrator(
        grants=grants_service, projections=projections, tenant_id="local",
    )
    mainline.set_orchestrator(orchestrator)

    app.include_router(build_grants_router(grants_service))
    # ---- P02-P09 workspace：工作台 + 人才市场 + 办公室 + 知识库 + 组织树 + 文件上传 ----
    marketplace_provider = _build_marketplace_provider(login_service)
    workspace_service = build_workspace_service(
        projections=projections, db=db, upload_dir=str(_upload_dir()),
        marketplace_provider=marketplace_provider,
        unread_counts_provider=mainline.unread_count_for_employee,
        loop_service=loop_service,
    )
    app.include_router(build_workspace_router(workspace_service))
    # ---- P06 群聊管理：创建/成员/消息/归档/更新 ----
    group_mgmt_service = build_group_mgmt_service(db=db, mainline=mainline, orchestrator=orchestrator)
    app.include_router(build_group_mgmt_router(group_mgmt_service))
    # ---- Terminal / 命令执行能力（issue #415）----
    terminal_service = _build_terminal_service()
    app.include_router(build_terminal_router(terminal_service, identity_provider=login_service.current_identity))

    # 前端静态托管（含 SPA fallback catch-all）必须在所有 API 路由 include 之后最后挂载（#257）。
    mount_frontend(app, settings.tier)
    return app


app = build_app()
