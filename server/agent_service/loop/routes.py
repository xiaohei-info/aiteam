"""Loop 北向路由（A3 / 02 §10.1 前缀 /api/agent；06 §7.6）。

REST：loops CRUD + enable/disable + 立即手动触发（dev/演示用）。
触发产生的 run 与私聊 run 同构：事件并入 conversation timeline（复用 A1 timeline 端点读取），
展示态只走 SSE/WS 流，loop 自身主状态不持展示态（D6）。

手动触发端点 POST /api/agent/loops/{id}/fire：不经 cron 判定、直接起一次 run——便于演示与
测试，也作为"调度器到点触发"的同一入口的同步可达版本。
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.envelope import Envelope, ListEnvelope, Page
from shared.contracts.runspec import RunSpec

from .models import Loop
from .scheduler import FireOutcome, LoopScheduler
from .service import LoopService


class CreateLoopRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: str = Field(min_length=1)
    cron: str = Field(min_length=1, description="5 字段 cron（分 时 日 月 周）")
    run_spec: RunSpec = Field(default_factory=RunSpec)
    title: str | None = None
    enabled: bool = False


class FireNowResponse(BaseModel):
    """手动/到点触发的结果（loop 视角）。run 详情走 /runs/{id}。"""

    model_config = ConfigDict(extra="forbid")

    loop_id: str
    run_id: str | None
    ok: bool
    error: str | None = None


def _fire_outcome_to_response(outcome: FireOutcome) -> FireNowResponse:
    return FireNowResponse(
        loop_id=outcome.loop_id,
        run_id=outcome.run_id,
        ok=outcome.ok,
        error=outcome.error,
    )


def build_loop_router(service: LoopService, scheduler: LoopScheduler) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent-loop"])

    @router.post("/loops", summary="建 Loop（默认 disabled）", operation_id="agent_create_loop")
    async def create_loop(req: CreateLoopRequest) -> Envelope[Loop]:
        loop = service.create_loop(
            conversation_id=req.conversation_id,
            cron=req.cron,
            run_spec=req.run_spec,
            title=req.title,
            enabled=req.enabled,
        )
        return Envelope[Loop](data=loop)

    @router.get("/loops", summary="列 Loop", operation_id="agent_list_loops")
    async def list_loops() -> ListEnvelope[Loop]:
        loops = service.list_loops()
        next_cursor = str(len(loops)) if loops else None
        return ListEnvelope[Loop](
            data=loops, page=Page(next_cursor=next_cursor, has_more=False)
        )

    @router.get("/loops/{loop_id}", summary="取 Loop", operation_id="agent_get_loop")
    async def get_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.get_loop(loop_id))

    @router.post("/loops/{loop_id}/enable", summary="启用 Loop（进调度）",
                 operation_id="agent_enable_loop")
    async def enable_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.enable(loop_id))

    @router.post("/loops/{loop_id}/disable", summary="停用 Loop（出调度）",
                 operation_id="agent_disable_loop")
    async def disable_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.disable(loop_id))

    @router.post("/loops/{loop_id}/fire", summary="立即手动触发（不经 cron）",
                 operation_id="agent_fire_loop_now")
    async def fire_loop_now(loop_id: str) -> Envelope[FireNowResponse]:
        """手动触发一次：绕过 cron 判定，直接起 run。到点调度走同一 _fire 路径。"""
        loop = service.get_loop(loop_id)
        outcome = await scheduler._fire(loop)  # noqa: SLF001 — 手动触发复用调度器同一发起逻辑
        return Envelope[FireNowResponse](data=_fire_outcome_to_response(outcome))

    @router.post("/loops/tick", summary="手动驱动一次调度 tick（dev/测试）",
                 operation_id="agent_loop_tick")
    async def loop_tick() -> ListEnvelope[FireNowResponse]:
        """以当前时刻驱动一次 fire_ready（同调度器后台 tick 用的入口，便于演示/测试）。

        生产后台调度由 scheduler.start() 自动驱动；此端点仅供 dev/测试手动触发判定。
        """
        from datetime import datetime, timezone

        outcomes = await scheduler.fire_ready(datetime.now(timezone.utc))
        data = [_fire_outcome_to_response(o) for o in outcomes]
        next_cursor = str(len(data)) if data else None
        return ListEnvelope[FireNowResponse](
            data=data, page=Page(next_cursor=next_cursor, has_more=False)
        )

    return router
