"""workspace 服务装配。

依赖注入：grants 投影仓储 + 本地仓储 + 主链未读计数回调。
依赖注入 grants 投影仓储 + 本地仓储，对齐 grants/factory.py 装配模式。
db 非空时用 SQLite 实现，空时用 InMemory（dev/测试）。
"""

from __future__ import annotations

from collections.abc import Callable

from agent_service.grants.store import ProjectionRepository
from agent_service.local_db import LocalDb

from .marketplace_provider import ManagerMarketplaceProvider, MarketplaceProvider
from .service import WorkspaceService
from .store import (
    InMemoryKnowledgeBaseRepository,
    InMemoryKnowledgeDocumentRepository,
    InMemoryKnowledgeIngestionRepository,
    InMemoryUploadAssetRepository,
    InMemoryWorkbenchStateRepository,
    KnowledgeBaseRepository,
    KnowledgeDocumentRepository,
    KnowledgeIngestionRepository,
    SqliteKnowledgeBaseRepository,
    SqliteKnowledgeDocumentRepository,
    SqliteKnowledgeIngestionRepository,
    SqliteUploadAssetRepository,
    SqliteWorkbenchStateRepository,
    UploadAssetRepository,
    WorkbenchStateRepository,
)


def build_workspace_service(
    *,
    projections: ProjectionRepository,
    db: LocalDb | None = None,
    upload_dir: str | None = None,
    marketplace_provider: MarketplaceProvider | None = None,
    unread_counts_provider: Callable[[str], int] | None = None,
    loop_service: "LoopService | None" = None,
) -> WorkspaceService:
    """装配本地 workspace 服务。

    db 非空用 SQLite（#159），空用 InMemory（dev/测试）。
    unread_counts_provider 由装配层注入（主链未读回调）；未注入时工作台未读回退 0，
    不影响现有 dev/测试。
    upload_dir 为空时上传功能不可用——调用方应确保配置。
    marketplace_provider 必须传入一个真实 provider（通常为 ManagerMarketplaceProvider）；
    不再提供 FakeMarketplaceProvider 兜底（AITEAM-672）。
    """
    workbench_store: WorkbenchStateRepository = (
        SqliteWorkbenchStateRepository(db) if db else InMemoryWorkbenchStateRepository()
    )
    kb_store: KnowledgeBaseRepository = (
        SqliteKnowledgeBaseRepository(db) if db else InMemoryKnowledgeBaseRepository()
    )
    doc_store: KnowledgeDocumentRepository = (
        SqliteKnowledgeDocumentRepository(db) if db else InMemoryKnowledgeDocumentRepository()
    )
    ingest_store: KnowledgeIngestionRepository = (
        SqliteKnowledgeIngestionRepository(db) if db else InMemoryKnowledgeIngestionRepository()
    )
    upload_store: UploadAssetRepository = (
        SqliteUploadAssetRepository(db) if db else InMemoryUploadAssetRepository()
    )
    return WorkspaceService(
        projections=projections,
        workbench_store=workbench_store,
        kb_store=kb_store,
        doc_store=doc_store,
        ingest_store=ingest_store,
        upload_store=upload_store,
        upload_dir=upload_dir,
        marketplace_provider=marketplace_provider,
        unread_counts_provider=unread_counts_provider,
        loop_service=loop_service,
    )
