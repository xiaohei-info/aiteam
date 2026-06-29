"""usage 服务装配（A5）。

装配 outbox 仓储 + reporter + service。默认对端用 UnconfiguredUsageClient（A5 对端 M8/#42
未联调，安全拒绝、留 pending 重试）；生产/联调注入 ServiceClientUsageClient。
"""

from __future__ import annotations

from agent_service.local_db import LocalDb

from .client import ManagerUsageClient, UnconfiguredUsageClient
from .models import RawUsageEvent
from .reporter import UsageReporter
from .service import UsageService
from ..mainline.models import RunStatus
from .store import InMemoryOutboxRepository, OutboxRepository, SqliteOutboxRepository


def build_usage_service(
    *, client: ManagerUsageClient | None = None, db: LocalDb | None = None
) -> UsageService:
    """装配本地 usage outbox 服务。

    db 非空时用 SQLite 实现（#159），空时用内存（dev/测试）。
    client 默认占位；测试注入 fake、生产注入真实客户端。
    """
    outbox: OutboxRepository = SqliteOutboxRepository(db) if db else InMemoryOutboxRepository()
    reporter = UsageReporter(outbox=outbox, client=client or UnconfiguredUsageClient())
    return UsageService(outbox=outbox, reporter=reporter)


def build_run_usage_recorder(service: UsageService):
    """闭环 C：把 MainlineService 的 run 终态 usage 回流进 outbox 的薄适配器（A5/D13/D14）。

    返回一个 UsageRecorder 回调 (tenant_id, run_id, run_status, usage, error)：
    - 只把 runtime 提取的 usage dict 交给 UsageService.record_usage 脱敏聚合；
    - 绝不传会话内容（D13：脱敏在聚合器，此处只交计量）；
    - run_status == FAILED 时标记 error=True，供聚合 error_count。
    回流是尽力而为：MainlineService 已在调用点吞掉异常（D14 不阻断本地 run）。
    """
    def _record(tenant_id, run_id, run_status, usage, error):
        service.record_usage(tenant_id, [
            RawUsageEvent(
                run_id=run_id,
                usage=usage or {},
                error=(run_status is RunStatus.FAILED),
            )
        ])
    return _record
