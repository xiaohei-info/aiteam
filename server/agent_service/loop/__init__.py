"""Loop 本地调度器（A3 / 06 7.6 / D19）。

分层（业界成熟实践，不沿用旧 app/ 单文件/全局态写法）：
    models      领域模型（Loop / LoopStatus / RecurrenceType，主状态状态机）
    store       仓储接口 + 内存实现（agent 本地库；真实持久化后续替换，接口不变）
    cron        5 字段 cron 解析与到点判定（runtime 无关、非 hermes cron、不引第三方依赖）
    scheduler   本地调度器：运行期到点构造 RunSpec 经 Gateway 执行（复用 A1 start_run）
    service     LoopService：CRUD + 状态机入口（activate/pause/complete/error/retry）
    routes      北向 /api/agent/loops/* 路由
    factory     装配 LoopService + LoopScheduler（共享仓储 + 复用 mainline）

铁律：
- 仅运行期执行；不做服务端常驻代跑；调度器 start/stop 随进程生命周期。
- 不依赖 hermes cron；cron 解析用本模块 cron.py。
- 触发即经 Gateway（复用 A1 MainlineService.start_run），不直调 runtime CLI。
- 展示态不落 Loop 主状态（D6）。
"""

from .models import InvalidTransition, Loop, LoopStatus, RecurrenceType
from .scheduler import FireOutcome, LoopScheduler
from .service import LoopService
from .store import InMemoryLoopRepository, LoopRepository

__all__ = [
    "Loop",
    "LoopStatus",
    "RecurrenceType",
    "InvalidTransition",
    "LoopService",
    "LoopScheduler",
    "FireOutcome",
    "LoopRepository",
    "InMemoryLoopRepository",
]
