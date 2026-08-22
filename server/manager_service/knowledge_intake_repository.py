"""知识文档 intake 租户作用域数据访问（issue #416；04 §6.1.2/§6.6；D21/D22）。

铁律：所有方法以 TenantContext 为隔离边界，tenant_id 只从 ctx 读，SQL 不接受调用方手写 tenant 过滤字符串（D22）；
RLS 强制跨租户隔离。

三个 repository：
- KnowledgeDocumentRepository：文档级实体 CRUD（knowledge_document 表）。
- KnowledgeIngestionJobRepository：intake 任务跟踪（knowledge_ingestion_job 表）。
- KnowledgeDocumentBindingRepository：文档 ↔ 员工索引绑定（knowledge_document_binding 表），
  含向知识空间已绑员工传播索引绑定的幂等 upsert。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

_DOC_COLUMNS = (
    "id, tenant_id, knowledge_space_id, display_name, source_type, file_name, file_type, "
    "file_size, storage_key, status, text_chars, error_code, error_message, created_at, updated_at"
)
_INGEST_COLUMNS = (
    "id, tenant_id, knowledge_space_id, document_id, status, error_code, error_message, "
    "chunk_count, started_at, completed_at, created_at"
)
_BIND_COLUMNS = (
    "id, tenant_id, knowledge_space_id, document_id, employee_id, rag_document_id, "
    "status, last_synced_at, created_at"
)
_OPERATION_COLUMNS = (
    "id, tenant_id, knowledge_space_id, document_id, operation, idempotency_key, "
    "request_fingerprint, status, upstream_status, error_code, error_message, "
    "created_at, updated_at, completed_at"
)


def _s(value: Any) -> str:
    return str(value)


# ─────────────────────────────── Document ───────────────────────────────


@dataclass(frozen=True)
class KnowledgeDocumentRow:
    id: str
    tenant_id: str
    knowledge_space_id: str
    display_name: str
    source_type: str
    file_name: str
    file_type: str
    file_size: int
    storage_key: str
    status: str
    text_chars: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


def _row_to_doc(row: Any) -> KnowledgeDocumentRow:
    return KnowledgeDocumentRow(
        id=_s(row[0]), tenant_id=_s(row[1]), knowledge_space_id=row[2], display_name=row[3],
        source_type=row[4], file_name=row[5], file_type=row[6], file_size=row[7] or 0,
        storage_key=row[8], status=row[9], text_chars=row[10], error_code=row[11],
        error_message=row[12], created_at=row[13], updated_at=row[14],
    )


class KnowledgeDocumentRepository:
    """文档级实体访问。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(
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
        status: str,
    ) -> KnowledgeDocumentRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO knowledge_document "
                "(tenant_id, knowledge_space_id, display_name, source_type, file_name, file_type, "
                "file_size, storage_key, status) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) "
                "RETURNING " + _DOC_COLUMNS,
                (ctx.tenant_id, knowledge_space_id, display_name, source_type, file_name,
                 file_type, file_size, storage_key, status),
            ).fetchone()
        assert row is not None
        return _row_to_doc(row)

    def get(self, ctx: TenantContext, *, document_id: str) -> KnowledgeDocumentRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _DOC_COLUMNS + " FROM knowledge_document WHERE id = %s",
                (document_id,),
            ).fetchone()
        return _row_to_doc(row) if row is not None else None

    def list_by_space(
        self, ctx: TenantContext, *, knowledge_space_id: str
    ) -> list[KnowledgeDocumentRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _DOC_COLUMNS + " FROM knowledge_document "
                "WHERE knowledge_space_id = %s ORDER BY created_at",
                (knowledge_space_id,),
            ).fetchall()
        return [_row_to_doc(r) for r in rows]

    def update_status(
        self,
        ctx: TenantContext,
        document_id: str,
        *,
        status: str,
        text_chars: int | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> bool:
        """带输出列的状态推进（统一 updated_at = now()）。"""
        with self._router.session(ctx) as s:
            cur = s.execute(
                "UPDATE knowledge_document SET status = %s, text_chars = COALESCE(%s, text_chars), "
                "error_code = %s, error_message = %s, updated_at = now() WHERE id = %s",
                (status, text_chars, error_code, error_message, document_id),
            )
            return cur.rowcount > 0

    def transition_status(
        self,
        ctx: TenantContext,
        document_id: str,
        *,
        expected: tuple[str, ...],
        status: str,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> bool:
        """CAS 状态推进，避免并发 delete/reindex 覆盖彼此的状态。"""
        if not expected:
            return False
        placeholders = ", ".join(["%s"] * len(expected))
        with self._router.session(ctx) as s:
            cur = s.execute(
                "UPDATE knowledge_document SET status = %s, error_code = %s, "
                "error_message = %s, updated_at = now() WHERE id = %s AND status IN ("
                + placeholders + ")",
                (status, error_code, error_message, document_id, *expected),
            )
            return cur.rowcount > 0


# ─────────────────────────────── Ingestion Job ───────────────────────────────


@dataclass(frozen=True)
class KnowledgeIngestionJobRow:
    id: str
    tenant_id: str
    knowledge_space_id: str
    document_id: str
    status: str
    error_code: str | None = None
    error_message: str | None = None
    chunk_count: int | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime | None = None


def _row_to_ing(row: Any) -> KnowledgeIngestionJobRow:
    return KnowledgeIngestionJobRow(
        id=_s(row[0]), tenant_id=_s(row[1]), knowledge_space_id=row[2], document_id=_s(row[3]),
        status=row[4], error_code=row[5], error_message=row[6], chunk_count=row[7],
        started_at=row[8], completed_at=row[9], created_at=row[10],
    )


class KnowledgeIngestionJobRepository:
    """intake 任务访问。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        status: str,
        started_at: datetime | None = None,
    ) -> KnowledgeIngestionJobRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO knowledge_ingestion_job "
                "(tenant_id, knowledge_space_id, document_id, status, started_at) "
                "VALUES (%s, %s, %s, %s, %s) RETURNING " + _INGEST_COLUMNS,
                (ctx.tenant_id, knowledge_space_id, document_id, status, started_at),
            ).fetchone()
        assert row is not None
        return _row_to_ing(row)

    def get(self, ctx: TenantContext, *, ingestion_id: str) -> KnowledgeIngestionJobRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _INGEST_COLUMNS + " FROM knowledge_ingestion_job WHERE id = %s",
                (ingestion_id,),
            ).fetchone()
        return _row_to_ing(row) if row is not None else None

    def get_latest_by_document(
        self, ctx: TenantContext, *, document_id: str
    ) -> KnowledgeIngestionJobRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _INGEST_COLUMNS + " FROM knowledge_ingestion_job "
                "WHERE document_id = %s ORDER BY created_at DESC LIMIT 1",
                (document_id,),
            ).fetchone()
        return _row_to_ing(row) if row is not None else None

    def list_by_document(
        self, ctx: TenantContext, *, document_id: str
    ) -> list[KnowledgeIngestionJobRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _INGEST_COLUMNS + " FROM knowledge_ingestion_job "
                "WHERE document_id = %s ORDER BY created_at",
                (document_id,),
            ).fetchall()
        return [_row_to_ing(r) for r in rows]

    def list_by_space(
        self, ctx: TenantContext, *, knowledge_space_id: str
    ) -> list[KnowledgeIngestionJobRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _INGEST_COLUMNS + " FROM knowledge_ingestion_job "
                "WHERE knowledge_space_id = %s ORDER BY created_at",
                (knowledge_space_id,),
            ).fetchall()
        return [_row_to_ing(r) for r in rows]

    def mark_done(
        self,
        ctx: TenantContext,
        ingestion_id: str,
        *,
        chunk_count: int | None,
        completed_at: datetime,
    ) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute(
                "UPDATE knowledge_ingestion_job SET status = 'done', chunk_count = %s, "
                "completed_at = %s WHERE id = %s AND status <> 'done'",
                (chunk_count, completed_at, ingestion_id),
            )
            return cur.rowcount > 0

    def mark_failed(
        self,
        ctx: TenantContext,
        ingestion_id: str,
        *,
        error_code: str,
        error_message: str,
        completed_at: datetime,
    ) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute(
                "UPDATE knowledge_ingestion_job SET status = 'failed', error_code = %s, "
                "error_message = %s, completed_at = %s WHERE id = %s AND status NOT IN ('done', 'failed')",
                (error_code, error_message[:2000], completed_at, ingestion_id),
            )
            return cur.rowcount > 0

    def update_status(
        self, ctx: TenantContext, ingestion_id: str, *, status: str
    ) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute(
                "UPDATE knowledge_ingestion_job SET status = %s WHERE id = %s",
                (status, ingestion_id),
            )
            return cur.rowcount > 0


# ─────────────────────────────── Document Binding ───────────────────────────────


@dataclass(frozen=True)
class KnowledgeDocumentBindingRow:
    id: str
    tenant_id: str
    knowledge_space_id: str
    document_id: str
    employee_id: str
    rag_document_id: str | None
    status: str
    last_synced_at: datetime | None
    created_at: datetime | None


def _row_to_bind(row: Any) -> KnowledgeDocumentBindingRow:
    return KnowledgeDocumentBindingRow(
        id=_s(row[0]), tenant_id=_s(row[1]), knowledge_space_id=row[2], document_id=_s(row[3]),
        employee_id=_s(row[4]), rag_document_id=row[5], status=row[6],
        last_synced_at=row[7], created_at=row[8],
    )


class KnowledgeDocumentBindingRepository:
    """文档 ↔ 员工索引绑定访问。tenant_id 取自 ctx（D22）。

    传播绑定：intake 完成后，向 knowledge_space 已绑员工幂等 upsert knowledge_document_binding。
    员工绑定真相态走 employee_knowledge_binding（D21）；本表为检索侧视图。
    """

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def _upsert_ready_many_in_session(
        self,
        s: Any,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        employee_ids: list[str],
        rag_document_id: str,
        synced_at: datetime,
    ) -> int:
        if not employee_ids:
            return 0
        values = ", ".join(["(%s, %s, %s, %s, %s, 'ready', %s)"] * len(employee_ids))
        params: list[Any] = []
        for employee_id in employee_ids:
            params.extend((ctx.tenant_id, knowledge_space_id, document_id, employee_id,
                           rag_document_id, synced_at))
        cur = s.execute(
            "INSERT INTO knowledge_document_binding "
            "(tenant_id, knowledge_space_id, document_id, employee_id, "
            "rag_document_id, status, last_synced_at) VALUES " + values +
            " ON CONFLICT (tenant_id, document_id, employee_id) DO UPDATE SET "
            "knowledge_space_id = EXCLUDED.knowledge_space_id, "
            "rag_document_id = EXCLUDED.rag_document_id, status = 'ready', "
            "last_synced_at = EXCLUDED.last_synced_at",
            tuple(params),
        )
        return cur.rowcount

    def upsert_ready_many(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        employee_ids: list[str],
        rag_document_id: str,
        synced_at: datetime,
    ) -> int:
        """Bulk upsert propagation in one INSERT ... ON CONFLICT statement."""
        with self._router.session(ctx) as s:
            return self._upsert_ready_many_in_session(
                s, ctx, knowledge_space_id=knowledge_space_id, document_id=document_id,
                employee_ids=employee_ids, rag_document_id=rag_document_id, synced_at=synced_at,
            )

    def publish_ready(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        employee_ids: list[str],
        rag_document_id: str,
        job_id: str,
        chunk_count: int | None,
        text_chars: int,
        completed_at: datetime,
        synced_at: datetime,
    ) -> int:
        """Publish bindings, job completion, and document readiness atomically."""
        with self._router.session(ctx) as s:
            count = self._upsert_ready_many_in_session(
                s, ctx, knowledge_space_id=knowledge_space_id, document_id=document_id,
                employee_ids=employee_ids, rag_document_id=rag_document_id, synced_at=synced_at,
            )
            job = s.execute(
                "UPDATE knowledge_ingestion_job SET status = 'done', chunk_count = %s, "
                "completed_at = %s WHERE id = %s AND status = 'indexing'",
                (chunk_count, completed_at, job_id),
            )
            if job.rowcount != 1:
                raise RuntimeError("ingestion job publication failed")
            document = s.execute(
                "UPDATE knowledge_document SET status = 'ready', text_chars = %s, "
                "error_code = NULL, error_message = NULL, updated_at = now() "
                "WHERE id = %s AND status = 'indexing'",
                (text_chars, document_id),
            )
            if document.rowcount != 1:
                raise RuntimeError("knowledge document publication failed")
            return count

    def upsert_ready(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        employee_id: str,
        rag_document_id: str | None,
        synced_at: datetime,
    ) -> KnowledgeDocumentBindingRow:
        """幂等 upsert：存在则刷新为 ready + rag_document_id；不存在则新建。"""
        with self._router.session(ctx) as s:
            # Use one INSERT ... ON CONFLICT statement so concurrent propagation cannot race.
            cur = s.execute(
                "INSERT INTO knowledge_document_binding "
                "(tenant_id, knowledge_space_id, document_id, employee_id, "
                "rag_document_id, status, last_synced_at) "
                "VALUES (%s, %s, %s, %s, %s, 'ready', %s) "
                "ON CONFLICT (tenant_id, document_id, employee_id) DO UPDATE SET "
                "knowledge_space_id = EXCLUDED.knowledge_space_id, "
                "rag_document_id = EXCLUDED.rag_document_id, status = 'ready', "
                "last_synced_at = EXCLUDED.last_synced_at "
                "RETURNING " + _BIND_COLUMNS,
                (ctx.tenant_id, knowledge_space_id, document_id, employee_id,
                 rag_document_id, synced_at),
            )
            row = cur.fetchone()
        assert row is not None
        return _row_to_bind(row)

    def backfill_ready_for_employee(
        self, ctx: TenantContext, *, knowledge_space_id: str, employee_id: str,
    ) -> int:
        """Create read bindings for ready documents when an employee is newly bound."""
        with self._router.session(ctx) as s:
            cur = s.execute(
                "INSERT INTO knowledge_document_binding "
                "(tenant_id, knowledge_space_id, document_id, employee_id, rag_document_id, status, last_synced_at) "
                "SELECT %s, d.knowledge_space_id, d.id, %s, d.id, 'ready', now() "
                "FROM knowledge_document d "
                "WHERE d.knowledge_space_id = %s AND d.status = 'ready' "
                "ON CONFLICT (tenant_id, document_id, employee_id) DO UPDATE SET "
                "rag_document_id = EXCLUDED.rag_document_id, status = 'ready', "
                "last_synced_at = EXCLUDED.last_synced_at",
                (ctx.tenant_id, employee_id, knowledge_space_id),
            )
            return cur.rowcount

    def mark_stale_by_document(self, ctx: TenantContext, *, document_id: str) -> int:
        """文档重新 intake 时将其已有 binding 标 stale（避免下游读到过期 rag_document_id）。"""
        with self._router.session(ctx) as s:
            cur = s.execute(
                "UPDATE knowledge_document_binding SET status = 'stale' "
                "WHERE document_id = %s AND status = 'ready'",
                (document_id,),
            )
            return cur.rowcount

    def mark_revoked_by_document(self, ctx: TenantContext, *, document_id: str) -> int:
        """撤销文档全部检索绑定，但保留绑定行作为审计/恢复依据。"""
        with self._router.session(ctx) as s:
            cur = s.execute(
                "UPDATE knowledge_document_binding SET status = 'revoked' "
                "WHERE document_id = %s AND status <> 'revoked'",
                (document_id,),
            )
            return cur.rowcount

    def list_by_document(
        self, ctx: TenantContext, *, document_id: str
    ) -> list[KnowledgeDocumentBindingRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _BIND_COLUMNS + " FROM knowledge_document_binding "
                "WHERE document_id = %s ORDER BY created_at",
                (document_id,),
            ).fetchall()
        return [_row_to_bind(r) for r in rows]

    def list_by_employee(
        self, ctx: TenantContext, *, employee_id: str, status: str | None = None
    ) -> list[KnowledgeDocumentBindingRow]:
        with self._router.session(ctx) as s:
            if status:
                rows = s.execute(
                    "SELECT " + _BIND_COLUMNS + " FROM knowledge_document_binding "
                    "WHERE employee_id = %s AND status = %s ORDER BY created_at",
                    (employee_id, status),
                ).fetchall()
            else:
                rows = s.execute(
                    "SELECT " + _BIND_COLUMNS + " FROM knowledge_document_binding "
                    "WHERE employee_id = %s ORDER BY created_at",
                    (employee_id,),
                ).fetchall()
        return [_row_to_bind(r) for r in rows]


# ─────────────────────────────── Lifecycle operation receipt ───────────────────────────────


@dataclass(frozen=True)
class KnowledgeOperationRow:
    id: str
    tenant_id: str
    knowledge_space_id: str
    document_id: str
    operation: str
    idempotency_key: str
    request_fingerprint: str
    status: str
    upstream_status: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None


def _row_to_operation(row: Any) -> KnowledgeOperationRow:
    return KnowledgeOperationRow(
        id=_s(row[0]), tenant_id=_s(row[1]), knowledge_space_id=row[2],
        document_id=_s(row[3]), operation=row[4], idempotency_key=row[5],
        request_fingerprint=row[6], status=row[7], upstream_status=row[8],
        error_code=row[9], error_message=row[10], created_at=row[11],
        updated_at=row[12], completed_at=row[13],
    )


class KnowledgeOperationRepository:
    """租户作用域的 delete/reindex 幂等收据。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def get_by_key(
        self, ctx: TenantContext, *, operation: str, idempotency_key: str
    ) -> KnowledgeOperationRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _OPERATION_COLUMNS + " FROM knowledge_document_operation "
                "WHERE operation = %s AND idempotency_key = %s",
                (operation, idempotency_key),
            ).fetchone()
        return _row_to_operation(row) if row is not None else None

    def get_latest_by_document(
        self,
        ctx: TenantContext,
        *,
        operation: str,
        knowledge_space_id: str,
        document_id: str,
    ) -> KnowledgeOperationRow | None:
        """Return the newest operation for one tenant-scoped document."""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _OPERATION_COLUMNS + " FROM knowledge_document_operation "
                "WHERE operation = %s AND knowledge_space_id = %s AND document_id = %s "
                "ORDER BY created_at DESC, id DESC LIMIT 1",
                (operation, knowledge_space_id, document_id),
            ).fetchone()
        return _row_to_operation(row) if row is not None else None

    def create(
        self,
        ctx: TenantContext,
        *,
        knowledge_space_id: str,
        document_id: str,
        operation: str,
        idempotency_key: str,
        request_fingerprint: str,
        status: str = "pending",
    ) -> KnowledgeOperationRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO knowledge_document_operation "
                "(tenant_id, knowledge_space_id, document_id, operation, idempotency_key, "
                "request_fingerprint, status) VALUES (%s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING "
                "RETURNING " + _OPERATION_COLUMNS,
                (ctx.tenant_id, knowledge_space_id, document_id, operation,
                 idempotency_key, request_fingerprint, status),
            ).fetchone()
            if row is None:
                row = s.execute(
                    "SELECT " + _OPERATION_COLUMNS + " FROM knowledge_document_operation "
                    "WHERE operation = %s AND idempotency_key = %s",
                    (operation, idempotency_key),
                ).fetchone()
        if row is None:
            raise RuntimeError("knowledge operation receipt unavailable")
        return _row_to_operation(row)

    def update(
        self,
        ctx: TenantContext,
        *,
        operation_id: str,
        status: str,
        upstream_status: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        completed: bool = False,
    ) -> KnowledgeOperationRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE knowledge_document_operation SET status = %s, upstream_status = %s, "
                "error_code = %s, error_message = %s, updated_at = now(), "
                "completed_at = CASE WHEN %s THEN now() ELSE completed_at END "
                "WHERE id = %s RETURNING " + _OPERATION_COLUMNS,
                (status, upstream_status, error_code, error_message[:2000] if error_message else None,
                 completed, operation_id),
            ).fetchone()
        return _row_to_operation(row) if row is not None else None


# ─────────────────────────────── Factory ───────────────────────────────


def build_knowledge_intake_repositories(
    router: PgTenantRouter,
) -> tuple[
    KnowledgeDocumentRepository,
    KnowledgeIngestionJobRepository,
    KnowledgeDocumentBindingRepository,
]:
    """组装 intake repository（保留既有三元组契约）。"""
    return (
        KnowledgeDocumentRepository(router),
        KnowledgeIngestionJobRepository(router),
        KnowledgeDocumentBindingRepository(router),
    )
