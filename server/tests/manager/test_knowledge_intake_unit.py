"""知识文档 intake 单元验收（issue #416；默认门必跑，不依赖 PG）。

验：
- document_parser：文本/docx/html_to_text 提取；未知格式按文本兜底；
  .doc 抛 UnsupportedFormatError；PDF 无 PyPDF2 时抛 UnsupportedFormatError。
- 路由契约：上传/URL 导入/retry/任务/绑定端点已注册；schema 约束。
- 服务层状态机主路径与失败路径：parsing → indexing → ready / failed。
- Index binding 传播：intake 完成后向 knowledge_space 已绑员工传播 ready 绑定。
- 鉴权：member 写 403；retry 在非终态 409；文档不在知识空间 404。
"""

from __future__ import annotations

import uuid
import threading
import copy
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from dataclasses import replace as _dc_replace

import pytest

from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, Forbidden, NotFound

from manager_service.document_parser import (
    UnsupportedFormatError,
    extract_text,
    html_to_text,
)
from manager_service.knowledge_intake_repository import (
    KnowledgeDocumentBindingRepository,
    KnowledgeDocumentRow,
    KnowledgeIngestionJobRow,
    KnowledgeOperationRow,
    KnowledgeReindexPreparation,
    KnowledgeReconciliationRequired,
)
from manager_service.knowledge_intake_service import KnowledgeIntakeService, RagDeletionBusy
from manager_service.employee_bindings_services import EmployeeKnowledgeBindingService
from manager_service.employee_bindings_repositories import KnowledgeBindingRow
from manager_service.rag_ingestion import RagDeletionResult, RagIngestionResult, RagIngestionUnavailable
from manager_service.schemas import (
    KnowledgeDocumentBindingOut,
    KnowledgeDocumentImportUrl,
)


# ─────────────────────────────── document_parser ───────────────────────────────


def _make_docx(text: str, path: Path) -> None:
    """构造最小有效 .docx（OOXML zip）。"""
    xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>" + text + "</w:t></w:r></w:p></w:body></w:document>"
    )
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("word/document.xml", xml)


def test_extract_text_plain(tmp_path: Path) -> None:
    p = tmp_path / "a.txt"
    p.write_text("hello world")
    assert extract_text(p) == "hello world"


def test_extract_text_docx(tmp_path: Path) -> None:
    p = tmp_path / "a.docx"
    _make_docx("one two three", p)
    assert extract_text(p) == "one two three"


def test_extract_text_doc_unsupported(tmp_path: Path) -> None:
    p = tmp_path / "a.doc"
    p.write_bytes(b"\x00\x01")
    with pytest.raises(UnsupportedFormatError):
        extract_text(p)


def test_extract_text_pdf_without_pypdf2(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """PDF 无 PyPDF2 时抛 UnsupportedFormatError，明确报错而非静默失败。"""
    p = tmp_path / "a.pdf"
    p.write_bytes(b"%PDF-1.4 fake")
    import builtins  # noqa: PLC0415

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "PyPDF2" or name == "PyPDF2.pager":
            raise ImportError("PyPDF2 not installed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(UnsupportedFormatError):
        extract_text(p)


def test_html_to_text_strips_tags() -> None:
    assert html_to_text("<p>Hello <b>world</b></p>") == "Hello world"


def test_html_to_text_extracts_title() -> None:
    out = html_to_text("<title>My Title</title><p>body</p>")
    assert out.startswith("My Title")
    assert "body" in out


# ─────────────────────────────── 内存伪 repository ───────────────────────────────


class _FakeDocRepo:
    def __init__(self):
        self._by_id: dict[str, KnowledgeDocumentRow] = {}
        self._by_space: dict[str, list[str]] = {}
        self.status_updates: list[tuple[str, str]] = []

    @classmethod
    def _row(cls, doc_id, ks, status="uploaded", **kw):
        return KnowledgeDocumentRow(
            id=doc_id, tenant_id="t", knowledge_space_id=ks,
            display_name=kw.get("display_name", "n"), source_type=kw.get("source_type", "file"),
            file_name=kw.get("file_name", "f.txt"), file_type=kw.get("file_type", "text/plain"),
            file_size=kw.get("file_size", 3), storage_key=kw.get("storage_key", "x/f.txt"),
            status=status, text_chars=kw.get("text_chars"), error_code=kw.get("error_code"),
            error_message=kw.get("error_message"), created_at=None, updated_at=None,
        )

    def create(self, ctx, *, knowledge_space_id, display_name, source_type, file_name,
               file_type, file_size, storage_key, status, create_job=False):
        rid = f"doc_{uuid.uuid4().hex[:8]}"
        row = self._row(rid, knowledge_space_id, status=status, display_name=display_name,
                        source_type=source_type, file_name=file_name, file_type=file_type,
                        file_size=file_size, storage_key=storage_key)
        with self._job_repo.lock if create_job else threading.RLock():
            before_id, before_space = copy.deepcopy((self._by_id, self._by_space))
            self._by_id[rid] = row
            self._by_space.setdefault(knowledge_space_id, []).append(rid)
            try:
                if create_job:
                    job = self._job_repo.create(ctx, knowledge_space_id=knowledge_space_id, document_id=rid, status="parsing")
                    return row, job
            except BaseException:
                self._by_id, self._by_space = before_id, before_space
                raise
        return row

    def get(self, ctx, *, document_id):
        return self._by_id.get(document_id)

    def list_by_space(self, ctx, *, knowledge_space_id):
        return [self._by_id[i] for i in self._by_space.get(knowledge_space_id, []) if i in self._by_id]

    def update_status(self, ctx, document_id, *, status, text_chars=None, error_code=None, error_message=None):
        row = self._by_id.get(document_id)
        if row is None:
            return False
        self._by_id[document_id] = KnowledgeDocumentRow(id=row.id, tenant_id=row.tenant_id, knowledge_space_id=row.knowledge_space_id,
                    display_name=row.display_name, source_type=row.source_type,
                    file_name=row.file_name, file_type=row.file_type, file_size=row.file_size,
                    storage_key=row.storage_key, status=status,
                    text_chars=text_chars if text_chars is not None else row.text_chars,
                    error_code=error_code, error_message=error_message,
                    created_at=row.created_at, updated_at=row.updated_at)
        self.status_updates.append((document_id, status))
        return True


class _FakeJobRepo:
    def __init__(self):
        self._by_id: dict[str, KnowledgeIngestionJobRow] = {}
        self._by_doc: dict[str, list[str]] = {}
        self._by_space: dict[str, list[str]] = {}
        self.done_count = 0
        self.lock = threading.RLock()

    @classmethod
    def _row(cls, jid, ks, doc_id, status="parsing"):
        return KnowledgeIngestionJobRow(
            id=jid, tenant_id="t", knowledge_space_id=ks, document_id=doc_id, status=status,
            error_code=None, error_message=None, chunk_count=None, started_at=None,
            completed_at=None, created_at=None,
        )

    def create(self, ctx, *, knowledge_space_id, document_id, status, started_at=None, operation_id=None):
        jid = f"ing_{uuid.uuid4().hex[:8]}"
        row = _dc_replace(self._row(jid, knowledge_space_id, document_id, status=status),
                          file_source=f"{document_id}/{jid}", operation_id=operation_id)
        self._by_id[jid] = row
        self._by_doc.setdefault(document_id, []).append(jid)
        self._by_space.setdefault(knowledge_space_id, []).append(jid)
        return row

    def get(self, ctx, *, ingestion_id):
        return self._by_id.get(ingestion_id)

    def get_latest_by_document(self, ctx, *, document_id):
        ids = self._by_doc.get(document_id, [])
        return self._by_id[ids[-1]] if ids else None

    def list_by_document(self, ctx, *, document_id):
        return [self._by_id[i] for i in self._by_doc.get(document_id, []) if i in self._by_id]

    def list_by_space(self, ctx, *, knowledge_space_id):
        return [self._by_id[i] for i in self._by_space.get(knowledge_space_id, []) if i in self._by_id]

    def _owned(self, job_id, owner):
        job = self._by_id[job_id]
        return job.claim_owner == owner and job.lease_until and job.lease_until > datetime.now(timezone.utc)

    def claim(self, ctx, *, owner, job_id=None):
        with self.lock:
            now = datetime.now(timezone.utc)
            for job in self._by_id.values():
                doc = self._doc_repo.get(ctx, document_id=job.document_id)
                if (job_id and job.id != job_id) or job.id != self._by_doc[job.document_id][-1] or doc.status not in {"uploaded", "parsing", "indexing", "reindex_requested", "failed"}:
                    continue
                if job.status in {"done", "failed"} and job.submission_state != "submitted":
                    continue
                if (job.lease_until and job.lease_until > now) or (job.next_attempt_at and job.next_attempt_at > now):
                    continue
                self._by_id[job.id] = _dc_replace(job, claim_owner=owner, lease_until=now+timedelta(seconds=90), heartbeat_at=now, attempts=job.attempts+1)
                return self._by_id[job.id]
        return None

    def fence_submission(self, ctx, job, *, owner, text_chars):
        with self.lock:
            current = self._by_id[job.id]
            if not self._owned(job.id, owner) or current.submission_state != "not_submitted":
                return False
            self._by_id[job.id] = _dc_replace(current, submission_state="submitted", status="indexing", text_chars=text_chars)
            self._doc_repo.update_status(ctx, job.document_id, status="indexing", text_chars=text_chars)
            return True

    def record_track(self, ctx, job, *, owner, track_id):
        with self.lock:
            if not self._owned(job.id, owner):
                return False
            self._by_id[job.id] = _dc_replace(self._by_id[job.id], track_id=track_id)
            return True

    def settle(self, ctx, job, *, owner, state, error_code=None, upstream_document_id=None):
        with self.lock:
            if not self._owned(job.id, owner):
                return False
            current = self._by_id[job.id]
            unknown = state == "unknown" and current.attempts >= 6
            status = "failed" if state == "failed" or unknown else "indexing"
            code = error_code or ("SUBMISSION_UNKNOWN" if unknown else None)
            self._by_id[job.id] = _dc_replace(current, status=status, error_code=code,
                submission_state="terminal" if state == "failed" else current.submission_state,
                upstream_document_id=upstream_document_id or current.upstream_document_id,
                next_attempt_at=datetime.now(timezone.utc)+timedelta(seconds=2), claim_owner=None, lease_until=None)
            self._doc_repo.update_status(ctx, job.document_id, status=status, error_code=code)
            if state == "failed" and current.operation_id:
                self._operation_repo.update(ctx, operation_id=current.operation_id, status="failed", error_code=code, completed=True)
            return True

    def prepare_reindex(self, ctx, *, document_id, knowledge_space_id, idempotency_key, request_fingerprint):
        with self.lock:
            operations = self._operation_repo
            existing = operations.get_by_key(ctx, operation="reindex", idempotency_key=idempotency_key)
            if existing is not None:
                if (existing.request_fingerprint != request_fingerprint or existing.document_id != document_id
                        or existing.knowledge_space_id != knowledge_space_id):
                    raise Conflict("idempotency key conflict")
                jobs = [job for job in self._by_id.values() if job.operation_id == existing.id]
                if len(jobs) > 1 or (jobs and (jobs[0].document_id != document_id or jobs[0].knowledge_space_id != knowledge_space_id)):
                    raise KnowledgeReconciliationRequired("ambiguous job association")
                return KnowledgeReindexPreparation(existing, jobs[0] if jobs else None, newly_created=False)
            before = copy.deepcopy((self._doc_repo._by_id, self._by_id, self._by_doc, self._by_space, operations.rows, operations.calls))
            try:
                operation = operations.create(ctx, operation="reindex", knowledge_space_id=knowledge_space_id,
                    document_id=document_id, idempotency_key=idempotency_key, request_fingerprint=request_fingerprint)
                doc = self._doc_repo.get(ctx, document_id=document_id)
                if doc.error_code == "SUBMISSION_UNKNOWN":
                    raise KnowledgeReconciliationRequired("unknown submission")
                if doc.status not in {"ready", "failed"}:
                    raise Conflict("document is not ready/failed")
                self._doc_repo.update_status(ctx, document_id, status="reindex_requested")
                job = self.create(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id,
                                  status="reindex_requested", operation_id=operation.id)
                return KnowledgeReindexPreparation(operation, job, newly_created=True)
            except BaseException:
                self._doc_repo._by_id, self._by_id, self._by_doc, self._by_space, operations.rows, operations.calls = before
                raise

    def mark_done(self, ctx, ingestion_id, *, chunk_count, completed_at):
        row = self._by_id.get(ingestion_id)
        if row and row.status != "done":
            self._by_id[ingestion_id] = _dc_replace(row, status="done", chunk_count=chunk_count, completed_at=completed_at, submission_state="terminal", claim_owner=None, lease_until=None)
            if row.operation_id:
                self._operation_repo.update(ctx, operation_id=row.operation_id, status="completed", upstream_status="processed", completed=True)
            self.done_count += 1
            return True
        return False

    def mark_failed(self, ctx, ingestion_id, *, error_code, error_message, completed_at):
        row = self._by_id.get(ingestion_id)
        if row and row.status not in ("done", "failed"):
            self._by_id[ingestion_id] = _dc_replace(row, status="failed", error_code=error_code,
                                                     error_message=error_message, completed_at=completed_at)
            return True
        return False

    def update_status(self, ctx, ingestion_id, *, status):
        row = self._by_id.get(ingestion_id)
        if row:
            self._by_id[ingestion_id] = _dc_replace(row, status=status)
            return True
        return False


class _FakeOperationRepo:
    def __init__(self):
        self.rows: dict[tuple[str, str], KnowledgeOperationRow] = {}
        self.calls = 0

    def get_by_key(self, ctx, *, operation, idempotency_key):
        return self.rows.get((operation, idempotency_key))

    def create(self, ctx, *, knowledge_space_id, document_id, operation, idempotency_key,
               request_fingerprint, status="pending"):
        self.calls += 1
        key = (operation, idempotency_key)
        self.rows.setdefault(key, KnowledgeOperationRow(
            id=f"op-{self.calls}", tenant_id=ctx.tenant_id,
            knowledge_space_id=knowledge_space_id, document_id=document_id,
            operation=operation, idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint, status=status,
        ))
        return self.rows[key]

    def update(self, ctx, *, operation_id, status, upstream_status=None,
               error_code=None, error_message=None, completed=False):
        for key, row in self.rows.items():
            if row.id == operation_id:
                self.rows[key] = _dc_replace(
                    row, status=status, upstream_status=upstream_status,
                    error_code=error_code, error_message=error_message,
                )
                return self.rows[key]
        return None


class _FakeBindingRepo:
    def __init__(self, doc_repo=None, job_repo=None):
        self.bindings: list[KnowledgeDocumentBindingOut] = []
        self.upserts = 0
        self._doc_repo = doc_repo
        self._job_repo = job_repo

    def upsert_ready_many(self, ctx, *, knowledge_space_id, document_id, employee_ids,
                          rag_document_id, synced_at):
        for employee_id in employee_ids:
            self.upserts += 1
            bid = f"bind_{uuid.uuid4().hex[:8]}"
            self.bindings.append(KnowledgeDocumentBindingOut(
                id=bid, tenant_id=ctx.tenant_id, knowledge_space_id=knowledge_space_id,
                document_id=document_id, employee_id=employee_id, rag_document_id=rag_document_id,
                status="ready", last_synced_at=synced_at, created_at=None,
            ))
        return len(employee_ids)

    def publish_ready(self, ctx, *, knowledge_space_id, document_id, employee_ids,
                      rag_document_id, job_id, chunk_count, text_chars, completed_at, synced_at, claim_owner=None):
        with self._job_repo.lock:
            if claim_owner is not None and not self._job_repo._owned(job_id, claim_owner):
                raise RuntimeError("ingestion claim expired")
            before = copy.deepcopy((self.bindings, self._job_repo._by_id, self._doc_repo._by_id, self._job_repo._operation_repo.rows))
            try:
                self.upsert_ready_many(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id,
                    employee_ids=employee_ids, rag_document_id=rag_document_id, synced_at=synced_at)
                self._job_repo.mark_done(ctx, job_id, chunk_count=chunk_count, completed_at=completed_at)
                self._doc_repo.update_status(ctx, document_id, status="ready", text_chars=text_chars)
                return len(employee_ids)
            except BaseException:
                self.bindings, self._job_repo._by_id, self._doc_repo._by_id, self._job_repo._operation_repo.rows = before
                raise

    def mark_stale_by_document(self, ctx, *, document_id):
        return 0

    def list_by_document(self, ctx, *, document_id):
        return [b for b in self.bindings if b.document_id == document_id]

    def list_by_employee(self, ctx, *, employee_id, status=None):
        return [b for b in self.bindings if b.employee_id == employee_id and (status is None or b.status == status)]


class _FakeExpertBinding:
    def __init__(self, experts: list[str] | None = None):
        self._experts = experts or []

    def list_experts_by_space(self, ctx, *, knowledge_space_id):
        return list(self._experts)


class _FakeEmployeeIdx:
    def __init__(self, employees: list[str] | None = None):
        self._employees = employees or []

    def list_employees_by_space(self, ctx, *, knowledge_space_id):
        return list(self._employees)


class _FakeRag:
    def get(self, ctx, knowledge_space_id):
        return type("Handle", (), {
            "tenant_id": ctx.tenant_id,
            "knowledge_space_id": knowledge_space_id,
            "workspace": f"t{ctx.tenant_id}__{knowledge_space_id}",
            "instance_id": "legacy",
        })()


class _FakeIngestion:
    def __init__(
        self, *, result=None, error=None, delete_result=None, delete_error=None,
        present=None, probe_error=None,
    ):
        self.calls = []
        self.delete_calls = []
        self.probe_calls = []
        self.result = result or RagIngestionResult("doc-placeholder", 1)
        self.error = error
        self.delete_result = delete_result or RagDeletionResult(True, False)
        self.delete_error = delete_error
        self.present = set(present or ())
        self.probe_error = probe_error

    def ingest_text(self, *, workspace, file_source, text, instance_id=None):
        self.calls.append((workspace, file_source, text))
        if self.error:
            raise self.error
        return RagIngestionResult(
            file_source, self.result.chunk_count, self.result.upstream_document_id
        )

    def validate_submission(self, *, workspace, file_source, text, instance_id=None):
        if not workspace or not file_source or not text or len(text.encode("utf-8")) > 4 * 1024 * 1024:
            raise RagIngestionUnavailable("invalid fixture submission")

    def submit_text(self, *, workspace, file_source, text, instance_id=None):
        self.validate_submission(
            workspace=workspace, file_source=file_source, text=text, instance_id=instance_id
        )
        self.ingest_text(
            workspace=workspace, file_source=file_source, text=text, instance_id=instance_id
        )
        return "fixture-track"

    def reconcile_ingestion(self, *, workspace, file_source, track_id=None, instance_id=None):
        from manager_service.rag_ingestion import RagIngestionStatus
        return RagIngestionStatus("processed", self.result.upstream_document_id or file_source.split("/")[0], self.result.chunk_count)

    def delete_document(self, *, workspace, doc_ids, delete_file, delete_llm_cache, instance_id=None):
        self.delete_calls.append((workspace, doc_ids, delete_file, delete_llm_cache))
        if self.delete_error:
            raise self.delete_error
        return self.delete_result

    def document_ids_present(self, *, workspace, doc_ids, instance_id=None):
        self.probe_calls.append((workspace, doc_ids))
        if self.probe_error:
            raise self.probe_error
        return set(self.present)


class _ResolvingFakeIngestion(_FakeIngestion):
    def __init__(self, *, resolved_id=None, **kwargs):
        super().__init__(**kwargs)
        self.resolved_id = resolved_id
        self.resolve_calls = []

    def resolve_document_id(self, *, workspace, aliases, instance_id=None):
        self.resolve_calls.append((workspace, aliases))
        return self.resolved_id


class _MultiResolvingFakeIngestion(_FakeIngestion):
    def __init__(self, *, resolved_ids=None, **kwargs):
        super().__init__(**kwargs)
        self.resolved_ids = list(resolved_ids or [])
        self.resolve_calls = []

    def resolve_document_ids(self, *, workspace, aliases, instance_id=None):
        self.resolve_calls.append((workspace, aliases))
        return list(self.resolved_ids)


class _FakeSpaceExists:
    def __init__(self, existing: set[str] | None = None):
        self._existing = existing or set()

    def __call__(self, ctx, knowledge_space_id):
        return knowledge_space_id in self._existing


# ─────────────────────────────── 服务层状态机 ───────────────────────────────


def _make_service(*, space_root: Path, experts=None, employees=None, existing_spaces=None,
                  ingestion=None, operation_repo=None):
    doc_repo = _FakeDocRepo()
    job_repo = _FakeJobRepo()
    operation_repo = operation_repo or _FakeOperationRepo()
    job_repo._operation_repo = operation_repo
    doc_repo._job_repo = job_repo
    job_repo._doc_repo = doc_repo
    return KnowledgeIntakeService(
        doc_repo=doc_repo,
        job_repo=job_repo,
        binding_repo=_FakeBindingRepo(doc_repo, job_repo),
        expert_binding=_FakeExpertBinding(experts),
        employee_index_port=_FakeEmployeeIdx(employees),
        space_exists=_FakeSpaceExists(existing_spaces),
        storage_root=space_root,
        rag_service=_FakeRag(),
        ingestion_client=ingestion or _FakeIngestion(),
        operation_repo=operation_repo,
    )


def _owner_ctx(tenant="t"):
    return TenantContext(tenant_id=tenant, user_id="u", roles=["owner"])


def test_ingest_upload_happy_path(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    ctx = _owner_ctx()
    # 准备一个文本文件
    doc, job = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="报告", file_name="report.txt",
        file_type="text/plain", content=b"hello knowledge intake " * 100,
    )
    assert doc.status == "ready"
    assert doc.text_chars and doc.text_chars > 0
    assert job.status == "done"
    assert job.chunk_count == 1


def test_prepare_upload_returns_before_background_processing(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    doc, job = svc.prepare_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="报告", file_name="report.txt",
        file_type="text/plain", content=b"hello knowledge intake",
    )

    assert doc.status == "uploaded"
    assert job.status == "parsing"
    svc.process_ingestion(
        _owner_ctx(), knowledge_space_id="ks", document_id=doc.id, job_id=job.id,
    )
    assert svc.get_document(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id).status == "ready"
    # A duplicate background delivery must not run a terminal document again.
    svc.process_ingestion(
        _owner_ctx(), knowledge_space_id="ks", document_id=doc.id, job_id=job.id,
    )
    assert svc.get_document(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id).status == "ready"


def test_background_delivery_failure_leaves_durable_job_for_recovery(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    doc, job = svc.prepare_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="报告", file_name="report.txt",
        file_type="text/plain", content=b"hello",
    )

    def fail(*_args, **_kwargs):
        raise RuntimeError("worker failed")

    advance = svc._advance
    svc._advance = fail
    with pytest.raises(RuntimeError, match="worker failed"):
        svc.process_ingestion(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id, job_id=job.id)
    assert svc.get_document(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id).status == "uploaded"
    svc._advance = advance
    svc.process_ingestion(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id, job_id=job.id)
    assert svc.get_document(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id).status == "ready"


def test_binding_propagation_failure_fails_closed_without_ready_state(tmp_path: Path) -> None:
    class FailingBindingRepo(_FakeBindingRepo):
        def publish_ready(self, *args, **kwargs):
            raise RuntimeError("db unavailable")

    svc = _make_service(space_root=tmp_path / "store", employees=["emp-1"], existing_spaces={"ks"})
    svc._binding_repo = FailingBindingRepo()
    doc, job = svc.ingest_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="failed", file_name="a.txt",
        file_type="text/plain", content=b"text",
    )
    assert doc.status == "indexing"
    assert job.status == "indexing"
    assert not doc.can_retry and not doc.can_delete
    current = svc._job_repo._by_id[job.id]
    assert current.track_id == "fixture-track" and current.submission_state == "submitted"
    svc._job_repo._by_id[job.id] = _dc_replace(current, next_attempt_at=None)
    assert svc.list_bindings(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id) == []
    svc._binding_repo = _FakeBindingRepo(svc._doc_repo, svc._job_repo)
    svc.process_ingestion(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id, job_id=job.id)
    assert svc.get_document(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id).status == "ready"
    assert len(svc._ingestion_client.calls) == 1
    assert len(svc.list_bindings(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id)) == 1


def test_ingest_upstream_failure_fails_closed_without_binding(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(error=RagIngestionUnavailable("upstream secret must not leak"))
    svc = _make_service(space_root=tmp_path / "store", employees=["emp-1"], existing_spaces={"ks"}, ingestion=ingestion)
    doc, job = svc.ingest_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="failed", file_name="a.txt",
        file_type="text/plain", content=b"text",
    )
    assert doc.status == "indexing"
    assert job.status == "indexing"
    assert not doc.can_retry and not doc.can_delete
    assert "secret" not in (doc.error_message or "")
    assert svc.list_bindings(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id) == []
    assert svc._job_repo.done_count == 0
    assert all(status != "ready" for _, status in svc._doc_repo.status_updates)


def test_binding_upsert_propagation_is_single_conflict_statement():
    class Cursor:
        rowcount = 2

    class Session:
        def __init__(self):
            self.sql = []

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, sql, params=None):
            self.sql.append(sql)
            return Cursor()

    class Router:
        def __init__(self):
            self.session_obj = Session()

        def session(self, ctx):
            return self.session_obj

    router = Router()
    count = KnowledgeDocumentBindingRepository(router).upsert_ready_many(
        _owner_ctx(), knowledge_space_id="ks", document_id="doc", employee_ids=["e1", "e2"],
        rag_document_id="doc", synced_at=datetime.now(timezone.utc),
    )
    assert count == 2
    assert len(router.session_obj.sql) == 1
    assert "INSERT INTO knowledge_document_binding" in router.session_obj.sql[0]
    assert "ON CONFLICT (tenant_id, document_id, employee_id) DO UPDATE" in router.session_obj.sql[0]
    assert "UPDATE knowledge_document_binding" not in router.session_obj.sql[0]


def test_atomic_publish_rolls_back_when_document_ready_update_fails():
    class Cursor:
        def __init__(self, rowcount):
            self.rowcount = rowcount

    class Session:
        def __init__(self):
            self.sql = []
            self.exit = None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            self.exit = exc_type
            return False

        def execute(self, sql, params=None):
            self.sql.append(sql)
            return Cursor(1 if len(self.sql) < 3 else 0)

    class Router:
        def __init__(self):
            self.session_obj = Session()

        def session(self, ctx):
            return self.session_obj

    router = Router()
    repo = KnowledgeDocumentBindingRepository(router)
    with pytest.raises(RuntimeError):
        repo.publish_ready(
            _owner_ctx(), knowledge_space_id="ks", document_id="doc", employee_ids=["e1"],
            rag_document_id="doc", job_id="job", chunk_count=1, text_chars=4,
            completed_at=datetime.now(timezone.utc), synced_at=datetime.now(timezone.utc),
        )
    assert router.session_obj.exit is RuntimeError
    assert len(router.session_obj.sql) == 3


def test_ingest_upload_empty_extracted_text_is_explicitly_failed(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    doc, job = svc.ingest_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="空文档", file_name="empty.txt",
        file_type="text/plain", content=b"\n  ",
    )
    assert doc.status == "failed"
    assert doc.error_code == "EMPTY_TEXT"
    assert job.status == "failed"


def test_ingest_upload_unsupported_format_fails(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    ctx = _owner_ctx()
    # .doc → 不支持 → 落 failed
    doc, job = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="old", file_name="old.doc",
        file_type="application/msword", content=b"\x00\x01\x02",
    )
    assert doc.status == "failed"
    assert doc.error_code == "UNSUPPORTED_FORMAT"
    assert job.status == "failed"


def test_ingest_upload_member_forbidden(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    member_ctx = TenantContext(tenant_id="t", user_id="u", roles=["member"])
    with pytest.raises(Forbidden):
        svc.ingest_upload(
            member_ctx, knowledge_space_id="ks", display_name="x", file_name="a.txt",
            file_type="text/plain", content=b"abc",
        )


def test_ingest_creates_index_bindings_for_bound_experts(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", experts=["emp-1"], employees=["emp-2"],
                        existing_spaces={"ks"})
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="binds", file_name="a.txt",
        file_type="text/plain", content=b"x" * 1000,
    )
    binding_rows = svc.list_bindings(ctx, knowledge_space_id="ks", document_id=doc.id)
    emp_ids = {b.employee_id for b in binding_rows}
    assert emp_ids == {"emp-2"}
    assert all(b.status == "ready" for b in binding_rows)
    assert all(b.rag_document_id == doc.id for b in binding_rows)


def test_ingest_binding_stores_upstream_document_id(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(
        result=RagIngestionResult(
            rag_document_id="ignored-manager-alias",
            chunk_count=1,
            upstream_document_id="doc-internal-1",
        )
    )
    svc = _make_service(
        space_root=tmp_path / "store", employees=["emp-2"], existing_spaces={"ks"},
        ingestion=ingestion,
    )
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="binds", file_name="a.txt",
        file_type="text/plain", content=b"x" * 1000,
    )
    binding_rows = svc.list_bindings(ctx, knowledge_space_id="ks", document_id=doc.id)
    assert [row.rag_document_id for row in binding_rows] == ["doc-internal-1"]


def test_cannot_retry_non_terminal_state(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    # 直接构造一个 parsing 状态的文档
    row = _FakeDocRepo._row("d1", "ks", status="parsing")
    svc._doc_repo._by_id["d1"] = row  # type: ignore[attr-defined]
    ctx = _owner_ctx()
    with pytest.raises(Conflict):
        svc.retry(ctx, knowledge_space_id="ks", document_id="d1")


def test_resolver_handles_empty_and_legacy_alias_results(tmp_path: Path) -> None:
    class EmptyMany(_FakeIngestion):
        def resolve_document_ids(self, *, workspace, aliases, instance_id=None):
            return None

    empty = _make_service(space_root=tmp_path / "empty", existing_spaces={"ks"}, ingestion=EmptyMany())
    assert empty._resolve_rag_document_ids(workspace="t__ks", aliases=["doc"]) == []

    class InvalidMany(_FakeIngestion):
        def resolve_document_ids(self, *, workspace, aliases, instance_id=None):
            return "invalid"

    invalid = _make_service(space_root=tmp_path / "invalid", existing_spaces={"ks"}, ingestion=InvalidMany())
    with pytest.raises(RagIngestionUnavailable):
        invalid._resolve_rag_document_ids(workspace="t__ks", aliases=["doc"])

    legacy = _make_service(
        space_root=tmp_path / "legacy", existing_spaces={"ks"},
        ingestion=_ResolvingFakeIngestion(resolved_id=None),
    )
    assert legacy._resolve_rag_document_ids(workspace="t__ks", aliases=["doc"]) == []


def test_delete_resolves_multiple_duplicate_aliases_before_request(tmp_path: Path) -> None:
    ingestion = _MultiResolvingFakeIngestion(
        resolved_ids=["duplicate-marker", "original-doc"],
        delete_result=RagDeletionResult(True, False),
    )
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    doc, _ = svc.ingest_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="duplicate", file_name="a.txt",
        file_type="text/plain", content=b"text",
    )

    operation = svc.delete(
        _owner_ctx(), knowledge_space_id="ks", document_id=doc.id, idempotency_key="delete-multi",
    )

    assert operation.status == "pending"
    assert ingestion.delete_calls[0][1] == ["duplicate-marker", "original-doc"]


def test_delete_resolves_alias_before_request_and_keeps_document_deleting(tmp_path: Path) -> None:
    ingestion = _ResolvingFakeIngestion(
        resolved_id="doc-internal-1",
        result=RagIngestionResult(
            rag_document_id="manager-alias", chunk_count=1, upstream_document_id="doc-stored-1"
        ),
        delete_result=RagDeletionResult(True, False),
    )
    svc = _make_service(
        space_root=tmp_path / "store", employees=["emp-1"], existing_spaces={"ks"}, ingestion=ingestion
    )
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="delete", file_name="a.txt",
        file_type="text/plain", content=b"delete me",
    )
    operation = svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-1")
    assert operation.status == "pending"
    assert operation.document_status == "deleting"
    assert len(ingestion.resolve_calls) == 1
    assert ingestion.resolve_calls[0][0] == "tt__ks"
    assert set(ingestion.resolve_calls[0][1]) == {doc.id, "doc-stored-1", svc._job_repo.get_latest_by_document(ctx, document_id=doc.id).file_source}
    assert ingestion.delete_calls == [("tt__ks", ["doc-internal-1"], False, True)]
    assert svc.get_document(ctx, knowledge_space_id="ks", document_id=doc.id).status == "deleting"


def test_delete_duplicate_idempotency_key_reuses_pending_receipt(tmp_path: Path) -> None:
    operations = _FakeOperationRepo()
    ingestion = _FakeIngestion(delete_result=RagDeletionResult(True, False))
    svc = _make_service(
        space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion,
        operation_repo=operations,
    )
    doc, _ = svc.ingest_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="duplicate", file_name="a.txt",
        file_type="text/plain", content=b"duplicate",
    )
    first = svc.delete(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id, idempotency_key="same")
    second = svc.delete(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id, idempotency_key="same")
    assert first.operation_id == second.operation_id
    assert first.status == second.status == "pending"
    assert len(ingestion.delete_calls) == 1


def test_delete_busy_is_retryable_and_does_not_claim_deleted(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(delete_result=RagDeletionResult(False, True))
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    doc, _ = svc.ingest_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="busy", file_name="a.txt",
        file_type="text/plain", content=b"busy",
    )
    with pytest.raises(RagDeletionBusy):
        svc.delete(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-busy")
    assert svc.get_document(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id).status == "deleting"


def test_delete_upstream_failure_revokes_reads_but_is_not_deleted(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(delete_error=RagIngestionUnavailable("secret"))
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    doc, _ = svc.ingest_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="failed delete", file_name="a.txt",
        file_type="text/plain", content=b"failed",
    )
    with pytest.raises(RagIngestionUnavailable):
        svc.delete(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-fail")
    assert svc.get_document(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id).status == "deleting"


def test_reconcile_delete_absent_completes_and_removes_source_idempotently(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(present=set())
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="reconcile", file_name="a.txt",
        file_type="text/plain", content=b"remove me",
    )
    source = svc._storage_root / doc.storage_key
    assert source.exists()
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-reconcile")

    completed = svc.reconcile_delete(
        ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-reconcile"
    )
    assert completed.status == "completed"
    assert completed.document_status == "deleted"
    assert completed.upstream_status == "deleted"
    assert not source.exists()

    repeated = svc.reconcile_delete(ctx, knowledge_space_id="ks", document_id=doc.id)
    assert repeated.operation_id == completed.operation_id
    assert repeated.status == "completed"
    fresh_request_key = svc.reconcile_delete(
        ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="fresh-reconcile-key"
    )
    assert fresh_request_key.operation_id == completed.operation_id
    assert fresh_request_key.status == "completed"
    assert ingestion.probe_calls == [("tt__ks", sorted([doc.id, svc._job_repo.get_latest_by_document(ctx, document_id=doc.id).file_source]))]


def test_reconcile_delete_resolves_internal_id_before_absence_probe(tmp_path: Path) -> None:
    ingestion = _ResolvingFakeIngestion(resolved_id="doc-internal-1", present=set())
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="reconcile", file_name="a.txt",
        file_type="text/plain", content=b"remove me",
    )
    source = svc._storage_root / doc.storage_key
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-reconcile")
    completed = svc.reconcile_delete(
        ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-reconcile"
    )
    assert completed.status == "completed"
    assert completed.document_status == "deleted"
    assert not source.exists()
    assert ingestion.resolve_calls == [("tt__ks", sorted([doc.id, svc._job_repo.get_latest_by_document(ctx, document_id=doc.id).file_source]))] * 2
    assert ingestion.probe_calls == [("tt__ks", ["doc-internal-1"])]


def test_reconcile_delete_records_sanitized_audit_lifecycle(tmp_path: Path) -> None:
    class Audit:
        def __init__(self):
            self.records = []

        def record(self, ctx, **kwargs):
            self.records.append(kwargs)

    audit = Audit()
    ingestion = _FakeIngestion(present=set())
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    svc._audit = audit
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="audit", file_name="a.txt",
        file_type="text/plain", content=b"audit me",
    )
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-audit")
    operation = svc.reconcile_delete(
        ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-audit"
    )
    assert operation.status == "completed"
    assert [record["action"] for record in audit.records] == [
        "knowledge_document_delete_requested",
        "knowledge_document_delete_pending",
        "knowledge_document_delete_reconciled",
    ]
    assert all("audit me" not in str(record) for record in audit.records)


def test_reconcile_delete_present_retries_and_keeps_pending_and_source(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(present={"doc-placeholder"})
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="still present", file_name="a.txt",
        file_type="text/plain", content=b"keep me",
    )
    source = svc._storage_root / doc.storage_key
    ingestion.present = {doc.id}
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-present")

    pending = svc.reconcile_delete(
        ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-present"
    )
    assert pending.status == "pending"
    assert pending.document_status == "deleting"
    assert pending.upstream_status == "deletion_started"
    assert source.exists()
    assert len(ingestion.delete_calls) == 2


def test_reconcile_delete_present_retries_busy_without_claiming_completion(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(
        present={"doc-placeholder"}, delete_result=RagDeletionResult(False, True),
    )
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="busy", file_name="a.txt",
        file_type="text/plain", content=b"busy",
    )
    ingestion.present = {doc.id}
    with pytest.raises(RagDeletionBusy):
        svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-busy")

    pending = svc.reconcile_delete(
        ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-busy"
    )
    assert pending.status == "pending"
    assert pending.document_status == "deleting"
    assert pending.upstream_status == "busy"
    assert len(ingestion.delete_calls) == 2


def test_reconcile_delete_retry_rejects_ambiguous_upstream_response(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(present={"doc-placeholder"})
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="ambiguous", file_name="a.txt",
        file_type="text/plain", content=b"ambiguous",
    )
    ingestion.present = {doc.id}
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-ambiguous")
    ingestion.delete_result = RagDeletionResult(False, False)

    with pytest.raises(RagIngestionUnavailable):
        svc.reconcile_delete(
            ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-ambiguous"
        )
    assert svc.get_document(ctx, knowledge_space_id="ks", document_id=doc.id).status == "deleting"


def test_reconcile_delete_retry_failure_is_sanitized_and_retryable(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(present={"doc-placeholder"})
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="retry failure", file_name="a.txt",
        file_type="text/plain", content=b"retry failure",
    )
    ingestion.present = {doc.id}
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-retry-failure")
    ingestion.delete_error = RuntimeError("upstream secret")

    with pytest.raises(RagIngestionUnavailable) as exc:
        svc.reconcile_delete(
            ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-retry-failure"
        )
    assert "upstream secret" not in str(exc.value)
    assert svc.get_document(ctx, knowledge_space_id="ks", document_id=doc.id).status == "deleting"


def test_reconcile_delete_probe_failure_is_retryable_without_claiming_deleted(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(probe_error=RagIngestionUnavailable("upstream-secret"))
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="probe failure", file_name="a.txt",
        file_type="text/plain", content=b"keep me",
    )
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-probe")
    with pytest.raises(RagIngestionUnavailable) as exc:
        svc.reconcile_delete(
            ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-probe"
        )
    assert "upstream-secret" not in str(exc.value)
    assert svc.get_document(ctx, knowledge_space_id="ks", document_id=doc.id).status == "deleting"


def test_reconcile_delete_source_path_fence_keeps_deleting(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="fenced", file_name="a.txt",
        file_type="text/plain", content=b"keep me",
    )
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-fenced")
    svc._doc_repo._by_id[doc.id] = _dc_replace(
        svc._doc_repo._by_id[doc.id], storage_key="knowledge/t/other/escape.txt"
    )
    with pytest.raises(RagIngestionUnavailable):
        svc.reconcile_delete(
            ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-fenced"
        )
    assert svc.get_document(ctx, knowledge_space_id="ks", document_id=doc.id).status == "deleting"


def test_reconcile_delete_rejects_symlinked_source(tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("must stay")
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="symlink", file_name="a.txt",
        file_type="text/plain", content=b"indexed",
    )
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-symlink")
    link = svc._storage_root / "knowledge" / "t" / "ks" / "linked.txt"
    link.symlink_to(outside)
    svc._doc_repo._by_id[doc.id] = _dc_replace(
        svc._doc_repo._by_id[doc.id], storage_key="knowledge/t/ks/linked.txt"
    )
    with pytest.raises(RagIngestionUnavailable):
        svc.reconcile_delete(
            ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-symlink"
        )
    assert outside.read_text() == "must stay"
    assert svc.get_document(ctx, knowledge_space_id="ks", document_id=doc.id).status == "deleting"


def test_reconcile_delete_requires_owner_admin_and_current_tenant(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    doc, _ = svc.ingest_upload(
        _owner_ctx(), knowledge_space_id="ks", display_name="auth", file_name="a.txt",
        file_type="text/plain", content=b"auth",
    )
    svc.delete(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-auth")
    with pytest.raises(Forbidden):
        svc.reconcile_delete(
            TenantContext(tenant_id="t", user_id="m", roles=["member"]),
            knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-auth",
        )
    with pytest.raises(NotFound):
        svc.reconcile_delete(
            _owner_ctx("other"), knowledge_space_id="ks", document_id=doc.id,
            idempotency_key="del-auth",
        )


def test_reindex_cannot_restart_deleted_document(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    ctx = _owner_ctx()
    doc, _ = svc.ingest_upload(
        ctx, knowledge_space_id="ks", display_name="deleted", file_name="a.txt",
        file_type="text/plain", content=b"gone",
    )
    svc.delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-reindex")
    svc.reconcile_delete(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="del-reindex")
    with pytest.raises(Conflict):
        svc.reindex(ctx, knowledge_space_id="ks", document_id=doc.id, idempotency_key="reindex-deleted")


def test_reindex_after_unknown_upstream_failure_is_protected_not_reposted(tmp_path: Path) -> None:
    ingestion = _FakeIngestion(error=RagIngestionUnavailable("secret"))
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"}, ingestion=ingestion)
    doc, _ = svc.ingest_upload(_owner_ctx(), knowledge_space_id="ks", display_name="reindex", file_name="a.txt", file_type="text/plain", content=b"reindex")
    with pytest.raises(Conflict):
        svc.reindex(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id, idempotency_key="re-1")
    assert svc.get_document(_owner_ctx(), knowledge_space_id="ks", document_id=doc.id).status == "indexing"
    assert len(ingestion.calls) == 1


def test_reindex_state_conflict_and_idempotency_key_fingerprint(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    row = _FakeDocRepo._row("d1", "ks", status="indexing")
    svc._doc_repo._by_id["d1"] = row  # type: ignore[attr-defined]
    with pytest.raises(Conflict):
        svc.reindex(_owner_ctx(), knowledge_space_id="ks", document_id="d1", idempotency_key="re-1")


def test_document_outside_space_raises_404(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    ctx = _owner_ctx()
    with pytest.raises(NotFound):
        svc.get_document(ctx, knowledge_space_id="ks", document_id="does-not-exist")


def test_missing_space_raises_404(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces=set())
    ctx = _owner_ctx()
    with pytest.raises(NotFound):
        svc.list_documents(ctx, knowledge_space_id="missing")


def test_ingest_url_schema_requires_url() -> None:
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        KnowledgeDocumentImportUrl(url="")


def test_lifecycle_schema_exposes_fail_closed_states_and_operation_receipt():
    from manager_service.schemas import KnowledgeDocumentOperationOut

    operation = KnowledgeDocumentOperationOut(
        operation_id="op-1", operation="delete", idempotency_key="k-1",
        tenant_id="t", knowledge_space_id="ks", document_id="doc-1",
        status="pending", document_status="deleting", upstream_status="deletion_started",
    )
    assert operation.model_dump()["document_status"] == "deleting"


# ─────────────────────────────── 路由契约（注册） ───────────────────────────────


def test_enabling_existing_employee_binding_backfills_ready_documents():
    class EmployeeRepo:
        def update(self, ctx, *, binding_id, enabled, config):
            return KnowledgeBindingRow(
                binding_id=binding_id, employee_id="emp-1", knowledge_space_id="ks",
                enabled=enabled, config=config, created_at=None, updated_at=None,
            )

    class ReadyDocuments:
        def __init__(self):
            self.calls = []

        def backfill_ready_for_employee(self, ctx, *, knowledge_space_id, employee_id):
            self.calls.append((knowledge_space_id, employee_id))
            return 1

    ready = ReadyDocuments()
    service = EmployeeKnowledgeBindingService(EmployeeRepo(), ready)
    result = service.update(_owner_ctx(), binding_id="binding-1", enabled=True, config={})
    assert result["enabled"] is True
    assert ready.calls == [("ks", "emp-1")]


def test_import_url_offloads_sync_intake(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio
    import manager_service.routes_knowledge_intake as routes
    from shared.auth import RejectingTokenVerifier

    calls = []

    class Service:
        def ingest_url(self, *args, **kwargs):
            calls.append((args, kwargs))
            raise RuntimeError("called in worker")

    async def fake_to_thread(func, *args, **kwargs):
        calls.append(func.__name__)
        return func(*args, **kwargs)

    monkeypatch.setattr(routes, "_service", lambda request: Service())
    monkeypatch.setattr(routes, "tenant_context_from", lambda claims: "ctx")
    monkeypatch.setattr(routes.asyncio, "to_thread", fake_to_thread)
    router = routes.build_knowledge_intake_router(RejectingTokenVerifier("x"))
    endpoint = next(r.endpoint for r in router.routes if r.path.endswith("/documents/url"))

    async def invoke():
        with pytest.raises(RuntimeError, match="called in worker"):
            await endpoint(
                "ks", KnowledgeDocumentImportUrl(url="https://public.example/page"), object(), object()
            )

    asyncio.run(invoke())
    assert calls[0] == "ingest_url"


def test_upload_persists_then_schedules_background_intake(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio
    import io
    import manager_service.routes_knowledge_intake as routes
    from fastapi import BackgroundTasks
    from shared.auth import RejectingTokenVerifier
    from manager_service.schemas import KnowledgeDocumentOut, KnowledgeIngestionJobOut
    from starlette.datastructures import Headers, UploadFile

    doc = KnowledgeDocumentOut(
        id="doc-1", tenant_id="t", knowledge_space_id="ks", display_name="report.txt",
        source_type="file", file_name="report.txt", file_type="text/plain", file_size=1,
        storage_key="knowledge/t/ks/report.txt", status="uploaded",
    )
    job = KnowledgeIngestionJobOut(
        id="job-1", tenant_id="t", knowledge_space_id="ks", document_id="doc-1", status="parsing",
    )
    calls = []

    class Service:
        def prepare_upload(self, *args, **kwargs):
            calls.append(("prepare_upload", args, kwargs))
            return doc, job

        def process_ingestion(self, *args, **kwargs):
            calls.append(("process_ingestion", args, kwargs))

    async def fake_to_thread(func, *args, **kwargs):
        calls.append(func.__name__)
        return func(*args, **kwargs)

    monkeypatch.setattr(routes, "_service", lambda request: Service())
    monkeypatch.setattr(routes, "tenant_context_from", lambda claims: "ctx")
    monkeypatch.setattr(routes.asyncio, "to_thread", fake_to_thread)
    router = routes.build_knowledge_intake_router(RejectingTokenVerifier("x"))
    endpoint = next(
        r.endpoint for r in router.routes
        if getattr(r, "path", "").endswith("/documents") and "{" in r.path and "POST" in r.methods
    )
    tasks = BackgroundTasks()

    async def invoke():
        return await endpoint(
            "ks", object(), tasks,
            UploadFile(file=io.BytesIO(b"x"), filename="report.txt", headers=Headers({"content-type": "text/plain"})),
            object(),
        )

    response = asyncio.run(invoke())
    assert response.data is doc
    assert calls[0] == "prepare_upload"
    assert len(tasks.tasks) == 1
    assert tasks.tasks[0].func.__name__ == "process_ingestion"
    assert tasks.tasks[0].kwargs == {"knowledge_space_id": "ks", "document_id": "doc-1", "job_id": "job-1"}


def test_analytics_offloads_sync_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio
    import manager_service.routes_knowledge_intake as routes
    from shared.auth import RejectingTokenVerifier

    calls = []
    analytics = {
        "knowledge_space_id": "ks", "status": "not_configured", "document_count": 0,
        "ready_count": 0, "failed_count": 0, "processing_count": 0, "deleted_count": 0,
        "total_bytes": 0, "total_text_chars": 0, "total_chunks": 0,
        "upstream_document_count": None, "upstream_ready_count": None,
        "upstream_failed_count": None, "upstream_processing_count": None,
        "last_activity_at": None, "refreshed_at": datetime.now(timezone.utc),
        "daily_activity": [], "documents": [],
    }

    class Service:
        def analytics(self, *args, **kwargs):
            calls.append((args, kwargs))
            from manager_service.analytics_schemas import KnowledgeAnalyticsOut
            return KnowledgeAnalyticsOut(**analytics)

    async def fake_to_thread(func, *args, **kwargs):
        calls.append(func.__name__)
        return func(*args, **kwargs)

    monkeypatch.setattr(routes, "_service", lambda request: Service())
    monkeypatch.setattr(routes, "tenant_context_from", lambda claims: "ctx")
    monkeypatch.setattr(routes.asyncio, "to_thread", fake_to_thread)
    router = routes.build_knowledge_intake_router(RejectingTokenVerifier("x"))
    endpoint = next(r.endpoint for r in router.routes if getattr(r, "path", "").endswith("/analytics"))

    async def invoke():
        response = await endpoint("ks", object(), object())
        assert response.data[0].knowledge_space_id == "ks"

    asyncio.run(invoke())
    assert calls[0] == "analytics"


def test_routes_registered() -> None:
    from manager_service.routes_knowledge_intake import build_knowledge_intake_router
    from shared.auth import RejectingTokenVerifier

    router = build_knowledge_intake_router(RejectingTokenVerifier("x"))
    paths = {r.path for r in router.routes if hasattr(r, "path")}
    for expected in [
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/url",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/reconcile-delete",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/reindex",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/retry",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/ingestion",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/ingestions",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/bindings",
    ]:
        assert expected in paths, f"missing route: {expected}"


def test_app_includes_intake_router() -> None:
    """验证 manager app 已挂载 intake 路由。

    经 openapi() 取路径而非裸遍历 app.routes：FastAPI ≥0.130 的 include_router
    是惰性注册（_IncludedRouter 占位），启动前 routes 里看不到具体 path。
    """
    from manager_service import app as manager_app
    paths = set(manager_app.app.openapi()["paths"])
    assert "/api/manager/knowledge-spaces/{knowledge_space_id}/documents" in paths
    assert "/api/manager/knowledge-spaces/{knowledge_space_id}/ingestions" in paths
