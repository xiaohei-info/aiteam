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
from shared.errors import Conflict, NotFound, ValidationProblem


class FakeCatalogGateway(CatalogManagerGateway):
    """记录目录变更通知与幂等键的内存 fake，不发真实网络。"""

    def __init__(self) -> None:
        self.notifications: list[tuple[CatalogReleaseNotify, str]] = []

    def notify_catalog_release(self, notify, *, idempotency_key):
        self.notifications.append((notify, idempotency_key))


class PlatformProviderStore:
    def validate_model_ref(self, ref, *, require_published=False):
        return ref


@pytest.fixture
def manager():
    return FakeCatalogGateway()


@pytest.fixture
def service(manager):
    class PlatformSkillStore:
        def get_package(self, *, skill_id, version, published_only=False):
            return {"content_hash": "abc123"}
    return CatalogService(
        CatalogRepository(), manager,
        platform_skills=PlatformSkillStore(), platform_providers=PlatformProviderStore(),
    )


def _expert(**kw):
    base = dict(
        template_id="tpl-cmo",
        display_name="CMO",
        category="marketing",
        avatar_url="https://example.com/cmo.png",
        system_prompt="market lead",
        platform_model_ref={"provider_id": "provider-1", "provider_version": 1, "model_id": "gpt-5", "model_version": 1},
        platform_skill_refs=[],
        description="CMO expert",
    )
    base.update(kw)
    return RegisterExpertTemplateRequest(**base)


def _solution(**kw):
    base = dict(
        solution_id="sol-growth",
        display_name="Growth",
        description="growth solution",
        expert_template_ids=["tpl-cmo"],
        coordinator_template_id="tpl-cmo",
        coordinator_instructions="Plan the campaign",
    )
    base.update(kw)
    return RegisterSolutionTemplateRequest(**base)


def _multi_solution(**kw):
    base = dict(
        solution_id="sol-multi",
        display_name="Multi",
        description="multi solution",
        coordinator_template_id="tpl-ceo",
        coordinator_instructions="Plan the multi campaign",
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

    svc = CatalogService(CatalogRepository(), _FailingGateway(), platform_providers=PlatformProviderStore())
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

    svc = CatalogService(CatalogRepository(), _FailingGateway(), platform_providers=PlatformProviderStore())
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
    """PATCH 写入非顶层字段（system_prompt）应合并进 payload，不抛 TypeError。
    这是 issue #266 的核心回归点：dataclasses.replace 不接受未定义的字段名。
    """
    service.register_expert_template(_expert())
    updated = service.update_entry(
        CatalogType.EXPERT_TEMPLATE, "tpl-cmo", {"system_prompt": "chief marketing"}
    )
    assert updated.display_name == "CMO"  # 不变
    entry = service.get_entry(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.system_prompt == "chief marketing"


def test_update_entry_mixed_fields(service):
    """PATCH 同时更新顶层 + payload 字段。"""
    service.register_expert_template(_expert())
    updated = service.update_entry(
        CatalogType.EXPERT_TEMPLATE, "tpl-cmo",
        {"display_name": "CMO v2", "system_prompt": "vp marketing", "category": "marketing"},
    )
    assert updated.display_name == "CMO v2"
    entry = service._repo.get(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.payload.get("system_prompt") == "vp marketing"
    assert entry.payload.get("category") == "marketing"


def test_update_entry_unknown_404(service):
    with pytest.raises(NotFound):
        service.update_entry(CatalogType.EXPERT_TEMPLATE, "ghost", {"display_name": "x"})


def test_update_solution_template_mixed_fields(service, manager):
    """PATCH 方案模板同时更新顶层 + payload 字段。"""
    service.register_solution_template(_solution())
    updated = service.update_entry(
        CatalogType.SOLUTION_TEMPLATE, "sol-growth",
        {"display_name": "Growth v2", "coordinator_instructions": "Coordinate the team"},
    )
    assert updated.display_name == "Growth v2"
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload.get("coordinator_instructions") == "Coordinate the team"


# ---- 方案模板协作说明字段 ----

def test_register_solution_with_coordinator_instructions(service):
    """方案只保存协调专家和可选自然语言协作说明。"""
    req = _solution(
        coordinator_instructions="先核查数据，再给出运营建议",
        description="增长方案描述",
        icon="icon-growth",
        tags=["marketing", "growth"],
    )
    service.register_solution_template(req)
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload["coordinator_template_id"] == "tpl-cmo"
    assert entry.payload["coordinator_instructions"] == "先核查数据，再给出运营建议"
    assert entry.payload["description"] == "增长方案描述"
    assert entry.payload["icon"] == "icon-growth"
    assert entry.payload["tags"] == ["marketing", "growth"]


def test_register_solution_defaults_optional_coordinator_instructions(service):
    service.register_solution_template(_solution(coordinator_instructions=""))
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload["coordinator_template_id"] == "tpl-cmo"
    assert entry.payload["coordinator_instructions"] == ""


def test_update_solution_coordinator_instructions(service):
    service.register_solution_template(_solution())
    service.update_entry(
        CatalogType.SOLUTION_TEMPLATE, "sol-growth",
        {"coordinator_instructions": "New collaboration guidance", "tags": ["updated"]},
    )
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload["coordinator_instructions"] == "New collaboration guidance"
    assert entry.payload["tags"] == ["updated"]


# ---- Issue #279：专家模板模型/绑定/提示词包/分类/角色字段 ----

def test_register_expert_stores_minimal_fields_and_pinned_skills(service):
    ref = {"skill_id": "00000000-0000-0000-0000-000000000101", "version": "1.0.0", "content_hash": "abc123"}
    req = _expert(
        category="marketing",
        avatar_url="https://example.com/avatar.png",
        system_prompt="You are CMO",
        platform_skill_refs=[ref],
        description="营销高管",
    )
    service.register_expert_template(req)
    entry = service._repo.get(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.payload["category"] == "marketing"
    assert entry.payload["avatar_url"] == "https://example.com/avatar.png"
    assert entry.payload["system_prompt"] == "You are CMO"
    assert entry.payload["platform_model_ref"]["model_id"] == "gpt-5"
    assert entry.payload["skill_ids"] == []
    assert entry.payload["platform_skill_refs"] == [ref]
    assert entry.payload["description"] == "营销高管"
    assert "initial_memories" not in entry.payload
    assert "sort_order" not in entry.payload


def test_register_expert_default_fields(service):
    """头像与平台技能均可不选。"""
    service.register_expert_template(_expert())
    entry = service._repo.get(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.payload["category"] == "marketing"
    assert entry.payload["avatar_url"] == "https://example.com/cmo.png"
    assert entry.payload["system_prompt"] == "market lead"
    assert entry.payload["platform_model_ref"]["model_id"] == "gpt-5"
    assert entry.payload["skill_ids"] == []
    assert entry.payload["platform_skill_refs"] == []
    assert entry.payload["description"] == "CMO expert"
    assert entry.payload["tags"] == []


def test_update_expert_flat_fields(service):
    """PATCH 专家模板可更新 PRD-v2 扁平字段。"""
    service.register_expert_template(_expert())
    service.update_entry(
        CatalogType.EXPERT_TEMPLATE, "tpl-cmo",
        {
            "system_prompt": "Updated system prompt",
            "platform_model_ref": {"provider_id": "provider-1", "provider_version": 1, "model_id": "claude-opus-4-8", "model_version": 1},
            "category": "growth",
            "platform_skill_refs": [{"skill_id": "00000000-0000-0000-0000-000000000101", "version": "1.0.0", "content_hash": "abc123"}],
        },
    )
    entry = service._repo.get(CatalogType.EXPERT_TEMPLATE, "tpl-cmo")
    assert entry.payload["system_prompt"] == "Updated system prompt"
    assert entry.payload["platform_model_ref"]["model_id"] == "claude-opus-4-8"
    assert entry.payload["category"] == "growth"
    assert entry.payload["platform_skill_refs"][0]["version"] == "1.0.0"


def test_list_published_experts_skips_legacy_missing_model_ref(service):
    service._repo.create(CatalogEntry(
        catalog_type=CatalogType.EXPERT_TEMPLATE,
        template_id="legacy-no-model",
        version="1",
        display_name="旧专家",
        status=CatalogStatus.PUBLISHED,
        payload={"system_prompt": "legacy"},
    ))
    service._repo.create(CatalogEntry(
        catalog_type=CatalogType.EXPERT_TEMPLATE,
        template_id="valid-model",
        version="1",
        display_name="可用专家",
        status=CatalogStatus.PUBLISHED,
        payload={"platform_model_ref": {"provider_id": "p", "provider_version": 1, "model_id": "m", "model_version": 1}},
    ))

    items = service.list_published_expert_templates()
    assert [item.template_id for item in items] == ["valid-model"]


def test_list_includes_full_config(service):
    """GET 目录列表时 CatalogEntryResponse 应返回完整模板配置（PRD-v2 扁平字段验收）。"""
    service.register_expert_template(
        _expert(
            system_prompt="x",
            category="marketing",
            platform_skill_refs=[{"skill_id": "00000000-0000-0000-0000-000000000101", "version": "1.0.0", "content_hash": "abc123"}],
            description="desc",
        )
    )
    items = service.list_catalog(catalog_type=CatalogType.EXPERT_TEMPLATE)
    assert len(items) == 1
    out = items[0]
    assert out.system_prompt == "x"
    assert out.platform_model_ref.model_id == "gpt-5"
    assert out.category == "marketing"
    assert out.skill_ids == []
    assert out.platform_skill_refs[0].content_hash == "abc123"
    assert out.description == "desc"
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
        description="over",
        expert_template_ids=["tpl-ignored"],
        coordinator_template_id="tpl-real",
        coordinator_instructions="Plan override",
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
    service.register_solution_template(_solution(expert_template_ids=["tpl-a", "tpl-b"], coordinator_template_id="tpl-a"))
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


def test_solution_coordinator_must_be_enabled(service):
    with pytest.raises(Exception, match="enabled experts"):
        service.register_solution_template(_multi_solution(coordinator_template_id="tpl-cmo"))


def test_publish_missing_platform_model_ref_is_a_business_validation_error(service):
    service._repo.create(CatalogEntry(
        catalog_type=CatalogType.EXPERT_TEMPLATE,
        template_id="legacy-no-model-publish",
        version="1",
        display_name="旧专家",
        payload={"system_prompt": "legacy"},
    ))
    with pytest.raises(ValidationProblem, match="valid published platform model"):
        service.publish_template(CatalogType.EXPERT_TEMPLATE, "legacy-no-model-publish", PublishTemplateRequest())


def test_pull_solution_fails_closed_when_bound_expert_is_missing(service):
    service.register_solution_template(_solution(solution_id="sol-missing", expert_template_ids=["tpl-missing"], coordinator_template_id="tpl-missing"))
    service.publish_template(CatalogType.SOLUTION_TEMPLATE, "sol-missing", PublishTemplateRequest())
    with pytest.raises(Conflict, match="unavailable or not published"):
        service.pull_solution_package(solution_id="sol-missing")


# ---- AITEAM-355 问题二：服务端自动生成 ID ----

def _auto_expert(**kw):
    base = dict(
        display_name="Auto",
        category="x",
        avatar_url="h",
        system_prompt="s",
        platform_model_ref={"provider_id": "provider-1", "provider_version": 1, "model_id": "g", "model_version": 1},
        skill_ids=["sk"],
        description="d",
    )
    base.update(kw)
    return RegisterExpertTemplateRequest(**base)


def _auto_solution(**kw):
    base = dict(display_name="Auto-Solution", description="d", expert_template_ids=["tpl-cmo"], coordinator_template_id="tpl-cmo", coordinator_instructions="Auto plan")
    base.update(kw)
    return RegisterSolutionTemplateRequest(**base)
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


# ---- 协调专家完整性校验 ----

def test_register_solution_persists_coordinator_template_id(service):
    service.register_solution_template(_solution(coordinator_template_id="tpl-cmo"))
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload["coordinator_template_id"] == "tpl-cmo"


def test_register_solution_missing_coordinator_rejected(service):
    from shared.errors import ValidationProblem

    req = RegisterSolutionTemplateRequest(
        solution_id="sol-nocoordinator", display_name="NoCoordinator", description="d",
        expert_template_ids=["tpl-cmo"],
    )
    with pytest.raises(ValidationProblem):
        service.register_solution_template(req)


def test_register_solution_coordinator_not_in_experts_rejected(service):
    from shared.errors import ValidationProblem

    req = RegisterSolutionTemplateRequest(
        solution_id="sol-badcoordinator", display_name="BadCoordinator", description="d",
        expert_template_ids=["tpl-cmo"], coordinator_template_id="tpl-ghost",
    )
    with pytest.raises(ValidationProblem):
        service.register_solution_template(req)


def test_register_solution_multi_expert_coordinator(service):
    service.register_solution_template(_multi_solution())
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-multi")
    assert entry.payload["coordinator_template_id"] == "tpl-ceo"


def test_detail_view_includes_coordinator_template_id(service):
    service.register_solution_template(_solution())
    detail = service.get_entry_detail(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert detail.coordinator_template_id == "tpl-cmo"


def test_pull_solution_package_includes_coordinator_template_id(service):
    service.register_expert_template(_expert())
    service.register_solution_template(_solution())
    service.publish_template(CatalogType.EXPERT_TEMPLATE, "tpl-cmo", PublishTemplateRequest())
    service.publish_template(CatalogType.SOLUTION_TEMPLATE, "sol-growth", PublishTemplateRequest())
    pkg = service.pull_solution_package(solution_id="sol-growth")
    assert pkg.coordinator_template_id == "tpl-cmo"


def test_update_solution_coordinator_template_id(service):
    service.register_solution_template(_solution())
    service.update_entry(
        CatalogType.SOLUTION_TEMPLATE, "sol-growth",
        {"coordinator_template_id": "tpl-cmo"},
    )
    entry = service._repo.get(CatalogType.SOLUTION_TEMPLATE, "sol-growth")
    assert entry.payload["coordinator_template_id"] == "tpl-cmo"


def test_update_solution_empty_coordinator_rejected(service):
    from shared.errors import ValidationProblem

    service.register_solution_template(_solution())
    with pytest.raises(ValidationProblem):
        service.update_entry(
            CatalogType.SOLUTION_TEMPLATE, "sol-growth",
            {"coordinator_template_id": ""},
        )


def test_update_solution_invalid_coordinator_rejected(service):
    from shared.errors import ValidationProblem

    service.register_solution_template(_solution())
    with pytest.raises(ValidationProblem):
        service.update_entry(
            CatalogType.SOLUTION_TEMPLATE, "sol-growth",
            {"coordinator_template_id": "tpl-ghost"},
        )


def test_update_solution_empty_experts_rejected(service):
    from shared.errors import ValidationProblem

    service.register_solution_template(_solution())
    with pytest.raises(ValidationProblem):
        service.update_entry(
            CatalogType.SOLUTION_TEMPLATE, "sol-growth",
            {"expert_template_ids": [], "expert_bindings": []},
        )
