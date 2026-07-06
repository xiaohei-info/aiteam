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
from agent_service.workspace.marketplace_provider import MarketplaceProvider
from agent_service.workspace.service import MarketTemplate, WorkspaceService
from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.snapshot import ModelPolicy


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _make_projection(
    employee_id: str,
    display_name: str,
    *,
    skills: list[str] | None = None,
    knowledge_refs: list[str] | None = None,
    connector_refs: list[str] | None = None,
    memory_policy: dict | None = None,
    model_policy: ModelPolicy | None = None,
    persona: str | None = None,
) -> LoadedExpertProjection:
    return LoadedExpertProjection(
        employee_id=employee_id,
        tenant_id="t1",
        version="1",
        display_name=display_name,
        runtime_binding=None,
        persona=persona,
        model_policy=model_policy or ModelPolicy(),
        skills=skills or [],
        knowledge_refs=knowledge_refs or [],
        connector_refs=connector_refs or [],
        memory_policy=memory_policy,
        synced_at=_now_dt(),
        revoked=False,
    )


def _make_service():
    proj = InMemoryProjectionRepository()
    wb = InMemoryWorkbenchStateRepository()
    kb = InMemoryKnowledgeBaseRepository()
    docs = InMemoryKnowledgeDocumentRepository()
    uploads = InMemoryUploadAssetRepository()
    seed_templates = [
        MarketTemplate(
            template_id="tpl-1", display_name="专家A", category="coding",
            model_name="gpt-5", tags=["python"], persona="资深后端",
            skills=[{"name": "code-review"}],
        ),
        MarketTemplate(
            template_id="tpl-2", display_name="专家B", category="writing",
            tags=["copywriting"],
        ),
    ]
    svc = WorkspaceService(
        projections=proj,
        workbench_store=wb,
        kb_store=kb,
        doc_store=docs,
        upload_store=uploads,
        upload_dir=None,  # will test upload separately
        marketplace_provider=StubMarketplaceProvider(seed_templates),
    )
    return svc, proj, wb


class TestWorkbench:
    def test_empty_workbench_returns_empty_view(self):
        svc, _, _ = _make_service()
        view = svc.get_workbench()
        assert view.employees == []
        assert view.total_unread == 0

    def test_workbench_honors_unread_counts_provider(self):
        svc, proj, _ = _make_service()
        proj.upsert(_make_projection("emp-1", "Alice"))
        proj.upsert(_make_projection("emp-2", "Bob"))
        provider = {"emp-1": 3, "emp-2": 0}.get
        svc_with_provider = WorkspaceService(
            projections=proj,
            workbench_store=svc._workbench,
            kb_store=svc._kb,
            doc_store=svc._docs,
            upload_store=svc._uploads,
            upload_dir=None,
            marketplace_provider=StubMarketplaceProvider([]),
            unread_counts_provider=provider,
        )
        view = svc_with_provider.get_workbench()
        by_id = {e.employee_id: e for e in view.employees}
        assert by_id["emp-1"].unread_count == 3
        assert by_id["emp-2"].unread_count == 0
        assert view.total_unread == 3

    def test_workbench_defaults_to_zero_without_provider(self):
        svc, proj, _ = _make_service()
        proj.upsert(_make_projection("emp-1", "Alice"))
        view = svc.get_workbench()
        assert view.employees[0].unread_count == 0
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

    def test_recruit_inherits_template_config(self):
        """AITEAM-288：招募时继承模板全部能力配置（skills/knowledge/model/policy）。"""
        svc, proj, _ = _make_service()
        result = svc.recruit("tpl-1")
        p = proj.get(result.employee_id)
        assert p is not None
        # 模板 persona 应落进投影
        assert p.persona == "资深后端"
        # 模板 skills -> 投影 skills（MarketTemplate.skills 取 code/name 字段）
        assert p.skills == ["code-review"]
        # model_policy 应含模板 model_name
        assert p.model_policy.model == "gpt-5"
        # 空 connector_refs / 默认 model_policy 字段未被污染
        assert p.connector_refs == []
        assert p.runtime_policy.runtime_binding is None

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



class StubMarketplaceProvider:
    """测试用 provider：返回固定模板列表，隔离 fake 默认数据。"""

    def __init__(self, templates: list[MarketTemplate]) -> None:
        self._templates = templates

    def list_templates(self) -> list[MarketTemplate]:
        return [MarketTemplate(
            template_id=t.template_id,
            display_name=t.display_name,
            category=t.category,
            model_name=t.model_name,
            skills_count=t.skills_count,
            recruit_count=t.recruit_count,
            is_recruited=t.is_recruited,
            tags=list(t.tags),
            avatar_url=t.avatar_url,
            persona=t.persona,
            skills=[dict(s) for s in t.skills],
            knowledge_bases=[dict(k) for k in t.knowledge_bases],
            initial_memories=[dict(m) for m in t.initial_memories],
            rating=t.rating,
        ) for t in self._templates]


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
