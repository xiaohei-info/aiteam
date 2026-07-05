"""主链组装（A1）。把仓储 + timeline + broker + GatewayRunner 装配成 MainlineService。

runtime 装配（#173）：显式注入 executor/driver → 用之（测试）；否则 `runtime_selection`
给定 → 经 Gateway 装配真实 Driver/Executor（注入子进程沙箱，§13 隔离）；都没有 → Fake
runtime（dev/测试默认）。不静默切换：未知 runtime_selection 显式报错。

持久化（#158 + #179）：`db_path` 给定 → SQLite 本地库（重启不丢，复用 local_db 底座 + 迁移），
raw_archive 经脱敏后落本地库 + 保留期清理；未给 → 内存实现（dev/测试默认，不落文件）。
"""

from __future__ import annotations

import os
import tempfile

from agent_gateway.factory import build_runner
from agent_gateway.drivers import FakeDriver, FakeExecutor
from agent_gateway.runner import GatewayRunner
from agent_gateway.sandbox import SandboxPolicy
from shared.contracts.gateway import Driver, Executor

from ..local_db import apply_migrations, connect
from .service import MainlineService
from .service import UsageRecorder  # noqa: F401  (re-exported for assembly)
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
from ..grants.store import (
    InMemorySolutionProjectionRepository,
    SolutionProjectionRepository,
    SqliteSolutionProjectionRepository,
)
from .stream import StreamBroker
from .timeline import (
    InMemoryRawEventArchive,
    InMemoryTimelineStore,
    SqliteRawEventArchive,
    SqliteTimelineStore,
)


def build_mainline_service(
    *,
    executor: Executor | None = None,
    driver: Driver | None = None,
    db_path: str | None = None,
    runtime_selection: str | None = None,
    runs_root: str | None = None,
    runtime_env_passthrough: tuple[str, ...] = (),
    usage_recorder=None,
    tenant_id: str = "local",
    solutions: SolutionProjectionRepository | None = None,
) -> MainlineService:
    if executor is not None or driver is not None:
        # 显式注入（测试/自定义编排器）：用所给，缺者补 Fake。
        runner = GatewayRunner(executor=executor or FakeExecutor(), driver=driver or FakeDriver())
    elif runtime_selection:
        # 真实 runtime：经 Gateway 装配，注入子进程沙箱（§13：隔离工作目录 + 脱敏 env）。
        # extra_env：把放行的凭据变量名从宿主 env 取值最小注入，否则沙箱脱敏后 runtime 无法鉴权。
        extra_env = {k: os.environ[k] for k in runtime_env_passthrough if k in os.environ}
        sandbox = SandboxPolicy(runs_root=runs_root or tempfile.gettempdir(), extra_env=extra_env)
        runner = build_runner(runtime_selection, sandbox=sandbox)
    else:
        runner = GatewayRunner(executor=FakeExecutor(), driver=FakeDriver())
    if db_path:
        db = connect(db_path)
        apply_migrations(db)
        conversations = SqliteConversationRepository(db)
        messages = SqliteMessageRepository(db)
        runs = SqliteRunRepository(db)
        tasks = SqliteTaskRepository(db)
        timeline = SqliteTimelineStore(db)
        raw_archive = SqliteRawEventArchive(db)
        solutions = SqliteSolutionProjectionRepository(db)
        # 启动时清理过期归档（保留期默认 7 天）
        raw_archive.cleanup_expired()
    else:
        conversations = InMemoryConversationRepository()
        solutions = InMemorySolutionProjectionRepository()
        messages = InMemoryMessageRepository()
        runs = InMemoryRunRepository()
        tasks = InMemoryTaskRepository()
        timeline = InMemoryTimelineStore()
        raw_archive = InMemoryRawEventArchive()
    return MainlineService(
        conversations=conversations,
        messages=messages,
        runs=runs,
        tasks=tasks,
        timeline=timeline,
        broker=StreamBroker(),
        runner=runner,
        raw_archive=raw_archive,
        usage_recorder=usage_recorder,
        tenant_id=tenant_id,
        solutions=solutions,
    )
