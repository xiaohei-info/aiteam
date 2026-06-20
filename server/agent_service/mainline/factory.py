"""主链组装（A1）。把内存仓储 + timeline + broker + GatewayRunner 装配成 MainlineService。

骨架期默认用 fake runtime（C0.4）；真实 Driver/Executor 由 Track G 接入时只换 runner 的
executor/driver，service 编排不变。内存实现是本地库占位，真实持久化后续替换、接口不变。
"""

from __future__ import annotations

from agent_gateway.fake_runtime import FakeDriver, FakeExecutor
from agent_gateway.runner import GatewayRunner
from shared.contracts.gateway import Driver, Executor

from .service import MainlineService
from .store import (
    InMemoryConversationRepository,
    InMemoryMessageRepository,
    InMemoryRunRepository,
    InMemoryTaskRepository,
)
from .stream import StreamBroker
from .timeline import InMemoryRawEventArchive, InMemoryTimelineStore


def build_mainline_service(
    *,
    executor: Executor | None = None,
    driver: Driver | None = None,
) -> MainlineService:
    runner = GatewayRunner(
        executor=executor or FakeExecutor(),
        driver=driver or FakeDriver(),
    )
    return MainlineService(
        conversations=InMemoryConversationRepository(),
        messages=InMemoryMessageRepository(),
        runs=InMemoryRunRepository(),
        tasks=InMemoryTaskRepository(),
        timeline=InMemoryTimelineStore(),
        broker=StreamBroker(),
        runner=runner,
        raw_archive=InMemoryRawEventArchive(),
    )
