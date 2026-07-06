"""知识库摄入流程测试 (AITEAM-260)。覆盖：状态机、docx/html 解析、URL 导入、重试、路由端点。"""

import io
import tempfile
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent_service.grants.store import InMemoryProjectionRepository
from agent_service.workspace.routes import build_workspace_router
from agent_service.workspace.service import WorkspaceService
from tests.agent.workspace._stub_provider import StubMarketplaceProvider

from agent_service.workspace.store import (
    DOCUMENT_STATUSES,
    INGESTION_STATUSES,
    KnowledgeDocument,
    KnowledgeIngestionJob,
    InMemoryKnowledgeBaseRepository,
    InMemoryKnowledgeDocumentRepository,
    InMemoryKnowledgeIngestionRepository,
    InMemoryUploadAssetRepository,
    InMemoryWorkbenchStateRepository,
)


def _make_service(*, upload_dir=None):
    return WorkspaceService(
        projections=InMemoryProjectionRepository(),
        workbench_store=InMemoryWorkbenchStateRepository(),
        kb_store=InMemoryKnowledgeBaseRepository(),
        doc_store=InMemoryKnowledgeDocumentRepository(),
        ingest_store=InMemoryKnowledgeIngestionRepository(),
        upload_store=InMemoryUploadAssetRepository(),
        upload_dir=upload_dir,
        marketplace_provider=StubMarketplaceProvider(),
    )


def _make_docx_bytes(text="段落一内容"):
    """构造一个最小 .docx 字节（仅用于测试）。"""
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '</Types>',
        )
        zf.writestr("word/document.xml", document_xml)
        zf.writestr(
            "word/_rels/document.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        )
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/></Relationships>',
        )
    return buf.getvalue()


class TestDocumentStatusMachine:
    def test_initial_status(self):
        d = KnowledgeDocument(doc_id="d1", kb_id="kb1", title="t1")
        assert d.status == "uploaded"
        assert d.ingestion_job_id is None
        assert d.rag_document_id == ""

    def test_state_machine_happy(self):
        d = KnowledgeDocument(doc_id="d1", kb_id="kb1", title="t1")
        d.start_ingesting("job-1")
        assert d.status == "ingesting"
        assert d.ingestion_job_id == "job-1"
        d.mark_ready(rag_document_id="rag-1", chunk_count=3)
        assert d.status == "ready"
        assert d.rag_document_id == "rag-1"
        assert d.chunk_count == 3

    def test_error_transitions(self):
        d = KnowledgeDocument(doc_id="d1", kb_id="kb1", title="t1")
        d.start_ingesting("job-1")
        d.mark_error("bad", "nope")
        assert d.status == "error"
        d.reset_for_retry()
        assert d.status == "uploaded"
        assert d.ingestion_job_id is None
        d.start_ingesting("job-2")
        d.mark_ready(rag_document_id="rag-2", chunk_count=1)
        assert d.status == "ready"

    def test_invalid_transitions_raise(self):
        d = KnowledgeDocument(doc_id="d1", kb_id="kb1", title="t1")
        with pytest.raises(ValueError):
            d.mark_ready(rag_document_id="x")          # not ingesting yet
        with pytest.raises(ValueError):
            d.mark_error("x", "y")                    # not ingesting yet
        d.start_ingesting("job-1")
        with pytest.raises(ValueError):
            d.reset_for_retry()                          # not error yet
        with pytest.raises(ValueError):
            d.start_ingesting("job-z")                  # must mark_error first


class TestIngestionJobMachine:
    def test_happy_lifecycle(self):
        j = KnowledgeIngestionJob(job_id="j1", kb_id="kb1", document_id="d1")
        assert j.status == "pending"
        j.start()
        assert j.status == "parsing"
        assert j.started_at
        j.start_inserting()
        assert j.status == "inserting"
        j.complete(rag_document_id="r1", chunk_count=5)
        assert j.status == "completed"
        assert j.chunk_count == 5
        assert j.completed_at

    def test_failure_lifecycle(self):
        j = KnowledgeIngestionJob(job_id="j1", kb_id="kb1", document_id="d1")
        j.start()
        j.fail("boom")
        assert j.status == "failed"
        assert j.error_message == "boom"

    def test_terminal_no_completion(self):
        j = KnowledgeIngestionJob(job_id="j1", kb_id="kb1", document_id="d1")
        with pytest.raises(ValueError):
            j.complete(rag_document_id="x")


class TestWorkspaceServiceIngestion:
    def test_upload_text_document_ingests_to_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            doc = svc.upload_document(kb_id, "note.txt", b"hello world", "text/plain")
            assert doc.status == "ready"
            assert doc.rag_document_id.startswith("rag-")
            assert doc.chunk_count >= 1
            assert doc.snippet

    def test_upload_docx_document_parses_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            doc = svc.upload_document(
                kb_id, "sample.docx", _make_docx_bytes("段落一内容"),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            assert doc.status == "ready"
            assert "段落一内容" in doc.snippet

    def test_retry_error_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            doc = svc.upload_document(kb_id, "empty.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")
            assert doc.status == "error"
            # 替换为良好内容并修改 title/file_path 扩展名为 .txt → 第二次 ingestion 走文本分支
            new_path = Path(doc.file_path).with_suffix(".txt")
            new_path.write_bytes(b"hello retry world " * 40)
            d2 = svc.get_document(doc.doc_id)
            assert d2 is not None
            d2.file_path = str(new_path)
            d2.title = "retry.txt"
            svc._docs.update(d2)
            retried = svc.retry_document(doc.doc_id)
            assert retried is not None
            assert retried.status == "ready"

    def test_retry_returns_none_for_missing(self):
        svc = _make_service()
        assert svc.retry_document("missing") is None

    def test_list_documents(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            svc.upload_document(kb_id, "a.txt", b"AAA")
            svc.upload_document(kb_id, "b.txt", b"BBB")
            assert len(svc.list_documents(kb_id)) == 2

    def test_list_ingestions(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            doc = svc.upload_document(kb_id, "x.txt", b"content")
            jobs = svc.list_ingestions(kb_id)
            assert len(jobs) == 1
            assert jobs[0].document_id == doc.doc_id
            assert jobs[0].status == "completed"

    def test_pdf_without_parser_marks_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            doc = svc.upload_document(kb_id, "bad.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")
            assert doc.status == "error"

    def test_import_url_http_failure_marks_error(self, monkeypatch):
        """模拟 HTTP 失败 → 应标 error 而不是 500。"""
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id

            class _Resp:
                status_code = 500
                content = b""
                headers = {}

                def raise_for_status(self):
                    from httpx import HTTPStatusError
                    raise HTTPStatusError("boom", request=None, response=self)

            class _Cl:
                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

                def get(self, url):
                    return _Resp()

            class _Cli:
                def __init__(self, *a, **k):
                    pass

                def __enter__(self):
                    return _Cl()

                def __exit__(self, *a):
                    return False

            monkeypatch.setattr("agent_service.workspace.service._httpx.Client", _Cli)
            doc = svc.import_url(kb_id, "https://example.com/page")
            assert doc.status == "error"
            assert doc.source_kind == "url"
            assert doc.source_url == "https://example.com/page"

    def test_import_url_ok_ingests_to_ready(self, monkeypatch):
        """模拟 200 + HTML → 应 ingestion 完成并标 ready。"""
        html = b"<html><title>T</title><body><p>hello world body</p></body></html>"
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id

            class _Resp:
                status_code = 200
                content = html
                headers = {"content_type": "text/html"}

                def raise_for_status(self):
                    return None

            class _Cli:
                def __init__(self, *a, **k):
                    pass

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

                def get(self, url):
                    return _Resp()

            monkeypatch.setattr("agent_service.workspace.service._httpx.Client", _Cli)
            doc = svc.import_url(kb_id, "https://example.com/article")
            assert doc.status == "ready"
            assert doc.source_kind == "url"
            assert doc.source_url == "https://example.com/article"


class TestInMemoryIngestionRepo:
    def test_create_and_get(self):
        repo = InMemoryKnowledgeIngestionRepository()
        j = KnowledgeIngestionJob(job_id="j1", kb_id="kb1", document_id="d1")
        repo.create(j)
        got = repo.get("j1")
        assert got is not None
        assert got.job_id == "j1"

    def test_update(self):
        repo = InMemoryKnowledgeIngestionRepository()
        j = KnowledgeIngestionJob(job_id="j1", kb_id="kb1", document_id="d1")
        repo.create(j)
        j.start()
        repo.update(j)
        assert repo.get("j1").status == "parsing"

    def test_list_by_kb(self):
        repo = InMemoryKnowledgeIngestionRepository()
        repo.create(KnowledgeIngestionJob(job_id="j1", kb_id="kb1", document_id="d1"))
        repo.create(KnowledgeIngestionJob(job_id="j2", kb_id="kb2", document_id="d2"))
        assert len(repo.list_by_kb("kb1")) == 1
        assert len(repo.list_by_kb("kb2")) == 1


class TestRouteEndToEnd:
    def test_list_documents_endpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            svc.upload_document(kb_id, "a.txt", b"hello")
            app = FastAPI()
            app.include_router(build_workspace_router(svc))
            c = TestClient(app)
            r = c.get(f"/api/agent/knowledge-bases/{kb_id}/documents")
            assert r.status_code == 200, r.text
            body = r.json()
            assert len(body["data"]) == 1
            assert body["data"][0]["status"] == "ready"
            assert body["data"][0]["source_kind"] == "file"

    def test_list_ingestions_endpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            svc.upload_document(kb_id, "a.txt", b"hello")
            app = FastAPI()
            app.include_router(build_workspace_router(svc))
            c = TestClient(app)
            r = c.get(f"/api/agent/knowledge-bases/{kb_id}/ingestions")
            assert r.status_code == 200, r.text
            body = r.json()
            assert len(body["data"]) == 1
            assert body["data"][0]["status"] == "completed"

    def test_retry_endpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            doc = svc.upload_document(kb_id, "empty.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")
            assert doc.status == "error"
            new_path = Path(doc.file_path).with_suffix(".txt")
            new_path.write_bytes(b"good content " * 40)
            d2 = svc.get_document(doc.doc_id)
            d2.file_path = str(new_path)
            d2.title = "retry.txt"
            svc._docs.update(d2)
            renamed = Path(doc.file_path).with_suffix(".txt")
            Path(doc.file_path).rename(renamed)
            d2 = svc.get_document(doc.doc_id)
            d2.file_path = str(renamed)
            svc._docs.update(d2)

            app = FastAPI()
            app.include_router(build_workspace_router(svc))
            c = TestClient(app)
            r = c.post(f"/api/agent/knowledge-bases/{kb_id}/documents/{doc.doc_id}/retry")
            assert r.status_code == 200, r.text
            assert r.json()["data"]["status"] == "ready"

    def test_import_url_endpoint(self, monkeypatch):
        html = b"<html><title>T</title><body><p>ok body</p></body></html>"
        with tempfile.TemporaryDirectory() as tmp:
            svc = _make_service(upload_dir=tmp)
            kb_id = svc.create_knowledge_base(name="KB").kb_id

            class _Resp:
                status_code = 200
                content = html
                headers = {"content_type": "text/html"}

                def raise_for_status(self):
                    return None

            class _Cli:
                def __init__(self, *a, **k):
                    pass

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

                def get(self, url):
                    return _Resp()

            monkeypatch.setattr("agent_service.workspace.service._httpx.Client", _Cli)
            app = FastAPI()
            app.include_router(build_workspace_router(svc))
            c = TestClient(app)
            r = c.post(
                f"/api/agent/knowledge-bases/{kb_id}/documents/url",
                json={"url": "https://example.com/foo"},
            )
            assert r.status_code == 200, r.text
            body = r.json()["data"]
            assert body["source_kind"] == "url"
            assert body["source_url"] == "https://example.com/foo"
            assert body["status"] == "ready"


def test_status_constants():
    assert DOCUMENT_STATUSES == ("uploaded", "ingesting", "ready", "error")
    assert INGESTION_STATUSES == ("pending", "parsing", "inserting", "completed", "failed")
