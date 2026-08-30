"""Focused fakes for Manager knowledge and memory analytics projections."""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.hindsight_client import HindsightUnavailable
from manager_service.knowledge_intake_service import KnowledgeIntakeService
from manager_service.memory_service import MemoryService
from manager_service.rag_ingestion import RagDocumentInfo
from shared.app_factory import create_app
from shared.config import Settings
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


CTX = TenantContext(tenant_id="tenant-a", user_id="member-a", roles=["owner"])


def _doc(document_id: str, *, status: str, created_at: datetime, updated_at: datetime, size: int, text: int | None):
    return SimpleNamespace(
        id=document_id,
        tenant_id="tenant-a",
        knowledge_space_id="enterprise_shared",
        display_name=document_id,
        source_type="file",
        file_name=f"{document_id}.md",
        file_type="text/markdown",
        file_size=size,
        storage_key=f"tenant-a/enterprise_shared/{document_id}.md",
        status=status,
        text_chars=text,
        error_code="INDEX_FAILED" if status == "failed" else None,
        error_message=None,
        created_at=created_at,
        updated_at=updated_at,
    )


class _Docs:
    def __init__(self, rows):
        self.rows = rows

    def list_by_space(self, ctx, *, knowledge_space_id):
        assert ctx is CTX
        assert knowledge_space_id == "enterprise_shared"
        return self.rows


class _Jobs:
    def __init__(self, rows):
        self.rows = rows

    def list_by_space(self, ctx, *, knowledge_space_id):
        assert ctx is CTX
        return self.rows


class _Bindings:
    def __init__(self, rows):
        self.rows = rows

    def list_by_document(self, ctx, *, document_id):
        assert ctx is CTX
        return [row for row in self.rows if row.document_id == document_id]


class _Rag:
    def get(self, ctx, knowledge_space_id):
        assert ctx is CTX
        return SimpleNamespace(
            tenant_id="tenant-a", knowledge_space_id=knowledge_space_id,
            workspace="enterprise-fixed",
        )


class _RagList:
    settings = object()
    instance_registry = None

    def list_documents(self, *, workspace):
        assert workspace == "enterprise-fixed"
        return [RagDocumentInfo(
            upstream_document_id="upstream-ready",
            file_path="doc-ready",
            status="processed",
            chunks_count=4,
            content_length=120,
            created_at="2026-08-26T09:00:00Z",
        )]


class _NoOp:
    pass


def _knowledge_service(docs, jobs, bindings, ingestion):
    return KnowledgeIntakeService(
        doc_repo=_Docs(docs),
        job_repo=_Jobs(jobs),
        binding_repo=_Bindings(bindings),
        expert_binding=_NoOp(),
        employee_index_port=_NoOp(),
        space_exists=lambda ctx, space_id: space_id == "enterprise_shared",
        storage_root=None,
        rag_service=_Rag(),
        ingestion_client=ingestion,
    )


def test_knowledge_analytics_combines_fixed_lightrag_metadata_and_manager_bindings():
    ready_time = datetime(2026, 8, 26, 9, tzinfo=timezone.utc)
    failed_time = datetime(2026, 8, 27, 10, tzinfo=timezone.utc)
    docs = [
        _doc("doc-ready", status="ready", created_at=ready_time, updated_at=ready_time, size=100, text=80),
        _doc("doc-failed", status="failed", created_at=failed_time, updated_at=failed_time, size=50, text=None),
        _doc("doc-indexing", status="indexing", created_at=failed_time, updated_at=failed_time, size=25, text=10),
    ]
    jobs = [
        SimpleNamespace(document_id="doc-ready", status="done", chunk_count=4, error_code=None,
                         created_at=ready_time, started_at=ready_time, completed_at=ready_time),
        SimpleNamespace(document_id="doc-failed", status="failed", chunk_count=None, error_code="INDEX_FAILED",
                         created_at=failed_time, started_at=failed_time, completed_at=failed_time),
    ]
    bindings = [
        SimpleNamespace(document_id="doc-ready", status="ready"),
        SimpleNamespace(document_id="doc-ready", status="stale"),
        SimpleNamespace(document_id="doc-failed", status="revoked"),
    ]

    result = _knowledge_service(docs, jobs, bindings, _RagList()).analytics(
        CTX, knowledge_space_id="enterprise_shared"
    )

    assert result.status == "available"
    assert result.document_count == 3
    assert result.ready_count == 1
    assert result.failed_count == 1
    assert result.processing_count == 1
    assert result.total_bytes == 175
    assert result.total_text_chars == 90
    assert result.total_chunks == 4
    ready = next(item for item in result.documents if item.document_id == "doc-ready")
    assert ready.upstream_status == "processed"
    assert ready.chunk_count == 4
    assert (ready.binding_count, ready.ready_binding_count, ready.stale_binding_count) == (2, 1, 1)
    assert {item.date for item in result.daily_activity} == {"2026-08-26", "2026-08-27"}


def test_knowledge_analytics_reports_unconfigured_lightrag_without_losing_local_inventory():
    ready_time = datetime(2026, 8, 26, 9, tzinfo=timezone.utc)
    ingestion = SimpleNamespace(settings=None, instance_registry=None)
    result = _knowledge_service(
        [_doc("doc-ready", status="ready", created_at=ready_time, updated_at=ready_time, size=10, text=3)],
        [], [], ingestion,
    ).analytics(CTX, knowledge_space_id="enterprise_shared")

    assert result.status == "not_configured"
    assert result.document_count == 1
    assert result.upstream_document_count is None


def test_lightrag_document_listing_is_bounded_and_does_not_return_content_or_workspace():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "manager-secret"
        assert request.headers["lightrag-workspace"] == "fixed"
        return httpx.Response(200, json={
            "documents": [{
                "id": "upstream-1", "file_path": "manager-doc-1", "status": "PROCESSED",
                "chunks_count": 3, "content_length": 12, "content": "private body",
            }],
            "pagination": {"page": 1, "page_size": 200, "total_count": 1, "total_pages": 1},
        })

    from manager_service.rag_ingestion import LightRagIngestionClient, LightRagIngestionSettings

    rag = LightRagIngestionClient(
        LightRagIngestionSettings("http://lightrag", "manager-secret", 100, 100),
        transport=httpx.MockTransport(handler),
    )
    try:
        result = rag.list_documents(workspace="fixed")
    finally:
        rag.close()

    assert result == [RagDocumentInfo(
        upstream_document_id="upstream-1", file_path="manager-doc-1", status="processed",
        chunks_count=3, content_length=12, created_at=None, updated_at=None,
    )]
    assert not hasattr(result[0], "content")


class _Snapshot:
    def generate(self, ctx, *, member_id, employee_id, employee_version=None):
        assert ctx is CTX
        return EmployeeExecutionSnapshot(
            employee_id=employee_id, version="1", snapshot_version="s1",
            memory_policy={"enabled": True},
        )


class _Employees:
    def list_all(self, ctx):
        assert ctx is CTX
        return [
            SimpleNamespace(employee_id="e1", display_name="研究专家"),
            SimpleNamespace(employee_id="e2", display_name="客服专家"),
        ]


class _MemoryBackend:
    def list(self, ctx, *, employee_id, query, limit, offset):
        assert ctx is CTX
        assert query is None
        data = {
            "e1": [{"id": "m1", "text": "偏好中文", "fact_type": "preference", "importance": 0.8,
                    "date": "2026-08-25T00:00:00Z", "last_used_at": "2026-08-26T00:00:00Z", "state": "valid"}],
            "e2": [{"id": "m2", "text": "已失效规则", "fact_type": "rule", "importance": 0.2,
                    "date": "2026-08-20T00:00:00Z", "last_used_at": None, "state": "invalidated"}],
        }
        return {"items": data[employee_id], "total": len(data[employee_id])}


def test_memory_analytics_reports_categories_recency_importance_and_state():
    result = MemoryService(
        snapshot=_Snapshot(), backend=_MemoryBackend(), employee_reader=_Employees(),
    ).analytics(CTX)

    assert result["status"] == "available"
    assert result["total_memory_count"] == 2
    first = next(item for item in result["employees"] if item["employee_id"] == "e1")
    assert first["category_counts"] == {"preference": 1}
    assert first["state_counts"] == {"valid": 1}
    assert first["latest_created_at"] == "2026-08-25T00:00:00Z"
    assert first["latest_used_at"] == "2026-08-26T00:00:00Z"
    assert first["average_importance"] == pytest.approx(0.8)


class _UnavailableBackend(_MemoryBackend):
    def list(self, *args, **kwargs):
        raise HindsightUnavailable("upstream unavailable")


def test_memory_analytics_gracefully_reports_hindsight_outage():
    result = MemoryService(
        snapshot=_Snapshot(), backend=_UnavailableBackend(), employee_reader=_Employees(),
    ).analytics(CTX)

    assert result["status"] == "unavailable"
    assert result["employees"] == []
    assert result["unavailable_employee_count"] == 2


def test_memory_analytics_route_is_authenticated_and_returns_a_safe_list_envelope():
    from manager_service.routes_memory_items import build_memory_items_router

    verifier, signer = make_inmem_verifier_and_signer()
    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://fake/fake"), APIRouter())
    app.state._memory_service = SimpleNamespace(analytics=lambda ctx: {
        "status": "unavailable", "employee_count": 0, "total_memory_count": 0,
        "refreshed_at": datetime.now(timezone.utc), "employees": [],
        "unavailable_employee_count": 0,
    })
    app.include_router(build_memory_items_router(verifier))
    client = TestClient(app)

    assert client.get("/api/manager/memories/analytics").status_code == 401
    token = sign_inmem_token(signer, "tenant-a", ["owner"], user_id="member-a")
    response = client.get(
        "/api/manager/memories/analytics",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert response.json()["data"][0]["status"] == "unavailable"
    assert "token" not in response.text
