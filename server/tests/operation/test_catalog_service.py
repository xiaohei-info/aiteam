"""CatalogService 单元测试（05 F03，D1）。

模板真相态归 Operator；发布/下架/可见范围变更必通知 Manager（CatalogReleaseNotify）。
对端 Manager 用 fake 网关；不写 Manager 租户库（只服务调用）。
"""

import pytest

from operation_service.catalog_gateway import CatalogManagerGateway
from operation_service.catalog_repository import CatalogRepository
from operation_service.catalog_schemas import (
    PublishTemplateRequest,
    RegisterExpertTemplateRequest,
    RegisterSolutionTemplateRequest,
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
