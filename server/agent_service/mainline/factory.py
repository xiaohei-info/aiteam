"""主链组装（A1）。把仓储 + timeline + broker + GatewayRunner 装配成 MainlineService。

骨架期默认用 fake runtime（C0.4）；真实 Driver/Executor 由 Track G 接入时只换 runner 的
executor/driver，service 编排不变。

持久化（#158）：`db_path` 给定 → SQLite 本地库（重启不丢，复用 local_db 底座 + 迁移）；
未给 → 内存实现（dev/测试默认，不落文件）。raw_archive 仍为内存占位（真实归档见 #179）。
"""

from __future__ import annotations

from agent_gateway.fake_runtime import FakeDriver, FakeExecutor
from agent_gateway.runner import GatewayRunner
from shared.contracts.gateway import Driver, Executor

from ..local_db import apply_migrations, connect
from .service import MainlineService
from .store import (
    InMemoryConversationRepository,
    InMemoryMessageRepository,
    InMemoryRunRepository,
    InMemoryTaskRepository,
    SqliteConversationRepository,
    SqliteMessageRepository,
    SqliteRunRepository,
    SqliteTaskRepository,
)
from .stream import StreamBroker
from .timeline import InMemoryRawEventArchive, InMemoryTimelineStore, SqliteTimelineStore


def build_mainline_service(
    *,
    executor: Executor | None = None,
    driver: Driver | None = None,
    db_path: str | None = None,
) -> MainlineService:
    runner = GatewayRunner(
        executor=executor or FakeExecutor(),
        driver=driver or FakeDriver(),
    )
    if db_path:
        db = connect(db_path)
        apply_migrations(db)
        conversations = SqliteConversationRepository(db)
        messages = SqliteMessageRepository(db)
        runs = SqliteRunRepository(db)
        tasks = SqliteTaskRepository(db)
        timeline = SqliteTimelineStore(db)
    else:
        conversations = InMemoryConversationRepository()
        messages = InMemoryMessageRepository()
        runs = InMemoryRunRepository()
        tasks = InMemoryTaskRepository()
        timeline = InMemoryTimelineStore()
    return MainlineService(
        conversations=conversations,
        messages=messages,
        runs=runs,
        tasks=tasks,
        timeline=timeline,
        broker=StreamBroker(),
        runner=runner,
        raw_archive=InMemoryRawEventArchive(),
    )
