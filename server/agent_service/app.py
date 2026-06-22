"""用户端 FastAPI 应用骨架（A0）。

本地登录（03 §9.4C）已落地：公开 login 端点经 Manager 校验凭据（A0 对端用 fake/占位），
缓存 token + 验签材料，此后本地无状态验签（whoami）。业务主链/群聊/Loop/pull 由后续
Track A 工单（11 §4）填入。

注意：默认仅 localhost 监听，不暴露非 localhost 入站（00 §4.2.3）；
用户端只持验签材料，绝不持可签发 token 的密钥（03 §9.5/D23）。
"""

from __future__ import annotations

from fastapi import APIRouter, FastAPI

from agent_service.auth.local_login import (
    LocalLoginService,
    LoginRequest,
    LoginResult,
    ManagerLoginClient,
)
from agent_service.auth.manager_client import UnconfiguredManagerClient
from agent_service.auth.token_cache import InMemoryTokenCache
from agent_service.grants.client import ManagerGrantsClient
from agent_service.grants.factory import build_grants_service
from agent_service.grants.routes import build_grants_router
from agent_service.loop.factory import build_loop_service
from agent_service.loop.routes import build_loop_router
from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.routes import build_mainline_router
from agent_service.mainline.service import MainlineService
from agent_service.usage.client import ManagerUsageClient
from agent_service.usage.factory import build_usage_service
from agent_service.usage.routes import build_usage_router
from shared.app_factory import create_app
from shared.config import load_settings
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

    @router.post("/login", summary="本地登录（首次在线取 token）", operation_id="agent_login")
    async def login(req: LoginRequest) -> Envelope[LoginResult]:
        # 公开端点（§9.6）：不挂 require_claims。校验在 Manager；用户端只缓存 + 本地验签。
        session = login_service.login(req)
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


def build_app(
    *,
    manager_client: ManagerLoginClient | None = None,
    mainline_service: MainlineService | None = None,
    usage_client: ManagerUsageClient | None = None,
    grants_client: ManagerGrantsClient | None = None,
) -> FastAPI:
    """构造用户端 app。manager_client 默认占位（A0 对端 fake）；测试可注入 stub。

    mainline_service 默认用 fake runtime 装配的本地主链（A1）；测试可注入自定义编排器。
    Loop 调度器复用同一 mainline_service（A3，06 §7.6），默认不 start 后台循环——
    dev/测试用手动触发端点或 scheduler.fire_ready 驱动；生产由进程启动期决定是否 start。
    usage_client 默认占位（A5 对端 M8/#42 未联调）；上报失败留 pending 重试，不阻塞本地。
    grants_client 默认占位（A4 对端 M7/#41 未联调）；sync 失败按离线降级处理，本地凭既有
    投影 + 已冻结快照继续工作，不致本端 not-ready（D14）。
    """
    login_service = LocalLoginService(
        manager=manager_client or UnconfiguredManagerClient(),
        cache=InMemoryTokenCache(),
    )
    settings = load_settings("agent")
    app = create_app(settings, build_router(login_service))
    # AGENT_DB_PATH→SQLite 本地库（重启不丢，#158）；AGENT_RUNTIME→真实 runtime 装配（#173，
    # 注入子进程沙箱隔离）；都未配则内存 + Fake runtime（dev/测试默认，行为不变）。
    mainline = mainline_service or build_mainline_service(
        db_path=settings.agent_db_path,
        runtime_selection=settings.agent_runtime,
        runs_root=settings.agent_runs_root,
    )
    app.include_router(build_mainline_router(mainline))
    loop_service, _loop_scheduler = build_loop_service(mainline=mainline)
    app.include_router(build_loop_router(loop_service, _loop_scheduler))
    # 生产可配置自启动 loop 调度后台循环（#173）；默认否，dev/测试用手动触发端点。
    if settings.agent_loop_autostart:
        app.router.on_startup.append(_loop_scheduler.start)
        app.router.on_shutdown.append(_loop_scheduler.stop)
    usage_service = build_usage_service(client=usage_client)
    app.include_router(build_usage_router(usage_service))
    grants_service = build_grants_service(client=grants_client)
    app.include_router(build_grants_router(grants_service))
    return app


app = build_app()
