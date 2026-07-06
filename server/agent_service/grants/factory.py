"""grants 服务装配（A4）。

装配本地投影仓储 + 冻结快照仓储 + service。默认对端用 UnconfiguredGrantsClient（A4 对端
M7/#41 未联调，安全拒绝；sync 失败按离线降级处理，不影响本地既有投影/快照）；
生产/联调注入 ServiceClientGrantsClient。
"""

from __future__ import annotations

from agent_service.local_db import LocalDb

from .client import ManagerGrantsClient, UnconfiguredGrantsClient
from .service import GrantsService
from .store import (
    InMemoryProjectionRepository,
    InMemorySnapshotRepository,
    InMemorySolutionProjectionRepository,
    ProjectionRepository,
    SnapshotRepository,
    SolutionProjectionRepository,
    SqliteProjectionRepository,
    SqliteSnapshotRepository,
    SqliteSolutionProjectionRepository,
)


def build_grants_service(
    *,
    client: ManagerGrantsClient | None = None,
    db: LocalDb | None = None,
    projections: ProjectionRepository | None = None,
    solutions: SolutionProjectionRepository | None = None,
) -> GrantsService:
    """装配本地 grants 服务。

    db 非空时用 SQLite 实现（#159），空时用内存（dev/测试）。
    projections 可选注入（workspace 共享同一仓储）；未注入时按 db 构建。
    solutions 可选；未注入时按 db 构建（None 表示未启用方案投影，grants sync 会跳过）。
    client 默认占位；测试注入 fake、生产注入真实客户端。
    """
    _projections: ProjectionRepository = (
        projections or (SqliteProjectionRepository(db) if db else InMemoryProjectionRepository())
    )
    snapshots: SnapshotRepository = (
        SqliteSnapshotRepository(db) if db else InMemorySnapshotRepository()
    )
    _solutions: SolutionProjectionRepository | None = (
        solutions
        if solutions is not None
        else (SqliteSolutionProjectionRepository(db) if db else InMemorySolutionProjectionRepository())
    )
    return GrantsService(
        client=client or UnconfiguredGrantsClient(),
        projections=_projections,
        snapshots=snapshots,
        solutions=_solutions,
    )
