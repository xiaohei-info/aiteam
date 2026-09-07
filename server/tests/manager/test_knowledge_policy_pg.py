"""Real app_rw/RLS routes, policy tombstones, snapshot delta and official MCP client."""
import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace as NS

import httpx
import psycopg
import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from manager_service.active_principal import ActivePrincipalVerifier
from manager_service.auth_service import build_auth_service
from manager_service.employee_bindings_repositories import EmployeeKnowledgeBindingRepository
from manager_service.employee_config_service import build_employee_config_service
from manager_service.knowledge_access_policy import KnowledgeAccessPolicy
from manager_service.knowledge_intake_repository import KnowledgeDocumentRepository, KnowledgeDocumentBindingRepository
from manager_service.member_service import MemberDeptService, GrantService
from manager_service.rag_mcp import LightRagClient, LightRagSettings, RagAccessService, RagUnavailable, build_rag_mcp, install_rag_mcp_lifespan
from manager_service.repository import TenantAuthRepository
from manager_service.repository_member import MemberDeptRepository, GrantRepository
from manager_service.routes_employee_bindings import build_employee_bindings_router
from manager_service.routes_grants import router as grants_router
from manager_service.routes_snapshot import build_snapshot_router
from manager_service.schemas import EmployeeConfigIn, MemberGrantCreate
from manager_service.snapshot_service import SnapshotService
from shared.app_factory import create_app
from shared.auth import DevTokenService
from shared.config import Settings
from shared.contracts.auth import TokenClaims
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter, apply_migrations
from shared.errors import Forbidden
from tests.manager.test_rag_mcp import EnterpriseRag

pytestmark = pytest.mark.integration


@pytest.fixture
def policy_pg(migrated_db, admin_url, two_tenants, tmp_path):
    router = PgTenantRouter(migrated_db)
    tenant, other_tenant = two_tenants
    auth = build_auth_service(migrated_db, admin_url)
    owner = auth.provision_owner(tenant, phone=uuid.uuid4().hex, bootstrap_password="Fixture-Pass-1")
    other_owner = auth.provision_owner(other_tenant, phone=uuid.uuid4().hex, bootstrap_password="Fixture-Pass-1")
    member = auth.create_member(tenant, phone=uuid.uuid4().hex, initial_password="Fixture-Pass-1")
    outsider = auth.create_member(tenant, phone=uuid.uuid4().hex, initial_password="Fixture-Pass-1")
    ctx = TenantContext(tenant_id=tenant, user_id=owner, roles=["owner"])
    other = TenantContext(tenant_id=other_tenant, user_id=other_owner, roles=["owner"])
    config = build_employee_config_service(router)
    employee = config.create(ctx, EmployeeConfigIn(display_name="RAG fixture"), employee_slug=uuid.uuid4().hex)
    employee = config.transition(ctx, employee_id=employee.employee_id, transition="activate")
    other_employee = config.create(other, EmployeeConfigIn(display_name="Other"), employee_slug=uuid.uuid4().hex)
    members = MemberDeptRepository(router)
    grants = GrantService(repo=GrantRepository(router), members=members)
    grants.create_grant(ctx, MemberGrantCreate(resource_type="expert", resource_id=employee.employee_id, member_ids=[member]))
    whole = EmployeeKnowledgeBindingRepository(router)
    bindings = KnowledgeDocumentBindingRepository(router)
    documents = KnowledgeDocumentRepository(router)
    docs = []
    for name in ("a", "b"):
        key = f"knowledge/{tenant}/enterprise_shared/{name}.txt"
        path = tmp_path / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"fixture source {name}")
        docs.append(documents.create(ctx, knowledge_space_id="enterprise_shared", display_name=name, source_type="file",
                                     file_name=f"{name}.txt", file_type="txt", file_size=16, storage_key=key, status="ready"))
    policy = KnowledgeAccessPolicy(whole, bindings)
    snapshot = SnapshotService(config_service=config, grant_service=grants,
                               member_service=MemberDeptService(repo=members), knowledge_binding=whole)
    seen = []
    async def upstream(request):
        seen.append(request)
        return httpx.Response(200, json={"data": {"chunks": [
            {"document_id": doc.id, "chunk_id": doc.id, "content": f"fixture source {doc.display_name}"} for doc in docs
        ]}})
    light = LightRagClient(LightRagSettings("http://fixture", "fixture-key"), transport=httpx.MockTransport(upstream))
    access = RagAccessService(snapshot_service=snapshot, member_repository=members, employee_config=config,
                              binding_repository=bindings, rag_service=EnterpriseRag(), light_rag=light,
                              document_repository=documents, storage_root=tmp_path, knowledge_policy=policy)
    signer = DevTokenService("fixture-only")
    verifier = ActivePrincipalVerifier(signer, TenantAuthRepository(router))
    app = create_app(
        Settings(
            tier="manager",
            service_name="rag-fixture",
            db_url=migrated_db,
            admin_db_url=admin_url,
        ),
        APIRouter(),
    )
    app.state._token_verifier = verifier
    app.include_router(build_employee_bindings_router(verifier))
    app.include_router(build_snapshot_router(verifier))
    app.include_router(grants_router)
    mcp, mounted = build_rag_mcp(verifier=verifier, access=access)
    app.mount("/api/manager/rag", mounted)
    install_rag_mcp_lifespan(app, mcp)
    def claims(user=member, tenant_id=tenant, roles=None):
        return TokenClaims(tenant_id=tenant_id, user_id=user, roles=roles or ["member"], exp=2_000_000_000)
    def headers(user=owner, tenant_id=tenant, roles=None):
        return {"Authorization": f"Bearer {signer.sign(claims(user, tenant_id, roles or ['owner']))}"}
    yield NS(router=router, ctx=ctx, other=other, owner=owner, member=member, outsider=outsider,
             eid=employee.employee_id, other_eid=other_employee.employee_id, config=config, whole=whole,
             bindings=bindings, documents=documents, docs=docs, snapshot=snapshot, policy=policy,
             light=light, access=access, app=app, client=TestClient(app), headers=headers, claims=claims,
             seen=seen, admin_url=admin_url, dsn=migrated_db, root=tmp_path)
    asyncio.run(light.aclose())


def search(f):
    return asyncio.run(f.access.search(f.access.authorize(f.claims(), f.eid), "fixture", 10))


def base(f):
    return f"/api/manager/employees/{f.eid}"


def delta(f, version):
    r = f.client.post("/api/manager/grants/authorized-config", headers=f.headers(f.member), json={
        "tenant_id": f.ctx.tenant_id, "member_id": f.member, "known_versions": {f.eid: str(version)},
    })
    assert r.status_code == 200, r.text
    return r.json()["data"]["experts"]


def test_compatibility_binding_uses_policy_tombstone_and_keeps_index_state_separate(policy_pg):
    from manager_service.knowledge_space_repository import ExpertKnowledgeBinding

    f = policy_pg
    compat = ExpertKnowledgeBinding(f.router)
    assert compat.bind(f.ctx, employee_id=f.eid, knowledge_space_id="enterprise_shared")
    first = f.whole.get_by_ref(f.ctx, employee_id=f.eid, knowledge_space_id="enterprise_shared")
    assert first.enabled is True and first.policy_revision == 1 and first.policy_actor == f.owner
    assert compat.unbind(f.ctx, employee_id=f.eid, knowledge_space_id="enterprise_shared")
    denied = f.whole.get_by_ref(f.ctx, employee_id=f.eid, knowledge_space_id="enterprise_shared")
    assert denied.enabled is False and denied.revoked_at is not None and denied.policy_revision == 2
    assert compat.bind(f.ctx, employee_id=f.eid, knowledge_space_id="enterprise_shared")
    restored = f.whole.get_by_ref(f.ctx, employee_id=f.eid, knowledge_space_id="enterprise_shared")
    assert restored.enabled is True and restored.revoked_at is None and restored.policy_revision == 3
    # Index publication cannot clear or advance the administrator policy.
    f.bindings.upsert_ready(f.ctx, knowledge_space_id="enterprise_shared", document_id=f.docs[0].id,
                            employee_id=f.eid, rag_document_id="compat-rag", synced_at=datetime.now(timezone.utc))
    after_index = f.whole.get_by_ref(f.ctx, employee_id=f.eid, knowledge_space_id="enterprise_shared")
    assert (after_index.policy_revision, after_index.policy_actor, after_index.revoked_at) == (3, f.owner, None)


def test_whole_delete_deny_restart_reenable_and_actual_known_versions(policy_pg):
    f = policy_pg
    initial = search(f)
    assert len(initial["items"]) == 2
    version = f.config.get(f.ctx, employee_id=f.eid).version
    assert delta(f, version) == []
    r = f.client.post(base(f)+"/knowledge-bindings", headers=f.headers(), json={"knowledge_space_id": "enterprise_shared", "enabled": False, "config": {"keep": 1}})
    assert r.status_code == 201, r.text
    row = r.json()["data"]
    path = base(f)+"/knowledge-bindings/"+row["binding_id"]
    assert row["policy_actor"] == f.owner and row["policy_revision"] == 1
    update = delta(f, version)[0]
    assert update["version"] == version + 1
    assert update["knowledge_policy"]["allowed_operations"] == []
    assert "knowledge_search" not in update["tools"]
    frozen = f.snapshot.generate(f.ctx, member_id=f.owner, employee_id=f.eid)
    assert frozen.knowledge_policy.state == "deny"
    r = f.client.patch(path, headers=f.headers(), json={"config": {"keep": 2}})
    assert r.status_code == 200 and r.json()["data"]["enabled"] is False
    assert f.client.patch(path, headers=f.headers(), json={}).json()["data"] == r.json()["data"]
    assert f.client.delete(path, headers=f.headers()).status_code == 204
    deleted_version = f.config.get(f.ctx, employee_id=f.eid).version
    assert f.client.delete(path, headers=f.headers()).status_code == 204
    assert f.config.get(f.ctx, employee_id=f.eid).version == deleted_version
    # Reinstantiate every policy repository and service (no cached authorization).
    restarted = RagAccessService(snapshot_service=f.snapshot, member_repository=MemberDeptRepository(PgTenantRouter(f.dsn)),
        employee_config=build_employee_config_service(PgTenantRouter(f.dsn)), binding_repository=KnowledgeDocumentBindingRepository(PgTenantRouter(f.dsn)),
        rag_service=EnterpriseRag(), light_rag=f.light, document_repository=f.documents, storage_root=f.root,
        knowledge_policy=KnowledgeAccessPolicy(EmployeeKnowledgeBindingRepository(PgTenantRouter(f.dsn)), KnowledgeDocumentBindingRepository(PgTenantRouter(f.dsn))))
    with pytest.raises(Forbidden):
        restarted.authorize(f.claims(), f.eid)
    assert f.client.get(path, headers=f.headers()).json()["data"]["revoked_at"]
    # Same legacy POST explicitly restores a tombstone, without a second row.
    r = f.client.post(base(f)+"/knowledge-bindings", headers=f.headers(), json={"knowledge_space_id": "enterprise_shared", "enabled": True})
    assert r.status_code == 201 and r.json()["data"]["binding_id"] == row["binding_id"]
    assert r.json()["data"]["revoked_at"] is None
    assert len(search(f)["items"]) == 2
    assert frozen.knowledge_policy.state == "deny"  # already frozen object unchanged


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_document_tombstone_reindex_backfill_publish_restart_and_old_citation(policy_pg, operation):
    f = policy_pg
    first = search(f)
    citation = next(i["citation_id"] for i in first["items"] if i["document_id"] == f.docs[0].id)
    auth = f.access.authorize(f.claims(), f.eid)
    path = base(f)+"/knowledge-document-bindings/"+f.docs[0].id
    version = f.config.get(f.ctx, employee_id=f.eid).version
    response = f.client.delete(path, headers=f.headers()) if operation == "delete" else f.client.put(path, headers=f.headers(), json={"enabled": False})
    assert response.status_code == (204 if operation == "delete" else 200), response.text
    assert delta(f, version)[0]["version"] == version+1
    before = f.bindings.list_by_employee(f.ctx, employee_id=f.eid)[0]
    assert before.enabled is False and before.policy_source == "admin"
    assert [i["document_id"] for i in search(f)["items"]] == [f.docs[1].id]
    with pytest.raises(RagUnavailable):
        f.access.get(auth, citation)
    f.bindings.mark_stale_by_document(f.ctx, document_id=f.docs[0].id)
    f.bindings.backfill_ready_for_employee(f.ctx, knowledge_space_id="enterprise_shared", employee_id=f.eid)
    now = datetime.now(timezone.utc)
    f.bindings.upsert_ready(f.ctx, knowledge_space_id="enterprise_shared", document_id=f.docs[0].id, employee_id=f.eid, rag_document_id="fixture-rag", synced_at=now)
    f.bindings.upsert_ready_many(f.ctx, knowledge_space_id="enterprise_shared", document_id=f.docs[0].id, employee_ids=[f.eid], rag_document_id="fixture-rag", synced_at=now)
    from manager_service.knowledge_intake_repository import KnowledgeIngestionJobRepository
    job = KnowledgeIngestionJobRepository(f.router).create(f.ctx, knowledge_space_id="enterprise_shared", document_id=f.docs[0].id, status="indexing")
    f.documents.update_status(f.ctx, f.docs[0].id, status="indexing")
    f.bindings.publish_ready(f.ctx, knowledge_space_id="enterprise_shared", document_id=f.docs[0].id, employee_ids=[f.eid], rag_document_id="fixture-rag", job_id=job.id, chunk_count=1, text_chars=16, completed_at=now, synced_at=now)
    restarted = KnowledgeDocumentBindingRepository(PgTenantRouter(f.dsn))
    after = next(row for row in restarted.list_by_employee(f.ctx, employee_id=f.eid) if row.document_id == f.docs[0].id)
    assert (after.enabled, after.revoked_at, after.policy_revision, after.policy_actor, after.policy_updated_at) == (before.enabled, before.revoked_at, before.policy_revision, before.policy_actor, before.policy_updated_at)
    assert after.status == "ready"
    assert f.config.get(f.ctx, employee_id=f.eid).version == version+1
    assert [i["document_id"] for i in search(f)["items"]] == [f.docs[1].id]
    assert f.client.put(path, headers=f.headers(), json={"enabled": True}).status_code == 200
    assert len(search(f)["items"]) == 2
    with pytest.raises(RagUnavailable):  # reindex changed the citation version
        f.access.get(auth, citation)
    f.documents.update_status(f.ctx, f.docs[0].id, status="deleted")
    assert [i["document_id"] for i in search(f)["items"]] == [f.docs[1].id]


def test_document_routes_current_role_scope_schema_fk_and_idempotence(policy_pg):
    f = policy_pg
    path = base(f)+"/knowledge-document-bindings/"+f.docs[0].id
    assert f.client.put(path, headers=f.headers(f.member), json={"enabled": False}).status_code == 403
    assert f.client.get(base(f)+"/knowledge-document-bindings", headers=f.headers(f.member)).status_code == 403
    assert f.client.put(path, headers=f.headers(), json={"enabled": False, "policy_actor": f.member}).status_code == 422
    assert f.client.put(path, headers=f.headers(), json={"enabled": "false"}).status_code == 422
    other_headers = f.headers(f.other.user_id, f.other.tenant_id)
    assert f.client.put(path, headers=other_headers, json={"enabled": False}).status_code == 404
    assert f.client.put(f"/api/manager/employees/{f.other_eid}/knowledge-document-bindings/{f.docs[0].id}", headers=other_headers, json={"enabled": False}).status_code == 404
    version = f.config.get(f.ctx, employee_id=f.eid).version
    assert f.client.delete(path, headers=f.headers()).status_code == 204
    assert f.client.delete(path, headers=f.headers()).status_code == 204
    assert f.config.get(f.ctx, employee_id=f.eid).version == version+1
    data = f.client.get(base(f)+"/knowledge-document-bindings", headers=f.headers()).json()["data"]
    assert len(data) == 1 and data[0]["policy_actor"] == f.owner
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        with f.router.session(f.ctx) as session:
            session.execute("INSERT INTO knowledge_document_binding (tenant_id, knowledge_space_id, document_id, employee_id) VALUES (%s, %s, %s, %s)", (f.ctx.tenant_id, "enterprise_shared", f.docs[0].id, f.other_eid))
    with f.router.session(f.other) as session:
        assert session.execute("SELECT id FROM knowledge_document_binding WHERE document_id = %s", (f.docs[0].id,)).fetchall() == []
    with f.router.session(f.ctx) as session:
        for table in ("employee_knowledge_binding", "knowledge_document_binding"):
            assert session.execute("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = %s::regclass", (table,)).fetchone() == (True, True)
        session.execute("UPDATE app_user SET roles = %s WHERE id = %s", (["finance_admin"], f.owner))
    assert f.client.delete(path, headers=f.headers()).status_code == 403  # stale owner claim
    with f.router.session(f.ctx) as session:
        session.execute("UPDATE app_user SET status = 'disabled' WHERE id = %s", (f.owner,))
    assert f.client.get(base(f)+"/knowledge-document-bindings", headers=f.headers()).status_code == 403


def test_official_mcp_client_checks_current_tool_document_and_member_grants(policy_pg):
    f = policy_pg
    transport = httpx.ASGITransport(app=f.app)
    def factory(headers=None, timeout=None, auth=None):
        return httpx.AsyncClient(transport=transport, base_url="http://test", headers=headers, timeout=timeout)
    async def run():
        async with f.app.router.lifespan_context(f.app):
            async with streamablehttp_client("http://test/api/manager/rag/mcp", headers={**f.headers(f.member), "X-AITeam-Employee-ID": f.eid}, httpx_client_factory=factory) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    first = await session.call_tool("knowledge_search", {"query": "fixture"})
                    assert not first.isError
                    citation = json.loads(first.content[0].text)["items"][0]["citation_id"]
                    assert not (await session.call_tool("knowledge_get", {"citation_id": citation})).isError
                    with f.router.session(f.ctx) as sql:
                        sql.execute("UPDATE employee SET tools = %s WHERE id = %s", (json.dumps(["knowledge_get"]), f.eid))
                    calls = len(f.seen)
                    assert (await session.call_tool("knowledge_search", {"query": "fixture"})).isError
                    assert len(f.seen) == calls
                    assert not (await session.call_tool("knowledge_get", {"citation_id": citation})).isError
                    f.bindings.set_policy(f.ctx, employee_id=f.eid, document_id=json.loads(first.content[0].text)["items"][0]["document_id"], enabled=False, revoke=True)
                    assert (await session.call_tool("knowledge_get", {"citation_id": citation})).isError
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            denied = await client.post("/api/manager/rag/mcp", headers={**f.headers(f.outsider), "X-AITeam-Employee-ID": f.eid}, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
            assert denied.status_code == 403
            f.whole.create(f.ctx, employee_id=f.eid, knowledge_space_id="enterprise_shared", enabled=False, config={})
            denied = await client.post("/api/manager/rag/mcp", headers={**f.headers(f.member), "X-AITeam-Employee-ID": f.eid}, json={"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "knowledge_get", "arguments": {"citation_id": "citation:enterprise_shared:"+f.docs[1].id}}})
            assert denied.status_code == 403 and "fixture source" not in denied.text
    asyncio.run(run())


def test_migration_replay_preserves_tombstone_and_legacy_unknown_intent(policy_pg):
    f = policy_pg
    f.bindings.set_policy(f.ctx, employee_id=f.eid, document_id=f.docs[0].id, enabled=False, revoke=True)
    f.bindings.upsert_ready(f.ctx, knowledge_space_id="enterprise_shared", document_id=f.docs[1].id, employee_id=f.eid, rag_document_id="legacy", synced_at=datetime.now(timezone.utc))
    f.bindings.mark_revoked_by_document(f.ctx, document_id=f.docs[1].id)
    rows = f.bindings.list_by_employee(f.ctx, employee_id=f.eid)
    version = f.config.get(f.ctx, employee_id=f.eid).version
    apply_migrations(f.admin_url, os.environ["APP_RW_PASSWORD"])
    assert f.bindings.list_by_employee(f.ctx, employee_id=f.eid) == rows
    assert f.config.get(f.ctx, employee_id=f.eid).version == version
    legacy = next(row for row in rows if row.document_id == f.docs[1].id)
    assert legacy.enabled is None and legacy.revoked_at is None and legacy.policy_revision == 0
    # Resource revocation still excludes citations, but ready publication isn't an admin allow.
    assert search(f)["items"] == []
    f.bindings.backfill_ready_for_employee(f.ctx, knowledge_space_id="enterprise_shared", employee_id=f.eid)
    assert [i["document_id"] for i in search(f)["items"]] == [f.docs[1].id]
    with psycopg.connect(f.admin_url) as conn:
        conn.execute((Path(__file__).parents[2] / "manager_service/knowledge_policy_preflight.sql").read_text())


def test_initial_migration_backfills_only_observed_policy_not_resource_intent(admin_url):
    """Execute the actual migration against synthetic pre-0036 tables, then replay."""
    from psycopg import sql
    schema = "s03_legacy_"+uuid.uuid4().hex
    migration = (Path(__file__).parents[2] / "manager_service/migrations/0036_knowledge_policy_tombstones.sql").read_text()
    with psycopg.connect(admin_url) as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        conn.execute(sql.SQL("SET LOCAL search_path TO {}, public").format(sql.Identifier(schema)))
        conn.execute("""
            CREATE TABLE employee (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, version int DEFAULT 1);
            CREATE TABLE employee_knowledge_binding (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, employee_id uuid NOT NULL, enabled boolean NOT NULL);
            CREATE TABLE knowledge_document (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, knowledge_space_id text NOT NULL, UNIQUE (tenant_id, knowledge_space_id, id));
            CREATE TABLE knowledge_document_binding (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, knowledge_space_id text NOT NULL, document_id uuid NOT NULL, employee_id uuid NOT NULL, status text NOT NULL);
        """)
        tenant, employee, untouched, doc, binding = [uuid.uuid4() for _ in range(5)]
        conn.execute("INSERT INTO employee(id, tenant_id) VALUES (%s,%s),(%s,%s)", (employee, tenant, untouched, tenant))
        conn.execute("INSERT INTO employee_knowledge_binding VALUES (%s,%s,%s,false)", (uuid.uuid4(), tenant, employee))
        conn.execute("INSERT INTO knowledge_document VALUES (%s,%s,'enterprise_shared')", (doc, tenant))
        conn.execute("INSERT INTO knowledge_document_binding VALUES (%s,%s,'enterprise_shared',%s,%s,'revoked')", (binding, tenant, doc, employee))
        conn.execute(migration)
        assert conn.execute("SELECT enabled, policy_source, policy_actor, policy_updated_at, revoked_at FROM employee_knowledge_binding").fetchone() == (False, "legacy_observed", None, None, None)
        assert conn.execute("SELECT enabled, policy_source, policy_actor, policy_updated_at, revoked_at FROM knowledge_document_binding").fetchone() == (None, "legacy_resource", None, None, None)
        assert conn.execute("SELECT count(*) FROM employee_knowledge_binding WHERE employee_id = %s", (untouched,)).fetchone()[0] == 0
        conn.execute(migration)
        assert conn.execute("SELECT sum(version) FROM employee").fetchone()[0] == 2
        # The validated composite FK rejects a same-UUID/cross-tenant owner, not fixes it.
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            with conn.transaction():
                conn.execute("UPDATE knowledge_document_binding SET tenant_id = %s", (uuid.uuid4(),))
        conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def test_policy_revision_is_atomic_and_concurrent_document_delete_is_idempotent(policy_pg):
    from concurrent.futures import ThreadPoolExecutor
    f = policy_pg
    version = f.config.get(f.ctx, employee_id=f.eid).version
    with pytest.raises(RuntimeError, match="rollback fixture"):
        with f.router.session(f.ctx) as session:
            session.execute("INSERT INTO employee_knowledge_binding (tenant_id, employee_id, knowledge_space_id, enabled) VALUES (%s,%s,'enterprise_shared',false)", (f.ctx.tenant_id, f.eid))
            assert session.execute("SELECT version FROM employee WHERE id = %s", (f.eid,)).fetchone()[0] == version+1
            raise RuntimeError("rollback fixture")
    assert f.config.get(f.ctx, employee_id=f.eid).version == version
    assert f.whole.list_all(f.ctx, employee_id=f.eid) == []
    def revoke(_):
        return KnowledgeDocumentBindingRepository(PgTenantRouter(f.dsn)).set_policy(f.ctx, employee_id=f.eid, document_id=f.docs[0].id, enabled=False, revoke=True)
    with ThreadPoolExecutor(max_workers=2) as executor:
        rows = list(executor.map(revoke, range(2)))
    assert rows[0] == rows[1] and rows[0].policy_revision == 1
    assert f.config.get(f.ctx, employee_id=f.eid).version == version+1
