"""KnowledgeBase repository."""

from typing import Optional

from ..domain.entities import KnowledgeBase


class KnowledgeBaseRepo:
    def __init__(self, cur):
        self.cur = cur

    def create(self, kb: KnowledgeBase) -> KnowledgeBase:
        self.cur.execute(
            "INSERT INTO knowledge_base (id, enterprise_id, name, description, "
            "status, document_count, storage_prefix) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (kb.id, kb.enterprise_id, kb.name, kb.description,
             kb.status, kb.document_count, kb.storage_prefix),
        )
        return kb

    def get_by_id(self, kb_id: str) -> Optional[KnowledgeBase]:
        self.cur.execute(
            "SELECT id, enterprise_id, name, description, status, "
            "document_count, storage_prefix, created_at, updated_at, "
            "created_by, updated_by, deleted_at "
            "FROM knowledge_base WHERE id = %s",
            (kb_id,),
        )
        row = self.cur.fetchone()
        return self._row_to_entity(row) if row else None

    def list_by_enterprise(self, enterprise_id: str, *, status: Optional[str] = None) -> list[KnowledgeBase]:
        if status:
            self.cur.execute(
                "SELECT id, enterprise_id, name, description, status, document_count, "
                "storage_prefix, created_at, updated_at, created_by, updated_by, deleted_at "
                "FROM knowledge_base WHERE enterprise_id = %s AND status = %s AND deleted_at IS NULL "
                "ORDER BY name",
                (enterprise_id, status),
            )
        else:
            self.cur.execute(
                "SELECT id, enterprise_id, name, description, status, document_count, "
                "storage_prefix, created_at, updated_at, created_by, updated_by, deleted_at "
                "FROM knowledge_base WHERE enterprise_id = %s AND deleted_at IS NULL ORDER BY name",
                (enterprise_id,),
            )
        return [self._row_to_entity(r) for r in self.cur.fetchall()]

    def update(self, kb: KnowledgeBase) -> KnowledgeBase:
        self.cur.execute(
            "UPDATE knowledge_base SET name=%s, description=%s, status=%s, document_count=%s, "
            "storage_prefix=%s, updated_at=now() WHERE id=%s",
            (kb.name, kb.description, kb.status, kb.document_count, kb.storage_prefix, kb.id),
        )
        return kb

    def archive(self, kb_id: str) -> None:
        self.cur.execute(
            "UPDATE knowledge_base SET status='archived', updated_at=now() WHERE id=%s",
            (kb_id,),
        )

    def increment_document_count(self, kb_id: str, delta: int = 1) -> None:
        self.cur.execute(
            "UPDATE knowledge_base SET document_count = document_count + %s, updated_at=now() WHERE id=%s",
            (delta, kb_id),
        )

    @staticmethod
    def _row_to_entity(row) -> KnowledgeBase:
        return KnowledgeBase(
            id=row[0], enterprise_id=row[1], name=row[2], description=row[3], status=row[4],
            document_count=row[5], storage_prefix=row[6], created_at=str(row[7] or ""),
            updated_at=str(row[8] or ""), created_by=row[9] or "", updated_by=row[10] or "",
            deleted_at=str(row[11]) if row[11] else None,
        )
