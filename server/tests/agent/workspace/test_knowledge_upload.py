"""知识库 + 文件上传测试（#267）。"""

from __future__ import annotations
import tempfile
from pathlib import Path

from agent_service.grants.store import InMemoryProjectionRepository
from agent_service.workspace.store import (
    InMemoryKnowledgeBaseRepository,
    InMemoryKnowledgeDocumentRepository,
    InMemoryUploadAssetRepository,
    InMemoryWorkbenchStateRepository,
)
from agent_service.workspace.service import WorkspaceService


def _make_service(*, upload_dir: str | None = None):
    proj = InMemoryProjectionRepository()
    wb = InMemoryWorkbenchStateRepository()
    kb = InMemoryKnowledgeBaseRepository()
    docs = InMemoryKnowledgeDocumentRepository()
    uploads = InMemoryUploadAssetRepository()
    svc = WorkspaceService(
        projections=proj, workbench_store=wb,
        kb_store=kb, doc_store=docs, upload_store=uploads,
        upload_dir=upload_dir,
    )
    return svc, kb, docs, uploads


class TestKnowledgeBase:
    def test_create_knowledge_base(self):
        svc, kb, _, _ = _make_service()
        created = svc.create_knowledge_base(name="我的知识库", description="测试用")
        assert created.kb_id
        assert created.name == "我的知识库"
        assert created.description == "测试用"
        # Verify persisted
        stored = kb.get(created.kb_id)
        assert stored is not None
        assert stored.name == "我的知识库"

    def test_list_knowledge_bases(self):
        svc, _, _, _ = _make_service()
        svc.create_knowledge_base(name="KB1")
        svc.create_knowledge_base(name="KB2")
        kbs = svc.list_knowledge_bases()
        assert len(kbs) == 2

    def test_search_knowledge_documents(self):
        svc, kb, docs, _ = _make_service()
        kb_id = svc.create_knowledge_base(name="KB").kb_id
        svc._docs.create(
            type("Doc", (), {"doc_id": "d1", "kb_id": kb_id, "title": "Python入门",
             "snippet": "Python基础教程", "file_path": "", "content_type": "text/plain",
             "size": 100, "created_at": ""})()
        )
        # Use the service's search method directly
        from agent_service.workspace.store import KnowledgeDocument
        docs.create(KnowledgeDocument(
            doc_id="d1", kb_id=kb_id, title="Python入门",
            snippet="Python基础教程", size=100,
        ))
        docs.create(KnowledgeDocument(
            doc_id="d2", kb_id=kb_id, title="Java进阶",
            snippet="Java高级编程", size=200,
        ))
        results = svc.search_knowledge(kb_id, "Python", top_k=5)
        assert len(results) == 1
        assert results[0].title == "Python入门"

    def test_search_empty_kb_returns_empty(self):
        svc, _, _, _ = _make_service()
        kb_id = svc.create_knowledge_base(name="KB").kb_id
        results = svc.search_knowledge(kb_id, "nothing", top_k=5)
        assert results == []

    def test_upload_document_requires_upload_dir(self):
        svc, _, _, _ = _make_service(upload_dir=None)
        kb_id = svc.create_knowledge_base(name="KB").kb_id
        try:
            svc.upload_document(kb_id, "test.txt", b"hello")
            assert False, "should have raised"
        except RuntimeError as e:
            assert "upload_dir" in str(e)

    def test_upload_document_saves_file_and_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            svc, kb, docs, _ = _make_service(upload_dir=tmpdir)
            kb_id = svc.create_knowledge_base(name="KB").kb_id
            doc = svc.upload_document(kb_id, "readme.md", b"# Hello World", content_type="text/markdown")
            assert doc.doc_id
            assert doc.title == "readme.md"
            assert doc.size == 13
            assert doc.content_type == "text/markdown"
            # Verify file on disk
            filepath = Path(doc.file_path)
            assert filepath.exists()
            assert filepath.read_bytes() == b"# Hello World"

    def test_upload_document_updates_kb_stats(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            svc, kb, _, _ = _make_service(upload_dir=tmpdir)
            created = svc.create_knowledge_base(name="KB")
            svc.upload_document(created.kb_id, "a.txt", b"hello world")
            svc.upload_document(created.kb_id, "b.txt", b"bonjour")
            updated = kb.get(created.kb_id)
            assert updated is not None
            assert updated.doc_count == 2


class TestFileUpload:
    def test_upload_file_requires_upload_dir(self):
        svc, _, _, _ = _make_service(upload_dir=None)
        try:
            svc.upload_file("test.txt", b"data")
            assert False, "should have raised"
        except RuntimeError as e:
            assert "upload_dir" in str(e)

    def test_upload_file_saves_and_returns_asset(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            svc, _, _, uploads = _make_service(upload_dir=tmpdir)
            asset = svc.upload_file("image.png", b"\x89PNG", content_type="image/png")
            assert asset.asset_id
            assert asset.filename == "image.png"
            assert asset.size == 4
            assert asset.content_type == "image/png"
            # Verify on disk
            assert Path(asset.file_path).exists()
            assert Path(asset.file_path).read_bytes() == b"\x89PNG"

    def test_get_upload_returns_asset(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            svc, _, _, uploads = _make_service(upload_dir=tmpdir)
            created = svc.upload_file("doc.pdf", b"pdfdata")
            retrieved = svc.get_upload(created.asset_id)
            assert retrieved is not None
            assert retrieved.asset_id == created.asset_id
            assert retrieved.filename == "doc.pdf"

    def test_get_upload_missing_returns_none(self):
        svc, _, _, _ = _make_service()
        assert svc.get_upload("nonexistent") is None
