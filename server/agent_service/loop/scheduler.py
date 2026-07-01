"""Loop 本地调度器（A3 / 06 7.6 / D19）。

职责（runtime 无关）：
- 持有 active loop 的触发配置（cron + recurrence）
- 运行期到点构造 RunSpec（从 loop.run_spec 模板复制一份）经 Gateway 执行
  （复用 A1 MainlineService.start_run：事件并入 conversation timeline、终态落 Run 主记录）
- 记一次触发（fire_count + last_run_id）、按失败重试策略记失败（达 max_retries 迁至 error）

红线（06 7.6 / CLAUDE/AGENTS 8）：
- **仅运行期执行**：调度靠 asyncio 后台 task 驱动，start() 起 / stop() 停；进程关停即不跑，
  **不做服务端常驻代跑**。运行期判定状态只在进程内，不落库。
- **不依赖 hermes cron**：判定用本模块 cron.py，不经 runtime cron、不经外部调度服务。
- **不直调 runtime CLI**：触发即调 MainlineService.start_run，run 全程经 Gateway（06 7.5）。
- **展示态不落库**：loop 自身主状态用 LoopStatus，run 的展示态（streaming/resolved）只在
  broker 流里，与 loop 主状态正交。

判定策略：每 tick 把"当前分钟"对每个 active loop 做 match_cron 判定。tick 频率默认 60s；
测试用 await fire_ready(now) 直接驱动（不依赖真实睡眠）。

幂等：同一分钟内只触发一次——调度器记录已触发分钟键（loop_id -> (y,m,d,H,M)）；同一分钟
重复 tick 不再触发。

复用 ScheduledJob 失败重试策略（AITEAM-244 / GitHub #289）：触发失败由泳道 /fire 经
``service.record_failure()`` 累计 ``retry_count``；达到 ``max_retries`` 自动迁至 error 并停跑。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from agent_service.mainline.service import MainlineService
from shared.contracts.runspec import RunSpec

from . import cron as cron_mod
from .models import Loop
from .store import LoopRepository

_logger = logging.getLogger(__name__)
_DEFAULT_TICK_SECONDS = 60.0


@dataclass
class FireOutcome:
    """单次 tick 的结果汇总（测试/可观测）。"""

    loop_id: str
    run_id: str | None
    ok: bool
    error: str | None = None


class LoopScheduler:
    """本地 Loop 调度器（runtime 无关、仅运行期执行）。

    持一个 LoopRepository（读 active loop）+ 一个 MainlineService（触发即起 run 经 Gateway）。
    不在内部缓存 loop（每次 tick 读仓储最新态：用户 pause 后下一 tick 即停触发）。
    """

    def __init__(
        self,
        *,
        loops: LoopRepository,
        mainline: MainlineService,
        tick_seconds: float = _DEFAULT_TICK_SECONDS,
    ) -> None:
        self._loops = loops
        self._mainline = mainline
        self._tick_seconds = tick_seconds
        self._task: asyncio.Task | None = None
        # loop_id -> 上次触发的分钟键，幂等防同分钟重复触发。
        self._fired_minute: dict[str, tuple[int, int, int, int, int]] = {}

    # ---- 运行期生命周期 ----

    def start(self) -> None:
        """启动后台调度 task（仅运行期；已启动则幂等 no-op）。"""
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._run(), name="loop-scheduler")

    async def stop(self) -> None:
        """停止后台调度 task（关机即不跑）。"""
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001 — 调度循环异常不该阻断关停
            _logger.exception("loop scheduler stop swallowed")

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    # ---- 核心：到点触发（可 await 直接驱动，便于测试）----

    async def fire_ready(self, now: datetime) -> list[FireOutcome]:
        """对当前时刻 `now` 触发所有命中且 active 的 loop。

        返回每个被尝试触发的 loop 的结果（成功/失败）。同一分钟内的同一 loop 只触发一次。
        """
        minute_key = (now.year, now.month, now.day, now.hour, now.minute)
        outcomes: list[FireOutcome] = []
        for loop in self._loops.list_active():
            if self._fired_minute.get(loop.id) == minute_key:
                continue  # 本分钟已触发，幂等跳过
            if not self._is_due(loop, now):
                continue
            outcome = await self._fire(loop)
            outcomes.append(outcome)
            if outcome.ok:
                self._fired_minute[loop.id] = minute_key
        return outcomes

    def _is_due(self, loop: Loop, now: datetime) -> bool:
        try:
            parsed = cron_mod.parse_cron(loop.cron)
        except cron_mod.CronError:
            _logger.warning("loop %s 非法 cron %r，跳过", loop.id, loop.cron)
            return False
        return cron_mod.match_cron(parsed, now)

    async def _fire(self, loop: Loop) -> FireOutcome:
        """到点触发：复制 loop.run_spec 模板 -> MainlineService.start_run -> 记 fire/重试。"""
        try:
            run = await self._mainline.start_run(
                loop.conversation_id, run_spec=_copy_spec(loop.run_spec)
            )
        except Exception as exc:  # noqa: BLE001
            _logger.exception("loop %s fire failed", loop.id)
            self._loops.record_failure(loop.id)
            return FireOutcome(loop_id=loop.id, run_id=None, ok=False, error=str(exc))
        self._loops.record_fire(loop.id, run_id=run.id)
        self._loops.record_success(loop.id)
        return FireOutcome(loop_id=loop.id, run_id=run.id, ok=True)

    # ---- 后台循环 ----

    async def _run(self) -> None:
        """后台 tick 循环：每 tick_seconds 唤醒一次，以当前 UTC 分钟判定。"""
        try:
            while True:
                await self.fire_ready(datetime.now(timezone.utc))
                await asyncio.sleep(self._tick_seconds)
        except asyncio.CancelledError:
            raise


def _copy_spec(template: RunSpec) -> RunSpec:
    """每次触发复制一份模板（run 间不共享可变状态；RunSpec 是 Pydantic 不可变友好）。"""
    return RunSpec(**template.model_dump())
