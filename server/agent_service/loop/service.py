"""Loop 服务编排（A3 / 06 7.6 / D19）。

薄编排层：Loop 的 CRUD（落本地库）+ 状态开关 + 调度器接入。不重写 run/timeline/SSE/WS
主链——触发即复用 A1 MainlineService.start_run，事件/终态/展示态全部走既有链路。

复用 ScheduledJob 完整口径：新增 recurrence_type / recurrence_config / input_template /
max_retries / retry_count，以及 activate/pause/complete/mark_error/clear_error 状态机入口。

红线（与 scheduler.py 一致）：
- 仅运行期执行；不在本服务做常驻代跑（后台循环归 scheduler.start/stop）。
- 不依赖 hermes cron；cron 解析用 loop.cron.py。
- 展示态不落 Loop 主状态。
"""

from __future__ import annotations

import uuid

from shared.contracts.runspec import RunSpec

from .models import Loop, LoopStatus, RecurrenceType
from .store import LoopRepository


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"

def _is_active(active: bool | None, enabled: bool | None) -> bool:
    """兼容枚举：优先 active，回退旧 enabled；两缺省为 paused。"""
    if active is not None:
        return bool(active)
    if enabled is not None:
        return bool(enabled)
    return False




class LoopService:
    """用户端本地 Loop 服务。单租户本地，无 tenant 路由（用户端单用户本地库）。"""

    def __init__(self, *, loops: LoopRepository) -> None:
        self._loops = loops

    @property
    def repository(self) -> LoopRepository:
        """底层仓储（供 factory 把同一实例注入调度器）。"""
        return self._loops

    def create_loop(
        self,
        *,
        conversation_id: str,
        cron: str = "* * * * *",
        run_spec: RunSpec | None = None,
        title: str | None = None,
        recurrence_type: RecurrenceType | str = RecurrenceType.CRON,
        recurrence_config: dict | None = None,
        input_template: str | None = None,
        max_retries: int = 3,
        active: bool | None = None,
        enabled: bool | None = None,
    ) -> Loop:
        """建一个 Loop。默认 paused——用户显式 activate 后才进调度。

        recurrence_type / recurrence_config 声明重复规则（复用 ScheduledJob 口径）；input_template
        为每次触发时的消息模板；max_retries 为连续失败上限。cron 在创建时不强制解析（解析失败由
        调度器跳过并告警）。
        """
        if isinstance(recurrence_type, str):
            recurrence_type = RecurrenceType(recurrence_type)
        loop = Loop(
            id=_new_id("loop"),
            conversation_id=conversation_id,
            cron=cron,
            run_spec=run_spec or RunSpec(),
            title=title,
            recurrence_type=recurrence_type,
            recurrence_config=recurrence_config,
            input_template=input_template,
            status=LoopStatus.ACTIVE if _is_active(active, enabled) else LoopStatus.PAUSED,
            max_retries=max_retries,
        )
        return self._loops.create(loop)

    def get_loop(self, loop_id: str) -> Loop:
        return self._loops.get(loop_id)

    def list_loops(self) -> list[Loop]:
        return self._loops.list()

    def list_active(self) -> list[Loop]:
        return self._loops.list_active()

    def update_loop(
        self,
        loop_id: str,
        *,
        cron: str | None = None,
        run_spec: RunSpec | None = None,
        title: str | None = None,
        recurrence_type: RecurrenceType | str | None = None,
        recurrence_config: dict | None = None,
        input_template: str | None = None,
        max_retries: int | None = None,
    ) -> Loop:
        """更新 loop 的可变字段；空参数保留原值。"""
        loop = self._loops.get(loop_id)
        if cron is not None:
            loop.cron = cron
        if run_spec is not None:
            loop.run_spec = run_spec
        if title is not None:
            loop.title = title
        if recurrence_type is not None:
            loop.recurrence_type = (
                RecurrenceType(recurrence_type)
                if isinstance(recurrence_type, str)
                else recurrence_type
            )
        if recurrence_config is not None:
            loop.recurrence_config = recurrence_config
        if input_template is not None:
            loop.input_template = input_template
        if max_retries is not None:
            loop.max_retries = max_retries
        return self._loops.update(loop)

    # ── 主状态机入口 ────────────────────────────────────────────────

    def activate(self, loop_id: str) -> Loop:
        loop = self._loops.get(loop_id)
        loop.activate()
        return self._loops.update(loop)

    def pause(self, loop_id: str) -> Loop:
        loop = self._loops.get(loop_id)
        loop.pause()
        return self._loops.update(loop)

    def disable(self, loop_id: str) -> Loop:
        """兼容旧口径：disable 等价于 pause。"""
        return self.pause(loop_id)

    def enable(self, loop_id: str) -> Loop:
        """兼容旧口径：enable 等价于 activate。"""
        return self.activate(loop_id)

    def complete(self, loop_id: str) -> Loop:
        loop = self._loops.get(loop_id)
        loop.complete()
        return self._loops.update(loop)

    def mark_error(self, loop_id: str) -> Loop:
        loop = self._loops.get(loop_id)
        loop.mark_error()
        return self._loops.update(loop)

    def clear_error(self, loop_id: str) -> Loop:
        loop = self._loops.get(loop_id)
        loop.clear_error()
        return self._loops.update(loop)

    def record_fire(self, loop_id: str, *, run_id: str) -> Loop:
        return self._loops.record_fire(loop_id, run_id=run_id)

    def record_failure(self, loop_id: str) -> Loop:
        return self._loops.record_failure(loop_id)

    def record_success(self, loop_id: str) -> Loop:
        loop = self._loops.get(loop_id)
        loop.record_success()
        return self._loops.update(loop)
