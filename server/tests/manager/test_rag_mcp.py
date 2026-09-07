import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from manager_service.rag_mcp import (
    AuthorizedRagRequest,
    LightRagClient,
    LightRagSettings,
    RagAccessService,
    RagUnavailable,
    build_rag_mcp,
    install_rag_mcp_lifespan,
)
from shared.auth import DevTokenService
from shared.contracts.auth import TokenClaims
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden


@dataclass
class Snapshot:
    employee_id: str
    knowledge_refs: list[str]


@dataclass
class EmployeeConfig:
    status: str = "active"


@dataclass
class Member:
    status: str = "active"


@dataclass
class Binding:
    knowledge_space_id: str
    document_id: str
    rag_document_id: str | None = None
    enabled: bool = True
    status: str = "ready"


@dataclass
class Document:
    id: str
    knowledge_space_id: str
    display_name: str
    tenant_id: str = "tenant-a"
    status: str = "ready"
    storage_key: str = ""
    file_name: str = ""
    source_type: str = "file"
    updated_at: datetime | None = None


@dataclass
class Handle:
    tenant_id: str
    knowledge_space_id: str
    workspace: str


class FakeSnapshots:
    def generate(self, ctx: TenantContext, *, member_id: str, employee_id: str, employee_version=None):
        return Snapshot(employee_id, ["space-a"])


class FakeMembers:
    def __init__(self, status="active"):
        self.status = status

    def get_member(self, ctx: TenantContext, *, member_id: str):
        return Member(self.status)


class FakeEmployees:
    def __init__(self, status="active"):
        self.status = status

    def get(self, ctx: TenantContext, *, employee_id: str):
        return EmployeeConfig(self.status)


class FakeBindings:
    def list_by_employee(self, ctx: TenantContext, *, employee_id: str, status=None):
        return [Binding("space-a", "doc-1", "rag-1"), Binding("space-a", "doc-2", "rag-2")]


class FakeSpaces:
    def get(self, ctx: TenantContext, *, knowledge_space_id: str):
        return object()


class FakeDocs:
    def get(self, ctx: TenantContext, *, document_id: str):
        return Document(document_id, "space-a", "Policy", storage_key="docs/policy.pdf", file_name="policy.pdf") if document_id == "doc-1" else None


class FakeRag:
    def get(self, ctx: TenantContext, knowledge_space_id: str):
        return Handle(ctx.tenant_id, knowledge_space_id, f"t{ctx.tenant_id}__{knowledge_space_id}")


class EnterpriseRag(FakeRag):
    default_space_id = "enterprise_shared"
    is_enterprise_scope = True

    def get(self, ctx: TenantContext, knowledge_space_id: str):
        assert knowledge_space_id == self.default_space_id
        return Handle(ctx.tenant_id, knowledge_space_id, "enterprise-fixed-workspace")


class EmptySnapshot(FakeSnapshots):
    def generate(self, ctx: TenantContext, *, member_id: str, employee_id: str, employee_version=None):
        return Snapshot(employee_id, [])


class EmptyBindings:
    def list_by_employee(self, ctx: TenantContext, *, employee_id: str, status=None):
        return []


class EnterpriseDocs(FakeDocs):
    def __init__(self, root):
        self._document = Document(
            "doc-1", "enterprise_shared", "Policy", storage_key="knowledge/tenant-a/enterprise_shared/policy.txt", file_name="policy.txt",
        )
        self._root = root

    def list_by_space(self, ctx: TenantContext, *, knowledge_space_id: str):
        return [self._document]

    def get(self, ctx: TenantContext, *, document_id: str):
        return self._document if document_id == self._document.id else None


def stored_documents(root, content_by_id):
    documents = {}
    for document_id, (space, text) in content_by_id.items():
        key = f"knowledge/tenant-a/{space}/{document_id}.txt"
        path = root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        documents[document_id] = Document(document_id, space, document_id, storage_key=key, file_name=f"{document_id}.txt")
    class StoredDocuments:
        def get(self, ctx, *, document_id):
            return documents.get(document_id)
    return StoredDocuments()


def test_lightrag_client_uses_manager_headers_and_bounded_query():
    seen = {}
    request_body = {}

    async def handler(request: httpx.Request):
        seen.update(request.headers)
        request_body.update(json.loads(request.content))
        return httpx.Response(200, json={"status": "success", "data": {"references": []}})

    async def run():
        client = LightRagClient(LightRagSettings("http://rag", "manager-secret"), transport=httpx.MockTransport(handler))
        try:
            await client.query(workspace="derived-space", query="hello", limit=100)
        finally:
            await client.aclose()
    asyncio.run(run())
    assert seen["x-api-key"] == "manager-secret"
    assert seen["lightrag-workspace"] == "derived-space"
    assert request_body["include_references"] is True


def test_lightrag_client_rejects_workspace_not_owned_by_fixed_instance():
    client = LightRagClient(
        LightRagSettings("http://rag", "secret", workspace="fixed-space"),
        transport=httpx.MockTransport(lambda request: httpx.Response(500)),
    )

    async def run():
        try:
            with pytest.raises(RagUnavailable, match="knowledge service unavailable"):
                await client.query(workspace="other-space", query="hello", limit=5)
        finally:
            await client.aclose()

    asyncio.run(run())


def test_lightrag_documented_no_context_response_is_empty_success():
    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "failure", "message": "No context found for query"})

    client = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    async def run():
        try:
            return await client.query(workspace="workspace", query="missing", limit=5)
        finally:
            await client.aclose()
    assert asyncio.run(run()) == {"status": "success", "data": {"references": [], "chunks": []}}


@pytest.mark.parametrize("status", ["disabled", "revoked"])
@pytest.mark.parametrize("role", ["owner", "enterprise_admin"])
def test_access_denies_inactive_members_even_when_they_are_management_roles(status, role):
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(status), employee_config=FakeEmployees(),
        binding_repository=FakeBindings(), rag_service=FakeRag(), light_rag=LightRagClient(LightRagSettings("http://rag", "secret")),
    )
    claims = TokenClaims(tenant_id="tenant-a", user_id="member-a", roles=[role], exp=2_000_000_000)
    with pytest.raises(Forbidden):
        access.authorize(claims, "employee-a")


@pytest.mark.parametrize("status", ["paused", "archived", "draft"])
def test_access_denies_non_runnable_employee_lifecycle(status):
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(status),
        binding_repository=FakeBindings(), rag_service=FakeRag(), light_rag=LightRagClient(LightRagSettings("http://rag", "secret")),
    )
    with pytest.raises(Forbidden):
        access.authorize(TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a")


def test_enterprise_scope_allows_ready_documents_without_employee_bindings(tmp_path):
    (tmp_path / "knowledge/tenant-a/enterprise_shared").mkdir(parents=True)
    (tmp_path / "knowledge/tenant-a/enterprise_shared/policy.txt").write_text("enterprise policy", encoding="utf-8")

    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "success", "data": {"references": [
            {"reference_id": "policy.txt", "file_path": "policy.txt", "content": "enterprise policy", "score": 0.8},
        ]}})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=EmptySnapshot(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=EmptyBindings(), rag_service=EnterpriseRag(), light_rag=light,
        document_repository=EnterpriseDocs(tmp_path), storage_root=tmp_path,
    )
    claims = TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000)

    async def run():
        try:
            auth = access.authorize(claims, "employee-a")
            result = await access.search(auth, "policy", 5)
        finally:
            await light.aclose()
        return auth, result

    auth, result = asyncio.run(run())
    assert auth.handle.workspace == "enterprise-fixed-workspace"
    assert result["items"][0]["document_id"] == "doc-1"


def test_access_derives_workspace_and_filters_unowned_citations(tmp_path):
    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "success", "data": {"references": [
            {"reference_id": 1, "file_path": "doc-1", "content": "allowed", "score": 0.8},
            {"reference_id": "rag-2", "content": ["unknown"], "score": 0.9},
        ]}})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(), binding_repository=FakeBindings(), rag_service=FakeRag(),
        light_rag=light, space_repository=FakeSpaces(), document_repository=stored_documents(tmp_path, {"doc-1": ("space-a", "allowed")}), storage_root=tmp_path,
    )
    claims = TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000)
    async def run():
        try:
            auth = access.authorize(claims, "employee-a")
            result = await access.search(auth, "policy", 100)
        finally:
            await light.aclose()
        return auth, result
    auth, result = asyncio.run(run())
    assert auth.handle.workspace == "ttenant-a__space-a"
    assert [item["document_id"] for item in result["items"]] == ["doc-1"]
    assert result["items"][0]["text"] == "allowed"
    assert "secret" not in str(result)


def test_access_does_not_use_duplicate_filename_as_citation_alias():
    class DuplicateBindings(FakeBindings):
        def list_by_employee(self, ctx: TenantContext, *, employee_id: str, status=None):
            return [Binding("space-a", "doc-1", "rag-1"), Binding("space-a", "doc-2", "rag-2")]

    class DuplicateDocs:
        def get(self, ctx: TenantContext, *, document_id: str):
            return Document(
                document_id, "space-a", document_id, storage_key=f"docs/{document_id}",
                file_name="duplicate.txt",
            )

    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "success", "data": {"references": [
            {"file_path": "duplicate.txt", "content": "ambiguous", "score": 0.9},
        ]}})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=DuplicateBindings(), rag_service=FakeRag(), light_rag=light,
        space_repository=FakeSpaces(), document_repository=DuplicateDocs(),
    )

    async def run():
        try:
            auth = access.authorize(TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a")
            return await access.search(auth, "duplicate", 5)
        finally:
            await light.aclose()

    assert asyncio.run(run())["items"] == []


def test_access_joins_reference_metadata_with_chunk_content(tmp_path):
    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "success", "data": {
            "references": [{"reference_id": "ref-1", "file_path": "doc-1", "file_name": "Policy", "score": 0.7}],
            "chunks": [{"reference_id": "ref-1", "file_path": "doc-1", "content": "joined chunk text"}],
        }})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(), binding_repository=FakeBindings(), rag_service=FakeRag(),
        light_rag=light, space_repository=FakeSpaces(), document_repository=stored_documents(tmp_path, {"doc-1": ("space-a", "joined chunk text")}), storage_root=tmp_path,
    )
    async def run():
        try:
            auth = access.authorize(TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a")
            return await access.search(auth, "policy", 5)
        finally:
            await light.aclose()
    result = asyncio.run(run())
    assert result["items"][0]["text"] == "joined chunk text"


def test_access_drops_wrong_binding_and_document_tenant_or_status():
    class UnsafeBindings(FakeBindings):
        def list_by_employee(self, ctx: TenantContext, *, employee_id: str, status=None):
            return [
                Binding("space-a", "doc-1", "rag-1", status="ready"),
                type("Binding", (), {"tenant_id": "tenant-b", "employee_id": employee_id, "knowledge_space_id": "space-a", "document_id": "doc-2", "rag_document_id": "rag-2", "status": "ready", "enabled": True})(),
            ]

    class UnsafeDocs(FakeDocs):
        def get(self, ctx: TenantContext, *, document_id: str):
            if document_id == "doc-1":
                return Document(document_id, "space-a", "Policy", status="processing")
            return Document(document_id, "space-a", "Other", tenant_id="tenant-b")

    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "success", "data": {"references": [
            {"reference_id": "rag-1", "content": "not ready"},
            {"reference_id": "rag-2", "content": "wrong tenant"},
        ]}})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(), binding_repository=UnsafeBindings(), rag_service=FakeRag(),
        light_rag=light, space_repository=FakeSpaces(), document_repository=UnsafeDocs(),
    )
    async def run():
        try:
            return await access.search(access.authorize(TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a"), "policy", 10)
        finally:
            await light.aclose()
    with pytest.raises(Forbidden):
        asyncio.run(run())


def test_access_fails_closed_when_snapshot_and_binding_disagree():
    class NoBinding(FakeBindings):
        def list_by_employee(self, ctx: TenantContext, *, employee_id: str, status=None):
            return []

    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(), binding_repository=NoBinding(), rag_service=FakeRag(),
        light_rag=LightRagClient(LightRagSettings("http://rag", "secret")), space_repository=FakeSpaces(),
    )
    with pytest.raises(Forbidden):
        access.authorize(TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a")


@pytest.mark.parametrize("binding_attrs", [
    {"tenant_id": "tenant-b", "employee_id": "employee-a", "status": "ready"},
    {"tenant_id": "tenant-a", "employee_id": "employee-a", "status": "stale"},
])
def test_access_rejects_cross_tenant_or_stale_space_binding(binding_attrs):
    class UnsafeBindings(FakeBindings):
        def list_by_employee(self, ctx, *, employee_id, status=None):
            return [type("UnsafeBinding", (), {
                "knowledge_space_id": "space-a", "document_id": "doc-1", "rag_document_id": "rag-1",
                "enabled": True, **binding_attrs,
            })()]

    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=UnsafeBindings(), rag_service=FakeRag(),
        light_rag=LightRagClient(LightRagSettings("http://rag", "secret")),
        space_repository=FakeSpaces(), document_repository=FakeDocs(),
    )
    with pytest.raises(Forbidden):
        access.authorize(TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a")


def test_access_fans_out_spaces_merges_deterministically_and_honors_limit(tmp_path):
    class MultiSnapshots(FakeSnapshots):
        def generate(self, ctx, *, member_id, employee_id, employee_version=None):
            return Snapshot(employee_id, ["space-a", "space-b"])

    class MultiBindings(FakeBindings):
        def list_by_employee(self, ctx, *, employee_id, status=None):
            return [Binding("space-a", "doc-a", "rag-a"), Binding("space-b", "doc-b", "rag-b")]

    class MultiDocs:
        def get(self, ctx, *, document_id):
            space = {"doc-a": "space-a", "doc-b": "space-b"}.get(document_id)
            return Document(document_id, space, document_id) if space else None

    seen_workspaces = []

    async def handler(request: httpx.Request):
        workspace = request.headers["lightrag-workspace"]
        seen_workspaces.append(workspace)
        ref = "rag-a" if workspace.endswith("space-a") else "rag-b"
        score = 0.8 if ref == "rag-a" else 0.9
        return httpx.Response(200, json={"status": "success", "data": {"references": [
            {"reference_id": ref, "content": ref, "score": score},
        ]}})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=MultiSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=MultiBindings(), rag_service=FakeRag(), light_rag=light,
        space_repository=FakeSpaces(), document_repository=stored_documents(tmp_path, {"doc-a": ("space-a", "rag-a"), "doc-b": ("space-b", "rag-b")}), storage_root=tmp_path,
    )

    async def run():
        try:
            auth = access.authorize(TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a")
            result = await access.search(auth, "policy", 1)
            return auth, result
        finally:
            await light.aclose()

    auth, result = asyncio.run(run())
    assert [handle.knowledge_space_id for handle in auth.handles] == ["space-a", "space-b"]
    assert sorted(seen_workspaces) == ["ttenant-a__space-a", "ttenant-a__space-b"]
    assert [item["document_id"] for item in result["items"]] == ["doc-b"]
    assert result["items"][0]["knowledge_space_id"] == "space-b"
    assert "degraded" not in result


def test_access_partial_space_failure_is_degraded_and_all_failure_is_unavailable(tmp_path):
    class MultiSnapshots(FakeSnapshots):
        def generate(self, ctx, *, member_id, employee_id, employee_version=None):
            return Snapshot(employee_id, ["space-a", "space-b"])

    class MultiBindings(FakeBindings):
        def list_by_employee(self, ctx, *, employee_id, status=None):
            return [Binding("space-a", "doc-a", "rag-a"), Binding("space-b", "doc-b", "rag-b")]

    class MultiDocs:
        def get(self, ctx, *, document_id):
            space = {"doc-a": "space-a", "doc-b": "space-b"}.get(document_id)
            return Document(document_id, space, document_id) if space else None

    async def handler(request: httpx.Request):
        if request.headers["lightrag-workspace"].endswith("space-b"):
            return httpx.Response(503, text="upstream key leaked")
        return httpx.Response(200, json={"status": "success", "data": {"references": [
            {"reference_id": "rag-a", "content": "available", "score": 0.5},
        ]}})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=MultiSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=MultiBindings(), rag_service=FakeRag(), light_rag=light,
        space_repository=FakeSpaces(), document_repository=stored_documents(tmp_path, {"doc-a": ("space-a", "available"), "doc-b": ("space-b", "rag-b")}), storage_root=tmp_path,
    )
    claims = TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000)

    async def run_partial():
        auth = access.authorize(claims, "employee-a")
        return await access.search(auth, "policy", 10)

    try:
        result = asyncio.run(run_partial())
        assert result["degraded"] is True
        assert [item["document_id"] for item in result["items"]] == ["doc-a"]
        assert "upstream key leaked" not in str(result)
    finally:
        asyncio.run(light.aclose())

    async def all_failed(request: httpx.Request):
        raise httpx.ConnectError("secret workspace failure", request=request)

    failed_light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(all_failed))
    failed_access = RagAccessService(
        snapshot_service=MultiSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=MultiBindings(), rag_service=FakeRag(), light_rag=failed_light,
        space_repository=FakeSpaces(), document_repository=stored_documents(tmp_path, {"doc-a": ("space-a", "available"), "doc-b": ("space-b", "rag-b")}), storage_root=tmp_path,
    )

    async def run_all_failed():
        try:
            auth = failed_access.authorize(claims, "employee-a")
            await failed_access.search(auth, "policy", 10)
        finally:
            await failed_light.aclose()

    with pytest.raises(RuntimeError, match="knowledge service unavailable"):
        asyncio.run(run_all_failed())


def test_mcp_inventory_is_read_only_search_and_bounded_get():
    mcp, _ = build_rag_mcp(verifier=DevTokenService(), access=object())
    tools = mcp._tool_manager.list_tools()
    assert [tool.name for tool in tools] == ["knowledge_search", "knowledge_get"]


def test_access_get_rejects_document_revoked_by_delete(tmp_path):
    storage_key = "knowledge/tenant-a/space-a/ingest-1/policy.txt"
    path = tmp_path / storage_key
    path.parent.mkdir(parents=True)
    path.write_text("must not be returned", encoding="utf-8")

    class DeletingDocs(FakeDocs):
        def get(self, ctx: TenantContext, *, document_id: str):
            doc = super().get(ctx, document_id=document_id)
            doc.status = "deleting"
            return doc

    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=FakeBindings(), rag_service=FakeRag(), light_rag=LightRagClient(),
        space_repository=FakeSpaces(), document_repository=DeletingDocs(), storage_root=tmp_path,
    )
    auth = access.authorize(
        TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a"
    )
    with pytest.raises(RagUnavailable):
        access.get(auth, "citation:space-a:doc-1")


def test_access_get_reads_current_authorized_document_with_bounded_text(tmp_path):
    storage_key = "knowledge/tenant-a/space-a/ingest-1/policy.txt"
    path = tmp_path / storage_key
    path.parent.mkdir(parents=True)
    path.write_text("x" * 5_000, encoding="utf-8")

    class StoredDocs(FakeDocs):
        def get(self, ctx, *, document_id):
            return Document(document_id, "space-a", "Policy", storage_key=storage_key)

    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=FakeBindings(), rag_service=FakeRag(), light_rag=LightRagClient(),
        space_repository=FakeSpaces(), document_repository=StoredDocs(), storage_root=tmp_path,
    )
    auth = access.authorize(
        TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a"
    )
    result = access.get(auth, "citation:space-a:doc-1")
    assert result["citation_id"] == "citation:space-a:doc-1"
    assert result["text"] == "x" * 4_000
    assert len(result["text"]) == 4_000
    assert str(tmp_path) not in json.dumps(result)
    assert "workspace" not in json.dumps(result)


def test_search_returns_versioned_exact_chunk_citations_and_gets_authoritative_chunks(tmp_path):
    chunk_zero = "a" * 1_200
    chunk_one = "second authoritative chunk"
    storage_key = "knowledge/tenant-a/space-a/ingest-1/policy.txt"
    path = tmp_path / storage_key
    path.parent.mkdir(parents=True)
    path.write_text(chunk_zero + chunk_one, encoding="utf-8")
    document = Document(
        "doc-1", "space-a", "Policy", storage_key=storage_key,
        file_name="policy.txt", updated_at=datetime(2026, 8, 22, tzinfo=timezone.utc),
    )

    class SingleBinding(FakeBindings):
        def list_by_employee(self, ctx, *, employee_id, status=None):
            return [Binding("space-a", "doc-1", "doc-1")]

    class StoredDocs:
        def get(self, ctx, *, document_id):
            return document if document_id == "doc-1" else None

    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "success", "data": {
            "references": [{"reference_id": "ref-1", "file_path": "doc-1"}],
            "chunks": [
                {"reference_id": "ref-1", "file_path": "doc-1", "chunk_id": "upstream-0",
                 "chunk_order_index": 0, "content": chunk_zero, "score": 0.9},
                {"reference_id": "ref-1", "file_path": "doc-1", "chunk_id": "upstream-1",
                 "chunk_order_index": 1, "content": chunk_one, "score": 0.8},
            ],
        }})

    light = LightRagClient(
        LightRagSettings("http://rag", "manager-secret"), transport=httpx.MockTransport(handler)
    )
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=SingleBinding(), rag_service=FakeRag(), light_rag=light,
        space_repository=FakeSpaces(), document_repository=StoredDocs(), storage_root=tmp_path,
    )
    claims = TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000)

    async def run():
        try:
            auth = access.authorize(claims, "employee-a")
            result = await access.search(auth, "policy", 10)
            fetched = [access.get(auth, item["citation_id"]) for item in result["items"]]
            return result, fetched
        finally:
            await light.aclose()

    result, fetched = asyncio.run(run())
    assert [item["chunk_index"] for item in result["items"]] == [0, 1]
    assert [item["text"] for item in result["items"]] == [chunk_zero, chunk_one]
    assert all(len(item["citation_id"].split(":")) == 4 for item in result["items"])
    assert all(item["locator"] in {"i0", "i1"} for item in result["items"])
    assert all(item["citation_version"].startswith("sha256:") for item in result["items"])
    assert all(fetched_item["text"] == expected for fetched_item, expected in zip(fetched, [chunk_zero, chunk_one]))
    rendered = json.dumps(result, ensure_ascii=False)
    assert all("workspace" not in json.dumps(item) and str(tmp_path) not in json.dumps(item) for item in result["items"])
    for forbidden in ("manager-secret", "upstream-0", "file_path", "storage_key", "chunk_id"):
        assert forbidden not in rendered


def test_chunk_id_without_order_uses_unique_authoritative_span_not_upstream_storage(tmp_path):
    text = "prefix-" + ("unique chunk text " * 8) + "-suffix"
    chunk_content = "unique chunk text " * 8
    storage_key = "knowledge/tenant-a/space-a/ingest-1/policy.txt"
    path = tmp_path / storage_key
    path.parent.mkdir(parents=True)
    path.write_text(text, encoding="utf-8")

    class SingleBinding(FakeBindings):
        def list_by_employee(self, ctx, *, employee_id, status=None):
            return [Binding("space-a", "doc-1", "doc-1")]

    class StoredDocs:
        def get(self, ctx, *, document_id):
            return Document("doc-1", "space-a", "Policy", storage_key=storage_key)

    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "success", "data": {"chunks": [
            {"file_path": "doc-1", "chunk_id": "upstream-token-only",
             "content": chunk_content, "score": 1.0},
        ]}})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=SingleBinding(), rag_service=FakeRag(), light_rag=light,
        space_repository=FakeSpaces(), document_repository=StoredDocs(), storage_root=tmp_path,
    )

    async def run():
        try:
            auth = access.authorize(TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a")
            result = await access.search(auth, "policy", 10)
            fetched = access.get(auth, result["items"][0]["citation_id"])
            return result, fetched
        finally:
            await light.aclose()

    result, fetched = asyncio.run(run())
    item = result["items"][0]
    assert item["locator"].startswith("o")
    assert "chunk_index" not in item
    assert item["text"] == chunk_content
    assert fetched["text"] == chunk_content


def test_exact_citation_version_fails_closed_after_document_version_changes(tmp_path):
    storage_key = "knowledge/tenant-a/space-a/ingest-1/policy.txt"
    path = tmp_path / storage_key
    path.parent.mkdir(parents=True)
    path.write_text("authoritative text", encoding="utf-8")
    document = Document(
        "doc-1", "space-a", "Policy", storage_key=storage_key,
        updated_at=datetime(2026, 8, 22, tzinfo=timezone.utc),
    )

    class SingleBinding(FakeBindings):
        def list_by_employee(self, ctx, *, employee_id, status=None):
            return [Binding("space-a", "doc-1", "doc-1")]

    class StoredDocs:
        def get(self, ctx, *, document_id):
            return document if document_id == "doc-1" else None

    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "success", "data": {"chunks": [
            {"file_path": "doc-1", "chunk_id": "upstream-0", "chunk_order_index": 0,
             "content": "authoritative text", "score": 1.0},
        ]}})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=SingleBinding(), rag_service=FakeRag(), light_rag=light,
        space_repository=FakeSpaces(), document_repository=StoredDocs(), storage_root=tmp_path,
    )
    claims = TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000)

    async def run():
        try:
            auth = access.authorize(claims, "employee-a")
            result = await access.search(auth, "policy", 10)
            return auth, result
        finally:
            await light.aclose()

    auth, result = asyncio.run(run())
    citation_id = result["items"][0]["citation_id"]
    document.updated_at = datetime(2026, 8, 23, tzinfo=timezone.utc)
    with pytest.raises(RagUnavailable):
        access.get(auth, citation_id)


def test_duplicate_or_out_of_range_upstream_chunk_falls_back_to_versioned_document_citation(tmp_path):
    chunk = "authoritative chunk"
    storage_key = "knowledge/tenant-a/space-a/ingest-1/policy.txt"
    path = tmp_path / storage_key
    path.parent.mkdir(parents=True)
    path.write_text(chunk, encoding="utf-8")

    class SingleBinding(FakeBindings):
        def list_by_employee(self, ctx, *, employee_id, status=None):
            return [Binding("space-a", "doc-1", "doc-1")]

    class StoredDocs:
        def get(self, ctx, *, document_id):
            return Document("doc-1", "space-a", "Policy", storage_key=storage_key)

    async def handler(request: httpx.Request):
        return httpx.Response(200, json={"status": "success", "data": {"chunks": [
            {"file_path": "doc-1", "chunk_id": "duplicate", "chunk_order_index": 0,
             "content": chunk, "score": 0.9},
            {"file_path": "doc-1", "chunk_id": "duplicate", "chunk_order_index": 0,
             "content": chunk, "score": 0.8},
            {"file_path": "doc-1", "chunk_id": "out-of-range", "chunk_order_index": 99,
             "content": "not authoritative", "score": 0.7},
        ]}})

    light = LightRagClient(LightRagSettings("http://rag", "secret"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=SingleBinding(), rag_service=FakeRag(), light_rag=light,
        space_repository=FakeSpaces(), document_repository=StoredDocs(), storage_root=tmp_path,
    )
    async def run():
        try:
            auth = access.authorize(TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a")
            return await access.search(auth, "policy", 10)
        finally:
            await light.aclose()

    result = asyncio.run(run())
    assert len(result["items"]) == 1
    assert result["items"][0]["citation_id"].endswith("-d")
    assert "chunk_index" not in result["items"][0]


@pytest.mark.parametrize("citation_id", [
    "", "doc-1", "citation:space-a", "citation:space-a:doc-1:extra", "citation:space-b:doc-1",
])
def test_access_get_rejects_malformed_or_foreign_citations(tmp_path, citation_id):
    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=FakeBindings(), rag_service=FakeRag(), light_rag=LightRagClient(),
        space_repository=FakeSpaces(), document_repository=FakeDocs(), storage_root=tmp_path,
    )
    auth = access.authorize(
        TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a"
    )
    with pytest.raises(RagUnavailable):
        access.get(auth, citation_id)


def test_access_get_reauthorizes_revoked_binding(tmp_path):
    class RevokedBindings(FakeBindings):
        def list_by_employee(self, ctx, *, employee_id, status=None):
            return [Binding("space-a", "doc-1", "rag-1", status="revoked")]

    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=RevokedBindings(), rag_service=FakeRag(), light_rag=LightRagClient(),
        space_repository=FakeSpaces(), document_repository=FakeDocs(), storage_root=tmp_path,
    )
    auth = AuthorizedRagRequest(
        TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000),
        TenantContext(tenant_id="tenant-a", user_id="member-a"), "member-a", "employee-a",
        Snapshot("employee-a", ["space-a"]), Handle("tenant-a", "space-a", "workspace"), (),
    )
    with pytest.raises(Forbidden):
        access.get(auth, "citation:space-a:doc-1")


def test_access_get_rejects_path_escape_and_missing_document(tmp_path):
    class UnsafeDocs(FakeDocs):
        def __init__(self, storage_key):
            self.storage_key = storage_key

        def get(self, ctx, *, document_id):
            return Document(document_id, "space-a", "Policy", storage_key=self.storage_key)

    access = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=FakeBindings(), rag_service=FakeRag(), light_rag=LightRagClient(),
        space_repository=FakeSpaces(), document_repository=UnsafeDocs("../outside.txt"), storage_root=tmp_path,
    )
    auth = access.authorize(
        TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000), "employee-a"
    )
    with pytest.raises(RagUnavailable):
        access.get(auth, "citation:space-a:doc-1")

    class MissingDocs(FakeDocs):
        def get(self, ctx, *, document_id):
            return None

    missing = RagAccessService(
        snapshot_service=FakeSnapshots(), member_repository=FakeMembers(), employee_config=FakeEmployees(),
        binding_repository=FakeBindings(), rag_service=FakeRag(), light_rag=LightRagClient(),
        space_repository=FakeSpaces(), document_repository=MissingDocs(), storage_root=tmp_path,
    )
    with pytest.raises(RagUnavailable):
        missing.get(auth, "citation:space-a:doc-1")


def test_mcp_auth_error_uses_problem_json_without_upstream_details():
    mcp, mounted = build_rag_mcp(verifier=DevTokenService(), access=object())
    app = FastAPI()
    app.mount("/api/manager/rag", mounted)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/api/manager/rag/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})

    response = asyncio.run(run())
    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "unauthorized"
    assert "missing bearer" not in response.text


def test_mcp_official_client_forwards_auth_and_employee_and_closes_lifespan():
    seen: dict[str, str] = {}

    class RecordingVerifier(DevTokenService):
        def verify(self, token: str):
            seen["authorization"] = token
            return super().verify(token)

    verifier = RecordingVerifier("integration-secret")
    claims = TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000)

    class IntegrationAccess:
        def authorize(self, received_claims: TokenClaims, employee_id: str):
            seen["employee_id"] = employee_id
            seen["user_id"] = received_claims.user_id
            return AuthorizedRagRequest(
                received_claims, TenantContext(tenant_id=received_claims.tenant_id, user_id=received_claims.user_id), received_claims.user_id,
                employee_id, Snapshot(employee_id, ["space-a"]), Handle("tenant-a", "space-a", "workspace"), (),
            )

        async def search(self, auth: AuthorizedRagRequest, query: str, limit: int):
            seen["query"] = query
            return {"query": query, "items": [{"document_id": "doc-1", "text": "bound"}]}

    mcp, mounted = build_rag_mcp(verifier=verifier, access=IntegrationAccess())
    app = FastAPI()
    app.mount("/api/manager/rag", mounted)
    install_rag_mcp_lifespan(app, mcp)
    transport = httpx.ASGITransport(app=app)
    token = verifier.sign(claims)

    def factory(headers=None, timeout=None, auth=None):
        return httpx.AsyncClient(transport=transport, base_url="http://test", headers=headers, timeout=timeout)

    async def run():
        async with app.router.lifespan_context(app):
            async with streamablehttp_client(
                "http://test/api/manager/rag/mcp",
                headers={"Authorization": f"Bearer {token}", "X-AITeam-Employee-ID": "employee-a"},
                httpx_client_factory=factory,
            ) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    result = await session.call_tool("knowledge_search", {"query": "policy", "limit": 3})
                    return tools, result

    tools, result = asyncio.run(run())
    assert [tool.name for tool in tools.tools] == ["knowledge_search", "knowledge_get"]
    assert result.isError is not True
    assert seen == {"authorization": token, "employee_id": "employee-a", "user_id": "member-a", "query": "policy"}
