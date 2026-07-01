"""issue #418 验收辅助：GET /api/agent/office/feed 聚合本地 Loop 为 scheduled_job 事件。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agent_service.app import build_app
from agent_service.grants.store import InMemoryProjectionRepository
from agent_service.workspace.service import WorkspaceService
from agent_service.loop.service import LoopService
from agent_service.loop.store import InMemoryLoopRepository


def _build_injector_app() -> tuple:
    repo = InMemoryLoopRepository()
    loop_svc = LoopService(loops=repo)
    # Create a loop
    loop_svc.create_loop(
        conversation_id="conv-1", title="每日巡检", cron="0 9 * * *", active=True,
    )
    from agent_service.grants.store import InMemoryProjectionRepository as PR
    return repo, loop_svc, PR()


def test_office_feed_endpoint_aggregates_scheduled_jobs() -> None:
    repo = InMemoryLoopRepository()
    loop_svc = LoopService(loops=repo)
    loop_svc.create_loop(conversation_id="conv-1", title="每日巡检", cron="0 9 * * *", active=True)

    projections = InMemoryProjectionRepository()

    # Build a fresh WorkspaceService
    from agent_service.workspace.service import WorkspaceService as WS
    from agent_service.workspace.store import (
        InMemoryKnowledgeBaseRepository, InMemoryKnowledgeDocumentRepository,
        InMemoryUploadAssetRepository, InMemoryWorkbenchStateRepository,
    )
    from agent_service.workspace.marketplace_provider import FakeMarketplaceProvider
    ws = WS(
        projections=projections,
        workbench_store=InMemoryWorkbenchStateRepository(),
        kb_store=InMemoryKnowledgeBaseRepository(),
        doc_store=InMemoryKnowledgeDocumentRepository(),
        upload_store=InMemoryUploadAssetRepository(),
        marketplace_provider=FakeMarketplaceProvider(),
        loop_service=loop_svc,
    )

    from agent_service.workspace.routes import build_workspace_router
    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(build_workspace_router(ws))
    c = TestClient(app)
    r = c.get("/api/agent/office/feed")
    assert r.status_code == 200
    body = r.json()
    # envelope
    events = body["data"]["events"]
    assert len(events) == 1
    ev = events[0]
    assert ev["type"] == "scheduled_job"
    assert ev["title"] == "每日巡检"
    assert ev["status"] == "active"
    assert ev["cron"] == "0 9 * * *"
    assert isinstance(ev["next_run_at"], str)
