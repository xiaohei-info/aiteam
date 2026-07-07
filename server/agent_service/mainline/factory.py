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
from ..capabilities.skill_cache import SkillCache
from ..grants.factory import build_grants_service
from agent_gateway.runtime_readiness import check_runtime_readiness
from agent_gateway.drivers import FakeDriver, FakeExecutor
from agent_gateway.runner import GatewayRunner
from agent_gateway.sandbox import SandboxPolicy
from shared.contracts.gateway import Driver, Executor

from ..local_db import apply_migrations, connect
from .service import MainlineService
from .service import UsageRecorder  # noqa: F401  (re-exported for assembly)
from .execution_orchestrator import ExecutionOrchestrator
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
    production: bool = False,
    usage_recorder=None,
    tenant_id: str = "local",
    solutions: SolutionProjectionRepository | None = None,
    orchestrator: ExecutionOrchestrator | None = None,
    skill_cache: SkillCache | None = None,
    grants_client=None,
) -> MainlineService:
    # AITEAM-688 M0：部署级 runtime 固定 + 生产 Fake 禁用。
    # 生产模式：缺/未知/fake runtime、或真实 runtime CLI 缺失 → fail-fast（启动期），不静默回退 Fake。
    # dev/test：行为不变——未配置回退 Fake；真实 runtime 直接装配（CLI 是否就绪由 /agent/health 反馈）。
    if executor is not None or driver is not None:
        # 显式注入（测试/自定义编排器）：用所给，缺者补 Fake。
        runner = GatewayRunner(executor=executor or FakeExecutor(), driver=driver or FakeDriver())
    elif production:
        if skill_cache is None and (runtime_selection or db_path):
            skill_cache = SkillCache()
        readiness = check_runtime_readiness(runtime_selection, production=True)
        if readiness.status != "ready":
            raise ValueError(
                f"runtime_not_ready: {readiness.reason} "
                f"(runtime={readiness.runtime!r}, production=True)"
            )
        # 生产 readiness=ready 意味着配了真实 runtime 且 CLI 可用。
        extra_env = {k: os.environ[k] for k in runtime_env_passthrough if k in os.environ}
        sandbox = SandboxPolicy(runs_root=runs_root or tempfile.gettempdir(), extra_env=extra_env)
        runner = build_runner(runtime_selection, sandbox=sandbox, skill_cache=skill_cache)
    elif runtime_selection:
        # dev/test 真实 runtime：未知 runtime 由 get_driver 显式报错（不静默切换）。
        extra_env = {k: os.environ[k] for k in runtime_env_passthrough if k in os.environ}
        sandbox = SandboxPolicy(runs_root=runs_root or tempfile.gettempdir(), extra_env=extra_env)
        runner = build_runner(runtime_selection, sandbox=sandbox, skill_cache=skill_cache)
    else:
        # dev/test 未配置：回退 Fake（行为不变）。
        runner = GatewayRunner(
            executor=FakeExecutor(),
            driver=FakeDriver(),
        )
    if db_path:
        db = connect(db_path)
        apply_migrations(db)
        conversations = SqliteConversationRepository(db)
        messages = SqliteMessageRepository(db)
        runs = SqliteRunRepository(db)
        tasks = SqliteTaskRepository(db)
        timeline = SqliteTimelineStore(db)
        raw_archive = SqliteRawEventArchive(db)
        if solutions is None:
            solutions = SqliteSolutionProjectionRepository(db)
        # 启动时清理过期归档（保留期默认 7 天）
        raw_archive.cleanup_expired()
    else:
        conversations = InMemoryConversationRepository()
        if solutions is None:
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
        orchestrator=orchestrator,
    )


def build_execution_orchestrator(
    *,
    grants: "GrantsService",
    projections: "ProjectionRepository",
    tenant_id: str = "local",
    member_id: str = "local",
) -> "ExecutionOrchestrator":
    """装配专家快照驱动的统一执行编排（AITEAM-689 / M1）。

    grants 提供 freeze_snapshot / latest_snapshot（在线冻结 + 离线 fallback）；
    projections 提供本地只读专家投影（employee_id -> version 基线）。
    """
    return ExecutionOrchestrator(
        grants=grants, projections=projections,
        tenant_id=tenant_id, member_id=member_id,
    )
