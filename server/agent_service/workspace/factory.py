"""workspace 服务装配。

依赖注入 grants 投影仓储 + 本地仓储，对齐 grants/factory.py 装配模式。
db 非空时用 SQLite 实现，空时用 InMemory（dev/测试）。
"""

from __future__ import annotations

from agent_service.grants.store import ProjectionRepository
from agent_service.local_db import LocalDb

from .service import WorkspaceService
from .store import (
    InMemoryKnowledgeBaseRepository,
    InMemoryKnowledgeDocumentRepository,
    InMemoryUploadAssetRepository,
    InMemoryWorkbenchStateRepository,
    KnowledgeBaseRepository,
    KnowledgeDocumentRepository,
    SqliteKnowledgeBaseRepository,
    SqliteKnowledgeDocumentRepository,
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
) -> WorkspaceService:
    """装配本地 workspace 服务。

    db 非空用 SQLite（#159），空用 InMemory（dev/测试）。
    upload_dir 为空时上传功能不可用——调用方应确保配置。
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
    upload_store: UploadAssetRepository = (
        SqliteUploadAssetRepository(db) if db else InMemoryUploadAssetRepository()
    )
    return WorkspaceService(
        projections=projections,
        workbench_store=workbench_store,
        kb_store=kb_store,
        doc_store=doc_store,
        upload_store=upload_store,
        upload_dir=upload_dir,
    )
