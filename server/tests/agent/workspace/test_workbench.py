"""工作台 + 市场 + 招募 + 办公室测试（#267）。"""

from datetime import datetime, timezone
from uuid import uuid4

from agent_service.grants.store import InMemoryProjectionRepository
from agent_service.workspace.store import (
    InMemoryKnowledgeBaseRepository,
    InMemoryKnowledgeDocumentRepository,
    InMemoryUploadAssetRepository,
    InMemoryWorkbenchStateRepository,
    WorkbenchState,
)
from agent_service.workspace.service import MarketTemplate, WorkspaceService
from shared.contracts.grants import LoadedExpertProjection


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _make_projection(employee_id: str, display_name: str) -> LoadedExpertProjection:
    return LoadedExpertProjection(
        employee_id=employee_id,
        tenant_id="t1",
        version="1",
        display_name=display_name,
        runtime_binding=None,
        synced_at=_now_dt(),
        revoked=False,
    )


def _make_service():
    proj = InMemoryProjectionRepository()
    wb = InMemoryWorkbenchStateRepository()
    kb = InMemoryKnowledgeBaseRepository()
    docs = InMemoryKnowledgeDocumentRepository()
    uploads = InMemoryUploadAssetRepository()
    svc = WorkspaceService(
        projections=proj,
        workbench_store=wb,
        kb_store=kb,
        doc_store=docs,
        upload_store=uploads,
        upload_dir=None,  # will test upload separately
    )
    # Pre-populate marketplace cache
    svc.sync_marketplace([
        MarketTemplate(
            template_id="tpl-1", display_name="专家A", category="coding",
            model_name="gpt-5", tags=["python"], persona="资深后端",
            skills=[{"name": "code-review"}],
        ),
        MarketTemplate(
            template_id="tpl-2", display_name="专家B", category="writing",
            tags=["copywriting"],
        ),
    ])
    return svc, proj, wb


class TestWorkbench:
    def test_empty_workbench_returns_empty_view(self):
        svc, _, _ = _make_service()
        view = svc.get_workbench()
        assert view.employees == []
        assert view.total_unread == 0

    def test_workbench_shows_projections_as_employees(self):
        svc, proj, _ = _make_service()
        proj.upsert(_make_projection("emp-1", "Alice"))
        proj.upsert(_make_projection("emp-2", "Bob"))
        view = svc.get_workbench()
        assert len(view.employees) == 2
        names = {e.display_name for e in view.employees}
        assert names == {"Alice", "Bob"}

    def test_workbench_reflects_starred_state(self):
        svc, proj, wb = _make_service()
        proj.upsert(_make_projection("emp-1", "Alice"))
        wb.upsert(WorkbenchState(employee_id="emp-1", is_starred=True))
        view = svc.get_workbench()
        assert view.employees[0].is_starred is True

    def test_update_workbench_state_creates_new_entry(self):
        svc, _, wb = _make_service()
        svc.update_workbench_state(employee_id="emp-1", is_starred=True)
        state = wb.get("emp-1")
        assert state is not None
        assert state.is_starred is True

    def test_update_workbench_state_preserves_unchanged_fields(self):
        svc, _, wb = _make_service()
        wb.upsert(WorkbenchState(employee_id="emp-1", is_starred=True, last_read_msg_id="msg-1"))
        svc.update_workbench_state(employee_id="emp-1", is_starred=False)
        state = wb.get("emp-1")
        assert state.is_starred is False
        assert state.last_read_msg_id == "msg-1"  # preserved


class TestMarketplace:
    def test_list_marketplace_returns_all_templates(self):
        svc, _, _ = _make_service()
        templates = svc.list_marketplace()
        assert len(templates) == 2
        ids = {t.template_id for t in templates}
        assert ids == {"tpl-1", "tpl-2"}

    def test_list_marketplace_filters_by_category(self):
        svc, _, _ = _make_service()
        templates = svc.list_marketplace(category="coding")
        assert len(templates) == 1
        assert templates[0].template_id == "tpl-1"

    def test_list_marketplace_filters_by_keyword(self):
        svc, _, _ = _make_service()
        templates = svc.list_marketplace(keyword="专家A")
        assert len(templates) == 1
        assert templates[0].display_name == "专家A"

    def test_get_marketplace_detail_returns_detail(self):
        svc, _, _ = _make_service()
        t = svc.get_marketplace_detail("tpl-1")
        assert t is not None
        assert t.display_name == "专家A"
        assert t.persona == "资深后端"
        assert len(t.skills) == 1

    def test_get_marketplace_detail_missing_returns_none(self):
        svc, _, _ = _make_service()
        assert svc.get_marketplace_detail("nonexistent") is None


class TestRecruit:
    def test_recruit_creates_projection_from_template(self):
        svc, proj, _ = _make_service()
        result = svc.recruit("tpl-1")
        assert result.success is True
        assert result.employee_id is not None
        assert result.message == "招募成功"
        # Verify projection was created
        p = proj.get(result.employee_id)
        assert p is not None
        assert p.display_name == "专家A"

    def test_recruit_nonexistent_template_fails(self):
        svc, _, _ = _make_service()
        result = svc.recruit("nonexistent")
        assert result.success is False
        assert "不存在" in result.message

    def test_recruit_duplicate_returns_existing(self):
        svc, proj, _ = _make_service()
        first = svc.recruit("tpl-1")
        second = svc.recruit("tpl-1")
        assert second.success is True
        assert second.employee_id == first.employee_id
        assert "已招募" in second.message
        # Only one projection should exist for this template
        available = proj.available()
        names = [p.display_name for p in available]
        assert names.count("专家A") == 1


class TestOffice:
    def test_office_scene_reflects_projections(self):
        svc, proj, _ = _make_service()
        proj.upsert(_make_projection("emp-1", "Alice"))
        proj.upsert(_make_projection("emp-2", "Bob"))
        scene = svc.get_office_scene()
        assert scene.summary["total"] == 2
        assert scene.summary["ready"] == 2
        assert len(scene.employees) == 2

    def test_office_feed_returns_empty_initially(self):
        svc, _, _ = _make_service()
        feed = svc.get_office_feed()
        assert feed.events == []


class TestOrgTree:
    def test_org_tree_reflects_projections(self):
        svc, proj, _ = _make_service()
        proj.upsert(_make_projection("emp-1", "Alice"))
        proj.upsert(_make_projection("emp-2", "Bob"))
        tree = svc.get_org_tree()
        assert tree.id == "root"
        assert tree.type == "department"
        assert len(tree.children) == 2
        child_ids = {c.id for c in tree.children}
        assert child_ids == {"emp-1", "emp-2"}
