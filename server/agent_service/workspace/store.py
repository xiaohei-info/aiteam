"""workspace 本地仓储——工作台偏好 / 知识库 / 文档 / 摄入任务 / 上传资产。

全部为 Agent 本地数据面（SQLite），不跨端、不上传 Manager/Operator。
接口 + 内存 + SQLite 三层，对齐 grants/store.py 模式。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Sequence

from ..local_db import LocalDb


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- 数据对象 ----

DOCUMENT_STATUSES = ("uploaded", "ingesting", "ready", "error")
INGESTION_STATUSES = ("pending", "parsing", "inserting", "completed", "failed")


@dataclass
class WorkbenchState:
    employee_id: str
    is_starred: bool = False
    last_read_msg_id: str | None = None
    updated_at: str = ""


@dataclass
class KnowledgeBase:
    kb_id: str
    name: str
    description: str = ""
    doc_count: int = 0
    size_kb: int = 0
    source_type: str = "upload"
    sync_status: str = "idle"
    created_at: str = ""
    updated_at: str = ""


@dataclass
class KnowledgeDocument:
    doc_id: str
    kb_id: str
    title: str
    snippet: str = ""
    file_path: str = ""
    content_type: str = "text/plain"
    size: int = 0
    # ---- 摄入状态机 (AITEAM-260) ----
    status: str = "uploaded"           # uploaded | ingesting | ready | error
    ingestion_job_id: str | None = None
    rag_document_id: str = ""
    error_code: str | None = None
    error_message: str | None = None
    chunk_count: int = 0
    source_kind: str = "file"          # file | url
    source_url: str = ""
    created_at: str = ""
    updated_at: str = ""

    def start_ingesting(self, ingestion_job_id: str) -> None:
        if self.status not in ("uploaded", "error"):
            raise ValueError(f"Cannot start ingesting from {self.status}")
        self.status = "ingesting"
        self.ingestion_job_id = ingestion_job_id
        self.error_code = None
        self.error_message = None

    def mark_ready(self, *, rag_document_id: str = "", chunk_count: int = 0) -> None:
        if self.status != "ingesting":
            raise ValueError(f"Cannot mark ready from {self.status}")
        self.status = "ready"
        self.rag_document_id = rag_document_id
        self.chunk_count = chunk_count
        self.error_code = None
        self.error_message = None

    def mark_error(self, error_code: str, error_message: str) -> None:
        if self.status != "ingesting":
            raise ValueError(f"Cannot mark error from {self.status}")
        self.status = "error"
        self.error_code = error_code
        self.error_message = error_message

    def reset_for_retry(self) -> None:
        if self.status != "error":
            raise ValueError(f"Cannot reset retry from {self.status}")
        self.status = "uploaded"
        self.ingestion_job_id = None
        self.error_code = None
        self.error_message = None


@dataclass
class KnowledgeIngestionJob:
    """异步摄入跟踪：文档解析 + 写入本地 RAG (AITEAM-260)。"""
    job_id: str
    kb_id: str
    document_id: str
    status: str = "pending"            # pending | parsing | inserting | completed | failed
    rag_document_id: str = ""
    error_message: str | None = None
    chunk_count: int = 0
    started_at: str | None = None
    completed_at: str | None = None
    created_at: str = ""
    updated_at: str = ""

    def start(self) -> None:
        if self.status != "pending":
            raise ValueError(f"Cannot start from {self.status}")
        self.status = "parsing"
        self.started_at = _now()
        self.updated_at = self.started_at

    def start_inserting(self) -> None:
        if self.status != "parsing":
            raise ValueError(f"Cannot start inserting from {self.status}")
        self.status = "inserting"
        self.updated_at = _now()

    def complete(self, *, rag_document_id: str = "", chunk_count: int = 0) -> None:
        if self.status not in ("parsing", "inserting"):
            raise ValueError(f"Cannot complete from {self.status}")
        now = _now()
        self.status = "completed"
        self.rag_document_id = rag_document_id
        self.chunk_count = chunk_count
        self.completed_at = now
        self.updated_at = now

    def fail(self, error_message: str) -> None:
        if self.status not in ("pending", "parsing", "inserting"):
            raise ValueError(f"Cannot fail from {self.status}")
        now = _now()
        self.status = "failed"
        self.error_message = error_message
        self.completed_at = now
        self.updated_at = now


@dataclass
class UploadAsset:
    asset_id: str
    filename: str
    size: int = 0
    content_type: str = "application/octet-stream"
    file_path: str = ""
    created_at: str = ""


# ---- Repository 接口 ----

class WorkbenchStateRepository(ABC):
    @abstractmethod
    def upsert(self, state: WorkbenchState) -> WorkbenchState: ...
    @abstractmethod
    def get(self, employee_id: str) -> WorkbenchState | None: ...
    @abstractmethod
    def list_all(self) -> list[WorkbenchState]: ...


class KnowledgeBaseRepository(ABC):
    @abstractmethod
    def create(self, kb: KnowledgeBase) -> KnowledgeBase: ...
    @abstractmethod
    def get(self, kb_id: str) -> KnowledgeBase | None: ...
    @abstractmethod
    def list_all(self) -> list[KnowledgeBase]: ...
    @abstractmethod
    def update(self, kb: KnowledgeBase) -> KnowledgeBase: ...
    @abstractmethod
    def delete(self, kb_id: str) -> bool: ...


class KnowledgeDocumentRepository(ABC):
    @abstractmethod
    def create(self, doc: KnowledgeDocument) -> KnowledgeDocument: ...
    @abstractmethod
    def get(self, doc_id: str) -> KnowledgeDocument | None: ...
    @abstractmethod
    def update(self, doc: KnowledgeDocument) -> KnowledgeDocument: ...
    @abstractmethod
    def search(self, kb_id: str, q: str, top_k: int) -> list[KnowledgeDocument]: ...
    @abstractmethod
    def list_by_kb(self, kb_id: str) -> list[KnowledgeDocument]: ...


class KnowledgeIngestionRepository(ABC):
    @abstractmethod
    def create(self, job: KnowledgeIngestionJob) -> KnowledgeIngestionJob: ...
    @abstractmethod
    def get(self, job_id: str) -> KnowledgeIngestionJob | None: ...
    @abstractmethod
    def update(self, job: KnowledgeIngestionJob) -> KnowledgeIngestionJob: ...
    @abstractmethod
    def list_by_kb(self, kb_id: str) -> list[KnowledgeIngestionJob]: ...


class UploadAssetRepository(ABC):
    @abstractmethod
    def create(self, asset: UploadAsset) -> UploadAsset: ...
    @abstractmethod
    def get(self, asset_id: str) -> UploadAsset | None: ...
    @abstractmethod
    def list_all(self) -> list[UploadAsset]: ...


# ---- InMemory 实现 ----

class InMemoryWorkbenchStateRepository(WorkbenchStateRepository):
    def __init__(self) -> None:
        self._items: dict[str, WorkbenchState] = {}

    def upsert(self, state: WorkbenchState) -> WorkbenchState:
        state.updated_at = _now()
        self._items[state.employee_id] = state
        return state

    def get(self, employee_id: str) -> WorkbenchState | None:
        return self._items.get(employee_id)

    def list_all(self) -> list[WorkbenchState]:
        return sorted(self._items.values(), key=lambda s: s.employee_id)


class InMemoryKnowledgeBaseRepository(KnowledgeBaseRepository):
    def __init__(self) -> None:
        self._items: dict[str, KnowledgeBase] = {}

    def create(self, kb: KnowledgeBase) -> KnowledgeBase:
        kb.created_at = _now()
        kb.updated_at = _now()
        self._items[kb.kb_id] = kb
        return kb

    def get(self, kb_id: str) -> KnowledgeBase | None:
        return self._items.get(kb_id)

    def list_all(self) -> list[KnowledgeBase]:
        return sorted(self._items.values(), key=lambda k: k.name)

    def update(self, kb: KnowledgeBase) -> KnowledgeBase:
        kb.updated_at = _now()
        self._items[kb.kb_id] = kb
        return kb

    def delete(self, kb_id: str) -> bool:
        return self._items.pop(kb_id, None) is not None


class InMemoryKnowledgeDocumentRepository(KnowledgeDocumentRepository):
    def __init__(self) -> None:
        self._items: dict[str, KnowledgeDocument] = {}

    def create(self, doc: KnowledgeDocument) -> KnowledgeDocument:
        doc.created_at = _now()
        doc.updated_at = _now()
        self._items[doc.doc_id] = doc
        return doc

    def get(self, doc_id: str) -> KnowledgeDocument | None:
        return self._items.get(doc_id)

    def update(self, doc: KnowledgeDocument) -> KnowledgeDocument:
        doc.updated_at = _now()
        self._items[doc.doc_id] = doc
        return doc

    def search(self, kb_id: str, q: str, top_k: int) -> list[KnowledgeDocument]:
        qlower = q.lower()
        results = [
            d for d in self._items.values()
            if d.kb_id == kb_id and (qlower in d.title.lower() or qlower in d.snippet.lower())
        ]
        results.sort(key=lambda d: d.created_at, reverse=True)
        return results[:top_k]

    def list_by_kb(self, kb_id: str) -> list[KnowledgeDocument]:
        return sorted(
            (d for d in self._items.values() if d.kb_id == kb_id),
            key=lambda d: d.created_at, reverse=True,
        )


class InMemoryKnowledgeIngestionRepository(KnowledgeIngestionRepository):
    def __init__(self) -> None:
        self._items: dict[str, KnowledgeIngestionJob] = {}

    def create(self, job: KnowledgeIngestionJob) -> KnowledgeIngestionJob:
        now = _now()
        job.created_at = now
        job.updated_at = now
        self._items[job.job_id] = job
        return job

    def get(self, job_id: str) -> KnowledgeIngestionJob | None:
        return self._items.get(job_id)

    def update(self, job: KnowledgeIngestionJob) -> KnowledgeIngestionJob:
        job.updated_at = _now()
        self._items[job.job_id] = job
        return job

    def list_by_kb(self, kb_id: str) -> list[KnowledgeIngestionJob]:
        return sorted(
            (j for j in self._items.values() if j.kb_id == kb_id),
            key=lambda j: j.created_at, reverse=True,
        )


class InMemoryUploadAssetRepository(UploadAssetRepository):
    def __init__(self) -> None:
        self._items: dict[str, UploadAsset] = {}

    def create(self, asset: UploadAsset) -> UploadAsset:
        asset.created_at = _now()
        self._items[asset.asset_id] = asset
        return asset

    def get(self, asset_id: str) -> UploadAsset | None:
        return self._items.get(asset_id)

    def list_all(self) -> list[UploadAsset]:
        return sorted(self._items.values(), key=lambda a: a.created_at, reverse=True)


# ---- SQLite 实现 ----

class SqliteWorkbenchStateRepository(WorkbenchStateRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def upsert(self, state: WorkbenchState) -> WorkbenchState:
        now = _now()
        existing = self._db.query_one(
            "SELECT * FROM workbench_state WHERE employee_id = ?", (state.employee_id,)
        )
        if existing:
            self._db.execute(
                "UPDATE workbench_state SET is_starred = ?, last_read_msg_id = ?, updated_at = ? "
                "WHERE employee_id = ?",
                (int(state.is_starred), state.last_read_msg_id, now, state.employee_id),
            )
        else:
            self._db.execute(
                "INSERT INTO workbench_state (employee_id, is_starred, last_read_msg_id, updated_at) "
                "VALUES (?, ?, ?, ?)",
                (state.employee_id, int(state.is_starred), state.last_read_msg_id, now),
            )
        state.updated_at = now
        return state

    def get(self, employee_id: str) -> WorkbenchState | None:
        row = self._db.query_one("SELECT * FROM workbench_state WHERE employee_id = ?", (employee_id,))
        return self._row_to_state(row) if row else None

    def list_all(self) -> list[WorkbenchState]:
        rows = self._db.query("SELECT * FROM workbench_state ORDER BY employee_id")
        return [self._row_to_state(r) for r in rows]

    @staticmethod
    def _row_to_state(row) -> WorkbenchState:
        return WorkbenchState(
            employee_id=row["employee_id"],
            is_starred=bool(row["is_starred"]),
            last_read_msg_id=row["last_read_msg_id"],
            updated_at=row["updated_at"],
        )


class SqliteKnowledgeBaseRepository(KnowledgeBaseRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def create(self, kb: KnowledgeBase) -> KnowledgeBase:
        now = _now()
        self._db.execute(
            "INSERT INTO knowledge_bases (kb_id, name, description, doc_count, size_kb, "
            "source_type, sync_status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (kb.kb_id, kb.name, kb.description, kb.doc_count, kb.size_kb,
             kb.source_type, kb.sync_status, now, now),
        )
        kb.created_at = now
        kb.updated_at = now
        return kb

    def get(self, kb_id: str) -> KnowledgeBase | None:
        row = self._db.query_one("SELECT * FROM knowledge_bases WHERE kb_id = ?", (kb_id,))
        return self._row_to_kb(row) if row else None

    def list_all(self) -> list[KnowledgeBase]:
        rows = self._db.query("SELECT * FROM knowledge_bases ORDER BY name")
        return [self._row_to_kb(r) for r in rows]

    def update(self, kb: KnowledgeBase) -> KnowledgeBase:
        now = _now()
        self._db.execute(
            "UPDATE knowledge_bases SET name = ?, description = ?, doc_count = ?, size_kb = ?, "
            "source_type = ?, sync_status = ?, updated_at = ? WHERE kb_id = ?",
            (kb.name, kb.description, kb.doc_count, kb.size_kb,
             kb.source_type, kb.sync_status, now, kb.kb_id),
        )
        kb.updated_at = now
        return kb

    def delete(self, kb_id: str) -> bool:
        self._db.execute("DELETE FROM knowledge_bases WHERE kb_id = ?", (kb_id,))
        return True

    @staticmethod
    def _row_to_kb(row) -> KnowledgeBase:
        return KnowledgeBase(
            kb_id=row["kb_id"],
            name=row["name"],
            description=row["description"],
            doc_count=row["doc_count"],
            size_kb=row["size_kb"],
            source_type=row["source_type"],
            sync_status=row["sync_status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class SqliteKnowledgeDocumentRepository(KnowledgeDocumentRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def create(self, doc: KnowledgeDocument) -> KnowledgeDocument:
        now = _now()
        self._db.execute(
            "INSERT INTO knowledge_documents (doc_id, kb_id, title, snippet, file_path, "
            "content_type, size, status, ingestion_job_id, rag_document_id, error_code, "
            "error_message, chunk_count, source_kind, source_url, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (doc.doc_id, doc.kb_id, doc.title, doc.snippet, doc.file_path,
             doc.content_type, doc.size, doc.status, doc.ingestion_job_id,
             doc.rag_document_id, doc.error_code, doc.error_message, doc.chunk_count,
             doc.source_kind, doc.source_url, now, now),
        )
        doc.created_at = now
        doc.updated_at = now
        return doc

    def get(self, doc_id: str) -> KnowledgeDocument | None:
        row = self._db.query_one("SELECT * FROM knowledge_documents WHERE doc_id = ?", (doc_id,))
        return self._row_to_doc(row) if row else None

    def update(self, doc: KnowledgeDocument) -> KnowledgeDocument:
        now = _now()
        self._db.execute(
            "UPDATE knowledge_documents SET title = ?, snippet = ?, file_path = ?, "
            "content_type = ?, size = ?, status = ?, ingestion_job_id = ?, "
            "rag_document_id = ?, error_code = ?, error_message = ?, chunk_count = ?, "
            "source_kind = ?, source_url = ?, updated_at = ? WHERE doc_id = ?",
            (doc.title, doc.snippet, doc.file_path, doc.content_type, doc.size,
             doc.status, doc.ingestion_job_id, doc.rag_document_id,
             doc.error_code, doc.error_message, doc.chunk_count,
             doc.source_kind, doc.source_url, now, doc.doc_id),
        )
        doc.updated_at = now
        return doc

    def search(self, kb_id: str, q: str, top_k: int) -> list[KnowledgeDocument]:
        pattern = f"%{q}%"
        rows = self._db.query(
            "SELECT * FROM knowledge_documents WHERE kb_id = ? AND "
            "(title LIKE ? OR snippet LIKE ?) ORDER BY created_at DESC LIMIT ?",
            (kb_id, pattern, pattern, top_k),
        )
        return [self._row_to_doc(r) for r in rows]

    def list_by_kb(self, kb_id: str) -> list[KnowledgeDocument]:
        rows = self._db.query(
            "SELECT * FROM knowledge_documents WHERE kb_id = ? ORDER BY created_at DESC",
            (kb_id,),
        )
        return [self._row_to_doc(r) for r in rows]

    @staticmethod
    def _row_to_doc(row) -> KnowledgeDocument:
        return KnowledgeDocument(
            doc_id=row["doc_id"],
            kb_id=row["kb_id"],
            title=row["title"],
            snippet=row["snippet"] or "",
            file_path=row["file_path"] or "",
            content_type=row["content_type"] or "text/plain",
            size=row["size"] or 0,
            status=row["status"] or "uploaded",
            ingestion_job_id=row["ingestion_job_id"],
            rag_document_id=row["rag_document_id"] or "",
            error_code=row["error_code"],
            error_message=row["error_message"],
            chunk_count=row["chunk_count"] or 0,
            source_kind=row["source_kind"] or "file",
            source_url=row["source_url"] or "",
            created_at=row["created_at"],
            updated_at=row["updated_at"] or "",
        )


class SqliteKnowledgeIngestionRepository(KnowledgeIngestionRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def create(self, job: KnowledgeIngestionJob) -> KnowledgeIngestionJob:
        now = _now()
        self._db.execute(
            "INSERT INTO knowledge_ingestions (job_id, kb_id, document_id, status, "
            "rag_document_id, error_message, chunk_count, started_at, completed_at, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (job.job_id, job.kb_id, job.document_id, job.status,
             job.rag_document_id, job.error_message, job.chunk_count,
             job.started_at, job.completed_at, now, now),
        )
        job.created_at = now
        job.updated_at = now
        return job

    def get(self, job_id: str) -> KnowledgeIngestionJob | None:
        row = self._db.query_one("SELECT * FROM knowledge_ingestions WHERE job_id = ?", (job_id,))
        return self._row_to_job(row) if row else None

    def update(self, job: KnowledgeIngestionJob) -> KnowledgeIngestionJob:
        now = _now()
        self._db.execute(
            "UPDATE knowledge_ingestions SET status = ?, rag_document_id = ?, "
            "error_message = ?, chunk_count = ?, started_at = ?, completed_at = ?, "
            "updated_at = ? WHERE job_id = ?",
            (job.status, job.rag_document_id, job.error_message, job.chunk_count,
             job.started_at, job.completed_at, now, job.job_id),
        )
        job.updated_at = now
        return job

    def list_by_kb(self, kb_id: str) -> list[KnowledgeIngestionJob]:
        rows = self._db.query(
            "SELECT * FROM knowledge_ingestions WHERE kb_id = ? ORDER BY created_at DESC",
            (kb_id,),
        )
        return [self._row_to_job(r) for r in rows]

    @staticmethod
    def _row_to_job(row) -> KnowledgeIngestionJob:
        return KnowledgeIngestionJob(
            job_id=row["job_id"],
            kb_id=row["kb_id"],
            document_id=row["document_id"],
            status=row["status"] or "pending",
            rag_document_id=row["rag_document_id"] or "",
            error_message=row["error_message"],
            chunk_count=row["chunk_count"] or 0,
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"] or "",
        )


class SqliteUploadAssetRepository(UploadAssetRepository):
    def __init__(self, db: LocalDb) -> None:
        self._db = db

    def create(self, asset: UploadAsset) -> UploadAsset:
        now = _now()
        self._db.execute(
            "INSERT INTO upload_assets (asset_id, filename, size, content_type, file_path, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (asset.asset_id, asset.filename, asset.size, asset.content_type, asset.file_path, now),
        )
        asset.created_at = now
        return asset

    def get(self, asset_id: str) -> UploadAsset | None:
        row = self._db.query_one("SELECT * FROM upload_assets WHERE asset_id = ?", (asset_id,))
        return self._row_to_asset(row) if row else None

    def list_all(self) -> list[UploadAsset]:
        rows = self._db.query("SELECT * FROM upload_assets ORDER BY created_at DESC")
        return [self._row_to_asset(r) for r in rows]

    @staticmethod
    def _row_to_asset(row) -> UploadAsset:
        return UploadAsset(
            asset_id=row["asset_id"],
            filename=row["filename"],
            size=row["size"],
            content_type=row["content_type"],
            file_path=row["file_path"],
            created_at=row["created_at"],
        )
