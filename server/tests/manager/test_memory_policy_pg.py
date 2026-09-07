"""Memory source, lease and restart checks against disposable real PostgreSQL/RLS."""
import json
import uuid
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock

import httpx
import psycopg
import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.active_principal import ActivePrincipalVerifier
from manager_service.auth_service import build_auth_service
from manager_service.employee_bindings_repositories import EmployeeMemorySettingRepository
from manager_service.employee_config_service import build_employee_config_service
from manager_service.hindsight_credentials import HindsightRuntimeService
from manager_service.hindsight_facade import HindsightFacade
from manager_service.hindsight_lease_repository import HindsightLeaseRepository
from manager_service.member_service import GrantService, MemberDeptService
from manager_service.memory_policy_service import MemoryPolicyService
from manager_service.repository import TenantAuthRepository
from manager_service.repository_member import GrantRepository, MemberDeptRepository
from manager_service.routes_employee_bindings import build_employee_bindings_router
from manager_service.routes_employee import build_employee_router
from manager_service.routes_hindsight import build_hindsight_router
from manager_service.schemas import EmployeeConfigIn, MemberGrantCreate
from manager_service.snapshot_service import SnapshotService
from shared.app_factory import create_app
from shared.auth import DevTokenService
from shared.config import Settings
from shared.contracts.auth import TokenClaims
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import NotFound
from tests.manager.test_hindsight_credentials import _settings

pytestmark = pytest.mark.integration
MIGRATION = Path(__file__).parents[2] / "manager_service/migrations/0037_memory_policy_lease_scopes.sql"


@pytest.fixture
def memory_pg(migrated_db, admin_url, two_tenants):
    router = PgTenantRouter(migrated_db)
    auth = build_auth_service(migrated_db, admin_url)
    tenant, other = two_tenants
    owner = auth.provision_owner(tenant, phone=uuid.uuid4().hex, bootstrap_password="Fixture-Pass-1")
    member = auth.create_member(tenant, phone=uuid.uuid4().hex, initial_password="Fixture-Pass-1")
    ctx = TenantContext(tenant_id=tenant, user_id=owner, roles=["owner"])
    config = build_employee_config_service(router)
    created = config.create(ctx, EmployeeConfigIn(display_name="memory fixture", memory_policy={"enabled": True, "allowed_operations": ["recall", "retain"]}), employee_slug=uuid.uuid4().hex)
    employee = config.transition(ctx, employee_id=created.employee_id, transition="activate")
    members = MemberDeptRepository(router)
    grants = GrantService(repo=GrantRepository(router), members=members)
    grant = grants.create_grant(ctx, MemberGrantCreate(resource_type="expert", resource_id=employee.employee_id, member_ids=[member]))
    snapshot = SnapshotService(config_service=config, grant_service=grants, member_service=MemberDeptService(repo=members))
    signer = DevTokenService("fixture-only")
    verifier = ActivePrincipalVerifier(signer, TenantAuthRepository(router))
    app = create_app(Settings(tier="manager", service_name="memory-fixture", db_url=migrated_db, admin_db_url=admin_url), APIRouter())
    app.state._token_verifier = verifier
    app.state._operator_catalog = None
    app.include_router(build_employee_bindings_router(verifier))
    app.include_router(build_employee_router(verifier))
    app.include_router(build_hindsight_router(verifier))
    leases = HindsightLeaseRepository(migrated_db, admin_url)
    app.state._hindsight_runtime_service = HindsightRuntimeService(snapshot_service=snapshot, settings=_settings(), leases=leases, bank_client=Mock())
    seen = []
    def upstream(request):
        seen.append(request)
        return httpx.Response(200, json={"results": []})
    app.state._hindsight_facade = HindsightFacade(settings=_settings(), leases=leases, snapshot_service=snapshot,
        principal_repository=TenantAuthRepository(router), client=httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
    def headers(user=owner, roles=None):
        claims = TokenClaims(tenant_id=tenant, user_id=user, roles=roles or ["owner"], exp=2_000_000_000)
        return {"Authorization": "Bearer " + signer.sign(claims)}
    return NS(router=router, admin_url=admin_url, dsn=migrated_db, ctx=ctx, other=other, member=member,
              config=config, eid=employee.employee_id, snapshot=snapshot, grant=grant, grants=grants,
              client=TestClient(app), app=app, headers=headers, seen=seen, leases=leases,
              base=f"/api/manager/employees/{employee.employee_id}")


def test_setting_is_effective_source_presence_delete_restart_and_roles(memory_pg):
    f = memory_pg
    setting = f.base + "/memory-setting"
    first = f.client.get(setting, headers=f.headers()).json()["data"]
    version = f.config.get(f.ctx, employee_id=f.eid).version
    assert first["policy"]["allowed_operations"] == ["recall", "retain"]
    assert first["explicit_auto_retain"] is False
    changed = f.client.patch(setting, headers=f.headers(), json={"retention_days": 7, "seed_memories": [{"content": "seed-not-imported"}]})
    assert changed.status_code == 200, changed.text
    assert f.config.get(f.ctx, employee_id=f.eid).version == version + 1
    denied = f.client.patch(setting, headers=f.headers(), json={"policy": {"allowed_operations": []}}).json()["data"]
    assert denied["retention_days"] == 7 and denied["seed_memories"] == [{"content": "seed-not-imported"}]
    assert f.snapshot.generate(f.ctx, member_id=f.ctx.user_id, employee_id=f.eid).memory_policy["allowed_operations"] == []
    assert f.client.patch(setting, headers=f.headers(), json={}).json()["data"] == denied
    assert f.client.delete(setting, headers=f.headers()).status_code == 204
    after = f.config.get(f.ctx, employee_id=f.eid)
    assert f.client.delete(setting, headers=f.headers()).status_code == 204
    assert f.config.get(f.ctx, employee_id=f.eid).version == after.version
    restarted = build_employee_config_service(PgTenantRouter(f.dsn)).get(f.ctx, employee_id=f.eid)
    assert restarted.memory_policy["enabled"] is False and restarted.memory_policy["source"] == "deleted_deny"
    assert f.client.get(setting, headers=f.headers(f.member, ["member"])).status_code == 403
    assert EmployeeMemorySettingRepository(f.router).get(TenantContext(tenant_id=f.other, user_id=f.ctx.user_id), employee_id=f.eid) is None
    assert f.seen == []


def test_legacy_config_writer_preserves_missing_memory_and_uses_same_transaction(memory_pg):
    f = memory_pg
    repo = EmployeeMemorySettingRepository(f.router)
    repo.upsert(f.ctx, employee_id=f.eid, policy={"enabled": False}, retention_days=9)
    f.config.update(f.ctx, EmployeeConfigIn(display_name="renamed"), employee_id=f.eid)
    out = f.config.get(f.ctx, employee_id=f.eid)
    assert out.memory_policy["enabled"] is False and out.memory_policy["retention_days"] == 9
    f.config.update(f.ctx, EmployeeConfigIn(display_name="renamed", memory_policy={"enabled": True, "allowed_operations": ["retain"], "explicit_auto_retain": True}), employee_id=f.eid)
    assert MemoryPolicyService(repo).effective(f.ctx, employee_id=f.eid) == f.config.get(f.ctx, employee_id=f.eid).memory_policy
    row = repo.get(f.ctx, employee_id=f.eid)
    assert row.explicit_auto_retain and row.retention_days == 9
    # Rollback after a setting write cannot publish a policy without its employee version.
    from manager_service.memory_policy_service import write_policy_in_session
    before = f.config.get(f.ctx, employee_id=f.eid)
    with pytest.raises(RuntimeError):
        with f.router.session(f.ctx) as s:
            write_policy_in_session(s, f.ctx, employee_id=f.eid, fields={"policy": {"enabled": False}}, source="test")
            raise RuntimeError("fixture rollback")
    assert f.config.get(f.ctx, employee_id=f.eid) == before


def test_durable_lease_restart_and_immediate_policy_grant_revoke(memory_pg):
    f = memory_pg
    response = f.client.post("/api/manager/hindsight/runtime-config", headers=f.headers(f.member, ["member"]), json={"employee_id": f.eid, "client_protocol": "aiteam-memory-v1"})
    assert response.status_code == 200, response.text
    runtime = response.json()["data"]
    restarted = HindsightLeaseRepository(f.dsn, f.admin_url)
    lease = restarted.resolve(runtime["token"], bank_id=runtime["bank_id"])
    assert lease.allowed_operations == ("recall", "retain") and lease.policy_revision == 1 and lease.token == ""
    f.app.state._hindsight_facade.leases = restarted
    path = f"/api/manager/hindsight/v1/default/banks/{lease.bank_id}/memories/recall"
    headers = {"Authorization": "Bearer " + runtime["token"]}
    assert f.client.post(path, headers=headers, json={"query": "fixture"}).status_code == 200
    EmployeeMemorySettingRepository(f.router).upsert(f.ctx, employee_id=f.eid, policy={"allowed_operations": ["retain"]})
    assert f.client.post(path, headers=headers, json={"query": "fixture"}).status_code == 403
    EmployeeMemorySettingRepository(f.router).upsert(f.ctx, employee_id=f.eid, policy={"allowed_operations": ["recall", "retain"]})
    with f.router.session(f.ctx) as s:
        s.execute("UPDATE member_grant SET member_ids='{}'::uuid[] WHERE resource_id=%s", (f.eid,))
    assert f.client.post(path, headers=headers, json={"query": "fixture"}).status_code == 403
    assert len(f.seen) == 1


def test_restrictive_legacy_migration_provenance_and_old_lease_invalidation(memory_pg):
    f = memory_pg
    runtime = f.client.post("/api/manager/hindsight/runtime-config", headers=f.headers(), json={"employee_id": f.eid}).json()["data"]
    # Synthetic pre-migration evidence only, never existing enterprise data.
    with psycopg.connect(f.admin_url, autocommit=True) as conn:
        conn.execute("UPDATE employee SET memory_policy=%s WHERE id=%s", (json.dumps({"enabled": True, "allowed_operations": ["recall", "retain"], "retention_days": 30}), f.eid))
        conn.execute("UPDATE employee_memory_setting SET policy=%s,retention_days=7,revision=0,source='legacy_pending' WHERE employee_id=%s", (json.dumps({"enabled": False, "allowed_operations": []}), f.eid))
        conn.execute("UPDATE hindsight_lease SET allowed_operations=NULL,policy_revision=NULL WHERE lease_id=%s", (runtime["lease_id"],))
        conn.execute(MIGRATION.read_text())
        conn.execute(MIGRATION.read_text())
    setting = EmployeeMemorySettingRepository(f.router).get(f.ctx, employee_id=f.eid)
    assert setting.policy["enabled"] is False and setting.policy["allowed_operations"] == [] and setting.retention_days == 7
    assert setting.provenance["employee_policy"]["retention_days"] == 30
    assert setting.provenance["setting_policy"]["allowed_operations"] == []
    assert setting.revision == 1 and f.leases.get(runtime["lease_id"]).revoked_at is not None


def test_guarded_bank_real_routes_ttl_retry_future_time_and_restart_cleanup(memory_pg):
    from datetime import datetime, timedelta, timezone
    from manager_service.memory_retention_service import MemoryRetentionService
    from manager_service.memory_retention_repository import MemoryRetentionRepository
    from tests.manager.test_memory_retention_service import deployed_schema
    f = memory_pg
    native_facts = {}
    operations = {}
    mutations = []
    class NativeFixture:
        def ensure_bank(self, *args, **kwargs): pass
        def retention_request(self, bank, suffix, *, method="GET", payload=None, params=None):
            if bank is None: return deployed_schema()
            if suffix == "memories" and method == "POST":
                operation = payload["operation_id"]
                if operation not in operations:
                    operations[operation] = "completed"
                    for item in payload["items"]:
                        mid = str(uuid.uuid4())
                        native_facts[mid] = {"id": mid, "text": item["content"], "type": "world", "fact_type": "world", "document_id": item["document_id"], "metadata": item["metadata"], "state": "valid", "bank": bank}
                return {"success":True,"async":True,"bank_id":bank,"operation_id":operation}
            if suffix.startswith("operations/"):
                assert params == {"include_payload":"false"}
                op = suffix.split("/")[-1]
                return {"operation_id":op,"status":operations[op]}
            if suffix == "memories/list":
                rows = [v for v in native_facts.values() if v["bank"]==bank and v["state"]=="valid" and v["document_id"]==params["document_id"]]
                assert params["offset"]==0
                return {"items": rows[:100], "total":len(rows)}
            if method == "PATCH":
                mid = suffix.split("/")[-1]
                mutations.append(mid)
                native_facts[mid]["state"]="invalidated"
                return {"id":mid,"state":"invalidated"}
            raise AssertionError((method,suffix))
    backend=NativeFixture()
    repo=MemoryRetentionRepository(f.router,f.admin_url)
    repo.tenant_ids_due=lambda _tenant=None:[f.ctx.tenant_id]
    clock=[datetime.now(timezone.utc)]
    retention=MemoryRetentionService(repo,backend,now=lambda:clock[0])
    f.app.state._hindsight_runtime_service._retention=retention
    facade=f.app.state._hindsight_facade
    facade._retention=retention
    def native(request):
        payload=json.loads(request.content)
        bank=request.url.path.split("/")[4]
        if request.url.path.endswith("/recall"):
            assert payload["types"]==["world","experience"] and payload["prefer_observations"] is False
            assert payload["include"]=={"entities":None,"chunks":None,"source_facts":None}
            return httpx.Response(200,json={"results":[v for v in native_facts.values() if v["bank"]==bank and v["state"]=="valid"], "chunks":{"old":"EXPIRED_MARKER"}, "entities":{"old":"EXPIRED_MARKER"}})
        return httpx.Response(200,json=backend.retention_request(bank,"memories",method="POST",payload=payload))
    facade._client=httpx.AsyncClient(transport=httpx.MockTransport(native))
    # Existing unlimited lease must obey a later finite bank policy, including after it is widened again.
    runtime=f.client.post("/api/manager/hindsight/runtime-config",headers=f.headers(f.member,["member"]),json={"employee_id":f.eid}).json()["data"]
    headers={"Authorization":"Bearer "+runtime["token"]}
    path=f"/api/manager/hindsight/v1/default/banks/{runtime['bank_id']}/memories"
    setting=f.base+"/memory-setting"
    assert f.client.patch(setting,headers=f.headers(),json={"retention_days":1}).status_code==200
    def current_write_headers():
        lease = f.client.post("/api/manager/hindsight/runtime-config", headers=f.headers(),
                              json={"employee_id":f.eid,"client_protocol":"aiteam-memory-v1"}).json()["data"]
        return {"Authorization":"Bearer "+lease["token"]}
    write_headers=current_write_headers()
    body={"items":[{"content":"EXPIRED_MARKER","timestamp":"2099-01-01T00:00:00Z","document_id":"shared-victim"}],"async":True,"operation_id":"caller-op"}
    assert f.client.post(path,headers=headers,json=body).status_code==403  # old client remains readonly
    result=f.client.post(path,headers=write_headers,json=body)
    assert result.status_code==200,result.text
    op=result.json()["operation_id"]
    retained=next(iter(native_facts.values()))
    accepted=repo.get(f.ctx,bank_id=runtime["bank_id"],document_id=retained["document_id"])
    assert accepted["accepted_at"].year != 2099
    assert f.client.post(path,headers=write_headers,json=body).status_code==200
    assert repo.get(f.ctx,bank_id=runtime["bank_id"],document_id=retained["document_id"])["accepted_at"]==accepted["accepted_at"]
    retention.maintain_once()
    assert f.client.post(path+"/recall",headers=headers,json={"query":"fixture"}).json()["results"][0]["text"]=="EXPIRED_MARKER"
    old_expiry=accepted["expires_at"]
    for days in (30,None):
        assert f.client.patch(setting,headers=f.headers(),json={"retention_days":days}).status_code==200
        assert repo.get(f.ctx,bank_id=runtime["bank_id"],document_id=retained["document_id"])["expires_at"]==old_expiry
        assert f.client.get(setting,headers=f.headers()).json()["data"]["retention_guarded"] is True
    clock[0]=old_expiry+timedelta(seconds=1)
    assert f.client.post(path,headers=write_headers,json=body).status_code==403  # stale revision cannot write
    write_headers=current_write_headers()
    assert f.client.post(path,headers=write_headers,json=body).status_code==403  # fresh lease cannot renew expiry
    fresh=f.client.post(path,headers=write_headers,json={"items":[{"content":"FRESH_MARKER","document_id":"shared-victim"}]})
    assert fresh.status_code==200,fresh.text
    retention.maintain_once()
    response=f.client.post(path+"/recall",headers=headers,json={"query":"fixture"})
    assert response.status_code==200 and "EXPIRED_MARKER" not in response.text and "FRESH_MARKER" in response.text
    # A new process retains terminal evidence; native operation records may already be gone.
    del operations[op]
    restarted_repo=MemoryRetentionRepository(PgTenantRouter(f.dsn),f.admin_url)
    restarted_repo.tenant_ids_due=lambda _tenant=None:[f.ctx.tenant_id]
    restarted=MemoryRetentionService(restarted_repo,backend,now=lambda:clock[0])
    for _ in range(2):
        with f.router.session(f.ctx) as s:
            s.execute("UPDATE memory_acceptance SET next_attempt=now()-interval '1 second' WHERE operation_id=%s",(op,))
        restarted.maintain_once()
    after=repo.get(f.ctx,bank_id=runtime["bank_id"],document_id=retained["document_id"])
    assert after["cleanup_state"]=="cleaned" and mutations==[retained["id"]]
    assert any(v["text"]=="FRESH_MARKER" and v["state"]=="valid" for v in native_facts.values())
    assert f.client.delete(setting,headers=f.headers()).status_code==204
    assert f.client.put(setting,headers=f.headers(),json={"policy":{"enabled":True,"allowed_operations":["recall"]},"retention_days":None}).json()["data"]["retention_guarded"] is True
    assert build_employee_config_service(PgTenantRouter(f.dsn)).get(f.ctx,employee_id=f.eid).memory_policy["retention_guarded"] is True


def test_acceptance_claim_cas_cross_tenant_and_concurrent_generation(memory_pg):
    from concurrent.futures import ThreadPoolExecutor
    from datetime import datetime, timedelta, timezone
    from manager_service.memory_retention_repository import MemoryRetentionRepository
    f=memory_pg
    repo=MemoryRetentionRepository(f.router,f.admin_url)
    policy=f.config.get(f.ctx,employee_id=f.eid).memory_policy
    def accept(doc):
        return repo.accept(f.ctx,employee_id=f.eid,bank_id="fixture-bank",document_id=doc,operation_id=str(uuid.uuid5(uuid.NAMESPACE_URL,doc)),policy=policy)
    with ThreadPoolExecutor(max_workers=2) as pool:
        rows=list(pool.map(lambda _:accept("same-generation"),range(2)))
    assert rows[0]["accepted_at"]==rows[1]["accepted_at"]
    first=repo.claim(f.ctx,owner="old")
    assert first and repo.claim(f.ctx,owner="other") is None
    assert repo.get(TenantContext(tenant_id=f.other,user_id=f.ctx.user_id),bank_id="fixture-bank",document_id="same-generation") is None
    with f.router.session(f.ctx) as s:
        s.execute("UPDATE memory_acceptance SET claim_until=now()-interval '1 second' WHERE bank_id='fixture-bank'")
    newer=repo.claim(f.ctx,owner="new")
    assert newer and not repo.owned(f.ctx,first,"old") and repo.owned(f.ctx,newer,"new")
    repo.finish(f.ctx,first,owner="old",operation_state="completed",cleanup_state="cleaned",next_attempt=datetime.now(timezone.utc))
    assert repo.get(f.ctx,bank_id="fixture-bank",document_id="same-generation")["cleanup_state"]=="waiting"
    second=accept("new-generation")
    assert second["operation_id"]!=first["operation_id"] and repo.claim(f.ctx,owner="second")["document_id"]=="new-generation"
