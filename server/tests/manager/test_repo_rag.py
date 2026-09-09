"""rag.py (PgManagerRagService) tenant workspace routing tests."""

from __future__ import annotations

import pytest

from manager_service.knowledge_space_repository import KnowledgeSpaceRepository
from manager_service.rag import PgManagerRagService, RagHandle
from manager_service.rag_instances import (
    RagInstance,
    RagInstanceConfigurationError,
    RagInstanceRegistry,
)
from shared.db import ManagerRagService
from shared.errors import ValidationProblem

from ._fake_router import FakeCursor, FakeRouter, ctx

_TID = "12345678-1234-1234-1234-123456789abc"
_TENANT_PREFIX = f"t{_TID.replace('-', '')}"
_SPACE = "enterprise_shared"


def _make_svc(
    router: FakeRouter,
    *,
    instance_registry: RagInstanceRegistry | None = None,
) -> PgManagerRagService:
    svc = PgManagerRagService.__new__(PgManagerRagService)
    svc._router = router
    if instance_registry is not None:
        svc._instances = instance_registry
    return svc


def _registry_for(*, instance_id: str = "rag-a") -> RagInstanceRegistry:
    return RagInstanceRegistry((RagInstance(instance_id, "http://rag", "secret"),))


def test_legacy_knowledge_space_id_rejects_malformed_suffixes():
    from manager_service.rag import legacy_knowledge_space_id

    assert legacy_knowledge_space_id("tenant__valid-key") == "valid-key"
    assert legacy_knowledge_space_id("tenant__bad space") is None
    assert legacy_knowledge_space_id("no-suffix") is None


def test_knowledge_space_ensure_preserves_legacy_enterprise_key():
    workspace = f"{_TENANT_PREFIX}__ks_default"
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=None),
        FakeCursor(fetchall=[("ks_default", workspace, "Legacy", None)]),
    )
    row = KnowledgeSpaceRepository(router).ensure(
        ctx(tid=_TID), knowledge_space_id="enterprise_shared", display_name="企业知识库",
    )
    assert row.knowledge_space_id == "ks_default"
    assert row.workspace == workspace
    assert len(router.executed) == 2


def test_space_repository_stamps_instance_id_for_new_multi_pool_mapping():
    registry = RagInstanceRegistry((
        RagInstance("rag-a", "http://rag-a", "secret-a"),
        RagInstance("rag-b", "http://rag-b", "secret-b"),
    ))
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue(
        FakeCursor(fetchone=(_SPACE, workspace, "Enterprise", None))
    )
    row = KnowledgeSpaceRepository(router, instance_registry=registry).create(
        ctx(tid=_TID), knowledge_space_id=_SPACE, display_name="Enterprise"
    )
    assert row.workspace == workspace
    assert router.executed[0][1][-1] == registry.resolve(workspace).instance_id
    assert "instance_id" in router.executed[0][0]


def test_space_repository_rejects_registry_routing_failure():
    class BrokenRegistry:
        def resolve(self, _workspace: str):
            raise RagInstanceConfigurationError("invalid workspace")

    with pytest.raises(ValidationProblem, match="workspace routing is unavailable"):
        KnowledgeSpaceRepository(FakeRouter(), instance_registry=BrokenRegistry()).create(
            ctx(tid=_TID), knowledge_space_id=_SPACE, display_name="Enterprise"
        )


def test_space_repository_ensure_stamps_instance_id_for_multi_pool_mapping(monkeypatch):
    monkeypatch.delenv("AITEAM_ENTERPRISE_KNOWLEDGE_SPACE_ID", raising=False)
    registry = RagInstanceRegistry((
        RagInstance("rag-a", "http://rag-a", "secret-a"),
        RagInstance("rag-b", "http://rag-b", "secret-b"),
    ))
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=None),
        FakeCursor(fetchall=[]),
        FakeCursor(fetchone=(_SPACE, workspace, "Enterprise", None)),
    )
    row = KnowledgeSpaceRepository(router, instance_registry=registry).ensure(
        ctx(tid=_TID), knowledge_space_id=_SPACE, display_name="Enterprise",
    )
    assert row.workspace == workspace
    assert router.executed[-1][1][-1] == registry.resolve(workspace).instance_id
    assert "instance_id" in router.last_sql


def test_space_repository_rejects_existing_canonical_null_mapping_with_multi_pool():
    registry = RagInstanceRegistry((
        RagInstance("rag-a", "http://rag-a", "secret-a"),
        RagInstance("rag-b", "http://rag-b", "secret-b"),
    ))
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue(FakeCursor(fetchone=(_SPACE, workspace, "Enterprise", None)))
    with pytest.raises(ValidationProblem, match="workspace routing is unavailable"):
        KnowledgeSpaceRepository(router, instance_registry=registry).ensure(
            ctx(tid=_TID), knowledge_space_id=_SPACE, display_name="Enterprise",
        )
    assert len(router.executed) == 1


def test_space_repository_rejects_existing_legacy_null_mapping_with_multi_pool():
    registry = RagInstanceRegistry((
        RagInstance("rag-a", "http://rag-a", "secret-a"),
        RagInstance("rag-b", "http://rag-b", "secret-b"),
    ))
    workspace = f"{_TENANT_PREFIX}__ks_default"
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=None),
        FakeCursor(fetchall=[("ks_default", workspace, "Legacy", None)]),
    )
    with pytest.raises(ValidationProblem, match="workspace routing is unavailable"):
        KnowledgeSpaceRepository(router, instance_registry=registry).ensure(
            ctx(tid=_TID), knowledge_space_id=_SPACE, display_name="Enterprise",
        )
    assert len(router.executed) == 2


def test_space_repository_stamps_existing_null_mapping_with_single_pool():
    registry = _registry_for()
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(_SPACE, workspace, "Enterprise", None, None)),
        FakeCursor(fetchone=(_SPACE, workspace, "Enterprise", "rag-a", None)),
    )
    row = KnowledgeSpaceRepository(router, instance_registry=registry).ensure(
        ctx(tid=_TID), knowledge_space_id=_SPACE, display_name="Enterprise",
    )
    assert row.instance_id == "rag-a"
    assert router.executed[-1][1] == ("rag-a", _SPACE)


def test_space_repository_recognizes_legacy_enterprise_mapping():
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=("ks_default", f"{_TENANT_PREFIX}__ks_default", "Legacy", None)),
        FakeCursor(fetchone=None),
    )
    repository = KnowledgeSpaceRepository(router)
    assert repository.is_enterprise_space(ctx(tid=_TID), knowledge_space_id="ks_default")
    assert not repository.is_enterprise_space(ctx(tid=_TID), knowledge_space_id="missing")


def test_space_repository_rejects_ambiguous_legacy_enterprise_keys():
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=None),
        FakeCursor(fetchall=[
            (_SPACE, f"{_TENANT_PREFIX}__enterprise_shared", "Current", None),
            ("ks_default", f"{_TENANT_PREFIX}__ks_default", "Legacy", None),
        ]),
    )
    with pytest.raises(ValidationProblem, match="legacy enterprise knowledge-space mapping is ambiguous"):
        KnowledgeSpaceRepository(router).ensure(
            ctx(tid=_TID), knowledge_space_id=_SPACE, display_name="Enterprise",
        )


def test_get_returns_existing_tenant_mapping():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue(FakeCursor(fetchone=(workspace, "legacy")))
    handle = _make_svc(router).get(ctx(tid=_TID), knowledge_space_id=_SPACE)
    assert isinstance(handle, RagHandle)
    assert handle.tenant_id == _TID
    assert handle.knowledge_space_id == _SPACE
    assert handle.workspace == workspace
    assert handle.instance_id == "legacy"
    assert router.executed[0][1] == (_SPACE,)
    assert "FROM rag_workspace WHERE knowledge_space_id" in router.last_sql


def test_default_space_id_for_prefers_canonical_mapping(monkeypatch):
    monkeypatch.delenv("AITEAM_ENTERPRISE_KNOWLEDGE_SPACE_ID", raising=False)
    router = FakeRouter().queue(FakeCursor(fetchall=[(_SPACE, f"{_TENANT_PREFIX}__enterprise_shared")]))
    assert _make_svc(router).default_space_id_for(ctx(tid=_TID)) == _SPACE


def test_default_space_id_for_preserves_legacy_key():
    router = FakeRouter().queue(FakeCursor(fetchall=[("ks_default", f"{_TENANT_PREFIX}__ks_default")]))
    assert _make_svc(router).default_space_id_for(ctx(tid=_TID)) == "ks_default"


def test_is_enterprise_space_checks_canonical_and_legacy_mappings(monkeypatch):
    monkeypatch.delenv("AITEAM_ENTERPRISE_KNOWLEDGE_SPACE_ID", raising=False)
    router = FakeRouter().queue_many(
        FakeCursor(fetchall=[(_SPACE, f"{_TENANT_PREFIX}__enterprise_shared")]),
        FakeCursor(fetchone=(f"{_TENANT_PREFIX}__ks_default",)),
        FakeCursor(fetchone=None),
    )
    service = _make_svc(router)
    assert service.is_enterprise_space(ctx(tid=_TID), _SPACE)
    assert service.is_enterprise_space(ctx(tid=_TID), "ks_default")
    assert not service.is_enterprise_space(ctx(tid=_TID), "missing")


def test_default_space_id_for_rejects_malformed_existing_mapping():
    router = FakeRouter().queue(FakeCursor(fetchall=[(_SPACE, "enterprise_shared")]))
    assert _make_svc(router).default_space_id_for(ctx(tid=_TID)) is None


def test_is_enterprise_space_rejects_canonical_over_malformed_mapping():
    router = FakeRouter().queue(FakeCursor(fetchall=[(_SPACE, "enterprise_shared")]))
    assert not _make_svc(router).is_enterprise_space(ctx(tid=_TID), _SPACE)


def test_default_space_id_for_rejects_ambiguous_legacy_keys():
    router = FakeRouter().queue(FakeCursor(fetchall=[
        ("ks_default", f"{_TENANT_PREFIX}__ks_default"),
        ("smoke_space", f"{_TENANT_PREFIX}__smoke_space"),
    ]))
    assert _make_svc(router).default_space_id_for(ctx(tid=_TID)) is None


def test_get_derives_workspace_and_assigns_registry_instance():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=None),
        FakeCursor(fetchone=(_TID, _SPACE, workspace, "rag-a")),
    )
    handle = _make_svc(router, instance_registry=_registry_for()).get(ctx(tid=_TID), _SPACE)
    assert handle.workspace == workspace
    assert handle.instance_id == "rag-a"
    assert router.executed[-1][1] == (_TID, _SPACE, workspace, "rag-a")
    assert "SET workspace = target.workspace" in router.last_sql


def test_get_reuses_persisted_instance_id_after_pool_order_changes():
    registry = RagInstanceRegistry((
        RagInstance("rag-a", "http://rag-a", "secret-a"),
        RagInstance("rag-b", "http://rag-b", "secret-b"),
    ))
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    persisted_instance_id = (
        "rag-b" if registry.resolve(workspace).instance_id == "rag-a" else "rag-a"
    )
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(workspace, persisted_instance_id)),
        FakeCursor(fetchone=(_TID, _SPACE, workspace, persisted_instance_id)),
    )
    handle = _make_svc(router, instance_registry=registry).get(ctx(tid=_TID), _SPACE)
    assert handle.instance_id == persisted_instance_id
    assert router.executed[-1][1][-1] == persisted_instance_id


def test_get_rejects_null_legacy_mapping_with_multi_instance_pool():
    # A fixed/suffixed workspace predates tenant-derived routing and carries no
    # endpoint provenance, so a multi-entry pool must not guess its destination.
    workspace = "old-fixed-workspace"
    registry = RagInstanceRegistry((
        RagInstance("rag-a", "http://rag-a", "secret-a"),
        RagInstance("rag-b", "http://rag-b", "secret-b"),
    ))
    router = FakeRouter().queue(FakeCursor(fetchone=(workspace, None)))
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        _make_svc(router, instance_registry=registry).get(ctx(tid=_TID), _SPACE)
    assert len(router.executed) == 1


def test_get_rejects_derived_null_mapping_with_multi_instance_pool():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    registry = RagInstanceRegistry((
        RagInstance("rag-a", "http://rag-a", "secret-a"),
        RagInstance("rag-b", "http://rag-b", "secret-b"),
    ))
    router = FakeRouter().queue(FakeCursor(fetchone=(workspace, None)))
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        _make_svc(router, instance_registry=registry).get(ctx(tid=_TID), _SPACE)


def test_get_bootstraps_null_legacy_mapping_with_single_instance_pool():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(workspace, None)),
        FakeCursor(fetchone=(_TID, _SPACE, workspace, "rag-a")),
    )
    handle = _make_svc(router, instance_registry=_registry_for()).get(ctx(tid=_TID), _SPACE)
    assert handle.instance_id == "rag-a"


def test_disabled_get_does_not_create_missing_mapping():
    router = FakeRouter().queue(FakeCursor(fetchone=None))
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        _make_svc(router).get(ctx(tid=_TID), _SPACE)
    assert len(router.executed) == 1


def test_get_replays_legacy_mapping_without_overwrite():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(workspace, "legacy")),
        FakeCursor(fetchone=(_TID, _SPACE, workspace, "legacy")),
        FakeCursor(fetchone=(workspace, "legacy")),
        FakeCursor(fetchone=(_TID, _SPACE, workspace, "legacy")),
    )
    svc = _make_svc(router, instance_registry=_registry_for(instance_id="legacy"))
    first = svc.get(ctx(tid=_TID), _SPACE)
    second = svc.get(ctx(tid=_TID), _SPACE)
    assert first.instance_id == second.instance_id == "legacy"
    assert len(router.executed) == 4


@pytest.mark.parametrize("knowledge_space_id", [None, "", " "])
def test_get_rejects_blank_space_id(knowledge_space_id):
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        _make_svc(FakeRouter()).get(ctx(tid=_TID), knowledge_space_id)


@pytest.mark.parametrize("workspace", ["", "tother__enterprise_shared", "t123__other_space"])
def test_get_rejects_malformed_or_foreign_existing_mapping(workspace):
    router = FakeRouter().queue(FakeCursor(fetchone=(workspace, "legacy")))
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        _make_svc(router).get(ctx(tid=_TID), _SPACE)
    assert len(router.executed) == 1


def test_get_rejects_unknown_space_without_mapping():
    router = FakeRouter().queue(FakeCursor(fetchone=None))
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        _make_svc(router).get(ctx(tid=_TID), "legacy-unknown")
    assert len(router.executed) == 1


def test_get_fails_closed_on_persisted_instance_drift():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue(FakeCursor(fetchone=(workspace, "rag-old")))
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        _make_svc(router, instance_registry=_registry_for()).get(ctx(tid=_TID), _SPACE)
    assert len(router.executed) == 1


def test_get_fails_closed_on_mapping_return_drift():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(workspace, "rag-a")),
        FakeCursor(fetchone=("other-tenant", _SPACE, workspace, "rag-a")),
    )
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        _make_svc(router, instance_registry=_registry_for()).get(ctx(tid=_TID), _SPACE)
    assert len(router.executed) == 2


def test_list_workspaces_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[
        ("ks-1", "ws-1"),
        ("ks-2", "ws-2"),
    ]))
    rows = _make_svc(router).list_workspaces(ctx())
    assert rows == [
        {"knowledge_space_id": "ks-1", "workspace": "ws-1"},
        {"knowledge_space_id": "ks-2", "workspace": "ws-2"},
    ]


def test_init_creates_pg_router():
    """PgManagerRagService.__init__ stores a PgTenantRouter."""
    from shared.db import PgTenantRouter
    svc = PgManagerRagService("postgresql://localhost/test")
    assert isinstance(svc._router, PgTenantRouter)


def test_list_workspaces_empty():
    router = FakeRouter().queue(FakeCursor(fetchall=[]))
    assert _make_svc(router).list_workspaces(ctx()) == []
