"""Loop 装配（A3）。把 loop 仓储 + 复用 A1 MainlineService 装成 LoopService 与 LoopScheduler。

铁律：调度器与 LoopService 共享同一 LoopRepository（enable/disable 立即影响下一 tick）；
调度器复用 A1 的 MainlineService（run 事件并入 conversation timeline，不另起主链）。
默认不 start 调度器——由 app 启动期决定是否起后台循环（dev/测试默认不起）。
"""

from __future__ import annotations

from agent_service.local_db import LocalDb
from agent_service.mainline.service import MainlineService

from .scheduler import LoopScheduler
from .service import LoopService
from .store import InMemoryLoopRepository, LoopRepository, SqliteLoopRepository


def build_loop_service(
    *, mainline: MainlineService, db: LocalDb | None = None
) -> tuple[LoopService, LoopScheduler]:
    """装配 LoopService + LoopScheduler（共享同一仓储 + 同一 mainline）。

    db 非空时用 SQLite 实现（#159），空时用内存（dev/测试）。
    返回 (service, scheduler)：调用方决定是否 scheduler.start()（运行期才起、关停即停）。
    """
    loops: LoopRepository = SqliteLoopRepository(db) if db else InMemoryLoopRepository()
    service = LoopService(loops=loops)
    scheduler = LoopScheduler(loops=loops, mainline=mainline)
    return service, scheduler
