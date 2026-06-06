"""KnowledgeIndexBinding repository."""

from typing import Optional

from ..domain.entities import KnowledgeIndexBinding


class KnowledgeIndexBindingRepo:
    def __init__(self, cur):
        self.cur = cur

    _FIELDS = (
        "id, enterprise_id, employee_id, knowledge_base_id, employee_knowledge_binding_id, "
        "document_id, rag_index_id, rag_document_id, scope_mode, status, error_message, "
        "last_synced_at, created_at, updated_at, created_by, updated_by, deleted_at"
    )

    def create(self, binding: KnowledgeIndexBinding) -> KnowledgeIndexBinding:
        self.cur.execute(
            f"INSERT INTO knowledge_index_binding ({self._FIELDS}) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now(), %s, %s, NULL)",
            (binding.id, binding.enterprise_id, binding.employee_id, binding.knowledge_base_id,
             binding.employee_knowledge_binding_id, binding.document_id, binding.rag_index_id,
             binding.rag_document_id, binding.scope_mode, binding.status, binding.error_message,
             binding.last_synced_at, binding.created_by, binding.updated_by),
        )
        return binding

    def get_by_id(self, binding_id: str) -> Optional[KnowledgeIndexBinding]:
        self.cur.execute(f"SELECT {self._FIELDS} FROM knowledge_index_binding WHERE id = %s", (binding_id,))
        row = self.cur.fetchone()
        return self._row_to_entity(row) if row else None

    def list_by_employee(self, employee_id: str, *, status: Optional[str] = None) -> list[KnowledgeIndexBinding]:
        if status:
            self.cur.execute(
                f"SELECT {self._FIELDS} FROM knowledge_index_binding "
                "WHERE employee_id = %s AND status = %s AND deleted_at IS NULL ORDER BY knowledge_base_id, rag_index_id",
                (employee_id, status),
            )
        else:
            self.cur.execute(
                f"SELECT {self._FIELDS} FROM knowledge_index_binding "
                "WHERE employee_id = %s AND deleted_at IS NULL ORDER BY knowledge_base_id, rag_index_id",
                (employee_id,),
            )
        return [self._row_to_entity(r) for r in self.cur.fetchall()]

    def list_by_document(self, document_id: str) -> list[KnowledgeIndexBinding]:
        self.cur.execute(
            f"SELECT {self._FIELDS} FROM knowledge_index_binding "
            "WHERE document_id = %s AND deleted_at IS NULL ORDER BY employee_id, rag_index_id",
            (document_id,),
        )
        return [self._row_to_entity(r) for r in self.cur.fetchall()]

    def update_state(
        self,
        binding_id: str,
        *,
        status: str,
        rag_document_id: Optional[str] = None,
        error_message: Optional[str] = None,
        last_synced_at=None,
    ) -> None:
        self.cur.execute(
            "UPDATE knowledge_index_binding SET status=%s, rag_document_id=COALESCE(%s, rag_document_id), "
            "error_message=%s, last_synced_at=COALESCE(%s, now()), updated_at=now() WHERE id=%s",
            (status, rag_document_id, error_message, last_synced_at, binding_id),
        )

    @staticmethod
    def _row_to_entity(row) -> KnowledgeIndexBinding:
        return KnowledgeIndexBinding(
            id=row[0], enterprise_id=row[1], employee_id=row[2], knowledge_base_id=row[3],
            employee_knowledge_binding_id=row[4], document_id=row[5], rag_index_id=row[6],
            rag_document_id=row[7], scope_mode=row[8], status=row[9], error_message=row[10],
            last_synced_at=str(row[11]) if row[11] else None, created_at=str(row[12] or ""),
            updated_at=str(row[13] or ""), created_by=row[14] or "", updated_by=row[15] or "",
            deleted_at=str(row[16]) if row[16] else None,
        )
