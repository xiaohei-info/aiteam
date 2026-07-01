"""Loop 北向路由（A3 / 02 10.1 前缀 /api/agent；06 7.6）。

REST：loops CRUD + enable/disable + activate/pause/complete/error 状态机 + 立即手动触发
（dev/演示用）。触发产生的 run 与私聊 run 同构：事件并入 conversation timeline（复用 A1
timeline 端点读取），展示态只走 SSE/WS 流，loop 自身主状态不持展示态（D6）。

复用 ScheduledJob 口径暴露 recurrence_type / recurrence_config / input_template / max_retries /
retry_count，以及 activate / pause / complete / mark_error / clear_error 完整状态机。
手动触发端点 POST /api/agent/loops/{id}/fire：不经 cron 判定、直接起一次 run——便于演示与
测试，也作为"调度器到点触发"的同一入口的同步可达版本。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.envelope import Envelope, ListEnvelope, Page
from shared.contracts.runspec import RunSpec

from .models import Loop, RecurrenceType
from .scheduler import FireOutcome, LoopScheduler
from .service import LoopService


class CreateLoopRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: str = Field(min_length=1)
    cron: str = Field(default="* * * * *", description="5 字段 cron（分 时 日 月 周，仅 cron 类型）")
    run_spec: RunSpec = Field(default_factory=RunSpec)
    title: str | None = None
    recurrence_type: RecurrenceType = Field(
        default=RecurrenceType.CRON, description="重复类型 once/daily/weekly/monthly/cron"
    )
    recurrence_config: dict | None = Field(
        default=None, description="重复配置（周几、日期、时刻等）"
    )
    input_template: str | None = Field(
        default=None, description="每次触发时的消息模板"
    )
    max_retries: int = Field(default=3, ge=0, description="连续失败上限")
    active: bool | None = None
    enabled: bool | None = None


class UpdateLoopRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cron: str | None = None
    run_spec: RunSpec | None = None
    title: str | None = None
    recurrence_type: RecurrenceType | str | None = None
    recurrence_config: dict | None = None
    input_template: str | None = None
    max_retries: int | None = Field(default=None, ge=0)


class FireNowResponse(BaseModel):
    """手动/到点触发的结果（loop 视角）。run 详情走 /runs/{id}。"""

    model_config = ConfigDict(extra="forbid")

    loop_id: str
    run_id: str | None
    ok: bool
    error: str | None = None



def _pick_active(active, enabled):
    if active is not None:
        return bool(active)
    if enabled is not None:
        return bool(enabled)
    return False

def _fire_outcome_to_response(outcome: FireOutcome) -> FireNowResponse:
    return FireNowResponse(
        loop_id=outcome.loop_id,
        run_id=outcome.run_id,
        ok=outcome.ok,
        error=outcome.error,
    )


def build_loop_router(service: LoopService, scheduler: LoopScheduler) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent-loop"])

    @router.post("/loops", summary="建 Loop（默认 paused）", description="创建定时循环：声明重复规则 / 消息模板 / 重试策略。默认不启用，需显式 activate。", operation_id="agent_create_loop")
    async def create_loop(req: CreateLoopRequest) -> Envelope[Loop]:
        loop = service.create_loop(
            conversation_id=req.conversation_id,
            cron=req.cron,
            run_spec=req.run_spec,
            title=req.title,
            recurrence_type=req.recurrence_type,
            recurrence_config=req.recurrence_config,
            input_template=req.input_template,
            max_retries=req.max_retries,
            active=_pick_active(req.active, req.enabled),
        )
        return Envelope[Loop](data=loop)

    @router.get("/loops", summary="列 Loop", description="列出本端所有 Loop，含启用/停用状态与重复/重试配置。", operation_id="agent_list_loops")
    async def list_loops() -> ListEnvelope[Loop]:
        loops = service.list_loops()
        next_cursor = str(len(loops)) if loops else None
        return ListEnvelope[Loop](
            data=loops, page=Page(next_cursor=next_cursor, has_more=False)
        )

    @router.get("/loops/{loop_id}", summary="取 Loop", description="取单个 Loop 详情 + 下一触发预览。", operation_id="agent_get_loop")
    async def get_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.get_loop(loop_id))

    @router.patch("/loops/{loop_id}", summary="更新 Loop 字段", description="更新 cron / 重复 / 模板 / 重试等可变字段（空则保留原值）。", operation_id="agent_update_loop")
    async def update_loop(loop_id: str, req: UpdateLoopRequest) -> Envelope[Loop]:
        loop = service.update_loop(
            loop_id,
            cron=req.cron,
            run_spec=req.run_spec,
            title=req.title,
            recurrence_type=req.recurrence_type,
            recurrence_config=req.recurrence_config,
            input_template=req.input_template,
            max_retries=req.max_retries,
        )
        return Envelope[Loop](data=loop)

    @router.post("/loops/{loop_id}/enable", summary="启用 Loop（active，兼容旧口径）",
                 description="启用指定 Loop：等价于 activate，进入调度器定时触发。",
                 operation_id="agent_enable_loop")
    async def enable_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.enable(loop_id))

    @router.post("/loops/{loop_id}/disable", summary="停用 Loop（paused，兼容旧口径）",
                 description="停用指定 Loop：等价于 pause。已触发的 run 不影响。",
                 operation_id="agent_disable_loop")
    async def disable_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.disable(loop_id))

    @router.post("/loops/{loop_id}/activate", summary="激活 Loop（active）",
                 description="将 Loop 从 paused/completed 激活为 active，进入调度。",
                 operation_id="agent_activate_loop")
    async def activate_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.activate(loop_id))

    @router.post("/loops/{loop_id}/pause", summary="暂停 Loop（paused）",
                 description="将 active Loop 暂停为 paused，调度器跳过。",
                 operation_id="agent_pause_loop")
    async def pause_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.pause(loop_id))

    @router.post("/loops/{loop_id}/complete", summary="完成 Loop（completed 终态）",
                 description="将 active Loop 标记为 completed 终态（once 任务触发完成后使用）。",
                 operation_id="agent_complete_loop")
    async def complete_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.complete(loop_id))

    @router.post("/loops/{loop_id}/error", summary="标记 Loop 进入 error",
                 description="将 active Loop 标记为 error（连续失败达上限后使用）。",
                 operation_id="agent_mark_error_loop")
    async def mark_error_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.mark_error(loop_id))

    @router.post("/loops/{loop_id}/clear-error", summary="清除 error（回到 paused）",
                 description="人工介入清除 error，回到 paused 校验后再 active。",
                 operation_id="agent_clear_error_loop")
    async def clear_error_loop(loop_id: str) -> Envelope[Loop]:
        return Envelope[Loop](data=service.clear_error(loop_id))

    @router.post("/loops/{loop_id}/fire", summary="立即手动触发（不经 cron）",
                 description="手动触发一次：绕过 cron 判定，直接起 run。到点调度走同一 _fire 路径。",
                 operation_id="agent_fire_loop_now")
    async def fire_loop_now(loop_id: str) -> Envelope[FireNowResponse]:
        loop = service.get_loop(loop_id)
        outcome = await scheduler._fire(loop)  # noqa: SLF001 — 手动触发复用调度器同一发起逻辑
        return Envelope[FireNowResponse](data=_fire_outcome_to_response(outcome))

    @router.post("/loops/tick", summary="手动驱动一次调度 tick（dev/测试）",
                 description="以当前时刻驱动一次 fire_ready。生产后台调度由 scheduler.start() 自动驱动。",
                 operation_id="agent_loop_tick")
    async def loop_tick() -> ListEnvelope[FireNowResponse]:
        """以当前时刻驱动一次 fire_ready（同调度器后台 tick 用的入口，便于演示/测试）。

        生产后台调度由 scheduler.start() 自动驱动；此端点仅供 dev/测试手动触发判定。
        """
        outcomes = await scheduler.fire_ready(datetime.now(timezone.utc))
        data = [_fire_outcome_to_response(o) for o in outcomes]
        next_cursor = str(len(data)) if data else None
        return ListEnvelope[FireNowResponse](
            data=data, page=Page(next_cursor=next_cursor, has_more=False)
        )

    return router
