"""知识文档 intake 编排（issue #416；04 §6.1.2/§6.6；D21/D22）。

编排三个 repository + 文档解析器，驱动 intake 状态机：uploaded → parsing → indexing → ready | failed。
完成时向 knowledge_space 已绑员工传播索引绑定（knowledge_document_binding）。

红线（D21）：
- 真实 LightRAG 写入只经 Manager-owned ingestion client；API key 不进入 Agent 或业务状态。
- workspace 只由 ManagerRagService 推导，本服务不接受外部 workspace。
- tenant_id 全程经 TenantContext（D22），不手写过滤。
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import ManagerRagService, PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound, ValidationProblem

from .document_parser import UnsupportedFormatError, extract_text
from .knowledge_intake_repository import (
    KnowledgeDocumentBindingRepository,
    KnowledgeDocumentRepository,
    KnowledgeIngestionJobRepository,
    build_knowledge_intake_repositories,
)
from .knowledge_space_repository import ExpertKnowledgeBinding
from .rag_ingestion import RagIngestionPort, RagIngestionUnavailable
from .schemas import (
    KnowledgeDocumentBindingOut,
    KnowledgeDocumentCreate,
    KnowledgeDocumentOut,
    KnowledgeIngestionJobOut,
)

logger = logging.getLogger(__name__)

# 写操作允许的企业角色（03 §9.7）。Member 只读。
_INTAKE_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]

# 单文档上传上限（字节）— 4 MB，与旧 app/ 口径一致。
_MAX_UPLOAD_BYTES = 4 * 1024 * 1024
_MAX_DISPLAY_NAME = 512
_MAX_FILE_NAME = 1024
_MAX_FILE_TYPE = 256


class _EmployeeIndexBindingPort(Protocol):
    """员工 ↔ 知识空间绑定查询端口（解耦：不直接依赖 employee_knowledge_binding repository）。"""

    def list_employees_by_space(self, ctx: TenantContext, *, knowledge_space_id: str) -> list[str]: ...


class _SpaceExistsPort(Protocol):
    """知识空间存在性查询端口。"""

    def __call__(self, ctx: TenantContext, knowledge_space_id: str) -> bool: ...


class _KnowledgeSpaceExists:
    """从 rag_workspace 表判断知识空间是否存在（tenant 隔离）。"""

    def __init__(self, router: "PgTenantRouter"):
        self._router = router

    def __call__(self, ctx: TenantContext, knowledge_space_id: str) -> bool:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT 1 FROM rag_workspace WHERE knowledge_space_id = %s",
                (knowledge_space_id,),
            ).fetchone()
        return row is not None


class _EmployeeKnowledgeBindingQuery:
    """从 employee_knowledge_binding 表查已绑员工（tenant 隔离，RLS 裁剪）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def list_employees_by_space(
        self, ctx: TenantContext, *, knowledge_space_id: str
    ) -> list[str]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT employee_id FROM employee_knowledge_binding "
                "WHERE knowledge_space_id = %s AND enabled = true",
                (knowledge_space_id,),
            ).fetchall()
        return [str(r[0]) for r in rows]


class KnowledgeIntakeService:
    """知识文档 intake 编排。tenant_id 全程经 TenantContext（D22）。"""

    def __init__(
        self,
        *,
        doc_repo: KnowledgeDocumentRepository,
        job_repo: KnowledgeIngestionJobRepository,
        binding_repo: KnowledgeDocumentBindingRepository,
        expert_binding: ExpertKnowledgeBinding,
        employee_index_port: _EmployeeIndexBindingPort,
        space_exists: "_SpaceExistsPort",
        storage_root: Path,
        rag_service: ManagerRagService,
        ingestion_client: RagIngestionPort,
    ):
        self._doc_repo = doc_repo
        self._job_repo = job_repo
        self._binding_repo = binding_repo
        self._expert_binding = expert_binding
        self._employee_index_port = employee_index_port
        self._space_exists = space_exists
        self._storage_root = storage_root
        self._rag_service = rag_service
        self._ingestion_client = ingestion_client

    # ─────────────────────────────── 查询 ───────────────────────────────

    def list_documents(
        self, ctx: TenantContext, *, knowledge_space_id: str
    ) -> list[KnowledgeDocumentOut]:
        self._require_space(ctx, knowledge_space_id)
        return [_to_doc_out(r) for r in self._doc_repo.list_by_space(ctx, knowledge_space_id=knowledge_space_id)]

    def get_document(
        self, ctx: TenantContext, *, knowledge_space_id: str, document_id: str
    ) -> KnowledgeDocumentOut:
        doc = self._require_doc(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id)
        return _to_doc_out(doc)

    def list_ingestions(
        self, ctx: TenantContext, *, knowledge_space_id: str
    ) -> list[KnowledgeIngestionJobOut]:
        self._require_space(ctx, knowledge_space_id)
        return [_to_ing_out(r) for r in self._job_repo.list_by_space(ctx, knowledge_space_id=knowledge_space_id)]

    def get_ingestion(
        self, ctx: TenantContext, *, knowledge_space_id: str, document_id: str
    ) -> KnowledgeIngestionJobOut:
        self._require_doc(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id)
        job = self._job_repo.get_latest_by_document(ctx, document_id=document_id)
        if job is None:
            raise NotFound(f"no ingestion job for document {document_id}")
        return _to_ing_out(job)

    def list_bindings(
        self, ctx: TenantContext, *, knowledge_space_id: str, document_id: str
    ) -> list[KnowledgeDocumentBindingOut]:
        self._require_doc(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id)
        return [_to_bind_out(r) for r in self._binding_repo.list_by_document(ctx, document_id=document_id)]

    # ─────────────────────────────── 写 ───────────────────────────────

    def ingest_upload(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        display_name: str,
        file_name: str,
        file_type: str,
        content: bytes,
    ) -> tuple[KnowledgeDocumentOut, KnowledgeIngestionJobOut]:
        """上传文件 intake：落盘 → 建文档+任务 → 推进状态机。"""
        _ensure_can_write(ctx)
        self._require_space(ctx, knowledge_space_id)
        if len(content) > _MAX_UPLOAD_BYTES:
            raise ValidationProblem(
                detail=f"file exceeds max upload size ({_MAX_UPLOAD_BYTES} bytes)",
                errors=None,
            )
        display_name, file_name, file_type = _normalize_document_metadata(
            display_name, file_name, file_type
        )
        storage_key = _store_bytes(self._storage_root, knowledge_space_id, file_name, content, tenant_id=ctx.tenant_id)
        return self._create_and_advance(
            ctx,
            knowledge_space_id=knowledge_space_id,
            display_name=display_name,
            source_type="file",
            file_name=file_name,
            file_type=file_type,
            file_size=len(content),
            storage_key=storage_key,
        )

    def ingest_url(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        url: str,
        display_name: str | None,
    ) -> tuple[KnowledgeDocumentOut, KnowledgeIngestionJobOut]:
        """URL 导入 intake：抓取 → 落盘 → 建文档+任务 → 推进状态机。"""
        _ensure_can_write(ctx)
        self._require_space(ctx, knowledge_space_id)
        from .document_parser_url import fetch_url_text
        text, name, mime, title = fetch_url_text(url)
        chosen_name = display_name or title or name or "web page"
        chosen_name, name, mime = _normalize_document_metadata(
            chosen_name, name, mime or "text/plain"
        )
        storage_key = _store_text(
            self._storage_root, knowledge_space_id, name, text, tenant_id=ctx.tenant_id
        )
        return self._create_and_advance(
            ctx,
            knowledge_space_id=knowledge_space_id,
            display_name=chosen_name,
            source_type="url",
            file_name=name,
            file_type=mime,
            file_size=len(text),
            storage_key=storage_key,
        )

    def retry(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
    ) -> tuple[KnowledgeDocumentOut, KnowledgeIngestionJobOut]:
        """重试失败/已完成的文档：重置为 parsing 并重新推进。"""
        _ensure_can_write(ctx)
        doc = self._require_doc(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id)
        if doc.status not in ("failed", "ready"):
            raise Conflict(f"cannot retry document in state {doc.status!r} (allowed: failed, ready)")
        # 标旧 binding 为 stale，避免下游读到过期 rag_document_id
        self._binding_repo.mark_stale_by_document(ctx, document_id=document_id)
        # 新建 intake 任务
        job = self._job_repo.create(
            ctx,
            knowledge_space_id=knowledge_space_id,
            document_id=document_id,
            status="parsing",
            started_at=datetime.now(timezone.utc),
        )
        self._doc_repo.update_status(ctx, document_id, status="parsing")
        self._advance(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id, job_id=job.id)
        updated = self._doc_repo.get(ctx, document_id=document_id)
        assert updated is not None
        latest = self._job_repo.get_latest_by_document(ctx, document_id=document_id)
        assert latest is not None
        return _to_doc_out(updated), _to_ing_out(latest)

    # ─────────────────────────────── 内部 ───────────────────────────────

    def _create_and_advance(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        display_name: str,
        source_type: str,
        file_name: str,
        file_type: str,
        file_size: int,
        storage_key: str,
    ) -> tuple[KnowledgeDocumentOut, KnowledgeIngestionJobOut]:
        doc = self._doc_repo.create(
            ctx,
            knowledge_space_id=knowledge_space_id,
            display_name=display_name,
            source_type=source_type,
            file_name=file_name,
            file_type=file_type,
            file_size=file_size,
            storage_key=storage_key,
            status="parsing",
        )
        job = self._job_repo.create(
            ctx,
            knowledge_space_id=knowledge_space_id,
            document_id=doc.id,
            status="parsing",
            started_at=datetime.now(timezone.utc),
        )
        self._advance(ctx, knowledge_space_id=knowledge_space_id, document_id=doc.id, job_id=job.id)
        updated = self._doc_repo.get(ctx, document_id=doc.id)
        assert updated is not None
        latest = self._job_repo.get_latest_by_document(ctx, document_id=doc.id)
        assert latest is not None
        return _to_doc_out(updated), _to_ing_out(latest)

    def _advance(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        job_id: str,
    ) -> None:
        """推进单个 intake 任务：parsing → indexing → ready | failed。失败不抛，落到文档 error 状态。"""
        doc = self._doc_repo.get(ctx, document_id=document_id)
        if doc is None:
            logger.warning("[kb]intake advance: document %s vanished", document_id)
            return
        path = _resolve_path(self._storage_root, doc.storage_key)
        # parsing
        try:
            text = extract_text(path)
        except UnsupportedFormatError as exc:
            self._fail(ctx, document_id=document_id, job_id=job_id,
                       error_code="UNSUPPORTED_FORMAT", message=str(exc))
            return
        except FileNotFoundError:
            self._fail(ctx, document_id=document_id, job_id=job_id,
                       error_code="FILE_NOT_FOUND", message=f"stored file missing: {doc.storage_key}")
            return
        except Exception as exc:
            logger.exception("[kb] parse failed for %s", document_id)
            self._fail(ctx, document_id=document_id, job_id=job_id,
                       error_code="PARSE_FAILED", message=str(exc)[:500])
            return
        self._doc_repo.update_status(ctx, document_id, status="indexing", text_chars=len(text))
        self._job_repo.update_status(ctx, job_id, status="indexing")
        # Indexing is Manager-owned: derive the workspace from tenant context,
        # then wait for LightRAG before publishing any ready state.
        try:
            handle = self._rag_service.get(ctx, knowledge_space_id)
            if (
                handle is None
                or handle.tenant_id != ctx.tenant_id
                or handle.knowledge_space_id != knowledge_space_id
                or not isinstance(handle.workspace, str)
                or not handle.workspace.strip()
            ):
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            result = self._ingestion_client.ingest_text(
                workspace=handle.workspace, file_source=document_id, text=text
            )
            if not result or result.rag_document_id != document_id:
                raise RagIngestionUnavailable("knowledge indexing unavailable")
        except Exception as exc:
            if not isinstance(exc, RagIngestionUnavailable):
                logger.warning("[kb] index failed for %s: %s", document_id, type(exc).__name__)
            self._fail(
                ctx, document_id=document_id, job_id=job_id,
                error_code="INDEX_FAILED", message="knowledge indexing unavailable",
            )
            return
        # Bindings, job completion, and Manager ready are one DB transaction.
        try:
            employee_ids = sorted(set(self._employee_index_port.list_employees_by_space(
                ctx, knowledge_space_id=knowledge_space_id
            )))
            published_at = datetime.now(timezone.utc)
            self._binding_repo.publish_ready(
                ctx, knowledge_space_id=knowledge_space_id, document_id=document_id,
                employee_ids=employee_ids, rag_document_id=result.rag_document_id,
                job_id=job_id, chunk_count=result.chunk_count, text_chars=len(text),
                completed_at=published_at, synced_at=published_at,
            )
        except Exception as exc:
            logger.warning("[kb] index publication failed for %s: %s", document_id, type(exc).__name__)
            self._fail(
                ctx, document_id=document_id, job_id=job_id,
                error_code="BINDING_PROPAGATION_FAILED", message="knowledge binding propagation unavailable",
            )
            return

    def _fail(
        self,
        ctx: TenantContext,
        *,
        document_id: str,
        job_id: str,
        error_code: str,
        message: str,
    ) -> None:
        now = datetime.now(timezone.utc)
        self._job_repo.mark_failed(
            ctx, job_id, error_code=error_code, error_message=message, completed_at=now
        )
        self._doc_repo.update_status(
            ctx, document_id, status="failed",
            error_code=error_code, error_message=message[:2000],
        )

    def _require_space(self, ctx: TenantContext, knowledge_space_id: str) -> None:
        """知识空间必须存在（跨 tenant 行 RLS 不可见 → NotFound）。"""
        if not self._space_exists(ctx, knowledge_space_id):
            raise NotFound(f"knowledge space {knowledge_space_id!r} not found in this tenant")

    def _require_doc(
        self, ctx: TenantContext, *, knowledge_space_id: str, document_id: str
    ):
        doc = self._doc_repo.get(ctx, document_id=document_id)
        if doc is None or doc.knowledge_space_id != knowledge_space_id:
            raise NotFound(f"document {document_id!r} not found in knowledge space {knowledge_space_id!r}")
        return doc


# ─────────────────────────────── 出参映射 ───────────────────────────────


def _to_doc_out(row) -> KnowledgeDocumentOut:
    return KnowledgeDocumentOut(
        id=row.id, tenant_id=row.tenant_id, knowledge_space_id=row.knowledge_space_id,
        display_name=row.display_name, source_type=row.source_type, file_name=row.file_name,
        file_type=row.file_type, file_size=row.file_size, storage_key=row.storage_key,
        status=row.status, text_chars=row.text_chars, error_code=row.error_code,
        error_message=row.error_message, created_at=row.created_at, updated_at=row.updated_at,
    )


def _to_ing_out(row) -> KnowledgeIngestionJobOut:
    return KnowledgeIngestionJobOut(
        id=row.id, tenant_id=row.tenant_id, knowledge_space_id=row.knowledge_space_id,
        document_id=row.document_id, status=row.status, error_code=row.error_code,
        error_message=row.error_message, chunk_count=row.chunk_count,
        started_at=row.started_at, completed_at=row.completed_at, created_at=row.created_at,
    )


def _to_bind_out(row) -> KnowledgeDocumentBindingOut:
    return KnowledgeDocumentBindingOut(
        id=row.id, tenant_id=row.tenant_id, knowledge_space_id=row.knowledge_space_id,
        document_id=row.document_id, employee_id=row.employee_id,
        rag_document_id=row.rag_document_id, status=row.status,
        last_synced_at=row.last_synced_at, created_at=row.created_at,
    )


# ─────────────────────────────── 存储 ───────────────────────────────


def _storage_component(value: str | None, fallback: str) -> str:
    candidate = value or fallback
    if Path(candidate).name != candidate or candidate in {".", ".."}:
        raise ValueError("invalid knowledge namespace component")
    return candidate


def manager_storage_root(settings) -> Path:
    """Return the canonical durable Manager document root from Settings."""
    return Path(settings.manager_data_root).resolve()


def ensure_storage_root(root: Path) -> Path:
    """Create and repair the private Manager storage tree (directories 0700, files 0600)."""
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    for current, directories, files in os.walk(root, followlinks=False):
        os.chmod(current, 0o700)
        for name in directories:
            path = Path(current) / name
            if not path.is_symlink():
                os.chmod(path, 0o700)
        for name in files:
            path = Path(current) / name
            if not path.is_symlink():
                os.chmod(path, 0o600)
    return root


def _normalize_document_metadata(
    display_name: str, file_name: str, file_type: str
) -> tuple[str, str, str]:
    safe_display = display_name.strip()
    safe_name = Path(file_name).name or "upload.bin"
    if not safe_display or len(safe_display) > _MAX_DISPLAY_NAME:
        raise ValidationProblem(
            detail=f"display_name must be 1-{_MAX_DISPLAY_NAME} characters", errors=None
        )
    if len(safe_name) > _MAX_FILE_NAME:
        raise ValidationProblem(
            detail=f"file_name must be <= {_MAX_FILE_NAME} characters", errors=None
        )
    if not isinstance(file_type, str) or not file_type or len(file_type) > _MAX_FILE_TYPE:
        raise ValidationProblem(
            detail=f"file_type must be 1-{_MAX_FILE_TYPE} characters", errors=None
        )
    return safe_display, safe_name, file_type


def _store_bytes(root: Path, knowledge_space_id: str, file_name: str, content: bytes, *, tenant_id: str | None = None) -> str:
    """把上传字节落盘到 root/knowledge/<tenant>/<ks>/<uuid>/<filename>。"""
    root = ensure_storage_root(root)
    target = _storage_target(root, tenant_id, knowledge_space_id)
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    _repair_directory_chain(target, root)
    # 防路径穿越：只取 basename
    safe_name = Path(file_name).name or "upload.bin"
    path = target / safe_name
    path.write_bytes(content)
    os.chmod(path, 0o600)
    return str(path.relative_to(root))


def _store_text(root: Path, knowledge_space_id: str, file_name: str, text: str, *, tenant_id: str | None = None) -> str:
    root = ensure_storage_root(root)
    target = _storage_target(root, tenant_id, knowledge_space_id)
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    _repair_directory_chain(target, root)
    safe_name = (Path(file_name).name or "page.html")
    if not safe_name.lower().endswith((".txt", ".html", ".md")):
        safe_name = safe_name + ".txt"
    path = target / safe_name
    path.write_text(text, encoding="utf-8")
    os.chmod(path, 0o600)
    return str(path.relative_to(root))


def _storage_target(root: Path, tenant_id: str | None, knowledge_space_id: str) -> Path:
    tenant = _storage_component(tenant_id, "_legacy")
    space = _storage_component(knowledge_space_id, "_space")
    namespace = root / "knowledge"
    for component in (namespace, namespace / tenant, namespace / tenant / space):
        if component.is_symlink():
            raise ValueError("symlinked knowledge namespace component is not allowed")
    target = namespace / tenant / space / uuid.uuid4().hex[:12]
    _assert_private_target(target, root)
    return target


def _assert_private_target(path: Path, root: Path) -> None:
    try:
        path.resolve().relative_to(root)
    except ValueError as exc:
        raise ValueError("storage target escapes configured knowledge root") from exc


def _repair_directory_chain(path: Path, root: Path) -> None:
    current = path
    while current != root:
        os.chmod(current, 0o700)
        current = current.parent


def _resolve_path(root: Path, storage_key: str) -> Path:
    """解析 storage_key 为绝对路径（防路径穿越及 root 前缀碰撞）。"""
    root_resolved = root.resolve()
    resolved = (root_resolved / storage_key).resolve()
    try:
        resolved.relative_to(root_resolved)
    except ValueError as exc:
        raise ValueError(f"storage_key escapes root: {storage_key!r}") from exc
    return resolved


# ─────────────────────────────── 鉴权 ───────────────────────────────


def _ensure_can_write(ctx: TenantContext) -> None:
    """intake 写操作鉴权（03 §9.7）。非 owner/enterprise_admin → 403。"""
    if not set(ctx.roles) & set(_INTAKE_WRITE_ROLES):
        raise Forbidden("knowledge document intake requires owner or enterprise_admin")


# ─────────────────────────────── 组装 ───────────────────────────────


def build_knowledge_intake_service(
    router: PgTenantRouter, *, storage_root: Path,
    rag_service: ManagerRagService,
    ingestion_client: RagIngestionPort,
) -> KnowledgeIntakeService:
    """组装 intake 服务；workspace 与 Manager ingestion client 显式注入。"""
    doc_repo, job_repo, binding_repo = build_knowledge_intake_repositories(router)
    return KnowledgeIntakeService(
        doc_repo=doc_repo,
        job_repo=job_repo,
        binding_repo=binding_repo,
        expert_binding=ExpertKnowledgeBinding(router),
        employee_index_port=_EmployeeKnowledgeBindingQuery(router),
        space_exists=_KnowledgeSpaceExists(router),
        storage_root=storage_root,
        rag_service=rag_service,
        ingestion_client=ingestion_client,
    )


__all__ = [
    "KnowledgeIntakeService",
    "build_knowledge_intake_service",
]
