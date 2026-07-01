"""办公室聚合 scheduled jobs（issue #418）——后端口径。

覆盖：
- office feed 在循环注入后聚合本地 Loop 为 scheduled_job 事件（状态 / 下次触发 / 重试计数）；
- 未注入 loop_service 时保持空（向后兼容）；
- 优先使用 loop.title，缺失回退到 loop_id。
"""

from __future__ import annotations

import pytest

from agent_service.grants.store import InMemoryProjectionRepository
from agent_service.loop.models import Loop, LoopStatus, RecurrenceType
from agent_service.loop.service import LoopService
from agent_service.loop.store import InMemoryLoopRepository
from agent_service.workspace.marketplace_provider import FakeMarketplaceProvider
from agent_service.workspace.service import WorkspaceService
from agent_service.workspace.store import (
    InMemoryKnowledgeBaseRepository,
    InMemoryKnowledgeDocumentRepository,
    InMemoryUploadAssetRepository,
    InMemoryWorkbenchStateRepository,
)


def _make_workspace(*, loop_service: LoopService | None = None) -> WorkspaceService:
    return WorkspaceService(
        projections=InMemoryProjectionRepository(),
        workbench_store=InMemoryWorkbenchStateRepository(),
        kb_store=InMemoryKnowledgeBaseRepository(),
        doc_store=InMemoryKnowledgeDocumentRepository(),
        upload_store=InMemoryUploadAssetRepository(),
        upload_dir=None,
        marketplace_provider=FakeMarketplaceProvider(),
        loop_service=loop_service,
    )


def _build_loop(**overrides) -> Loop:
    base = dict(
        id="loop-1",
        conversation_id="conv-x",
        cron="*/15 * * * *",
        title=None,
        recurrence_type=RecurrenceType.CRON,
        status=LoopStatus.ACTIVE,
    )
    base.update(overrides)
    return Loop(**base)


def test_office_feed_aggregates_loops_as_scheduled_jobs() -> None:
    """office feed 把本地 Loop 聚合为 scheduled_job 事件。"""
    repo = InMemoryLoopRepository()
    loop = LoopService(loops=repo).create_loop(
        conversation_id="conv-1",
        title="每日巡检",
        cron="0 9 * * *",
        active=True,
    )
    ws = _make_workspace(loop_service=LoopService(loops=repo))

    feed = ws.get_office_feed()
    assert len(feed.events) == 1
    ev = feed.events[0]
    assert ev["type"] == "scheduled_job"
    assert ev["loop_id"] == loop.id
    assert ev["title"] == "每日巡检"
    assert ev["status"] == "active"
    assert ev["cron"] == "0 9 * * *"
    assert ev["conversation_id"] == "conv-1"
    assert ev["fire_count"] == 0
    # cron loop 通过 preview_next_run 计算下次触发（不为 None）
    assert isinstance(ev["next_run_at"], str)


def test_office_feed_without_loop_service_returns_empty() -> None:
    """未注入 loop_service 保持空列表（向后兼容旧调用方）。"""
    ws = _make_workspace()
    feed = ws.get_office_feed()
    assert feed.events == []


def test_office_feed_title_falls_back_to_loop_id() -> None:
    """loop.title 缺失时回退到 loop_id 作为展示 title。"""
    repo = InMemoryLoopRepository()
    repo.create(_build_loop())
    ws = _make_workspace(loop_service=LoopService(loops=repo))
    feed = ws.get_office_feed()
    assert feed.events[0]["title"] == "loop-1"


def test_office_feed_mapped_status_for_paused_and_error() -> None:
    """paused / error 状态与重试计数正确映射到事件。"""
    repo = InMemoryLoopRepository()
    repo.create(_build_loop(id="lp", status=LoopStatus.PAUSED, title="p"))
    repo.create(_build_loop(id="le", status=LoopStatus.ERROR, title="e", retry_count=2, max_retries=3))
    ws = _make_workspace(loop_service=LoopService(loops=repo))
    feed = ws.get_office_feed()
    by_id = {ev["loop_id"]: ev for ev in feed.events}
    assert by_id["lp"]["status"] == "paused"
    assert by_id["le"]["status"] == "error"
    assert by_id["le"]["retry_count"] == 2
    assert by_id["le"]["max_retries"] == 3


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
