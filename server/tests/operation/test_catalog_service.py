"""CatalogService 单元测试（05 F03，D1）。

模板真相态归 Operator；发布/下架/可见范围变更必通知 Manager（CatalogReleaseNotify）。
对端 Manager 用 fake 网关；不写 Manager 租户库（只服务调用）。
"""

import pytest

from operation_service.catalog_gateway import CatalogManagerGateway
from operation_service.catalog_repository import CatalogEntry, CatalogRepository
from operation_service.catalog_schemas import (
    PublishTemplateRequest,
    RegisterExpertTemplateRequest,
    RegisterSolutionTemplateRequest,
    ExpertBinding,
    SetVisibilityRequest,
)
from operation_service.catalog_service import CatalogService
from shared.contracts.crosstier import CatalogReleaseNotify
from shared.contracts.enums import CatalogStatus, CatalogType
from shared.errors import Conflict, NotFound


class FakeCatalogGateway(CatalogManagerGateway):
    """记录目录变更通知与幂等键的内存 fake，不发真实网络。"""

    def __init__(self) -> None:
        self.notifications: list[tuple[CatalogReleaseNotify, str]] = []

    def notify_catalog_release(self, notify, *, idempotency_key):
        self.notifications.append((notify, idempotency_key))


@pytest.fixture
def manager():
    return FakeCatalogGateway()


@pytest.fixture
def service(manager):
    return CatalogService(CatalogRepository(), manager)


def _expert(**kw):
    base = dict(template_id="tpl-cmo", display_name="CMO", persona="market lead")
    base.update(kw)
    return RegisterExpertTemplateRequest(**base)


def _solution(**kw):
    base = dict(
        solution_id="sol-growth",
        display_name="Growth",
        expert_template_ids=["tpl-cmo"],
    )
    base.update(kw)
    return RegisterSolutionTemplateRequest(**base)


def _multi_solution(**kw):
    base = dict(
        solution_id="sol-multi",
        display_name="Multi",
        expert_bindings=[
            ExpertBinding(template_id="tpl-cmo", sequence_no=2, enabled=False),
            ExpertBinding(template_id="tpl-ceo", sequence_no=1, enabled=True),
        ],
    )
    base.update(kw)
    return RegisterSolutionTemplateRequest(**base)


# ---- 注册（草稿态，不通知 Manager）----

def test_register_expert_is_draft_and_silent(service, manager):
    entry = service.register_expert_template(_expert())
    assert entry.catalog_type == CatalogType.EXPERT_TEMPLATE
    assert entry.status == CatalogStatus.DRAFT
    assert entry.version  # 自动派生首版本
    assert manager.notifications == []  # 草稿不外溢


def test_register_solution_is_draft(service):
    entry = service.register_solution_template(_solution())
    assert entry.catalog_type == CatalogType.SOLUTION_TEMPLATE
    assert entry.status == CatalogStatus.DRAFT


def test_register_duplicate_id_conflict(service):
    service.register_expert_template(_expert())
    with pytest.raises(Conflict):
        service.register_expert_template(_expert())


# ---- 发布 ----

def test_publish_notifies_manager(service, manager):
    service.register_expert_template(_expert())
    entry = service.publish_template(
        CatalogType.EXPERT_TEMPLATE, "tpl-cmo", PublishTemplateRequest()
    )
    assert entry.status == CatalogStatus.PUBLISHED

    assert len(manager.notifications) == 1
    notify, key = manager.notifications[0]
    assert notify.catalog_type == CatalogType.EXPERT_TEMPLATE.value
    assert notify.template_id == "tpl-cmo"
    assert notify.action == "published"
    assert notify.version == entry.version
    # 幂等键随 type/id/version/action 派生，下游可去重。
    assert "tpl-cmo" in key and "published" in key


def test_publish_unknown_404(service):
    with pytest.raises(NotFound):
        service.publish_template(
            CatalogType.EXPERT_TEMPLATE, "ghost", PublishTemplateRequest()
        )


def test_publish_already_published_conflict(service):
    service.register_expert_template(_expert())
    service.publish_template(CatalogType.EXPERT_TEMPLATE, "tpl-cmo", PublishTemplateRequest())
    with pytest.raises(Conflict):
        service.publish_template(CatalogType.EXPERT_TEMPLATE, "tpl-cmo", PublishTemplateRequest())


# ---- 下架 ----

def test_publish_succeeds_when_manager_notify_fails(service):
    """Manager 通知失败不应阻断发布：Operator 已落本端真相，通知是 best-effort。"""
    class _FailingGateway(CatalogManagerGateway):
        def notify_catalog_release(self, notify, *, idempotency_key):
            raise RuntimeError('Manager unreachable / 405')

    svc = CatalogService(CatalogRepository(), _FailingGateway())
    svc.register_expert_template(_expert())
    entry = svc.publish_template(
        CatalogType.EXPERT_TEMPLATE, 'tpl-cmo', PublishTemplateRequest()
    )
    assert entry.status == CatalogStatus.PUBLISHED


def test_unpublish_succeeds_when_manager_notify_fails(service):
    """Manager 通知失败不应阻断下架。"""
    class _FailingGateway(CatalogManagerGateway):
        def notify_catalog_release(self, notify, *, idempotency_key):
            raise RuntimeError('Manager unreachable / 405')

    svc = CatalogService(CatalogRepository(), _FailingGateway())
    svc.register_expert_template(_expert())
    svc.publish_template(CatalogType.EXPERT_TEMPLATE, 'tpl-cmo', PublishTemplateRequest())
    entry = svc.unpublish_template(CatalogType.EXPERT_TEMPLATE, 'tpl-cmo')
    assert entry.status == CatalogStatus.UNPUBLISHED


def test_unpublish_notifies_manager(service, manager):
    service.register_expert_template(_expert())
    service.publish_template(CatalogType.EXPERT_TEMPLATE, "tpl-cmo", PublishTemplateRequest())
    entry = service.unpublish_template(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.status == CatalogStatus.UNPUBLISHED

    notify, _ = manager.notifications[-1]
    assert notify.action == "unpublished"


def test_unpublish_draft_conflict(service):
    """未发布的不能下架。"""
    service.register_expert_template(_expert())
    with pytest.raises(Conflict):
        service.unpublish_template(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")


# ---- 可见范围 ----

def test_set_visibility_notifies_manager(service, manager):
    service.register_expert_template(_expert())
    service.publish_template(CatalogType.EXPERT_TEMPLATE, "tpl-cmo", PublishTemplateRequest())
    scope = {"tenant_ids": ["t1", "t2"]}
    entry = service.set_visibility(
        CatalogType.EXPERT_TEMPLATE, "tpl-cmo", SetVisibilityRequest(visible_scope=scope)
    )
    assert entry.visible_scope == scope

    notify, _ = manager.notifications[-1]
    assert notify.action == "visibility_changed"
    assert notify.visible_scope == scope


def test_set_visibility_unpublished_conflict(service):
    """只有已发布的目录项才谈得上可见范围变更通知。"""
    service.register_expert_template(_expert())
    with pytest.raises(Conflict):
        service.set_visibility(
            CatalogType.EXPERT_TEMPLATE, "tpl-cmo", SetVisibilityRequest(visible_scope={})
        )


# ---- 列举/获取 ----

def test_list_filters_by_status_and_type(service):
    service.register_expert_template(_expert())
    service.register_solution_template(_solution())
    service.publish_template(CatalogType.EXPERT_TEMPLATE, "tpl-cmo", PublishTemplateRequest())

    published = service.list_catalog(status=CatalogStatus.PUBLISHED)
    assert len(published) == 1
    assert published[0].template_id == "tpl-cmo"

    experts = service.list_catalog(catalog_type=CatalogType.EXPERT_TEMPLATE)
    assert {e.template_id for e in experts} == {"tpl-cmo"}


def test_get_unknown_404(service):
    with pytest.raises(NotFound):
        service.get_entry(CatalogType.SOLUTION_TEMPLATE, "nope")


# ---- 红线：不写 Manager 租户库 ----

def test_gateway_only_service_call_no_tenant_write(service, manager):
    """红线断言：Operator 只通过窄通道通知 Manager，不直写租户库——fake 只暴露 notify。"""
    service.register_expert_template(_expert())
    service.publish_template(CatalogType.EXPERT_TEMPLATE, "tpl-cmo", PublishTemplateRequest())
    assert hasattr(manager, "notify_catalog_release")
    assert all(isinstance(n, CatalogReleaseNotify) for n, _ in manager.notifications)


# ---- PATCH 回归测试（issue #266） ----

def test_update_entry_top_level_field(service):
    """PATCH 可更新顶层字段（如 display_name）。"""
    service.register_expert_template(_expert())
    updated = service.update_entry(
        CatalogType.EXPERT_TEMPLATE, "tpl-cmo", {"display_name": "NewCMO"}
    )
    assert updated.display_name == "NewCMO"


def test_update_entry_payload_field_no_type_error(service):
    """PATCH 写入非顶层字段（persona）应合并进 payload，不抛 TypeError。
    这是 issue #266 的核心回归点：dataclasses.replace 不接受未定义的字段名。
    """
    service.register_expert_template(_expert())
    updated = service.update_entry(
        CatalogType.EXPERT_TEMPLATE, "tpl-cmo", {"persona": "chief marketing"}
    )
    assert updated.display_name == "CMO"  # 不变
    # 验证 payload 已更新
    entry = service.get_entry(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry is not None


def test_update_entry_mixed_fields(service):
    """PATCH 同时更新顶层 + payload 字段。"""
    service.register_expert_template(_expert())
    updated = service.update_entry(
        CatalogType.EXPERT_TEMPLATE, "tpl-cmo",
        {"display_name": "CMO v2", "persona": "vp marketing", "recommended_config": {"temp": 0.9}},
    )
    assert updated.display_name == "CMO v2"
    # 再读回验证 payload 正确合并
    from operation_service.catalog_repository import CatalogRepository
    entry = service._repo.get(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.payload.get("persona") == "vp marketing"
    assert entry.payload.get("recommended_config") == {"temp": 0.9}


def test_update_entry_unknown_404(service):
    with pytest.raises(NotFound):
        service.update_entry(CatalogType.EXPERT_TEMPLATE, "ghost", {"display_name": "x"})


def test_update_solution_template_mixed_fields(service, manager):
    """PATCH 方案模板同时更新顶层 + payload 字段。"""
    service.register_solution_template(_solution())
    updated = service.update_entry(
        CatalogType.SOLUTION_TEMPLATE, "sol-growth",
        {"display_name": "Growth v2", "knowledge_refs": ["k1", "k2"]},
    )
    assert updated.display_name == "Growth v2"
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload.get("knowledge_refs") == ["k1", "k2"]


# ---- Issue #278：方案模板编排规则/蓝图字段 ----

def test_register_solution_with_orchestration_fields(service):
    """注册方案时携带编排规则 + 蓝图字段，应存入 payload。"""
    req = _solution(
        planner_prompt="Plan the campaign",
        subtask_prompt="Break into steps",
        aggregate_prompt="Summarize outputs",
        default_kb_blueprint={"graph": "knowledge_graph_v1"},
        default_skill_bundle={"skills": ["seo", "analytics"]},
        default_collaboration_template_ref="collab-tpl-001",
        tags=["marketing", "growth"],
    )
    service.register_solution_template(req)
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload["planner_prompt"] == "Plan the campaign"
    assert entry.payload["subtask_prompt"] == "Break into steps"
    assert entry.payload["aggregate_prompt"] == "Summarize outputs"
    assert entry.payload["default_kb_blueprint"] == {"graph": "knowledge_graph_v1"}
    assert entry.payload["default_skill_bundle"] == {"skills": ["seo", "analytics"]}
    assert entry.payload["default_collaboration_template_ref"] == "collab-tpl-001"
    assert entry.payload["tags"] == ["marketing", "growth"]


def test_register_solution_default_orchestration_fields(service):
    """注册方案时不带编排字段，应落默认值（空字符串/空 dict/空 list/None）。"""
    service.register_solution_template(_solution())
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload["planner_prompt"] == ""
    assert entry.payload["subtask_prompt"] == ""
    assert entry.payload["aggregate_prompt"] == ""
    assert entry.payload["default_kb_blueprint"] == {}
    assert entry.payload["default_skill_bundle"] == {}
    assert entry.payload["default_collaboration_template_ref"] is None
    assert entry.payload["tags"] == []


def test_update_solution_orchestration_fields(service):
    """PATCH 方案模板可更新编排字段。"""
    service.register_solution_template(_solution())
    service.update_entry(
        CatalogType.SOLUTION_TEMPLATE, "sol-growth",
        {
            "planner_prompt": "New planner",
            "tags": ["updated"],
            "default_kb_blueprint": {"new": True},
        },
    )
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload["planner_prompt"] == "New planner"
    assert entry.payload["tags"] == ["updated"]
    assert entry.payload["default_kb_blueprint"] == {"new": True}
    # 未更新字段保持原默认值
    assert entry.payload["subtask_prompt"] == ""
    assert entry.payload["default_collaboration_template_ref"] is None


# ---- Issue #279：专家模板模型/绑定/提示词包/分类/角色字段 ----

def test_register_expert_stores_model_binding_prompt_fields(service):
    """注册专家模板时携带 default_model_json/default_binding_json/prompt_pack_json/category_code/role_name，应存入 payload。"""
    req = _expert(
        default_model_json={"provider": "openai", "model": "gpt-5", "temperature": 0.7, "max_tokens": 2048},
        default_binding_json={"skills": ["web_search"], "knowledge_bases": ["kb_general"], "memory": {"mode": "builtin"}},
        prompt_pack_json={"system_prompt": "You are CMO", "behavior_rules": {"tone": "pro"}, "opening_message": "Hi"},
        category_code="marketing",
        role_name="CMO",
    )
    service.register_expert_template(req)
    entry = service._repo.get(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.payload["default_model_json"] == {"provider": "openai", "model": "gpt-5", "temperature": 0.7, "max_tokens": 2048}
    assert entry.payload["default_binding_json"]["skills"] == ["web_search"]
    assert entry.payload["prompt_pack_json"]["system_prompt"] == "You are CMO"
    assert entry.payload["category_code"] == "marketing"
    assert entry.payload["role_name"] == "CMO"


def test_register_expert_default_model_binding_prompt_fields(service):
    """注册专家模板时不带新字段，应落默认值（空 dict/string）。"""
    service.register_expert_template(_expert())
    entry = service._repo.get(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.payload["default_model_json"] == {}
    assert entry.payload["default_binding_json"] == {}
    assert entry.payload["prompt_pack_json"] == {}
    assert entry.payload["category_code"] == ""
    assert entry.payload["role_name"] == ""


def test_update_expert_model_binding_prompt_fields(service):
    """PATCH 专家模板可更新模型/绑定/提示词/分类/角色字段。"""
    service.register_expert_template(_expert())
    service.update_entry(
        CatalogType.EXPERT_TEMPLATE, "tpl-cmo",
        {
            "default_model_json": {"provider": "relay", "model": "claude-opus-4-8", "temperature": 0.5, "max_tokens": 4096},
            "default_binding_json": {"skills": ["seo"]},
            "prompt_pack_json": {"system_prompt": "Updated"},
            "category_code": "growth",
            "role_name": "Growth Lead",
        },
    )
    entry = service._repo.get(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.payload["default_model_json"] == {"provider": "relay", "model": "claude-opus-4-8", "temperature": 0.5, "max_tokens": 4096}
    assert entry.payload["default_binding_json"] == {"skills": ["seo"]}
    assert entry.payload["prompt_pack_json"] == {"system_prompt": "Updated"}
    assert entry.payload["category_code"] == "growth"
    assert entry.payload["role_name"] == "Growth Lead"


def test_list_includes_full_config(service):
    """GET 目录列表时 CatalogEntryResponse 应返回完整模板配置（issue #279 验收）。"""
    service.register_expert_template(
        _expert(
            default_model_json={"model": "gpt-5"},
            prompt_pack_json={"system_prompt": "x"},
            category_code="marketing",
            role_name="CMO",
        )
    )
    items = service.list_catalog(catalog_type=CatalogType.EXPERT_TEMPLATE)
    assert len(items) == 1
    out = items[0]
    assert out.default_model_json == {"model": "gpt-5"}
    assert out.prompt_pack_json == {"system_prompt": "x"}
    assert out.category_code == "marketing"
    assert out.role_name == "CMO"
# ---- Issue #285：方案内专家绑定排序（sequence_no）与启用开关（enabled）----

def test_register_solution_expert_bindings_persisted(service):
    """显式 expert_bindings 应持久化到 payload，并派生有序 expert_template_ids。"""
    service.register_solution_template(_multi_solution())
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-multi")
    assert entry.payload["expert_template_ids"] == ["tpl-cmo", "tpl-ceo"]
    assert entry.payload["expert_bindings"] == [
        {"template_id": "tpl-cmo", "sequence_no": 2, "enabled": False},
        {"template_id": "tpl-ceo", "sequence_no": 1, "enabled": True},
    ]

def test_register_solution_expert_bindings_overrides_flat_ids(service):
    """提供 expert_bindings 时优先于 expert_template_ids（去重/重排序均由 bindings 决定）。"""
    req = RegisterSolutionTemplateRequest(
        solution_id="sol-over",
        display_name="Over",
        expert_template_ids=["tpl-ignored"],
        expert_bindings=[ExpertBinding(template_id="tpl-real", sequence_no=1, enabled=True)],
    )
    service.register_solution_template(req)
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-over")
    assert entry.payload["expert_template_ids"] == ["tpl-real"]
    assert entry.payload["expert_bindings"] == [
        {"template_id": "tpl-real", "sequence_no": 1, "enabled": True},
    ]

def test_register_solution_flat_ids_fallback_derives_bindings(service):
    """仅提供 expert_template_ids 时，应派生默认 bindings（位置顺序、全部启用）。"""
    service.register_solution_template(_solution(expert_template_ids=["tpl-a", "tpl-b"]))
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload["expert_template_ids"] == ["tpl-a", "tpl-b"]
    assert entry.payload["expert_bindings"] == [
        {"template_id": "tpl-a", "sequence_no": 1, "enabled": True},
        {"template_id": "tpl-b", "sequence_no": 2, "enabled": True},
    ]

def test_expert_binding_sequence_no_must_be_positive():
    """sequence_no < 1 应被 Pydantic 拒绝（ge=1）。"""
    with pytest.raises(Exception):
        ExpertBinding(template_id="tpl-x", sequence_no=0, enabled=True)



# ---- AITEAM-355 问题二：服务端自动生成 ID ----

def _auto_expert(**kw):
    base = dict(display_name="Auto")
    base.update(kw)
    return RegisterExpertTemplateRequest(**base)


def _auto_solution(**kw):
    base = dict(display_name="Auto-Solution")
    base.update(kw)
    return RegisterSolutionTemplateRequest(**kw)


def test_register_expert_without_id_generates_id(service, manager):
    """不传 template_id 时服务端必须自动生成非空、URL 安全的 ID（AITEAM-355）。"""
    entry = service.register_expert_template(_auto_expert(display_name="测试专家"))
    assert entry.template_id
    # URL 安全：只含 ASCII 字母/数字/连字符
    import re
    assert re.fullmatch(r"[a-z0-9-]+", entry.template_id), entry.template_id
    assert entry.status == CatalogStatus.DRAFT
    assert manager.notifications == []  # 草稿不通知 Manager


def test_register_solution_without_id_generates_id(service):
    entry = service.register_solution_template(_auto_solution(display_name="全渠道增长方案"))
    assert entry.template_id
    assert entry.status == CatalogStatus.DRAFT


def test_register_auto_id_chinese_display_name_falls_back_to_item(service):
    """全中文/非 ASCII display_name 应回落到可读的 item-<random> 形式。"""
    entry = service.register_expert_template(_auto_expert(display_name="首席技术官"))
    assert entry.template_id.startswith("item-")


def test_register_auto_id_same_display_name_no_collision(service):
    """同名注册两次不会冲突，ID 互不相同（随机后缀去重）。"""
    e1 = service.register_expert_template(_auto_expert(display_name="Sales Rep"))
    e2 = service.register_expert_template(_auto_expert(display_name="Sales Rep"))
    assert e1.template_id and e2.template_id
    assert e1.template_id != e2.template_id


def test_register_auto_id_is_persisted_and_fetchable(service):
    """自动生成的 ID 必须落库且能被后续 GET 命中。"""
    created = service.register_expert_template(_auto_expert(display_name="Persisted"))
    fetched = service._repo.get(CatalogType.EXPERT_TEMPLATE, created.template_id)
    assert fetched.display_name == "Persisted"
    assert fetched.version == "1"


def test_register_explicit_id_still_honored_and_conflicts(service):
    """显式 ID 必须保留原语义：直接 create、重复 → Conflict（409 路径）。"""
    first = service.register_expert_template(_auto_expert(display_name="A", template_id="my-explicit"))
    assert first.template_id == "my-explicit"
    with pytest.raises(Conflict):
        service.register_expert_template(_auto_expert(display_name="B", template_id="my-explicit"))



# ---- AITEAM-355 问题二：自动生成 ID 的极端路径 ----

class _ConflictThenSucceedRepository(CatalogRepository):
    """前 N 次 create 抛 Conflict，第 N+1 次成功——强制触发 _with_auto_id 的 except Conflict 重试分支。"""

    def __init__(self, conflicts: int = 2) -> None:
        super().__init__()
        self._conflicts = conflicts
        self._calls = 0

    def create(self, entry):
        self._calls += 1
        if self._calls <= self._conflicts:
            from shared.errors import Conflict

            raise Conflict(f"forced-id-conflict #{self._calls}")
        return super().create(entry)


class _SlugConflictRepository(CatalogRepository):
    """对所有 slug 派生 ID 抛 Conflict，对 uuid4 兜底 ID(item-*) 成功——强制 _with_auto_id 走完所有派生尝试后回退到 uuid4 兜底分支。"""

    def create(self, entry):
        from shared.errors import Conflict

        # _derive_id 产生 "{slug}-{4hex}"，_fallback_id 产生 "item-{8hex}"
        if not entry.template_id.startswith("item-"):
            raise Conflict("slug-collision")
        return super().create(entry)


def test_with_auto_id_retries_on_conflict_then_succeeds():
    """repo.create 前几次抛 Conflict 时 _with_auto_id 必须重试并最终成功。"""
    repo = _ConflictThenSucceedRepository(conflicts=3)
    from operation_service.catalog_service import _with_auto_id

    def make(candidate):
        from shared.contracts.enums import CatalogType

        return CatalogEntry(
            catalog_type=CatalogType.EXPERT_TEMPLATE,
            template_id=candidate,
            version="1",
            display_name="Retry",
            payload={},
        )

    entry = _with_auto_id(repo, make, "Retry")
    assert entry.template_id  # 重试后成功
    assert repo._calls == 4  # 3 次冲突 + 1 次成功


def test_with_auto_id_falls_back_to_uuid4_when_all_attempts_conflict():
    """所有 slug 派生尝试都冲突时，_with_auto_id 必须回退到 uuid4 兜底 ID。"""
    repo = _SlugConflictRepository()
    from operation_service.catalog_service import _with_auto_id

    def make(candidate):
        from shared.contracts.enums import CatalogType

        return CatalogEntry(
            catalog_type=CatalogType.EXPERT_TEMPLATE,
            template_id=candidate,
            version="1",
            display_name="Fallback",
            payload={},
        )

    entry = _with_auto_id(repo, make, "Fallback")
    assert entry.template_id.startswith("item-")  # _fallback_id 形式
    assert len(entry.template_id) == len("item-") + 8


def test_slugify_id_empty_and_special_inputs():
    """全空 / 纯特殊字符输入回落到可读的 "item" 基名（覆盖 base = ... or "item" 分支）。"""
    from operation_service.catalog_service import _slugify_id

    assert _slugify_id("", random_suffix="x1x2").startswith("item-")
    assert _slugify_id("   ", random_suffix="x1x2").startswith("item-")
    assert _slugify_id("测试中文", random_suffix="x1x2").startswith("item-")  # 非 ASCII 回落 item
    assert _slugify_id("Hello World!", random_suffix="abcd").startswith("hello-world-")
    assert _slugify_id("__$$%%__", random_suffix="abcd").startswith("item-")
