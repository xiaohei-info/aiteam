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
    ProjectionRepository,
    SnapshotRepository,
    SqliteProjectionRepository,
    SqliteSnapshotRepository,
)


def build_grants_service(
    *,
    client: ManagerGrantsClient | None = None,
    db: LocalDb | None = None,
    projections: ProjectionRepository | None = None,
) -> GrantsService:
    """装配本地 grants 服务。

    db 非空时用 SQLite 实现（#159），空时用内存（dev/测试）。
    projections 可选注入（workspace 共享同一仓储）；未注入时按 db 构建。
    client 默认占位；测试注入 fake、生产注入真实客户端。
    """
    _projections: ProjectionRepository = (
        projections or (SqliteProjectionRepository(db) if db else InMemoryProjectionRepository())
    )
    snapshots: SnapshotRepository = (
        SqliteSnapshotRepository(db) if db else InMemorySnapshotRepository()
    )
    return GrantsService(
        client=client or UnconfiguredGrantsClient(),
        projections=_projections,
        snapshots=snapshots,
    )
