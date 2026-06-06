"""KnowledgeDocument repository."""

from typing import Optional

from ..domain.entities import KnowledgeDocument


class KnowledgeDocumentRepo:
    def __init__(self, cur):
        self.cur = cur

    _FIELDS = (
        "id, knowledge_base_id, enterprise_id, asset_id, display_name, file_name, file_type, "
        "file_size, storage_key, status, ingestion_job_id, rag_document_id, error_code, "
        "error_message, chunk_count, created_at, updated_at, created_by, updated_by, deleted_at"
    )

    def create(self, doc: KnowledgeDocument) -> KnowledgeDocument:
        self.cur.execute(
            f"INSERT INTO knowledge_document ({self._FIELDS}) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now(), %s, %s, NULL)",
            (doc.id, doc.knowledge_base_id, doc.enterprise_id, doc.asset_id, doc.display_name,
             doc.file_name, doc.file_type, doc.file_size, doc.storage_key, doc.status,
             doc.ingestion_job_id, doc.rag_document_id, doc.error_code, doc.error_message,
             doc.chunk_count, doc.created_by, doc.updated_by),
        )
        return doc

    def get_by_id(self, doc_id: str) -> Optional[KnowledgeDocument]:
        self.cur.execute(f"SELECT {self._FIELDS} FROM knowledge_document WHERE id = %s", (doc_id,))
        row = self.cur.fetchone()
        return self._row_to_entity(row) if row else None

    def get_by_asset(self, knowledge_base_id: str, asset_id: str) -> Optional[KnowledgeDocument]:
        self.cur.execute(
            f"SELECT {self._FIELDS} FROM knowledge_document "
            "WHERE knowledge_base_id = %s AND asset_id = %s AND deleted_at IS NULL",
            (knowledge_base_id, asset_id),
        )
        row = self.cur.fetchone()
        return self._row_to_entity(row) if row else None

    def list_by_kb(self, kb_id: str, *, status: Optional[str] = None) -> list[KnowledgeDocument]:
        if status:
            self.cur.execute(
                f"SELECT {self._FIELDS} FROM knowledge_document "
                "WHERE knowledge_base_id = %s AND status = %s AND deleted_at IS NULL ORDER BY created_at DESC",
                (kb_id, status),
            )
        else:
            self.cur.execute(
                f"SELECT {self._FIELDS} FROM knowledge_document "
                "WHERE knowledge_base_id = %s AND deleted_at IS NULL ORDER BY created_at DESC",
                (kb_id,),
            )
        return [self._row_to_entity(r) for r in self.cur.fetchall()]

    def update_state(
        self,
        doc_id: str,
        *,
        status: str,
        ingestion_job_id: Optional[str] = None,
        rag_document_id: Optional[str] = None,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        chunk_count: Optional[int] = None,
    ) -> None:
        self.cur.execute(
            "UPDATE knowledge_document SET status=%s, ingestion_job_id=COALESCE(%s, ingestion_job_id), "
            "rag_document_id=COALESCE(%s, rag_document_id), error_code=%s, error_message=%s, "
            "chunk_count=COALESCE(%s, chunk_count), updated_at=now() WHERE id=%s",
            (status, ingestion_job_id, rag_document_id, error_code, error_message, chunk_count, doc_id),
        )

    @staticmethod
    def _row_to_entity(row) -> KnowledgeDocument:
        return KnowledgeDocument(
            id=row[0], knowledge_base_id=row[1], enterprise_id=row[2], asset_id=row[3], display_name=row[4],
            file_name=row[5], file_type=row[6], file_size=row[7], storage_key=row[8], status=row[9],
            ingestion_job_id=row[10], rag_document_id=row[11], error_code=row[12], error_message=row[13],
            chunk_count=row[14], created_at=str(row[15] or ""), updated_at=str(row[16] or ""),
            created_by=row[17] or "", updated_by=row[18] or "", deleted_at=str(row[19]) if row[19] else None,
        )
