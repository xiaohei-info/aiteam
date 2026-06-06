"""KnowledgeIngestionJob repository."""

from typing import Optional

from ..domain.entities import KnowledgeIngestionJob


class KnowledgeIngestionJobRepo:
    def __init__(self, cur):
        self.cur = cur

    _FIELDS = (
        "id, knowledge_base_id, enterprise_id, document_id, status, rag_document_id, "
        "error_message, chunk_count, started_at, completed_at, created_at, updated_at, "
        "created_by, updated_by, deleted_at"
    )

    def create(self, job: KnowledgeIngestionJob) -> KnowledgeIngestionJob:
        self.cur.execute(
            f"INSERT INTO knowledge_ingestion_job ({self._FIELDS}) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now(), %s, %s, NULL)",
            (job.id, job.knowledge_base_id, job.enterprise_id, job.document_id, job.status,
             job.rag_document_id, job.error_message, job.chunk_count, job.started_at,
             job.completed_at, job.created_by, job.updated_by),
        )
        return job

    def get_by_id(self, job_id: str) -> Optional[KnowledgeIngestionJob]:
        self.cur.execute(f"SELECT {self._FIELDS} FROM knowledge_ingestion_job WHERE id = %s", (job_id,))
        row = self.cur.fetchone()
        return self._row_to_entity(row) if row else None

    def get_latest_by_document(self, document_id: str) -> Optional[KnowledgeIngestionJob]:
        self.cur.execute(
            f"SELECT {self._FIELDS} FROM knowledge_ingestion_job "
            "WHERE document_id = %s AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
            (document_id,),
        )
        row = self.cur.fetchone()
        return self._row_to_entity(row) if row else None

    def list_pending(self) -> list[KnowledgeIngestionJob]:
        self.cur.execute(
            f"SELECT {self._FIELDS} FROM knowledge_ingestion_job "
            "WHERE status IN ('pending','parsing','inserting') AND deleted_at IS NULL ORDER BY created_at",
        )
        return [self._row_to_entity(r) for r in self.cur.fetchall()]

    def update_state(
        self,
        job_id: str,
        *,
        status: str,
        rag_document_id: Optional[str] = None,
        error_message: Optional[str] = None,
        chunk_count: Optional[int] = None,
    ) -> None:
        self.cur.execute(
            "UPDATE knowledge_ingestion_job SET status=%s, rag_document_id=COALESCE(%s, rag_document_id), "
            "error_message=%s, chunk_count=COALESCE(%s, chunk_count), "
            "started_at=CASE WHEN %s = 'parsing' AND started_at IS NULL THEN now() ELSE started_at END, "
            "completed_at=CASE WHEN %s IN ('completed','failed') THEN now() ELSE completed_at END, "
            "updated_at=now() WHERE id=%s",
            (status, rag_document_id, error_message, chunk_count, status, status, job_id),
        )

    @staticmethod
    def _row_to_entity(row) -> KnowledgeIngestionJob:
        return KnowledgeIngestionJob(
            id=row[0], knowledge_base_id=row[1], enterprise_id=row[2], document_id=row[3], status=row[4],
            rag_document_id=row[5], error_message=row[6], chunk_count=row[7],
            started_at=str(row[8]) if row[8] else None, completed_at=str(row[9]) if row[9] else None,
            created_at=str(row[10] or ""), updated_at=str(row[11] or ""), created_by=row[12] or "",
            updated_by=row[13] or "", deleted_at=str(row[14]) if row[14] else None,
        )
