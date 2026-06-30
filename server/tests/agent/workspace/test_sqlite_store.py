"""workspace SQLite store 集成测试（#267）。验证迁移 0003 表创建 + 读写。"""

import tempfile
from pathlib import Path

from agent_service.local_db import LocalDb, apply_migrations, connect
from agent_service.workspace.store import (
    KnowledgeBase,
    KnowledgeDocument,
    SqliteKnowledgeBaseRepository,
    SqliteKnowledgeDocumentRepository,
    SqliteUploadAssetRepository,
    SqliteWorkbenchStateRepository,
    UploadAsset,
    WorkbenchState,
)


def _make_db():
    d = tempfile.mkdtemp()
    db_path = str(Path(d) / "test.db")
    db = connect(db_path)
    apply_migrations(db)
    return db


class TestSqliteWorkbenchState:
    def test_upsert_and_get(self):
        db = _make_db()
        repo = SqliteWorkbenchStateRepository(db)
        repo.upsert(WorkbenchState(employee_id="emp-1", is_starred=True))
        row = repo.get("emp-1")
        assert row is not None
        assert row.is_starred is True

    def test_list_all(self):
        db = _make_db()
        repo = SqliteWorkbenchStateRepository(db)
        repo.upsert(WorkbenchState(employee_id="emp-1", is_starred=True))
        repo.upsert(WorkbenchState(employee_id="emp-2", is_starred=False))
        all_states = repo.list_all()
        assert len(all_states) == 2

    def test_update_existing(self):
        db = _make_db()
        repo = SqliteWorkbenchStateRepository(db)
        repo.upsert(WorkbenchState(employee_id="emp-1", is_starred=True))
        repo.upsert(WorkbenchState(employee_id="emp-1", is_starred=False))
        row = repo.get("emp-1")
        assert row is not None
        assert row.is_starred is False


class TestSqliteKnowledgeBase:
    def test_create_and_get(self):
        db = _make_db()
        repo = SqliteKnowledgeBaseRepository(db)
        kb = repo.create(KnowledgeBase(kb_id="kb-1", name="测试库"))
        assert kb.kb_id == "kb-1"
        stored = repo.get("kb-1")
        assert stored is not None
        assert stored.name == "测试库"

    def test_update_and_delete(self):
        db = _make_db()
        repo = SqliteKnowledgeBaseRepository(db)
        kb = repo.create(KnowledgeBase(kb_id="kb-1", name="旧名"))
        kb.name = "新名"
        repo.update(kb)
        stored = repo.get("kb-1")
        assert stored is not None
        assert stored.name == "新名"
        repo.delete("kb-1")
        assert repo.get("kb-1") is None


class TestSqliteKnowledgeDocument:
    def test_create_and_search(self):
        db = _make_db()
        kb_repo = SqliteKnowledgeBaseRepository(db)
        kb_repo.create(KnowledgeBase(kb_id="kb-1", name="KB"))
        repo = SqliteKnowledgeDocumentRepository(db)
        repo.create(KnowledgeDocument(doc_id="d1", kb_id="kb-1", title="Python入门", snippet="Python基础"))
        repo.create(KnowledgeDocument(doc_id="d2", kb_id="kb-1", title="Java进阶", snippet="Java高级"))
        results = repo.search("kb-1", "Python", 5)
        assert len(results) == 1
        assert results[0].doc_id == "d1"

    def test_list_by_kb(self):
        db = _make_db()
        kb_repo = SqliteKnowledgeBaseRepository(db)
        kb_repo.create(KnowledgeBase(kb_id="kb-1", name="KB"))
        repo = SqliteKnowledgeDocumentRepository(db)
        repo.create(KnowledgeDocument(doc_id="d1", kb_id="kb-1", title="Doc1"))
        repo.create(KnowledgeDocument(doc_id="d2", kb_id="kb-1", title="Doc2"))
        docs = repo.list_by_kb("kb-1")
        assert len(docs) == 2


class TestSqliteUploadAsset:
    def test_create_and_get(self):
        db = _make_db()
        repo = SqliteUploadAssetRepository(db)
        asset = repo.create(UploadAsset(asset_id="a1", filename="test.pdf", size=1024))
        stored = repo.get("a1")
        assert stored is not None
        assert stored.filename == "test.pdf"
        assert stored.size == 1024

    def test_list_all(self):
        db = _make_db()
        repo = SqliteUploadAssetRepository(db)
        repo.create(UploadAsset(asset_id="a1", filename="a.pdf"))
        repo.create(UploadAsset(asset_id="a2", filename="b.pdf"))
        assert len(repo.list_all()) == 2
