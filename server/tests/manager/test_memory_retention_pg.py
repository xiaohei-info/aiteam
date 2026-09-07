"""S04 acceptance/cleanup integration: real Manager routes and app_rw/RLS, fake native HTTP only."""
from datetime import datetime, timedelta, timezone
import json
import uuid
from unittest.mock import Mock

import httpx
import pytest

from manager_service.hindsight_client import HindsightUnavailable
from manager_service.memory_retention_repository import MemoryRetentionRepository
from manager_service.memory_retention_service import MemoryRetentionService, acceptance_metadata
from manager_service.routes_memory_items import build_memory_items_router
from manager_service.memory_service import MemoryService
from shared.contracts.tenancy import TenantContext
from tests.manager.test_memory_policy_pg import memory_pg
from tests.manager.test_memory_retention_service import deployed_schema

pytestmark = pytest.mark.integration


@pytest.fixture
def retention_pg(memory_pg):
    f = memory_pg
    repo = MemoryRetentionRepository(f.router, f.admin_url)
    # Bound each test's maintenance inventory to its own newly generated tenant.
    repo.tenant_ids_due = lambda _tenant=None: [f.ctx.tenant_id]
    backend = Mock()
    backend.retention_request.side_effect = lambda bank, suffix, **kw: deployed_schema() if bank is None else {}
    f.repo, f.backend = repo, backend
    f.retention = MemoryRetentionService(repo, backend, bound_tenant_id=f.ctx.tenant_id)
    f.policy = f.config.get(f.ctx, employee_id=f.eid).memory_policy
    f.bank = MemoryService._bank(f.ctx, f.eid)
    def accept(doc="generation", days=None):
        if days is not None:
            f.client.patch(f.base + "/memory-setting", headers=f.headers(), json={"retention_days": days}).raise_for_status()
            f.policy = f.config.get(f.ctx, employee_id=f.eid).memory_policy
        return repo.accept(f.ctx, employee_id=f.eid, bank_id=f.bank, document_id=doc,
                           operation_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f.ctx.tenant_id + doc)), policy=f.policy)
    f.accept = accept
    def due(**fields):
        with f.router.session(f.ctx) as s:
            s.execute("UPDATE memory_acceptance SET next_attempt=now()-interval '1 second' WHERE bank_id=%s", (f.bank,))
        return repo.claim(f.ctx, owner="fixture-worker")
    f.claim = due
    return f


def native_fact(job):
    # Pinned ListMemoryUnitsResponse exposes ``type``; keep fact_type absent
    # here so the real Manager mapping regression cannot rely on the legacy name.
    return {"id": str(uuid.uuid4()), "text": "BODY_MUST_NOT_ENTER_LEDGER", "type": "world",
            "document_id": job["document_id"], "metadata": acceptance_metadata(job)}


@pytest.mark.parametrize("terminal", ["failed", "cancelled"])
def test_failed_or_cancelled_unlimited_partial_results_cleanup_without_waiting_forever(retention_pg, terminal):
    f = retention_pg
    accepted = f.accept()
    item = native_fact(accepted)
    items = [item]
    def native(bank, suffix, *, method="GET", params=None, payload=None):
        if bank is None: return deployed_schema()
        if suffix.startswith("operations/"):
            assert params == {"include_payload": "false"}
            return {"operation_id": accepted["operation_id"], "status": terminal}
        if suffix == "memories/list":
            assert params == {"document_id": accepted["document_id"], "state": "valid", "limit": 100, "offset": 0}
            return {"items": list(items), "total": len(items)}
        assert method == "PATCH" and payload["state"] == "invalidated"
        items.clear()
        return {"id": item["id"], "state": "invalidated"}
    f.backend.retention_request.side_effect = native
    f.retention._maintain_job(f.ctx, f.claim(), "fixture-worker")
    assert not items
    persisted = f.repo.get(f.ctx, bank_id=f.bank, document_id=accepted["document_id"])
    assert persisted["operation_state"] == terminal and persisted["terminal_at"] is not None
    # Terminal evidence survives restart even if the native operation is later purged.
    restarted = MemoryRetentionService(MemoryRetentionRepository(f.router), f.backend)
    restarted._maintain_job(f.ctx, f.claim(), "fixture-worker")
    assert f.repo.get(f.ctx, bank_id=f.bank, document_id=accepted["document_id"])["cleanup_state"] == "cleaned"


def test_terminal_proof_and_cleanup_are_claim_cas_not_cross_document_writes(retention_pg):
    f = retention_pg
    first = f.accept("first")
    old = f.claim()
    # A second item can share one operation, but has a separate durable document job.
    second = f.repo.accept(f.ctx, employee_id=f.eid, bank_id=f.bank, document_id="second",
                           operation_id=first["operation_id"], policy=f.policy)
    with f.router.session(f.ctx) as s:
        s.execute("UPDATE memory_acceptance SET claim_until=now()-interval '1 second' WHERE document_id='first'")
    new = f.repo.claim(f.ctx, owner="new-worker")
    assert new["document_id"] == "first"
    assert f.repo.settled(f.ctx, old, owner="fixture-worker", state="failed") is False
    assert f.repo.settled(f.ctx, new, owner="new-worker", state="completed") is True
    assert f.repo.get(f.ctx, bank_id=f.bank, document_id="second")["operation_state"] == "pending"
    assert f.repo.settled(f.ctx, new, owner="new-worker", state="failed") is False
    assert f.repo.get(f.ctx, bank_id=f.bank, document_id="first")["operation_state"] == "completed"


@pytest.mark.parametrize("state", ["pending", "processing", "unknown", "missing", "wrong-id"])
def test_expired_pending_unknown_or_unconfirmed_native_operation_never_auto_cleans(retention_pg, state):
    f = retention_pg
    accepted = f.accept(days=1)
    with f.router.session(f.ctx) as s:
        s.execute("UPDATE memory_acceptance SET expires_at=now()-interval '1 second' WHERE bank_id=%s", (f.bank,))
    def native(bank, suffix, **kw):
        if bank is None: return deployed_schema()
        assert suffix.startswith("operations/")
        if state == "missing": raise HindsightUnavailable("fixture 404 BODY_SECRET")
        return {"operation_id": "other" if state == "wrong-id" else accepted["operation_id"], "status": state}
    f.backend.retention_request.side_effect = native
    f.retention._maintain_job(f.ctx, f.claim(), "fixture-worker")
    current = f.repo.get(f.ctx, bank_id=f.bank, document_id=accepted["document_id"])
    assert current["cleanup_state"] == "waiting" and current["terminal_at"] is None
    assert current["claim_owner"] is None and current["next_attempt"] > datetime.now(timezone.utc)
    assert "BODY_SECRET" not in json.dumps(current, default=str)


def test_partial_page_failure_retries_from_zero_without_losing_terminal_proof(retention_pg, caplog):
    f = retention_pg
    accepted = f.accept(days=1)
    with f.router.session(f.ctx) as s:
        s.execute("UPDATE memory_acceptance SET expires_at=now()-interval '1 second' WHERE bank_id=%s", (f.bank,))
    facts = [native_fact(accepted) for _ in range(102)]
    remaining = list(facts)
    patches = []
    fail = [True]
    def native(bank, suffix, *, method="GET", params=None, payload=None):
        if bank is None: return deployed_schema()
        if suffix.startswith("operations/"): return {"operation_id": accepted["operation_id"], "status": "completed"}
        if suffix == "memories/list":
            assert params["offset"] == 0 and params["limit"] == 100
            return {"items": remaining[:100], "total": len(remaining)}
        mid = suffix.split("/")[-1]
        if fail[0] and len(patches) == 1: raise HindsightUnavailable("BODY_SECRET_TOKEN fixture timeout")
        patches.append(mid)
        remaining[:] = [item for item in remaining if item["id"] != mid]
        return {"id": mid, "state": "invalidated"}
    f.backend.retention_request.side_effect = native
    f.retention._maintain_job(f.ctx, f.claim(), "fixture-worker")
    current = f.repo.get(f.ctx, bank_id=f.bank, document_id=accepted["document_id"])
    assert current["operation_state"] == "completed" and current["cleanup_state"] == "invalidating"
    assert current["last_error_code"] == "memory_retention_reconciliation_failed" and len(patches) == 1
    assert "BODY_SECRET_TOKEN" not in caplog.text
    fail[0] = False
    restarted = MemoryRetentionService(f.repo, f.backend)
    for _ in range(3): restarted._maintain_job(f.ctx, f.claim(), "fixture-worker")
    assert f.repo.get(f.ctx, bank_id=f.bank, document_id=accepted["document_id"])["cleanup_state"] == "cleaned"
    assert len(patches) == len(set(patches)) == 102


def test_no_progress_and_unproven_sources_fail_closed_without_cleaned_or_unknown_patch(retention_pg):
    f = retention_pg
    accepted = f.accept(days=1)
    with f.router.session(f.ctx) as s:
        s.execute("UPDATE memory_acceptance SET expires_at=now()-interval '1 second' WHERE bank_id=%s", (f.bank,))
    item = native_fact(accepted)
    def native(bank, suffix, *, method="GET", **kw):
        if bank is None: return deployed_schema()
        if suffix.startswith("operations/"): return {"operation_id": accepted["operation_id"], "status": "completed"}
        if suffix == "memories/list": return {"items": [item], "total": 1}
        return {"id": item["id"], "state": "invalidated"}  # confirms, but next page still contains it
    f.backend.retention_request.side_effect = native
    for _ in range(2): f.retention._maintain_job(f.ctx, f.claim(), "fixture-worker")
    current = f.repo.get(f.ctx, bank_id=f.bank, document_id=accepted["document_id"])
    assert current["cleanup_state"] == "invalidating" and current["last_error_code"]
    assert len([c for c in f.backend.retention_request.call_args_list if c.kwargs.get("method") == "PATCH"]) == 1
    item["id"] = str(uuid.uuid4()); item["metadata"] = {"legacy_timestamp": "2099"}
    f.retention._maintain_job(f.ctx, f.claim(), "fixture-worker")
    assert len([c for c in f.backend.retention_request.call_args_list if c.kwargs.get("method") == "PATCH"]) == 1


def test_deadline_tightens_transactionally_never_relaxes_and_metadata_has_no_body(retention_pg):
    f = retention_pg
    accepted = f.accept(days=7)
    for days in (2, 30, None):
        f.client.patch(f.base + "/memory-setting", headers=f.headers(), json={"retention_days": days}).raise_for_status()
    old = f.repo.get(f.ctx, bank_id=f.bank, document_id=accepted["document_id"])
    assert old["expires_at"] == accepted["accepted_at"] + timedelta(days=2)
    assert f.config.get(f.ctx, employee_id=f.eid).memory_policy["retention_guarded"] is True
    other_ctx = TenantContext(tenant_id=f.other, user_id=f.ctx.user_id)
    assert f.repo.get(other_ctx, bank_id=f.bank, document_id=accepted["document_id"]) is None
    with f.router.session(f.ctx) as s:
        columns = {r[0] for r in s.execute("SELECT column_name FROM information_schema.columns WHERE table_name='memory_acceptance'").fetchall()}
    assert not columns & {"content", "text", "payload", "response", "metadata", "token"}


@pytest.mark.parametrize("operation", ["recall", "list"])
def test_management_unlimited_wait_cannot_return_rich_data_after_finite_policy_commit(retention_pg, operation):
    f = retention_pg
    def upstream(*a, **kw):
        f.client.patch(f.base + "/memory-setting", headers=f.headers(), json={"retention_days": 1}).raise_for_status()
        return {"results": [{"id": "old", "text": "EXPIRED_MARKER", "type": "world"}],
                "items": [{"id": "old", "text": "EXPIRED_MARKER", "metadata": {"secret": "EXPIRED_MARKER"}}], "chunks": {"old": "EXPIRED_MARKER"}}
    backend = Mock(recall=upstream, list=upstream)
    f.app.state._memory_service = MemoryService(snapshot=f.snapshot, backend=backend, retention_service=f.retention)
    f.app.include_router(build_memory_items_router(f.app.state._token_verifier))
    response = f.client.get("/api/manager/memories" + ("/recall" if operation == "recall" else ""),
                            headers=f.headers(), params={"employee_id": f.eid, "query": "fixture"})
    assert response.status_code == 403, response.text
    assert "EXPIRED_MARKER" not in response.text


def test_expired_claim_loses_native_mutation_authority_and_tightening_wakes_old_schedule(retention_pg):
    f = retention_pg
    accepted = f.accept(days=7)
    job = f.claim()
    # A policy change while a worker holds the old schedule cannot be undone by finish.
    f.client.patch(f.base + "/memory-setting", headers=f.headers(), json={"retention_days":1}).raise_for_status()
    f.repo.finish(f.ctx, job, owner="fixture-worker", operation_state="completed", cleanup_state="waiting", next_attempt=job["expires_at"])
    current = f.repo.get(f.ctx, bank_id=f.bank, document_id=job["document_id"])
    assert current["next_attempt"] <= accepted["accepted_at"] + timedelta(days=1)
    with f.router.session(f.ctx) as s:
        s.execute("UPDATE memory_acceptance SET expires_at=now()-interval '1 second' WHERE bank_id=%s", (f.bank,))
    item = native_fact(accepted)
    def native(bank, suffix, **kw):
        if bank is None: return deployed_schema()
        assert suffix == "memories/list"
        with f.router.session(f.ctx) as s:
            s.execute("UPDATE memory_acceptance SET claim_until=now()-interval '1 second' WHERE bank_id=%s", (f.bank,))
        return {"items":[item],"total":1}
    f.backend.retention_request.side_effect = native
    f.retention._maintain_job(f.ctx, f.claim(), "fixture-worker")
    assert not any(c.kwargs.get("method") == "PATCH" for c in f.backend.retention_request.call_args_list)


def test_guard_projection_and_versions_survive_full_migration_replay_after_relaxation(retention_pg):
    import os
    from shared.db import apply_migrations
    f = retention_pg
    f.accept(days=1)
    f.client.patch(f.base + "/memory-setting", headers=f.headers(), json={"retention_days":None}).raise_for_status()
    before = f.config.get(f.ctx, employee_id=f.eid)
    assert before.memory_policy["retention_guarded"] is True
    for _ in range(2): apply_migrations(f.admin_url, os.environ["APP_RW_PASSWORD"])
    after = f.config.get(f.ctx, employee_id=f.eid)
    assert after == before


def test_guarded_analytics_never_calls_rich_native_stats(retention_pg):
    from types import SimpleNamespace
    f = retention_pg
    f.accept(days=1)
    f.backend.retention_request.side_effect = lambda bank, suffix, **kw: deployed_schema() if bank is None else {"items":[],"total":0}
    service = MemoryService(snapshot=f.snapshot, backend=f.backend, retention_service=f.retention,
                            employee_reader=SimpleNamespace(list_all=lambda ctx:[SimpleNamespace(employee_id=f.eid, display_name="fixture")]))
    output = service.analytics(f.ctx)
    assert output["total_memory_count"] == 0 and output["employees"][0]["total_observations"] is None
    f.backend.stats.assert_not_called()


def test_due_inventory_excludes_active_claims_and_uses_only_metadata(retention_pg):
    f = retention_pg
    f.accept()
    inventory = MemoryRetentionRepository(f.router, f.admin_url, bound_tenant_id=f.ctx.tenant_id)
    with f.router.session(f.ctx) as s:
        s.execute("UPDATE memory_acceptance SET next_attempt=now()-interval '1000 years' WHERE bank_id=%s", (f.bank,))
    assert f.ctx.tenant_id in inventory.tenant_ids_due()
    assert inventory.claim(f.ctx, owner="inventory-worker") is not None
    assert f.ctx.tenant_id not in inventory.tenant_ids_due()
    assert MemoryRetentionRepository(f.router).tenant_ids_due() == []
