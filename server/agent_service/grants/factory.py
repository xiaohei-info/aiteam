"""grants 服务装配（A4）。

装配本地投影仓储 + 冻结快照仓储 + service。默认对端用 UnconfiguredGrantsClient（A4 对端
M7/#41 未联调，安全拒绝；sync 失败按离线降级处理，不影响本地既有投影/快照）；
生产/联调注入 ServiceClientGrantsClient。
"""

from __future__ import annotations

from .client import ManagerGrantsClient, UnconfiguredGrantsClient
from .service import GrantsService
from .store import InMemoryProjectionRepository, InMemorySnapshotRepository


def build_grants_service(*, client: ManagerGrantsClient | None = None) -> GrantsService:
    """装配本地 grants 服务。client 默认占位；测试注入 fake、生产注入真实客户端。"""
    return GrantsService(
        client=client or UnconfiguredGrantsClient(),
        projections=InMemoryProjectionRepository(),
        snapshots=InMemorySnapshotRepository(),
    )
