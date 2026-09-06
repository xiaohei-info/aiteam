import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, Mock, patch

import pytest

from manager_service.memory_retention_service import MemoryRetentionService, MemoryRetentionOptionUnsupported, acceptance_metadata, schema_fingerprint, SCHEMA_FINGERPRINT
from manager_service.hindsight_client import HindsightUnavailable
from manager_service.memory_policy_service import MemoryRetentionUnverified
from manager_service.memory_retention_preflight import historical_preflight
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden

NOW = datetime(2026, 9, 6, tzinfo=timezone.utc)
CTX = TenantContext(tenant_id="tenant", user_id="member", roles=["owner"])


def deployed_schema():
    contract = json.loads((Path(__file__).parent / "fixtures/hindsight_retention_contract.json").read_text())
    return {"info": {"version": contract["version"]}, "paths": contract["paths"], "components": {"schemas": contract["schemas"]}}


def row(*, expired=False, unlimited=False):
    return {"tenant_id":"tenant","employee_id":"employee","member_id":"member","bank_id":"bank", "document_id":"doc", "operation_id":"operation",
            "policy_revision":3,"accepted_at":NOW-timedelta(days=2 if expired else 0),
            "expires_at":None if unlimited else NOW+timedelta(days=-1 if expired else 1), "operation_state":"completed", "cleanup_state":"waiting"}


def fact(accepted, **extra):
    return {"id":"fact", "text":"fresh text", "type":"world", "document_id":accepted["document_id"], "metadata":acceptance_metadata(accepted), **extra}


@pytest.fixture
def service():
    repo = Mock()
    accepted = row()
    repo.get.return_value = accepted
    repo.accept.return_value = accepted
    backend = Mock(retention_request=Mock(return_value=deployed_schema()))
    clock = [NOW]
    svc = MemoryRetentionService(repo, backend, now=lambda: clock[0], bound_tenant_id="tenant-a")
    return NS(svc=svc,repo=repo,backend=backend,row=accepted,clock=clock,policy={"retention_days":1,"revision":3})


def test_exact_deployed_contract_and_mismatch_fail_closed(service):
    f=service
    assert schema_fingerprint(deployed_schema()) == SCHEMA_FINGERPRINT
    f.svc.require_ready(f.policy)
    f.backend.retention_request.assert_called_once_with(None, "")
    f.svc.require_ready(f.policy)
    assert f.backend.retention_request.call_count == 1
    bad=deployed_schema();bad["info"]["version"]="0.8.0"
    with pytest.raises(MemoryRetentionUnverified):
        MemoryRetentionService(f.repo, Mock(retention_request=Mock(return_value=bad))).require_ready(f.policy)


def test_trusted_acceptance_overrides_model_time_and_retry_does_not_renew(service):
    f=service
    body={"operation_id":"operation","items":[{"content":"fixture","timestamp":"2099-01-01T00:00:00Z","document_id":"doc","metadata":{"aiteam_accepted_at":"2099"}}]}
    prepared=f.svc.prepare(CTX,employee_id="employee",bank_id="bank",policy=f.policy,body=body)
    assert prepared["items"][0]["metadata"]==acceptance_metadata(f.row)
    assert prepared == f.svc.prepare(CTX,employee_id="employee",bank_id="bank",policy=f.policy,body=body)
    f.clock[0] += timedelta(days=2)
    with pytest.raises(Forbidden): f.svc.prepare(CTX,employee_id="employee",bank_id="bank",policy=f.policy,body=body)


@pytest.mark.parametrize("options", [{"types":["observation"]},{"prefer_observations":True},{"include":{"chunks":{}}},{"include":{"entities":{"max_tokens":10}}},{"include":{"source_facts":{}}}])
def test_finite_rejects_explicit_derived_options_instead_of_fake_empty(service, options):
    with pytest.raises(MemoryRetentionOptionUnsupported): service.svc.recall_body(service.policy,{"query":"fixture",**options})


def test_finite_forces_native_fact_retrieval_and_strips_all_derived_free_fields(service):
    f=service
    payload=f.svc.recall_body(f.policy,{"query":"fixture"})
    assert payload["types"]==["world","experience"] and payload["prefer_observations"] is False
    assert payload["include"]=={"entities":None,"chunks":None,"source_facts":None}
    raw={"results":[fact(f.row,context="EXPIRED",entities=["EXPIRED"],tags=["EXPIRED"],chunk_id="old")], "chunks":{"old":{"text":"EXPIRED"}},"entities":{"EXPIRED":{}},"source_facts":{"old":{"text":"EXPIRED"}},"trace":{"text":"EXPIRED"}}
    result=f.svc.filter_recall(CTX,employee_id="employee",bank_id="bank",policy=f.policy,response=raw)
    assert result=={"results":[{"id":"fact","text":"fresh text","type":"world"}]}
    assert "EXPIRED" not in json.dumps(result)


@pytest.mark.parametrize("change", ["time", "missing", "wrong-bank", "wrong-employee", "wrong-operation", "wrong-revision", "pending", "cleaned", "observation", "untrusted-metadata"])
def test_expired_or_unproven_fact_never_appears(service, change):
    f=service
    raw=fact(f.row)
    if change=="time": f.clock[0]+=timedelta(days=1)
    if change=="missing": f.repo.get.return_value=None
    if change=="wrong-bank": f.row["bank_id"]="other"
    if change=="wrong-employee": f.row["employee_id"]="other"
    if change=="wrong-operation": raw["metadata"]["aiteam_operation"]="other"
    if change=="wrong-revision": raw["metadata"]["aiteam_policy_revision"]="99"
    if change=="pending": f.row["operation_state"]="pending"
    if change=="cleaned": f.row["cleanup_state"]="cleaned"
    if change=="observation": raw["type"]="observation"
    if change=="untrusted-metadata": raw["metadata"]={}
    assert f.svc.filter_recall(CTX,employee_id="employee",bank_id="bank",policy=f.policy,response={"results":[raw]})=={"results":[]}


def test_guarded_recall_rejects_empty_or_oversized_native_text(service):
    f = service
    for text in (" ", "x" * 131073):
        with pytest.raises(HindsightUnavailable):
            f.svc.filter_recall(
                CTX,
                employee_id="employee",
                bank_id="bank",
                policy=f.policy,
                response={"results": [fact(f.row, text=text)]},
            )


def test_guarded_bank_keeps_fact_only_after_unlimited_but_fresh_unlimited_fact_is_readable(service):
    f=service
    f.row["expires_at"]=None
    result=f.svc.filter_recall(CTX,employee_id="employee",bank_id="bank",policy={"retention_days":None,"retention_guarded":True},response={"results":[fact(f.row)],"chunks":{"old":"EXPIRED"}})
    assert result["results"] and "EXPIRED" not in json.dumps(result)
    rich={"results":[],"chunks":{"legacy":"unchanged"}}
    assert f.svc.filter_recall(CTX,employee_id="employee",bank_id="bank",policy={"retention_days":None},response=rich) is rich


def test_history_preflight_is_content_free_and_has_no_write_authority(service):
    f=service
    f.backend.retention_request.return_value={"items":[fact(f.row, text="NEVER_EXPORT"),{"id":"unknown","text":"NEVER_EXPORT","metadata":{"timestamp":"2099"}}]}
    out=historical_preflight(CTX,employee_id="employee",bank_id="bank",backend=f.backend,repository=f.repo)
    assert "NEVER_EXPORT" not in json.dumps(out) and out["unknown_count"]==1 and out["cleanup_authorized"] is False
    assert all(call.kwargs.get("method", "GET")=="GET" for call in f.backend.retention_request.mock_calls)


def test_native_retain_success_envelope_is_required(service):
    with pytest.raises(Exception, match="not confirmed"):
        service.svc.validate_retain_response({"operation_id":"op"},{"success":False},"bank")


def test_return_clock_rechecks_earlier_facts_after_slow_ledger_reads(service):
    f = service
    first = fact(f.row)
    second = fact(f.row, id="second")
    count = [0]
    def lookup(*args, **kwargs):
        count[0] += 1
        if count[0] == 2: f.clock[0] += timedelta(days=1)
        return f.row
    f.repo.get.side_effect = lookup
    assert f.svc.filter_recall(CTX, employee_id="employee", bank_id="bank", policy=f.policy, response={"results":[first, second]}) == {"results":[]}


@pytest.mark.parametrize("reason", ["expired", "unknown", "pending", "wrong-id"])
def test_guarded_edit_cannot_reactivate_expired_or_unproven_fact(service, reason):
    f = service
    f.svc.require_ready(f.policy)
    f.backend.retention_request.return_value = fact(f.row)
    if reason == "expired": f.clock[0] += timedelta(days=2)
    if reason == "unknown": f.repo.get.return_value = None
    if reason == "pending": f.row["operation_state"] = "pending"
    memory_id = "../config" if reason == "wrong-id" else "44444444-4444-4444-8444-444444444444"
    with pytest.raises(Forbidden):
        f.svc.check_edit(CTX, employee_id="employee", bank_id="bank", memory_id=memory_id, policy=f.policy)


def test_confirmation_returns_only_safe_ack_fields(service):
    result = service.svc.validate_retain_response({"operation_id":"op"},
        {"success":True,"bank_id":"bank","operation_id":"op","async":True,"payload":"DO_NOT_RETURN","metadata":{"text":"DO_NOT_RETURN"}}, "bank")
    assert result == {"success":True,"bank_id":"bank","operation_id":"op","async":True}


def test_due_inventory_requires_and_filters_bound_tenant():
    from manager_service.memory_retention_repository import MemoryRetentionRepository
    router = Mock()
    repo = MemoryRetentionRepository(router, "postgresql://admin", bound_tenant_id="tenant-a")
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.__exit__.return_value = None
    connection.execute.return_value.fetchall.return_value = [("tenant-a",)]
    with patch("psycopg.connect", return_value=connection):
        assert repo.tenant_ids_due() == ["tenant-a"]
        assert repo.tenant_ids_due("tenant-a") == ["tenant-a"]
        assert repo.tenant_ids_due("tenant-b") == []
    calls = connection.execute.call_args_list
    assert all(call.args[1] == ("tenant-a",) for call in calls[:2])


def test_maintenance_total_claim_budget_is_bounded_across_tenants(service):
    f = service
    f.repo.tenant_ids_due.return_value = ["tenant-a", "tenant-b"]
    f.repo.claim.return_value = {"document_id":"fixture"}
    f.svc._maintain_job = Mock()
    f.svc.maintain_once("tenant-a")
    assert f.repo.claim.call_count == f.svc._maintain_job.call_count == 16
    f.repo.claim.return_value = None
    f.svc.maintain_once("tenant-a")
    assert f.svc._maintain_job.call_count == 16


def test_production_builder_is_singleton_and_fails_without_metadata_db(monkeypatch):
    from manager_service.memory_retention_service import build_memory_retention_service
    from manager_service.hindsight_client import HindsightClient
    request = NS(app=NS(state=NS(settings=NS(db_url=None, admin_db_url=None))))
    with pytest.raises(MemoryRetentionUnverified): build_memory_retention_service(request)
    monkeypatch.setattr(HindsightClient, "__init__", lambda self, **kwargs: None)
    request.app.state.settings = NS(db_url="postgresql://fixture", admin_db_url="postgresql://fixture-admin", manager_tenant_id="tenant-a")
    built = build_memory_retention_service(request)
    assert build_memory_retention_service(request) is built


@pytest.mark.asyncio
async def test_lifespan_runs_threaded_maintenance_and_stops_without_dropping_claims():
    import asyncio
    from fastapi import FastAPI
    from manager_service.memory_retention_service import install_memory_retention_lifespan
    app = FastAPI()
    app.state.settings = NS(manager_tenant_id="tenant-a")
    called = asyncio.Event()
    loop = asyncio.get_running_loop()
    app.state._memory_retention_service = NS(maintain_once=lambda _tenant: loop.call_soon_threadsafe(called.set))
    install_memory_retention_lifespan(app)
    async with app.router.lifespan_context(app):
        await asyncio.wait_for(called.wait(), timeout=2)
    # All poll tasks have been joined by lifespan, not left using an old claim.
    assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]
