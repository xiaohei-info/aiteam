"""rag.py (PgManagerRagService) branch coverage (issue #234, target >=90%)."""

from __future__ import annotations

from manager_service.rag import PgManagerRagService, RagHandle

from ._fake_router import FakeCursor, FakeRouter, ctx

_TID = "12345678-1234-1234-1234-123456789abc"


def _make_svc(router: FakeRouter) -> PgManagerRagService:
    svc = PgManagerRagService.__new__(PgManagerRagService)
    svc._router = router
    return svc


def test_get_returns_rag_handle():
    router = FakeRouter()
    router.queue(FakeCursor())  # INSERT ON CONFLICT DO NOTHING
    svc = _make_svc(router)
    handle = svc.get(ctx(tid=_TID), knowledge_space_id="ks-default")
    assert isinstance(handle, RagHandle)
    assert handle.tenant_id == _TID
    assert handle.knowledge_space_id == "ks-default"
    assert handle.workspace == "t12345678123412341234123456789abc__ks-default"


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
