"""rag.py (PgManagerRagService) branch coverage (issue #234, target >=90%)."""

from __future__ import annotations

import pytest

from manager_service.rag import PgManagerRagService, RagHandle
from manager_service.rag_instances import RagInstance, RagInstanceRegistry
from shared.db import ManagerRagService

from ._fake_router import FakeCursor, FakeRouter, ctx

_TID = "12345678-1234-1234-1234-123456789abc"


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


def _registry_for(tenant_id: str, *, instance_id: str = "rag-a") -> RagInstanceRegistry:
    workspace = ManagerRagService.derive_workspace(tenant_id, "ks-default")
    return RagInstanceRegistry((RagInstance(instance_id, "http://rag", "secret", workspace),))


def test_get_returns_rag_handle_with_verified_instance():
    workspace = ManagerRagService.derive_workspace(_TID, "ks-default")
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=(_TID, "ks-default", workspace, "legacy")))
    svc = _make_svc(router)
    handle = svc.get(ctx(tid=_TID), knowledge_space_id="ks-default")
    assert isinstance(handle, RagHandle)
    assert handle.tenant_id == _TID
    assert handle.knowledge_space_id == "ks-default"
    assert handle.workspace == workspace
    assert handle.instance_id == "legacy"
    assert "instance_id" in router.last_sql
    assert router.executed[-1][1][-1] == "legacy"


def test_get_resolves_registry_before_atomic_mapping_upsert():
    workspace = ManagerRagService.derive_workspace(_TID, "ks-default")
    registry = _registry_for(_TID)
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=(_TID, "ks-default", workspace, "rag-a")))
    handle = _make_svc(router, instance_registry=registry).get(ctx(tid=_TID), "ks-default")
    assert handle.instance_id == "rag-a"
    assert router.executed[-1][1] == (_TID, "ks-default", workspace, "rag-a")
    assert "COALESCE(target.instance_id, EXCLUDED.instance_id)" in router.last_sql


def test_get_replays_verified_legacy_mapping_without_overwrite():
    workspace = ManagerRagService.derive_workspace(_TID, "ks-default")
    registry = _registry_for(_TID, instance_id="legacy")
    router = FakeRouter().queue_many(
        FakeCursor(fetchone=(_TID, "ks-default", workspace, "legacy")),
        FakeCursor(fetchone=(_TID, "ks-default", workspace, "legacy")),
    )
    svc = _make_svc(router, instance_registry=registry)
    first = svc.get(ctx(tid=_TID), "ks-default")
    second = svc.get(ctx(tid=_TID), "ks-default")
    assert first.instance_id == second.instance_id == "legacy"
    assert all("COALESCE(target.instance_id, EXCLUDED.instance_id)" in sql for sql, _ in router.executed)


def test_get_rejects_unknown_registry_without_writing_mapping():
    registry = RagInstanceRegistry((RagInstance("rag-a", "http://rag", "secret", "not-derived"),))
    router = FakeRouter()
    svc = _make_svc(router, instance_registry=registry)
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        svc.get(ctx(tid=_TID), "ks-default")
    assert router.executed == []


@pytest.mark.parametrize(
    "mapped_row",
    [
        ("other-tenant", "ks-default", ManagerRagService.derive_workspace(_TID, "ks-default"), "rag-a"),
        (_TID, "ks-default", "wrong-workspace", "rag-a"),
        (_TID, "ks-default", ManagerRagService.derive_workspace(_TID, "ks-default"), "rag-old"),
    ],
)
def test_get_fails_closed_on_mapping_drift(mapped_row):
    workspace = ManagerRagService.derive_workspace(_TID, "ks-default")
    router = FakeRouter().queue(FakeCursor(fetchone=mapped_row))
    svc = _make_svc(router, instance_registry=_registry_for(_TID))
    with pytest.raises(ValueError, match="knowledge service unavailable"):
        svc.get(ctx(tid=_TID), "ks-default")
    assert router.executed[-1][1] == (_TID, "ks-default", workspace, "rag-a")


def test_list_workspaces_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[
        ("ks-1", "ws-1"),
        ("ks-2", "ws-2"),
    ]))
    svc = _make_svc(router)
    rows = svc.list_workspaces(ctx())
    assert len(rows) == 2
    assert rows[0] == {"knowledge_space_id": "ks-1", "workspace": "ws-1"}
    assert rows[1] == {"knowledge_space_id": "ks-2", "workspace": "ws-2"}


def test_init_creates_pg_router():
    """PgManagerRagService.__init__ stores a PgTenantRouter (covers line 30)."""
    from shared.db import PgTenantRouter
    svc = PgManagerRagService('postgresql://localhost/test')
    assert isinstance(svc._router, PgTenantRouter)


def test_list_workspaces_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    svc = _make_svc(router)
    assert svc.list_workspaces(ctx()) == []
