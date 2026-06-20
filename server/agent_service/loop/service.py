"""Loop 服务编排（A3 / 06 §7.6 / D19）。

薄编排层：Loop 的 CRUD（落本地库）+ 状态开关 + 调度器接入。不重写 run/timeline/SSE/WS
主链——触发即复用 A1 MainlineService.start_run，事件/终态/展示态全部走既有链路。

红线（与 scheduler.py 一致）：
- 仅运行期执行；不在本服务做常驻代跑（后台循环归 scheduler.start/stop）。
- 不依赖 hermes cron；cron 解析用 loop.cron.py。
- 展示态不落 Loop 主状态。
"""

from __future__ import annotations

import uuid

from shared.contracts.runspec import RunSpec

from .models import Loop, LoopStatus
from .store import LoopRepository


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


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
        cron: str,
        run_spec: RunSpec | None = None,
        title: str | None = None,
        enabled: bool = False,
    ) -> Loop:
        """建一个 Loop。默认 disabled——用户显式 enable 后才进调度。

        cron 在创建时不强制解析（解析失败由调度器跳过并告警）；调用方可先用 validate_cron
        提前校验给用户即时反馈。
        """
        loop = Loop(
            id=_new_id("loop"),
            conversation_id=conversation_id,
            cron=cron,
            run_spec=run_spec or RunSpec(),
            title=title,
            status=LoopStatus.ENABLED if enabled else LoopStatus.DISABLED,
        )
        return self._loops.create(loop)

    def get_loop(self, loop_id: str) -> Loop:
        return self._loops.get(loop_id)

    def list_loops(self) -> list[Loop]:
        return self._loops.list()

    def list_enabled(self) -> list[Loop]:
        return self._loops.list_enabled()

    def enable(self, loop_id: str) -> Loop:
        return self._loops.set_status(loop_id, LoopStatus.ENABLED)

    def disable(self, loop_id: str) -> Loop:
        return self._loops.set_status(loop_id, LoopStatus.DISABLED)
