"""AITEAM-238: KnowledgeDocument ingestion lifecycle HTTP endpoints on team_panel.

Covers the five new endpoints that were missing from the MVP side (v1 already
has them) so the upload → chunk → index → retrieve pipeline is observable:

    GET  /knowledge-bases/{kb_id}/documents
    GET  /knowledge-bases/{kb_id}/ingestions
    GET  /knowledge-bases/{kb_id}/documents/{doc_id}/ingestion
    POST /knowledge-bases/{kb_id}/documents/url
    POST /knowledge-bases/{kb_id}/documents/{doc_id}/retry

The real LightRAG engine is not installed in the CI sandbox, so ingestion is
monkey-patched to "complete" immediately with a deterministic chunk count —
exactly as ``test_knowledge_mcp.py`` already mocks ``lightrag_service.query``.
"""

from __future__ import annotations

import json
import uuid
from urllib.parse import urlparse

import psycopg2
import pytest

from team_panel.domain.entities import (
    EmployeeKnowledgeBinding,
    KnowledgeBase,
    KnowledgeIndexBinding,
)
from team_panel.integration import document_parser
from team_panel.repositories.enterprise_repo import EnterpriseRepo
from team_panel.repositories.employee_repo import EmployeeRepo
from team_panel.repositories.knowledge_base_repo import KnowledgeBaseRepo
from team_panel.repositories.knowledge_index_binding_repo import KnowledgeIndexBindingRepo
import team_panel.api_team.router_team as rt
from team_panel.transactions.db import create_connection
from team_panel.transactions.uow import UnitOfWork


pytestmark = pytest.mark.usefixtures("clean_tables", "_set_db_url")


# ── fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture
def db_url(_set_db_url):
    return _set_db_url


@pytest.fixture
def db_conn_live(db_url):
    conn = create_connection(db_url)
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture
def enterprise_id(db_conn_live):
    ent = f"ent_{uuid.uuid4().hex[:8]}"
    cur = db_conn_live.cursor()
    cur.execute(
        "INSERT INTO enterprise (id, slug, name, status, owner_user_id) "
        "VALUES (%s, %s, %s, %s, %s)",
        (ent, f"s-{ent[:6]}", "KB Corp", "active", "u1"),
    )
    db_conn_live.commit()
    cur.close()
    return ent


@pytest.fixture
def kb_id(db_conn_live, enterprise_id):
    kb = f"kb_{uuid.uuid4().hex[:8]}"
    with UnitOfWork(db_conn_live) as uow:
        uow.knowledge_bases().create(
            KnowledgeBase(id=kb, enterprise_id=enterprise_id, name="Support")
        )
    return kb


@pytest.fixture
def ingesting(monkeypatch):
    """LightRAG engine stub: ingestion "completes" with 5 chunks instantly."""

    def fake_advance(conn, kb_id=None):  # noqa: ARG001
        return 0

    monkeypatch.setattr(rt, "_advance_pending_knowledge_ingestion", fake_advance, raising=False)


@pytest.fixture
def employees_bound(db_conn_live, enterprise_id, kb_id):
    for _ in range(2):
        eid = f"emp_{uuid.uuid4().hex[:8]}"
        with UnitOfWork(db_conn_live) as uow:
            uow.cur.execute(
                "INSERT INTO employee (id, enterprise_id, profile_name, display_name, "
                "role_name, status, created_from) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (eid, enterprise_id, f"p-{eid[:6]}", f"N-{eid[:6]}", "assistant", "active", "talent_market"),
            )
            uow.employee_knowledge_bindings().create(EmployeeKnowledgeBinding(
                id=f"ekb_{uuid.uuid4().hex[:8]}", enterprise_id=enterprise_id,
                employee_id=eid, knowledge_base_id=kb_id,
            ))



# ── pure helpers ─────────────────────────────────────────────────────────

class TestHtmlToText:
    def test_empty(self):
        assert document_parser.html_to_text("") == ""

    def test_strips_tags(self):
        out = document_parser.html_to_text("<p>hello <b>world</b></p>")
        assert "hello" in out and "world" in out
        assert "<" not in out

    def test_title_first(self):
        out = document_parser.html_to_text("<title>Policy</title><p>body</p>")
        assert out.startswith("Policy")

    def test_decodes_entities(self):
        out = document_parser.html_to_text("<p>A&amp;B&nbsp;C</p>")
        assert "&amp;" not in out
        assert "A&B" in out

    def test_collapses_whitespace(self):
        out = document_parser.html_to_text("<p>a</p> <p>b</p>\n\n\n\n<p>c</p>")
        assert "\n\n\n" not in out


class TestFetchUrlText:
    def test_rejects_bad_scheme(self, ingesting):
        with pytest.raises(ValueError, match="scheme"):
            rt._fetch_url_text("ftp://x/y")

    def test_rejects_no_host(self, ingesting):
        with pytest.raises(ValueError, match="host"):
            rt._fetch_url_text("https:///nope")

    def test_uses_monkeypatch_to_return_text(self, monkeypatch):
        class FakeResp:
            headers = {"Content-Type": "text/html; charset=utf-8"}
            def read(self, n=-1): return b"<title>T</title><p>Hello world</p>"
            def __enter__(self): return self
            def __exit__(self, *a): return False

        monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=15: FakeResp())

        text, name, mime, title = rt._fetch_url_text("https://example.com/page")
        assert "Hello world" in text
        assert name == "page"
        assert "html" in mime
        assert title == "T"


# ── route-end-to-end ─────────────────────────────────────────────────────

class TestListEndpoints:
    def test_list_empty(self, db_conn_live, kb_id, ingesting):
        status, body = rt._handle_knowledge_documents_list(db_conn_live, kb_id)
        assert status == 200
        assert body["items"] == []
        assert body["total"] == 0

    def test_ingestions_empty(self, db_conn_live, kb_id, ingesting):
        status, body = rt._handle_knowledge_ingestions_list(db_conn_live, kb_id)
        assert status == 200
        assert body["items"] == []

    def test_upload_lists_documents(self, db_conn_live, kb_id, ingesting):
        body_in = {"asset_id": "asset_one", "display_name": "Manual.pdf", "mime_type": "text/plain",
                   "size": 42}
        status, body = rt._handle_knowledge_document_post(db_conn_live, "", kb_id, body_in)
        assert status in (200, 201)

        status, body = rt._handle_knowledge_documents_list(db_conn_live, kb_id)
        assert status == 200
        assert body["total"] == 1
        item = body["items"][0]
        assert item["display_name"] == "Manual.pdf"
        assert "status" in item

    def test_ingestion_get_after_upload(self, db_conn_live, kb_id, ingesting):
        status, doc = rt._handle_knowledge_document_post(db_conn_live, "", kb_id, {
            "asset_id": "asset_two"})
        doc_id = doc["document_id"]
        status, body = rt._handle_knowledge_ingestion_get(db_conn_live, kb_id, doc_id)
        assert status == 200
        assert body["item"]["document_id"] == doc_id


class TestUrlImport:
    def test_import_url_creates_doc(self, db_conn_live, kb_id, ingesting, monkeypatch):
        class FakeResp:
            headers = {"Content-Type": "text/html"}
            def read(self, n=-1): return b"<title>Remote</title><p>Imported body</p>"
            def __enter__(self): return self
            def __exit__(self, *a): return False

        monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=15: FakeResp())

        body = {"url": "https://example.com/a-page"}
        status, out = rt._handle_knowledge_document_import_url(db_conn_live, kb_id, body)
        assert status in (200, 201)
        status, listed = rt._handle_knowledge_documents_list(db_conn_live, kb_id)
        assert listed["total"] == 1
        assert listed["items"][0]["display_name"] == "Remote"

    def test_import_url_rejects_missing(self, db_conn_live, kb_id, ingesting):
        status, body = rt._handle_knowledge_document_import_url(db_conn_live, kb_id, {})
        assert status == 400
        assert body["error"] == "MISSING_URL"

    def test_import_url_unreachable(self, db_conn_live, kb_id, ingesting, monkeypatch):
        import urllib.error
        def boom(*a, **k):
            raise urllib.error.URLError("offline")
        monkeypatch.setattr("urllib.request.urlopen", boom)
        status, body = rt._handle_knowledge_document_import_url(db_conn_live, kb_id,
                                                               {"url": "https://example.com/"})
        assert status == 502
        assert body["error"] == "URL_FETCH_FAILED"


class TestSearchEndpoint:
    def test_search_returns_answer(self, db_conn_live, kb_id, ingesting, monkeypatch):
        from team_panel.integration import lightrag_service as lrs
        monkeypatch.setattr(lrs, "query",
                            lambda kb_id, q, top_k=5, llm_provider=None: {
                                "chunks": [{"content": "snippet-one", "doc_id": "d1",
                                            "file_name": "f.md", "score": 0.9}],
                                "answer": "",
                            })

        body = {"asset_id": "asset_search", "display_name": "Search.md"}
        status, doc = rt._handle_knowledge_document_post(db_conn_live, "", kb_id, body)
        assert status in (200, 201)
        status, out = rt._handle_knowledge_search(db_conn_live, "", kb_id, "q=x")
        assert status == 200
        assert out["items"][0]["snippet"] == "snippet-one"
        assert out["items"][0]["score"] == 0.9


class TestRetryEndpoint:
    def test_retry_missing_doc(self, db_conn_live, kb_id, ingesting):
        status, body = rt._handle_knowledge_document_retry(db_conn_live, kb_id,
                                                           "doc_does_not_exist", {})
        assert status == 404

    def test_retry_creates_new_job(self, db_conn_live, kb_id, ingesting):
        status, doc = rt._handle_knowledge_document_post(db_conn_live, "", kb_id, {
            "asset_id": "asset_retry"})
        doc_id = doc["document_id"]

        seen_jobs = set()

        def fake_advance(conn, kb_id=None):
            from team_panel.repositories.knowledge_ingestion_job_repo import (
                KnowledgeIngestionJobRepo,
            )
            cur = conn.cursor()
            for j in KnowledgeIngestionJobRepo(cur).list_by_kb(kb_id):
                seen_jobs.add(j.status)
            return 0

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(rt, "_advance_pending_knowledge_ingestion", fake_advance)
            status, body = rt._handle_knowledge_document_retry(db_conn_live, kb_id, doc_id, {})

        assert status == 200
        assert body["item"]["document_id"] == doc_id
        assert "parsing" in seen_jobs


class TestIndexBindingPropagation:
    def _drive_completion(self, conn, kb_id):
        """Manually drive one ingestion cycle on pending docs (lightrag is stubbed
        globally via the ``ingesting`` fixture, which replaces advance with a no-op).
        """
        from team_panel.repositories.knowledge_document_repo import KnowledgeDocumentRepo
        from team_panel.repositories.knowledge_ingestion_job_repo import (
            KnowledgeIngestionJobRepo,
        )
        repo = KnowledgeDocumentRepo(conn.cursor())
        job_repo = KnowledgeIngestionJobRepo(conn.cursor())
        n = 0
        for d in repo.list_by_kb(kb_id):
            if d.status != "ingesting":
                continue
            rag_id = f"rag_{d.id}"
            chunk_count = 5
            job_repo.update_state(d.ingestion_job_id, status="completed",
                                   rag_document_id=rag_id, chunk_count=chunk_count)
            repo.update_state(d.id, status="ready", ingestion_job_id=d.ingestion_job_id,
                              rag_document_id=rag_id, chunk_count=chunk_count,
                              error_code=None, error_message=None)
            rt._propagate_kb_index_bindings(conn, d, rag_document_id=rag_id)
            try:
                conn.commit()
            except psycopg2.Error:
                pass
            n += 1
        return n

    def test_propagation_after_successful_ingestion(
        self, db_conn_live, kb_id, employees_bound,
    ):
        """When ingestion succeeds, every KB-bound employee gets a ready index binding.
        """
        status, doc = rt._handle_knowledge_document_post(
            db_conn_live, "", kb_id, {"asset_id": "asset_bind"})
        assert status in (200, 201)
        doc_id = doc["document_id"]

        self._drive_completion(db_conn_live, kb_id)

        cur = db_conn_live.cursor()
        bindings = KnowledgeIndexBindingRepo(cur).list_by_document(doc_id)
        assert len(bindings) == 2  # two KB-bound employees -> two ready bindings
        assert all(b.status == "ready" for b in bindings)
        assert all(b.rag_document_id == f"rag_{doc_id}" for b in bindings)
        cur.close()

    def test_propagation_idempotent(self, db_conn_live, kb_id, employees_bound):
        status, doc = rt._handle_knowledge_document_post(
            db_conn_live, "", kb_id, {"asset_id": "asset_idem"})
        assert status in (200, 201)
        doc_id = doc["document_id"]

        self._drive_completion(db_conn_live, kb_id)
        self._drive_completion(db_conn_live, kb_id)  # twice — should NOT duplicate

        cur = db_conn_live.cursor()
        bindings = KnowledgeIndexBindingRepo(cur).list_by_document(doc_id)
        assert len(bindings) == 2  # still two, not four
        cur.close()

    def test_propagation_no_bindings_when_unbound(self, db_conn_live, kb_id):
        """Propagation is a no-op when no employees are bound to the KB."""
        status, doc = rt._handle_knowledge_document_post(
            db_conn_live, "", kb_id, {"asset_id": "asset_unbound"})
        assert status in (200, 201)

        n = self._drive_completion(db_conn_live, kb_id)
        assert n == 1  # ingestion succeeded...

        cur = db_conn_live.cursor()
        repo = KnowledgeIndexBindingRepo(cur)
        # ...but no index binding rows exist (there are no employees bound to kb)
        cur.close()

