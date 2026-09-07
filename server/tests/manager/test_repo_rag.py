"""rag.py (PgManagerRagService) tenant workspace routing tests."""

from __future__ import annotations

import pytest

from manager_service.knowledge_space_repository import KnowledgeSpaceRepository
from manager_service.rag import PgManagerRagService, RagHandle
from manager_service.rag_instances import RagInstance, RagInstanceRegistry
from shared.db import ManagerRagService

from ._fake_router import FakeCursor, FakeRouter, ctx

_TID = "12345678-1234-1234-1234-123456789abc"
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


def test_knowledge_space_ensure_preserves_legacy_enterprise_key():
    workspace = "t123__ks_default"
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


def test_get_returns_existing_tenant_mapping():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(workspace, "legacy")),
        FakeCursor(fetchone=(_TID, _SPACE, workspace, "legacy")),
    )
    handle = _make_svc(router).get(ctx(tid=_TID), knowledge_space_id=_SPACE)
    assert isinstance(handle, RagHandle)
    assert handle.tenant_id == _TID
    assert handle.knowledge_space_id == _SPACE
    assert handle.workspace == workspace
    assert handle.instance_id == "legacy"
    assert router.executed[0][1] == (_SPACE,)
    assert "COALESCE(target.instance_id, EXCLUDED.instance_id)" in router.last_sql


def test_default_space_id_for_preserves_legacy_key():
    router = FakeRouter().queue(FakeCursor(fetchall=[("ks_default", "t123__ks_default")]))
    assert _make_svc(router).default_space_id_for(ctx(tid=_TID)) == "ks_default"


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
    workspace = next(
        f"tenant-a__candidate-{index}"
        for index in range(100)
        if registry.resolve(f"tenant-a__candidate-{index}").instance_id == "rag-b"
    )
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(workspace, "rag-a")),
        FakeCursor(fetchone=(_TID, _SPACE, workspace, "rag-a")),
    )
    handle = _make_svc(router, instance_registry=registry).get(ctx(tid=_TID), _SPACE)
    assert handle.instance_id == "rag-a"
    assert router.executed[-1][1][-1] == "rag-a"


def test_get_rejects_null_legacy_mapping_with_multi_instance_pool():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    registry = RagInstanceRegistry((
        RagInstance("rag-a", "http://rag-a", "secret-a"),
        RagInstance("rag-b", "http://rag-b", "secret-b"),
    ))
    router = FakeRouter().queue(FakeCursor(fetchone=(workspace, None)))
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        _make_svc(router, instance_registry=registry).get(ctx(tid=_TID), _SPACE)
    assert len(router.executed) == 1


def test_get_bootstraps_null_legacy_mapping_with_single_instance_pool():
    workspace = ManagerRagService.derive_workspace(_TID, _SPACE)
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(workspace, None)),
        FakeCursor(fetchone=(_TID, _SPACE, workspace, "rag-a")),
    )
    handle = _make_svc(router, instance_registry=_registry_for()).get(ctx(tid=_TID), _SPACE)
    assert handle.instance_id == "rag-a"


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
