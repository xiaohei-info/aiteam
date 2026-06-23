"""usage 服务装配（A5）。

装配 outbox 仓储 + reporter + service。默认对端用 UnconfiguredUsageClient（A5 对端 M8/#42
未联调，安全拒绝、留 pending 重试）；生产/联调注入 ServiceClientUsageClient。
"""

from __future__ import annotations

from agent_service.local_db import LocalDb

from .client import ManagerUsageClient, UnconfiguredUsageClient
from .reporter import UsageReporter
from .service import UsageService
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
