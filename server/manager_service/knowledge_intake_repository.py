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

import uuid

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict


class KnowledgeReconciliationRequired(Conflict):
    status, code, title = 409, "knowledge_reconciliation_required", "Knowledge reconciliation required"

_DOC_COLUMNS = (
    "id, tenant_id, knowledge_space_id, display_name, source_type, file_name, file_type, "
    "file_size, storage_key, status, text_chars, error_code, error_message, created_at, updated_at"
)
_INGEST_COLUMNS = (
    "id, tenant_id, knowledge_space_id, document_id, status, error_code, error_message, "
    "chunk_count, started_at, completed_at, created_at, claim_owner, lease_until, heartbeat_at, "
    "attempts, next_attempt_at, submission_state, file_source, track_id, upstream_document_id, text_chars, operation_id"
)
_BIND_COLUMNS = (
    "id, tenant_id, knowledge_space_id, document_id, employee_id, rag_document_id, "
    "status, last_synced_at, created_at, enabled, policy_revision, policy_source, "
    "policy_actor, policy_updated_at, revoked_at"
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
        create_job: bool = False,
    ) -> KnowledgeDocumentRow | tuple[KnowledgeDocumentRow, KnowledgeIngestionJobRow]:
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
            if create_job:
                job = _insert_job(s, ctx, knowledge_space_id=knowledge_space_id, document_id=str(row[0]), status="parsing")
                return _row_to_doc(row), job
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
    claim_owner: str | None = None
    lease_until: datetime | None = None
    heartbeat_at: datetime | None = None
    attempts: int = 0
    next_attempt_at: datetime | None = None
    submission_state: str = "not_submitted"
    file_source: str = ""
    track_id: str | None = None
    upstream_document_id: str | None = None
    text_chars: int | None = None
    operation_id: str | None = None


def _row_to_ing(row: Any) -> KnowledgeIngestionJobRow:
    return KnowledgeIngestionJobRow(
        id=_s(row[0]), tenant_id=_s(row[1]), knowledge_space_id=row[2], document_id=_s(row[3]),
        status=row[4], error_code=row[5], error_message=row[6], chunk_count=row[7],
        started_at=row[8], completed_at=row[9], created_at=row[10],
        claim_owner=row[11], lease_until=row[12], heartbeat_at=row[13], attempts=row[14],
        next_attempt_at=row[15], submission_state=row[16], file_source=row[17], track_id=row[18],
        upstream_document_id=row[19], text_chars=row[20], operation_id=str(row[21]) if row[21] else None,
    )


def _insert_job(s, ctx, *, knowledge_space_id, document_id, status, started_at=None, operation_id=None):
    job_id = str(uuid.uuid4())
    row = s.execute(
        "INSERT INTO knowledge_ingestion_job (id, tenant_id, knowledge_space_id, document_id, status, started_at, file_source, operation_id) "
        "VALUES (%s, %s, %s, %s, %s, COALESCE(%s, now()), %s, %s) RETURNING " + _INGEST_COLUMNS,
        (job_id, ctx.tenant_id, knowledge_space_id, document_id, status, started_at, f"{document_id}/{job_id}", operation_id),
    ).fetchone()
    return _row_to_ing(row)


class KnowledgeIngestionJobRepository:
    """intake 任务访问。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(self, ctx: TenantContext, *, knowledge_space_id: str, document_id: str,
               status: str, started_at: datetime | None = None, operation_id: str | None = None) -> KnowledgeIngestionJobRow:
        with self._router.session(ctx) as s:
            return _insert_job(s, ctx, knowledge_space_id=knowledge_space_id, document_id=document_id,
                               status=status, started_at=started_at, operation_id=operation_id)

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

    def prepare_reindex(
        self, ctx: TenantContext, *, document_id: str, knowledge_space_id: str,
        idempotency_key: str, request_fingerprint: str,
    ) -> KnowledgeReindexPreparation:
        """Commit the receipt, document CAS and exact job association together.

        The unique operation key serializes same-key requests. A document CAS
        loser raises inside this transaction so it cannot leave an orphan receipt.
        No parsing, delivery or external HTTP occurs while this transaction is open.
        """
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO knowledge_document_operation "
                "(tenant_id, knowledge_space_id, document_id, operation, idempotency_key, request_fingerprint, status) "
                "VALUES (%s, %s, %s, 'reindex', %s, %s, 'pending') "
                "ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING RETURNING " + _OPERATION_COLUMNS,
                (ctx.tenant_id, knowledge_space_id, document_id, idempotency_key, request_fingerprint),
            ).fetchone()
            newly_created = row is not None
            if row is None:
                row = s.execute(
                    "SELECT " + _OPERATION_COLUMNS + " FROM knowledge_document_operation "
                    "WHERE operation='reindex' AND idempotency_key=%s", (idempotency_key,),
                ).fetchone()
            if row is None:
                raise RuntimeError("knowledge operation receipt unavailable")
            operation = _row_to_operation(row)
            if (operation.request_fingerprint != request_fingerprint or operation.document_id != document_id
                    or operation.knowledge_space_id != knowledge_space_id):
                raise Conflict("idempotency key was already used for a different document operation")
            if not newly_created:
                rows = s.execute(
                    "SELECT " + _INGEST_COLUMNS + " FROM knowledge_ingestion_job WHERE operation_id=%s LIMIT 2",
                    (operation.id,),
                ).fetchall()
                job = _row_to_ing(rows[0]) if len(rows) == 1 else None
                if len(rows) > 1 or (job is not None and (
                    job.document_id != operation.document_id or job.knowledge_space_id != operation.knowledge_space_id
                )):
                    raise KnowledgeReconciliationRequired("Reindex job association is ambiguous; reconciliation is required")
                return KnowledgeReindexPreparation(operation, job, newly_created=False)
            doc = s.execute(
                "UPDATE knowledge_document SET status='reindex_requested', error_code=NULL, error_message=NULL, updated_at=now() "
                "WHERE id=%s AND knowledge_space_id=%s AND status IN ('ready','failed') "
                "AND error_code IS DISTINCT FROM 'SUBMISSION_UNKNOWN' RETURNING id",
                (document_id, knowledge_space_id),
            ).fetchone()
            if doc is None:
                current = s.execute("SELECT error_code FROM knowledge_document WHERE id=%s", (document_id,)).fetchone()
                if current and current[0] == "SUBMISSION_UNKNOWN":
                    raise KnowledgeReconciliationRequired("Submission outcome is unknown; automatic reconciliation continues. Retry/delete are protected.")
                raise Conflict("document changed or is not ready/failed; reindex was not accepted")
            s.execute("UPDATE knowledge_document_binding SET status='stale' WHERE document_id=%s AND status <> 'revoked'", (document_id,))
            job = _insert_job(s, ctx, knowledge_space_id=knowledge_space_id, document_id=document_id,
                              status="reindex_requested", operation_id=operation.id)
            return KnowledgeReindexPreparation(operation, job, newly_created=True)

    def claim(self, ctx, *, owner: str, job_id: str | None = None):
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT j.id FROM knowledge_ingestion_job j JOIN knowledge_document d ON d.id=j.document_id "
                "WHERE (%s::uuid IS NULL OR j.id=%s) AND j.next_attempt_at <= now() "
                "AND (j.lease_until IS NULL OR j.lease_until <= now()) "
                "AND (j.status NOT IN ('done','failed') OR j.submission_state='submitted') "
                "AND d.status IN ('uploaded','parsing','indexing','reindex_requested','failed') "
                "AND j.id=(SELECT k.id FROM knowledge_ingestion_job k WHERE k.document_id=j.document_id ORDER BY k.created_at DESC, k.id DESC LIMIT 1) "
                "ORDER BY j.next_attempt_at, j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1",
                (job_id, job_id),
            ).fetchone()
            if row is None:
                return None
            result = s.execute(
                "UPDATE knowledge_ingestion_job SET claim_owner=%s, lease_until=now()+interval '90 seconds', "
                "heartbeat_at=now(), attempts=attempts+1 WHERE id=%s RETURNING " + _INGEST_COLUMNS,
                (owner, row[0]),
            ).fetchone()
            return _row_to_ing(result)

    @staticmethod
    def _owned(s, job_id, owner):
        return s.execute(
            "SELECT id FROM knowledge_ingestion_job WHERE id=%s AND claim_owner=%s AND lease_until>now() FOR UPDATE",
            (job_id, owner),
        ).fetchone() is not None

    def fence_submission(self, ctx, job, *, owner, text_chars):
        with self._router.session(ctx) as s:
            if not self._owned(s, job.id, owner):
                return False
            changed = s.execute(
                "UPDATE knowledge_ingestion_job SET submission_state='submitted', status='indexing', text_chars=%s, "
                "heartbeat_at=now(), lease_until=now()+interval '90 seconds' WHERE id=%s AND submission_state='not_submitted'",
                (text_chars, job.id),
            ).rowcount
            if changed:
                s.execute("UPDATE knowledge_document SET status='indexing', text_chars=%s, error_code=NULL, error_message=NULL, updated_at=now() WHERE id=%s", (text_chars, job.document_id))
            return changed == 1

    def record_track(self, ctx, job, *, owner, track_id):
        with self._router.session(ctx) as s:
            if not self._owned(s, job.id, owner):
                return False
            s.execute("UPDATE knowledge_ingestion_job SET track_id=%s, heartbeat_at=now(), lease_until=now()+interval '90 seconds' WHERE id=%s", (track_id, job.id))
            return True

    def settle(self, ctx, job, *, owner, state, error_code=None, upstream_document_id=None):
        """CAS job + document + receipt. Unknown submissions stay claimable."""
        terminal = state == "failed"
        unknown_terminal = state == "unknown" and job.attempts >= 6
        code = error_code or ("SUBMISSION_UNKNOWN" if unknown_terminal else None)
        status = "failed" if terminal or unknown_terminal else "indexing"
        # Unknown acceptance outcomes remain claimable for bounded automatic
        # reconciliation even after the visible document status becomes failed.
        submission_terminal = terminal and not unknown_terminal
        with self._router.session(ctx) as s:
            if not self._owned(s, job.id, owner):
                return False
            s.execute(
                "UPDATE knowledge_ingestion_job SET status=%s, submission_state=CASE WHEN %s THEN 'terminal' ELSE submission_state END, "
                "error_code=%s, error_message=%s, upstream_document_id=COALESCE(%s,upstream_document_id), "
                "claim_owner=NULL, lease_until=NULL, next_attempt_at=now()+(%s * interval '1 second'), "
                "completed_at=CASE WHEN %s THEN now() ELSE NULL END WHERE id=%s",
                (status, submission_terminal, code, "Knowledge reconciliation required" if code else None, upstream_document_id,
                 min(300, 2 ** min(job.attempts, 8)), terminal or unknown_terminal, job.id),
            )
            s.execute("UPDATE knowledge_document SET status=%s, error_code=%s, error_message=%s, updated_at=now() WHERE id=%s",
                      (status, code, "Knowledge reconciliation required" if code else None, job.document_id))
            if (terminal or unknown_terminal) and job.operation_id:
                s.execute("UPDATE knowledge_document_operation SET status='failed', error_code=%s, error_message='Knowledge processing failed', updated_at=now(), completed_at=now() WHERE id=%s", (code, job.operation_id))
            return True

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

    enabled: bool | None = None
    policy_revision: int = 0
    policy_source: str = "inherit"
    policy_actor: str | None = None
    policy_updated_at: datetime | None = None
    revoked_at: datetime | None = None


def _row_to_bind(row: Any) -> KnowledgeDocumentBindingRow:
    return KnowledgeDocumentBindingRow(
        id=_s(row[0]), tenant_id=_s(row[1]), knowledge_space_id=row[2], document_id=_s(row[3]),
        employee_id=_s(row[4]), rag_document_id=row[5], status=row[6],
        last_synced_at=row[7], created_at=row[8], enabled=row[9],
        policy_revision=row[10], policy_source=row[11],
        policy_actor=str(row[12]) if row[12] is not None else None,
        policy_updated_at=row[13], revoked_at=row[14],
    )


class KnowledgeDocumentBindingRepository:
    """文档 ↔ 员工索引绑定访问。tenant_id 取自 ctx（D22）。

    传播绑定：intake 完成后，向 knowledge_space 已绑员工幂等 upsert knowledge_document_binding。
    员工绑定真相态走 employee_knowledge_binding（D21）；本表为检索侧视图。
    """

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def set_policy(self, ctx: TenantContext, *, employee_id: str, document_id: str,
                   enabled: bool, revoke: bool = False) -> KnowledgeDocumentBindingRow | None:
        """Only the administrator service calls this; indexing never writes policy columns."""
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO knowledge_document_binding AS b "
                "(tenant_id, knowledge_space_id, document_id, employee_id, status, enabled, "
                "policy_revision, policy_source, policy_actor, policy_updated_at, revoked_at) "
                "SELECT %s, d.knowledge_space_id, d.id, e.id, "
                "CASE WHEN d.status = 'ready' THEN 'ready' ELSE 'pending' END, %s, "
                "1, 'admin', %s, now(), CASE WHEN %s THEN now() ELSE NULL END "
                "FROM knowledge_document d CROSS JOIN employee e WHERE d.id = %s AND e.id = %s "
                "ON CONFLICT (tenant_id, document_id, employee_id) DO UPDATE SET "
                "enabled = EXCLUDED.enabled, policy_revision = b.policy_revision + 1, "
                "policy_source = 'admin', policy_actor = EXCLUDED.policy_actor, policy_updated_at = now(), "
                "status = CASE WHEN EXCLUDED.status = 'ready' THEN 'ready' ELSE b.status END, "
                "revoked_at = CASE WHEN %s THEN COALESCE(b.revoked_at, now()) ELSE NULL END "
                "WHERE b.enabled IS DISTINCT FROM EXCLUDED.enabled "
                "OR (b.revoked_at IS NOT NULL) IS DISTINCT FROM %s "
                "RETURNING " + _BIND_COLUMNS,
                (ctx.tenant_id, enabled, ctx.user_id, revoke, document_id, employee_id, revoke, revoke),
            ).fetchone()
            if row is None:
                row = s.execute("SELECT " + _BIND_COLUMNS + " FROM knowledge_document_binding "
                                "WHERE document_id = %s AND employee_id = %s", (document_id, employee_id)).fetchone()
        return _row_to_bind(row) if row is not None else None

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
        claim_owner: str | None = None,
    ) -> int:
        """Publish bindings, job completion, and document readiness atomically."""
        with self._router.session(ctx) as s:
            if claim_owner is not None:
                if not KnowledgeIngestionJobRepository._owned(s, job_id, claim_owner):
                    raise RuntimeError("ingestion claim expired")
                s.execute("UPDATE knowledge_ingestion_job SET status='indexing' WHERE id=%s", (job_id,))
                s.execute("UPDATE knowledge_document SET status='indexing' WHERE id=%s AND status IN ('indexing','failed')", (document_id,))
            count = self._upsert_ready_many_in_session(
                s, ctx, knowledge_space_id=knowledge_space_id, document_id=document_id,
                employee_ids=employee_ids, rag_document_id=rag_document_id, synced_at=synced_at,
            )
            job = s.execute(
                "UPDATE knowledge_ingestion_job SET status = 'done', chunk_count = %s, "
                "completed_at = %s, submission_state='terminal', claim_owner=NULL, lease_until=NULL, error_code=NULL, error_message=NULL, "
                "upstream_document_id=%s WHERE id = %s AND status = 'indexing'",
                (chunk_count, completed_at, rag_document_id, job_id),
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
            s.execute("UPDATE knowledge_document_operation SET status='completed', upstream_status='processed', updated_at=now(), completed_at=now() "
                      "WHERE id=(SELECT operation_id FROM knowledge_ingestion_job WHERE id=%s)", (job_id,))
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
                "rag_document_id = EXCLUDED.rag_document_id, status = CASE "
                "WHEN EXCLUDED.status = 'ready' THEN 'ready' ELSE b.status END, "
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


@dataclass(frozen=True)
class KnowledgeReindexPreparation:
    operation: KnowledgeOperationRow
    job: KnowledgeIngestionJobRow | None
    newly_created: bool


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
