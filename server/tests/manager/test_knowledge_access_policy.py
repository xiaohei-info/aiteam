"""RAG policy enforcement at real service/MCP seams with bounded synthetic sources."""
import asyncio
from dataclasses import replace
from types import SimpleNamespace as NS

import httpx
import pytest

from manager_service.knowledge_access_policy import KnowledgeAccessPolicy
from manager_service.rag_mcp import LightRagClient, LightRagSettings, RagAccessService, RagUnavailable
from shared.contracts.auth import TokenClaims
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden
from tests.manager.test_rag_mcp import (
    Document, EmptySnapshot, EnterpriseRag, FakeEmployees, FakeMembers,
)


class Policies:
    def __init__(self):
        self.whole = []
        self.documents = []

    def list_all(self, ctx, *, employee_id):
        return self.whole

    def list_by_employee(self, ctx, *, employee_id, status=None):
        return self.documents


@pytest.fixture
def rag_policy(tmp_path):
    policies = Policies()
    employee = NS(status="active", tools=[], version=1)
    employees = FakeEmployees()
    employees.get = lambda ctx, employee_id: employee
    docs = {}
    for name in ("a", "b"):
        path = tmp_path / f"knowledge/tenant-a/enterprise_shared/{name}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"source {name}")
        docs[name] = Document(name, "enterprise_shared", name, storage_key=str(path.relative_to(tmp_path)), file_name=f"{name}.txt")
    documents = NS(get=lambda ctx, document_id: docs.get(document_id),
                   list_by_space=lambda ctx, knowledge_space_id: list(docs.values()))
    seen = []
    hooks = []

    async def handler(request):
        seen.append(request)
        for hook in hooks:
            hook()
        return httpx.Response(200, json={"data": {"chunks": [
            {"document_id": name, "chunk_id": name, "content": f"source {name}"} for name in docs
        ]}})

    light = LightRagClient(LightRagSettings("http://fixture", "fixture-key"), transport=httpx.MockTransport(handler))
    access = RagAccessService(
        snapshot_service=EmptySnapshot(), member_repository=FakeMembers(), employee_config=employees,
        binding_repository=policies, rag_service=EnterpriseRag(), light_rag=light,
        document_repository=documents, storage_root=tmp_path,
        knowledge_policy=KnowledgeAccessPolicy(policies, policies),
    )
    claims = TokenClaims(tenant_id="tenant-a", user_id="member-a", exp=2_000_000_000)
    yield NS(access=access, claims=claims, policies=policies, employee=employee, seen=seen, hooks=hooks, docs=docs, light=light)
    asyncio.run(light.aclose())


def search(f):
    return asyncio.run(f.access.search(f.access.authorize(f.claims, "employee-a"), "source", 5))


def whole(enabled=True, revoked_at=None):
    return NS(binding_id="whole", knowledge_space_id="enterprise_shared", enabled=enabled,
              revoked_at=revoked_at, policy_revision=1)


def doc_policy(document_id, enabled=None, status="ready", revoked_at=None):
    return NS(document_id=document_id, knowledge_space_id="enterprise_shared", enabled=enabled,
              status=status, revoked_at=revoked_at, policy_revision=1)


def test_untouched_employee_default_and_independent_tool_allowlists(rag_policy):
    f = rag_policy
    initial = search(f)
    assert {item["document_id"] for item in initial["items"]} == {"a", "b"}
    citation = initial["items"][0]["citation_id"]
    auth = f.access.authorize(f.claims, "employee-a")
    f.employee.tools = ["knowledge_get"]
    assert f.access.get(auth, citation)["text"].startswith("source")
    with pytest.raises(Forbidden):
        asyncio.run(f.access.search(auth, "source", 5))
    f.employee.tools = ["knowledge_search"]
    assert search(f)["items"]
    with pytest.raises(Forbidden):
        f.access.get(auth, citation)
    f.employee.tools = ["read"]
    with pytest.raises(Forbidden):
        f.access.authorize(f.claims, "employee-a")


@pytest.mark.parametrize("revoked", [None, "2026-09-06"])
def test_whole_disable_or_delete_dominates_doc_allow_and_stale_auth(rag_policy, revoked):
    f = rag_policy
    initial = search(f)
    auth = f.access.authorize(f.claims, "employee-a")
    calls = len(f.seen)
    f.policies.whole = [whole(False, revoked)]
    f.policies.documents = [doc_policy("a", True)]
    with pytest.raises(Forbidden):
        asyncio.run(f.access.search(auth, "source", 5))
    with pytest.raises(Forbidden):
        f.access.get(auth, initial["items"][0]["citation_id"])
    assert len(f.seen) == calls


@pytest.mark.parametrize("status", ["ready", "stale", "revoked"])
def test_document_deny_does_not_hide_other_document_or_revive_on_reindex(rag_policy, status):
    f = rag_policy
    citation = next(i["citation_id"] for i in search(f)["items"] if i["document_id"] == "a")
    auth = f.access.authorize(f.claims, "employee-a")
    f.policies.documents = [doc_policy("a", False, status)]
    assert [item["document_id"] for item in search(f)["items"]] == ["b"]
    with pytest.raises(RagUnavailable):
        f.access.get(auth, citation)
    f.policies.documents[0].enabled = None
    f.policies.documents[0].status = "ready"
    assert len(search(f)["items"]) == 2


def test_index_stale_is_not_permanent_admin_deny_and_allow_cannot_revive_deleted(rag_policy):
    f = rag_policy
    f.policies.documents = [doc_policy("a", None, "stale")]
    assert len(search(f)["items"]) == 2
    f.policies.documents[0].enabled = True
    f.docs["a"] = replace(f.docs["a"], status="deleted")
    assert [item["document_id"] for item in search(f)["items"]] == ["b"]


@pytest.mark.parametrize("change", ["whole", "doc", "tools", "member", "version"])
def test_search_rechecks_after_upstream_wait_and_does_not_deliver_old_results(rag_policy, change):
    f = rag_policy
    def revoke():
        if change == "whole":
            f.policies.whole = [whole(False)]
        elif change == "doc":
            f.policies.documents = [doc_policy("a", False)]
        elif change == "tools":
            f.employee.tools = ["read"]
        elif change == "member":
            f.access._members.status = "disabled"
        else:
            f.employee.version += 1
    f.hooks.append(revoke)
    with pytest.raises((Forbidden, RagUnavailable)):
        search(f)


def test_policy_projection_empty_operations_are_explicit_and_foreign_rows_rejected():
    p = Policies()
    p.whole = [whole(False)]
    ctx = TenantContext(tenant_id="tenant-a", user_id="member-a")
    resolved = KnowledgeAccessPolicy(p, p).resolve(ctx, employee_id="employee-a", tools=[], version="8")
    assert resolved.projection.model_dump() == {"state": "deny", "allowed_operations": [], "revision": "8"}
    assert "knowledge_get" not in resolved.tools
    p.whole[0].tenant_id = "tenant-b"
    with pytest.raises(Forbidden):
        KnowledgeAccessPolicy(p, p).resolve(ctx, employee_id="employee-a", tools=[], version="8")


@pytest.mark.parametrize("payload", [
    {"chunks": [{"document_id": "b", "chunk_id": "mixed", "content": "source a and source b"}]},
    {"chunks": [{"document_id": "b", "reference_id": "unknown", "content": "source b"}]},
    {"references": [{"reference_id": "r", "document_id": "a"}], "chunks": [{"reference_id": "r", "document_id": "b", "content": "source b"}]},
    {"chunks": [{"document_id": "b", "metadata": {"document_id": "a"}, "content": "source b"}]},
    {"entities": [{"description": "source a"}], "relationships": [{"description": "source a"}]},
])
def test_unknown_conflicting_or_mixed_graph_provenance_returns_no_text(rag_policy, payload):
    f = rag_policy
    f.policies.documents = [doc_policy("a", False)]
    auth = f.access.authorize(f.claims, "employee-a")
    assert f.access._citations(auth, auth.handle, {"data": payload}) == []


def test_denied_document_filename_still_makes_allowed_alias_ambiguous(rag_policy):
    f = rag_policy
    f.docs["a"] = replace(f.docs["a"], file_name="same.txt")
    f.docs["b"] = replace(f.docs["b"], file_name="same.txt")
    f.policies.documents = [doc_policy("a", False)]
    auth = f.access.authorize(f.claims, "employee-a")
    assert f.access._citations(auth, auth.handle, {"data": {"chunks": [
        {"file_path": "same.txt", "chunk_id": "one", "content": "source b"},
    ]}}) == []
