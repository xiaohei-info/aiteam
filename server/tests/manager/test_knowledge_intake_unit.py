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

import io
import uuid
import zipfile
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
    KnowledgeDocumentRepository,
    KnowledgeDocumentRow,
    KnowledgeIngestionJobRepository,
    KnowledgeIngestionJobRow,
)
from manager_service.knowledge_intake_service import KnowledgeIntakeService
from manager_service.schemas import (
    KnowledgeDocumentBindingOut,
    KnowledgeDocumentImportUrl,
    KnowledgeDocumentOut,
    KnowledgeIngestionJobOut,
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
               file_type, file_size, storage_key, status):
        rid = f"doc_{uuid.uuid4().hex[:8]}"
        row = self._row(rid, knowledge_space_id, status=status, display_name=display_name,
                        source_type=source_type, file_name=file_name, file_type=file_type,
                        file_size=file_size, storage_key=storage_key)
        self._by_id[rid] = row
        self._by_space.setdefault(knowledge_space_id, []).append(rid)
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

    @classmethod
    def _row(cls, jid, ks, doc_id, status="parsing"):
        return KnowledgeIngestionJobRow(
            id=jid, tenant_id="t", knowledge_space_id=ks, document_id=doc_id, status=status,
            error_code=None, error_message=None, chunk_count=None, started_at=None,
            completed_at=None, created_at=None,
        )

    def create(self, ctx, *, knowledge_space_id, document_id, status, started_at=None):
        jid = f"ing_{uuid.uuid4().hex[:8]}"
        row = self._row(jid, knowledge_space_id, document_id, status=status)
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

    def mark_done(self, ctx, ingestion_id, *, chunk_count, completed_at):
        row = self._by_id.get(ingestion_id)
        if row and row.status != "done":
            self._by_id[ingestion_id] = _dc_replace(row, status="done", chunk_count=chunk_count, completed_at=completed_at)
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


class _FakeBindingRepo:
    def __init__(self):
        self.bindings: list[KnowledgeDocumentBindingOut] = []
        self.upserts = 0

    def upsert_ready(self, ctx, *, knowledge_space_id, document_id, employee_id,
                     rag_document_id, synced_at):
        self.upserts += 1
        bid = f"bind_{uuid.uuid4().hex[:8]}"
        row = KnowledgeDocumentBindingOut(
            id=bid, tenant_id=ctx.tenant_id, knowledge_space_id=knowledge_space_id,
            document_id=document_id, employee_id=employee_id, rag_document_id=rag_document_id,
            status="ready", last_synced_at=synced_at, created_at=None,
        )
        self.bindings.append(row)
        return row

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


class _FakeSpaceExists:
    def __init__(self, existing: set[str] | None = None):
        self._existing = existing or set()

    def __call__(self, ctx, knowledge_space_id):
        return knowledge_space_id in self._existing


# ─────────────────────────────── 服务层状态机 ───────────────────────────────


def _make_service(*, space_root: Path, experts=None, employees=None, existing_spaces=None):
    return KnowledgeIntakeService(
        doc_repo=_FakeDocRepo(),
        job_repo=_FakeJobRepo(),
        binding_repo=_FakeBindingRepo(),
        expert_binding=_FakeExpertBinding(experts),
        employee_index_port=_FakeEmployeeIdx(employees),
        space_exists=_FakeSpaceExists(existing_spaces),
        storage_root=space_root,
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
    assert job.chunk_count and job.chunk_count >= 1


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
    assert {"emp-1", "emp-2"}.issubset(emp_ids)
    assert all(b.status == "ready" for b in binding_rows)


def test_cannot_retry_non_terminal_state(tmp_path: Path) -> None:
    svc = _make_service(space_root=tmp_path / "store", existing_spaces={"ks"})
    # 直接构造一个 parsing 状态的文档
    row = _FakeDocRepo._row("d1", "ks", status="parsing")
    svc._doc_repo._by_id["d1"] = row  # type: ignore[attr-defined]
    ctx = _owner_ctx()
    with pytest.raises(Conflict):
        svc.retry(ctx, knowledge_space_id="ks", document_id="d1")


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


# ─────────────────────────────── 路由契约（注册） ───────────────────────────────


def test_routes_registered() -> None:
    from manager_service.routes_knowledge_intake import build_knowledge_intake_router
    from shared.auth import RejectingTokenVerifier

    router = build_knowledge_intake_router(RejectingTokenVerifier("x"))
    paths = {r.path for r in router.routes if hasattr(r, "path")}
    for expected in [
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/url",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/retry",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/ingestion",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/ingestions",
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/bindings",
    ]:
        assert expected in paths, f"missing route: {expected}"


def test_app_includes_intake_router() -> None:
    """验证 manager app 已挂载 intake 路由（非空跑——import app 即 assert 已注册）。"""
    from manager_service import app as manager_app
    paths = {r.path for r in manager_app.app.routes if hasattr(r, "path")}
    assert "/api/manager/knowledge-spaces/{knowledge_space_id}/documents" in paths
    assert "/api/manager/knowledge-spaces/{knowledge_space_id}/ingestions" in paths
