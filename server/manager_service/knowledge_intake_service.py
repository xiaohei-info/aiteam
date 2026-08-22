"""知识文档 intake 编排（issue #416；04 §6.1.2/§6.6；D21/D22）。

编排 intake repository + 文档解析器，驱动状态机：uploaded → parsing → indexing → ready | failed；
重建经 reindex_requested，删除经 deleting（LightRAG 仅异步确认，不能伪造 deleted）。
完成时向 knowledge_space 已绑员工传播索引绑定（knowledge_document_binding）。

红线（D21）：
- 真实 LightRAG 写入只经 Manager-owned ingestion client；API key 不进入 Agent 或业务状态。
- workspace 只由 ManagerRagService 推导，本服务不接受外部 workspace。
- tenant_id 全程经 TenantContext（D22），不手写过滤。
"""

from __future__ import annotations

import hashlib
import logging
import os
import stat
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import ManagerRagService, PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound, ValidationProblem

from .document_parser import UnsupportedFormatError, extract_text
from .enterprise_audit_repository import build_enterprise_audit_repository
from .knowledge_intake_repository import (
    KnowledgeDocumentBindingRepository,
    KnowledgeDocumentRepository,
    KnowledgeIngestionJobRepository,
    KnowledgeOperationRepository,
    KnowledgeOperationRow,
    build_knowledge_intake_repositories,
)
from .knowledge_space_repository import ExpertKnowledgeBinding
from .rag_ingestion import RagIngestionPort, RagIngestionUnavailable
from .schemas import (
    KnowledgeDocumentBindingOut,
    KnowledgeDocumentOperationOut,
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
_MAX_IDEMPOTENCY_KEY = 256
_DELETE_RETRYABLE_ERROR_CODES = frozenset({
    "LIGHTRAG_UNAVAILABLE",
    "SOURCE_DELETE_FAILED",
})


class RagDeletionBusy(Conflict):
    """LightRAG reports that deletion is still busy; local access stays revoked."""

    status, code, title = 409, "knowledge_deletion_busy", "Knowledge deletion is busy"


class _EmployeeIndexBindingPort(Protocol):
    """员工 ↔ 知识空间绑定查询端口（解耦：不直接依赖 employee_knowledge_binding repository）。"""

    def list_employees_by_space(self, ctx: TenantContext, *, knowledge_space_id: str) -> list[str]: ...


class _SpaceExistsPort(Protocol):
    """知识空间存在性查询端口。"""

    def __call__(self, ctx: TenantContext, knowledge_space_id: str) -> bool: ...


class _AuditPort(Protocol):
    def record(
        self, ctx: TenantContext, *, actor: str, action: str,
        resource_type: str | None = None, resource_id: str | None = None,
        detail: str | None = None,
    ) -> object: ...


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
        operation_repo: KnowledgeOperationRepository | None = None,
        audit_recorder: _AuditPort | None = None,
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
        self._operation_repo = operation_repo
        self._audit = audit_recorder
        # Compatibility for unit/dev callers that predate the durable receipt
        # repository. Production always supplies KnowledgeOperationRepository.
        self._local_operations: dict[tuple[str, str], KnowledgeOperationRow] = {}
        self._local_latest_operations: dict[tuple[str, str, str], KnowledgeOperationRow] = {}

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
        idempotency_key: str | None = None,
    ) -> tuple[KnowledgeDocumentOut, KnowledgeIngestionJobOut]:
        """兼容旧 retry 路径，复用 reindex 状态机与 durable receipt。"""
        self.reindex(
            ctx,
            knowledge_space_id=knowledge_space_id,
            document_id=document_id,
            idempotency_key=idempotency_key,
        )
        updated = self._doc_repo.get(ctx, document_id=document_id)
        latest = self._job_repo.get_latest_by_document(ctx, document_id=document_id)
        if updated is None or latest is None:
            raise NotFound(f"document {document_id!r} disappeared during retry")
        return _to_doc_out(updated), _to_ing_out(latest)

    def reindex(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        idempotency_key: str | None = None,
    ) -> KnowledgeDocumentOperationOut:
        """重建当前租户文档的索引，旧 binding 在成功前保持不可检索。"""
        _ensure_can_write(ctx)
        return self._run_reindex(
            ctx,
            knowledge_space_id=knowledge_space_id,
            document_id=document_id,
            idempotency_key=idempotency_key,
        )

    def delete(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        idempotency_key: str | None = None,
    ) -> KnowledgeDocumentOperationOut:
        """请求 LightRAG 删除；started/busy 均不代表物理删除完成。"""
        _ensure_can_write(ctx)
        doc = self._require_doc(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id)
        key = _operation_key(idempotency_key)
        fingerprint = _fingerprint("delete", knowledge_space_id, document_id)
        existing = self._existing_operation(
            ctx, operation="delete", idempotency_key=key, request_fingerprint=fingerprint
        )
        if existing is not None:
            return self._operation_out(ctx, existing)
        if doc.status == "deleted":
            raise Conflict("cannot delete document in state 'deleted'")
        if doc.status not in ("ready", "failed", "deleting"):
            raise Conflict(
                f"cannot delete document in state {doc.status!r} "
                "(allowed: ready, failed, deleting)"
            )
        operation = self._create_operation(
            ctx,
            operation="delete",
            knowledge_space_id=knowledge_space_id,
            document_id=document_id,
            idempotency_key=key,
            request_fingerprint=fingerprint,
        )
        if (
            operation.request_fingerprint != fingerprint
            or operation.document_id != document_id
            or operation.knowledge_space_id != knowledge_space_id
        ):
            raise Conflict("idempotency key was already used for a different document operation")
        if operation.status != "pending":
            return self._operation_out(ctx, operation)
        if doc.status != "deleting":
            if not self._transition_document(
                ctx, document_id=document_id, expected=("ready", "failed"), status="deleting"
            ):
                self._update_operation(
                    ctx, operation_id=operation.id, status="failed",
                    error_code="STATE_CONFLICT", error_message="document changed while deletion was requested",
                )
                raise Conflict("document changed while deletion was being requested")
        # Revoke before calling LightRAG: a slow or failed upstream must not
        # leave an old citation readable.
        self._revoke_bindings(ctx, document_id=document_id)
        self._record_audit(
            ctx, action="knowledge_document_delete_requested", resource_id=document_id,
            detail="document status set to deleting; bindings revoked",
        )
        try:
            handle = self._rag_handle(ctx, knowledge_space_id)
            aliases = self._rag_document_ids(
                ctx, document_id=document_id, knowledge_space_id=knowledge_space_id
            )
            resolved_ids = self._resolve_rag_document_ids(
                workspace=handle.workspace, aliases=aliases
            )
            if not resolved_ids:
                operation = self._update_operation_or_replace(
                    ctx, operation, status="pending", upstream_status="absent",
                    error_code=None, error_message=None,
                )
                self._record_audit(
                    ctx, action="knowledge_document_delete_pending", resource_id=document_id,
                    detail="LightRAG document is absent; reconciliation will clean the source",
                )
                return self._operation_out(ctx, operation)
            result = self._ingestion_client.delete_document(
                workspace=handle.workspace,
                doc_ids=resolved_ids,
                delete_file=False,
                delete_llm_cache=True,
            )
            started = _result_flag(result, "deletion_started")
            busy = _result_flag(result, "busy")
            if not started and not busy:
                raise RagIngestionUnavailable("knowledge deletion unavailable")
        except RagIngestionUnavailable:
            self._update_operation(
                ctx, operation_id=operation.id, status="failed",
                upstream_status="unavailable", error_code="LIGHTRAG_UNAVAILABLE",
                error_message="knowledge deletion unavailable",
            )
            self._record_audit(
                ctx, action="knowledge_document_delete_failed", resource_id=document_id,
                detail="LightRAG deletion unavailable; document remains deleting",
            )
            raise
        except Exception as exc:
            logger.warning("[kb] delete failed for %s: %s", document_id, type(exc).__name__)
            self._update_operation(
                ctx, operation_id=operation.id, status="failed",
                upstream_status="unavailable", error_code="LIGHTRAG_UNAVAILABLE",
                error_message="knowledge deletion unavailable",
            )
            self._record_audit(
                ctx, action="knowledge_document_delete_failed", resource_id=document_id,
                detail="LightRAG deletion unavailable; document remains deleting",
            )
            raise RagIngestionUnavailable("knowledge deletion unavailable") from exc
        upstream_status = "deletion_started" if started else "busy"
        operation = self._update_operation(
            ctx, operation_id=operation.id, status="pending",
            upstream_status=upstream_status,
        ) or replace(operation, status="pending", upstream_status=upstream_status)
        self._record_audit(
            ctx, action="knowledge_document_delete_pending", resource_id=document_id,
            detail=f"LightRAG response={upstream_status}; document remains deleting",
        )
        if busy and not started:
            raise RagDeletionBusy(
                f"knowledge deletion is still busy; operation {operation.id} remains pending"
            )
        return self._operation_out(ctx, operation)

    def reconcile_delete(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        idempotency_key: str | None = None,
    ) -> KnowledgeDocumentOperationOut:
        """Reconcile LightRAG deletion and publish ``deleted`` only after proof.

        LightRAG 1.5.6 exposes no deletion track id.  The bounded document
        probe is therefore the only completion evidence; an unavailable or
        malformed probe leaves the local document fail-closed in ``deleting``.
        """
        _ensure_can_write(ctx)
        doc = self._require_doc(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id)
        fingerprint = _fingerprint("delete", knowledge_space_id, document_id)
        provided_key = _provided_operation_key(idempotency_key)
        operation = self._current_delete_operation(
            ctx,
            knowledge_space_id=knowledge_space_id,
            document_id=document_id,
            request_fingerprint=fingerprint,
            idempotency_key=provided_key,
        )
        if operation is None:
            raise Conflict("no current delete operation is available for reconciliation")
        if (
            operation.tenant_id != ctx.tenant_id
            or operation.operation != "delete"
            or operation.knowledge_space_id != knowledge_space_id
            or operation.document_id != document_id
            or operation.request_fingerprint != fingerprint
        ):
            raise Conflict("delete operation does not match this document")
        if doc.status == "deleted":
            if operation.status == "completed":
                # A repeated call with the same (or omitted) key is an idempotent
                # read of the durable completion receipt.
                return self._operation_out(ctx, operation)
            if not _delete_operation_retryable(operation):
                raise Conflict("delete operation is not retryable")
            completed = self._update_operation_or_replace(
                ctx, operation, status="completed", upstream_status="deleted",
                error_code=None, error_message=None, completed=True,
            )
            self._record_audit(
                ctx, action="knowledge_document_delete_reconciled", resource_id=document_id,
                detail="document already deleted; completion receipt repaired",
            )
            return self._operation_out(ctx, completed)
        if doc.status != "deleting":
            raise Conflict(
                f"cannot reconcile document in state {doc.status!r} "
                "(required: deleting)"
            )
        if not _delete_operation_retryable(operation):
            raise Conflict("delete operation is not retryable")

        try:
            handle = self._rag_handle(ctx, knowledge_space_id)
            aliases = self._rag_document_ids(
                ctx, document_id=document_id, knowledge_space_id=knowledge_space_id
            )
            resolved_ids = self._resolve_rag_document_ids(
                workspace=handle.workspace, aliases=aliases
            )
            if not resolved_ids:
                present_ids: set[str] = set()
            else:
                present = self._ingestion_client.document_ids_present(
                    workspace=handle.workspace, doc_ids=resolved_ids
                )
                if not isinstance(present, (set, frozenset)) or any(
                    not isinstance(value, str) for value in present
                ):
                    raise RagIngestionUnavailable("knowledge deletion unavailable")
                present_ids = set(present)
                if not present_ids.issubset(set(resolved_ids)):
                    raise RagIngestionUnavailable("knowledge deletion unavailable")
        except RagIngestionUnavailable as exc:
            operation = self._mark_reconcile_failed(
                ctx, operation, upstream_status="unavailable",
                error_code="LIGHTRAG_UNAVAILABLE",
            )
            self._record_audit(
                ctx, action="knowledge_document_delete_reconcile_failed", resource_id=document_id,
                detail="LightRAG deletion probe unavailable; document remains deleting",
            )
            raise RagIngestionUnavailable("knowledge deletion unavailable") from exc
        except Exception as exc:  # noqa: BLE001 - never expose upstream/storage details
            logger.warning("[kb] delete reconciliation probe failed: %s", type(exc).__name__)
            operation = self._mark_reconcile_failed(
                ctx, operation, upstream_status="unavailable",
                error_code="LIGHTRAG_UNAVAILABLE",
            )
            self._record_audit(
                ctx, action="knowledge_document_delete_reconcile_failed", resource_id=document_id,
                detail="LightRAG deletion probe unavailable; document remains deleting",
            )
            raise RagIngestionUnavailable("knowledge deletion unavailable") from exc

        if present_ids:
            operation = self._update_operation_or_replace(
                ctx, operation, status="pending", upstream_status="present",
                error_code=None, error_message=None,
            )
            self._record_audit(
                ctx, action="knowledge_document_delete_reconcile_pending", resource_id=document_id,
                detail="LightRAG document is still present; document remains deleting",
            )
            return self._operation_out(ctx, operation)

        try:
            _delete_source_file(
                self._storage_root,
                tenant_id=ctx.tenant_id,
                knowledge_space_id=knowledge_space_id,
                storage_key=doc.storage_key,
            )
        except (OSError, ValueError, TypeError) as exc:
            logger.warning("[kb] source cleanup failed: %s", type(exc).__name__)
            operation = self._mark_reconcile_failed(
                ctx, operation, upstream_status="source_unavailable",
                error_code="SOURCE_DELETE_FAILED",
            )
            self._record_audit(
                ctx, action="knowledge_document_delete_reconcile_failed", resource_id=document_id,
                detail="Manager source cleanup failed; document remains deleting",
            )
            raise RagIngestionUnavailable("knowledge deletion unavailable") from exc

        if not self._transition_document(
            ctx, document_id=document_id, expected=("deleting",), status="deleted",
            error_code=None, error_message=None,
        ):
            current = self._doc_repo.get(ctx, document_id=document_id)
            if current is not None and current.status == "deleted":
                completed = self._current_delete_operation(
                    ctx,
                    knowledge_space_id=knowledge_space_id,
                    document_id=document_id,
                    request_fingerprint=fingerprint,
                    idempotency_key=operation.idempotency_key,
                )
                if completed is not None and completed.status == "completed":
                    return self._operation_out(ctx, completed)
            self._update_operation(
                ctx, operation_id=operation.id, status="failed",
                upstream_status="state_conflict", error_code="STATE_CONFLICT",
                error_message="document changed while deletion was reconciled",
            )
            raise Conflict("document changed while deletion was being reconciled")

        updated = self._update_operation(
            ctx, operation_id=operation.id, status="completed",
            upstream_status="deleted", error_code=None, error_message=None, completed=True,
        )
        if self._operation_repo is not None and updated is None:
            # The document is already fail-closed as deleted, but do not return
            # a false durable receipt when its operation row could not update.
            self._record_audit(
                ctx, action="knowledge_document_delete_reconcile_failed", resource_id=document_id,
                detail="delete completion receipt unavailable after source cleanup",
            )
            raise RagIngestionUnavailable("knowledge deletion unavailable")
        operation = updated or replace(
            operation, status="completed", upstream_status="deleted",
            error_code=None, error_message=None, completed_at=datetime.now(timezone.utc),
        )
        self._record_audit(
            ctx, action="knowledge_document_delete_reconciled", resource_id=document_id,
            detail="LightRAG document absent; source removed and document marked deleted",
        )
        return self._operation_out(ctx, operation)

    # ─────────────────────────────── 内部 ───────────────────────────────

    def _run_reindex(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        idempotency_key: str | None,
    ) -> KnowledgeDocumentOperationOut:
        doc = self._require_doc(ctx, knowledge_space_id=knowledge_space_id, document_id=document_id)
        key = _operation_key(idempotency_key)
        fingerprint = _fingerprint("reindex", knowledge_space_id, document_id)
        existing = self._existing_operation(
            ctx, operation="reindex", idempotency_key=key, request_fingerprint=fingerprint
        )
        if existing is not None:
            return self._operation_out(ctx, existing)
        if doc.status not in ("ready", "failed"):
            raise Conflict(
                f"cannot reindex document in state {doc.status!r} "
                "(allowed: ready, failed)"
            )
        operation = self._create_operation(
            ctx,
            operation="reindex",
            knowledge_space_id=knowledge_space_id,
            document_id=document_id,
            idempotency_key=key,
            request_fingerprint=fingerprint,
        )
        if (
            operation.request_fingerprint != fingerprint
            or operation.document_id != document_id
            or operation.knowledge_space_id != knowledge_space_id
        ):
            raise Conflict("idempotency key was already used for a different document operation")
        if operation.status != "pending":
            return self._operation_out(ctx, operation)
        if not self._transition_document(
            ctx, document_id=document_id, expected=("ready", "failed"), status="reindex_requested",
            error_code=None, error_message=None,
        ):
            self._update_operation(
                ctx, operation_id=operation.id, status="failed",
                error_code="STATE_CONFLICT", error_message="document changed while reindex was requested",
            )
            raise Conflict("document changed while reindex was being requested")
        # Keep old citations unavailable while the new index is built.
        self._binding_repo.mark_stale_by_document(ctx, document_id=document_id)
        self._record_audit(
            ctx, action="knowledge_document_reindex_requested", resource_id=document_id,
            detail="document status set to reindex_requested; bindings stale",
        )
        job = self._job_repo.create(
            ctx,
            knowledge_space_id=knowledge_space_id,
            document_id=document_id,
            status="reindex_requested",
            started_at=datetime.now(timezone.utc),
        )
        try:
            self._advance(
                ctx,
                knowledge_space_id=knowledge_space_id,
                document_id=document_id,
                job_id=job.id,
                propagate_unavailable=True,
            )
        except RagIngestionUnavailable:
            self._update_operation(
                ctx, operation_id=operation.id, status="failed",
                upstream_status="unavailable", error_code="LIGHTRAG_UNAVAILABLE",
                error_message="knowledge indexing unavailable",
            )
            self._record_audit(
                ctx, action="knowledge_document_reindex_failed", resource_id=document_id,
                detail="LightRAG indexing unavailable; document remains failed",
            )
            raise
        updated = self._doc_repo.get(ctx, document_id=document_id)
        if updated is None:
            self._update_operation(
                ctx, operation_id=operation.id, status="failed",
                error_code="DOCUMENT_UNAVAILABLE", error_message="knowledge document unavailable",
            )
            raise RagIngestionUnavailable("knowledge indexing unavailable")
        if updated.status == "ready":
            self._record_audit(
                ctx, action="knowledge_document_reindex_completed", resource_id=document_id,
                detail="document and current bindings published ready",
            )
            operation = self._update_operation(
                ctx, operation_id=operation.id, status="completed",
                upstream_status="processed", completed=True,
            ) or replace(operation, status="completed", upstream_status="processed")
        else:
            self._record_audit(
                ctx, action="knowledge_document_reindex_failed", resource_id=document_id,
                detail="document intake failed; document remains retryable",
            )
            operation = self._update_operation(
                ctx, operation_id=operation.id, status="failed",
                upstream_status="failed", error_code=updated.error_code,
                error_message=updated.error_message,
            ) or replace(
                operation, status="failed", upstream_status="failed",
                error_code=updated.error_code, error_message=updated.error_message,
            )
        return self._operation_out(ctx, operation)

    def _existing_operation(
        self,
        ctx: TenantContext,
        *,
        operation: str,
        idempotency_key: str,
        request_fingerprint: str,
    ) -> KnowledgeOperationRow | None:
        row = None
        if self._operation_repo is not None:
            row = self._operation_repo.get_by_key(
                ctx, operation=operation, idempotency_key=idempotency_key
            )
        if row is None:
            row = self._local_operations.get((operation, idempotency_key))
        if row is not None and row.request_fingerprint != request_fingerprint:
            raise Conflict("idempotency key was already used for a different document operation")
        return row

    def _current_delete_operation(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        request_fingerprint: str,
        idempotency_key: str | None,
    ) -> KnowledgeOperationRow | None:
        if idempotency_key is not None:
            # A reconciliation request has its own retry key. It may be a
            # fresh key generated by the UI, so first honor an exact existing
            # operation key and then fall back to the latest delete receipt for
            # this document. The fingerprint check below still prevents a
            # cross-document or cross-space lookup.
            row = self._existing_operation(
                ctx, operation="delete", idempotency_key=idempotency_key,
                request_fingerprint=request_fingerprint,
            )
            if row is not None:
                return row
        row = None
        if self._operation_repo is not None:
            getter = getattr(self._operation_repo, "get_latest_by_document", None)
            if getter is not None:
                row = getter(
                    ctx, operation="delete", knowledge_space_id=knowledge_space_id,
                    document_id=document_id,
                )
        if row is None:
            row = self._local_latest_operations.get(("delete", knowledge_space_id, document_id))
        if row is not None and row.request_fingerprint != request_fingerprint:
            raise Conflict("current delete operation does not match this document")
        return row

    def _remember_operation(self, operation: KnowledgeOperationRow) -> KnowledgeOperationRow:
        if self._operation_repo is not None and hasattr(
            self._operation_repo, "get_latest_by_document"
        ):
            return operation
        self._local_operations[(operation.operation, operation.idempotency_key)] = operation
        self._local_latest_operations[
            (operation.operation, operation.knowledge_space_id, operation.document_id)
        ] = operation
        return operation

    def _create_operation(
        self,
        ctx: TenantContext,
        *,
        operation: str,
        knowledge_space_id: str,
        document_id: str,
        idempotency_key: str,
        request_fingerprint: str,
    ) -> KnowledgeOperationRow:
        if self._operation_repo is None:
            # Unit/dev callers that predate the lifecycle receipt still execute
            # the same state machine; production builder always injects this repo.
            row = KnowledgeOperationRow(
                id=uuid.uuid4().hex, tenant_id=ctx.tenant_id,
                knowledge_space_id=knowledge_space_id, document_id=document_id,
                operation=operation, idempotency_key=idempotency_key,
                request_fingerprint=request_fingerprint, status="pending",
            )
            return self._remember_operation(row)
        return self._remember_operation(self._operation_repo.create(
            ctx,
            knowledge_space_id=knowledge_space_id,
            document_id=document_id,
            operation=operation,
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
        ))

    def _update_operation(self, ctx: TenantContext, **kwargs) -> KnowledgeOperationRow | None:
        if self._operation_repo is not None:
            updated = self._operation_repo.update(ctx, **kwargs)
            return self._remember_operation(updated) if updated is not None else None
        operation_id = kwargs.get("operation_id")
        row = next(
            (candidate for candidate in self._local_operations.values() if candidate.id == operation_id),
            None,
        )
        if row is None:
            return None
        completed = kwargs.get("completed", False)
        updated = replace(
            row,
            status=kwargs["status"],
            upstream_status=kwargs.get("upstream_status"),
            error_code=kwargs.get("error_code"),
            error_message=kwargs.get("error_message"),
            completed_at=(datetime.now(timezone.utc) if completed else row.completed_at),
        )
        return self._remember_operation(updated)

    def _update_operation_or_replace(
        self, ctx: TenantContext, operation: KnowledgeOperationRow, **kwargs
    ) -> KnowledgeOperationRow:
        updated = self._update_operation(ctx, operation_id=operation.id, **kwargs)
        if updated is not None:
            return updated
        if self._operation_repo is not None:
            raise RagIngestionUnavailable("knowledge deletion unavailable")
        completed = kwargs.get("completed", False)
        return self._remember_operation(replace(
            operation,
            status=kwargs["status"],
            upstream_status=kwargs.get("upstream_status"),
            error_code=kwargs.get("error_code"),
            error_message=kwargs.get("error_message"),
            completed_at=(datetime.now(timezone.utc) if completed else operation.completed_at),
        ))

    def _mark_reconcile_failed(
        self,
        ctx: TenantContext,
        operation: KnowledgeOperationRow,
        *,
        upstream_status: str,
        error_code: str,
    ) -> KnowledgeOperationRow:
        try:
            updated = self._update_operation(
                ctx, operation_id=operation.id, status="failed",
                upstream_status=upstream_status, error_code=error_code,
                error_message="knowledge deletion unavailable",
            )
        except Exception as exc:  # noqa: BLE001 - preserve sanitized upstream error
            logger.warning("[kb] delete operation update failed: %s", type(exc).__name__)
            updated = None
        if updated is not None:
            return updated
        return self._remember_operation(replace(
            operation, status="failed", upstream_status=upstream_status,
            error_code=error_code, error_message="knowledge deletion unavailable",
        ))

    def _operation_out(
        self, ctx: TenantContext, operation: KnowledgeOperationRow
    ) -> KnowledgeDocumentOperationOut:
        doc = self._doc_repo.get(ctx, document_id=operation.document_id)
        if (
            operation.tenant_id != ctx.tenant_id
            or doc is None
            or doc.tenant_id != ctx.tenant_id
            or doc.knowledge_space_id != operation.knowledge_space_id
        ):
            raise NotFound("knowledge document operation target is unavailable")
        return KnowledgeDocumentOperationOut(
            operation_id=operation.id,
            operation=operation.operation,
            idempotency_key=operation.idempotency_key,
            tenant_id=ctx.tenant_id,
            knowledge_space_id=operation.knowledge_space_id,
            document_id=operation.document_id,
            status=operation.status,
            document_status=doc.status,
            upstream_status=operation.upstream_status,
            error_code=operation.error_code,
            error_message=operation.error_message,
            created_at=operation.created_at,
            updated_at=operation.updated_at,
            completed_at=operation.completed_at,
        )

    def _transition_document(
        self,
        ctx: TenantContext,
        *,
        document_id: str,
        expected: tuple[str, ...],
        status: str,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> bool:
        transition = getattr(self._doc_repo, "transition_status", None)
        if transition is not None:
            return transition(
                ctx, document_id, expected=expected, status=status,
                error_code=error_code, error_message=error_message,
            )
        # Compatibility for in-memory repositories supplied by existing tests.
        doc = self._doc_repo.get(ctx, document_id=document_id)
        if doc is None or doc.status not in expected:
            return False
        return self._doc_repo.update_status(
            ctx, document_id, status=status, error_code=error_code, error_message=error_message
        )

    def _revoke_bindings(self, ctx: TenantContext, *, document_id: str) -> None:
        revoke = getattr(self._binding_repo, "mark_revoked_by_document", None)
        if revoke is not None:
            revoke(ctx, document_id=document_id)
            return
        # Compatibility for old in-memory repositories: stale is also denied
        # by the read facade, while production uses the explicit revoked state.
        self._binding_repo.mark_stale_by_document(ctx, document_id=document_id)

    def _record_audit(
        self, ctx: TenantContext, *, action: str, resource_id: str, detail: str
    ) -> None:
        if self._audit is None:
            return
        try:
            self._audit.record(
                ctx, actor=ctx.user_id, action=action,
                resource_type="knowledge_document", resource_id=resource_id, detail=detail,
            )
        except Exception:  # noqa: BLE001 - lifecycle state must not fail on audit outage
            logger.warning("[kb] lifecycle audit write failed for %s", resource_id)

    def _rag_handle(self, ctx: TenantContext, knowledge_space_id: str):
        handle = self._rag_service.get(ctx, knowledge_space_id)
        if (
            handle is None
            or handle.tenant_id != ctx.tenant_id
            or handle.knowledge_space_id != knowledge_space_id
            or not isinstance(handle.workspace, str)
            or not handle.workspace.strip()
        ):
            raise RagIngestionUnavailable("knowledge deletion unavailable")
        registry = getattr(self._ingestion_client, "instance_registry", None)
        if registry is not None:
            try:
                instance = registry.resolve(handle.workspace)
            except Exception as exc:
                raise RagIngestionUnavailable("knowledge deletion unavailable") from exc
            if getattr(handle, "instance_id", "legacy") != instance.instance_id:
                raise RagIngestionUnavailable("knowledge deletion unavailable")
        return handle

    def _rag_document_ids(
        self, ctx: TenantContext, *, document_id: str, knowledge_space_id: str
    ) -> list[str]:
        """Return binding ids plus the Manager id as resolver candidates."""
        rows = self._binding_repo.list_by_document(ctx, document_id=document_id)
        ids: set[str] = {document_id}
        for row in rows:
            if (
                row.tenant_id != ctx.tenant_id
                or row.document_id != document_id
                or row.knowledge_space_id != knowledge_space_id
            ):
                raise RagIngestionUnavailable("knowledge deletion unavailable")
            rag_document_id = row.rag_document_id
            if rag_document_id is None:
                continue
            if (
                not isinstance(rag_document_id, str)
                or not rag_document_id.strip()
                or rag_document_id != rag_document_id.strip()
                or len(rag_document_id) > 1_024
                or any(char in rag_document_id for char in "\x00\r\n")
            ):
                raise RagIngestionUnavailable("knowledge deletion unavailable")
            ids.add(rag_document_id)
        return sorted(ids)

    def _resolve_rag_document_ids(self, *, workspace: str, aliases: list[str]) -> list[str]:
        """Resolve aliases before a delete/probe; retain old fake-port compatibility."""
        resolver = getattr(self._ingestion_client, "resolve_document_id", None)
        if resolver is None:
            return aliases
        resolved = resolver(workspace=workspace, aliases=aliases)
        if resolved is None:
            return []
        if (
            not isinstance(resolved, str)
            or not resolved.strip()
            or resolved != resolved.strip()
            or len(resolved) > 1_024
            or any(char in resolved for char in "\x00\r\n")
        ):
            raise RagIngestionUnavailable("knowledge deletion unavailable")
        return [resolved]

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
        propagate_unavailable: bool = False,
    ) -> None:
        """推进 parsing → indexing → ready | failed；重建可传播上游不可达。"""
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
            registry = getattr(self._ingestion_client, "instance_registry", None)
            if registry is not None:
                instance = registry.resolve(handle.workspace)
                if getattr(handle, "instance_id", "legacy") != instance.instance_id:
                    raise RagIngestionUnavailable("knowledge indexing unavailable")
            result = self._ingestion_client.ingest_text(
                workspace=handle.workspace, file_source=document_id, text=text
            )
            if not result or getattr(result, "rag_document_id", None) != document_id:
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            upstream_document_id = getattr(result, "upstream_document_id", None)
            if upstream_document_id is not None and (
                not isinstance(upstream_document_id, str)
                or not upstream_document_id.strip()
                or upstream_document_id != upstream_document_id.strip()
                or len(upstream_document_id) > 1_024
                or any(char in upstream_document_id for char in "\x00\r\n")
            ):
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            binding_rag_document_id = upstream_document_id or document_id
        except Exception as exc:
            if not isinstance(exc, RagIngestionUnavailable):
                logger.warning("[kb] index failed for %s: %s", document_id, type(exc).__name__)
            self._fail(
                ctx, document_id=document_id, job_id=job_id,
                error_code="INDEX_FAILED", message="knowledge indexing unavailable",
            )
            if propagate_unavailable:
                raise RagIngestionUnavailable("knowledge indexing unavailable") from exc
            return
        # Bindings, job completion, and Manager ready are one DB transaction.
        try:
            employee_ids = sorted(set(self._employee_index_port.list_employees_by_space(
                ctx, knowledge_space_id=knowledge_space_id
            )))
            published_at = datetime.now(timezone.utc)
            self._binding_repo.publish_ready(
                ctx, knowledge_space_id=knowledge_space_id, document_id=document_id,
                employee_ids=employee_ids, rag_document_id=binding_rag_document_id,
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
        if (
            doc is None
            or doc.tenant_id != ctx.tenant_id
            or doc.knowledge_space_id != knowledge_space_id
        ):
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


def _operation_key(value: str | None) -> str:
    key = value.strip() if isinstance(value, str) else ""
    if not key:
        return uuid.uuid4().hex
    if len(key) > _MAX_IDEMPOTENCY_KEY or any(char in key for char in "\r\n"):
        raise ValidationProblem(detail="Idempotency-Key is invalid", errors=None)
    return key


def _fingerprint(operation: str, knowledge_space_id: str, document_id: str) -> str:
    return hashlib.sha256(
        f"{operation}|{knowledge_space_id}|{document_id}".encode("utf-8")
    ).hexdigest()


def _result_flag(result: object, field: str) -> bool:
    if isinstance(result, dict):
        value = result.get(field)
    else:
        value = getattr(result, field, False)
    return value is True


def _provided_operation_key(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return _operation_key(value)


def _delete_operation_retryable(operation: KnowledgeOperationRow) -> bool:
    return operation.status == "pending" or (
        operation.status == "failed"
        and operation.error_code in _DELETE_RETRYABLE_ERROR_CODES
    )


def _delete_source_file(
    root: Path,
    *,
    tenant_id: str,
    knowledge_space_id: str,
    storage_key: str,
) -> None:
    """Unlink one Manager source below its tenant/space directory only.

    Directory descriptors with ``O_NOFOLLOW`` prevent a concurrent symlink
    swap from redirecting the unlink outside the private knowledge root.
    """
    if not isinstance(storage_key, str) or not storage_key or "\x00" in storage_key:
        raise ValueError("invalid knowledge storage key")
    parts = Path(storage_key).parts
    tenant = _storage_component(tenant_id, "_legacy")
    space = _storage_component(knowledge_space_id, "_space")
    if (
        Path(storage_key).is_absolute()
        or len(parts) < 4
        or parts[:3] != ("knowledge", tenant, space)
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise ValueError("knowledge source is outside its tenant root")

    root_resolved = root.resolve()
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    current_fd: int | None = None
    try:
        current_fd = os.open(root_resolved, flags)
        for component in parts[:-1]:
            try:
                next_fd = os.open(component, flags, dir_fd=current_fd)
            except FileNotFoundError:
                return
            os.close(current_fd)
            current_fd = next_fd
        try:
            source_stat = os.stat(parts[-1], dir_fd=current_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError("knowledge source is not a regular file")
        os.unlink(parts[-1], dir_fd=current_fd)
    finally:
        if current_fd is not None:
            os.close(current_fd)


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
        operation_repo=KnowledgeOperationRepository(router),
        audit_recorder=build_enterprise_audit_repository(router),
    )


__all__ = [
    "KnowledgeIntakeService",
    "RagDeletionBusy",
    "build_knowledge_intake_service",
]
