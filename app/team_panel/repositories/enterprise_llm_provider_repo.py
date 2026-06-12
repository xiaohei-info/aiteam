"""Enterprise LLM provider/model repositories (catalog; DB is source of truth)."""
from typing import List, Optional

from ..domain.entities import EnterpriseLlmModel, EnterpriseLlmProvider


class EnterpriseLlmProviderRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, p: EnterpriseLlmProvider) -> EnterpriseLlmProvider:
        self._cur.execute(
            "INSERT INTO enterprise_llm_provider (id, enterprise_id, provider_key, "
            "display_name, base_url, api_key, transport, enabled, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (p.id, p.enterprise_id, p.provider_key, p.display_name, p.base_url,
             p.api_key, p.transport, p.enabled, p.created_by),
        )
        return p

    def get_by_id(self, provider_id: str) -> Optional[EnterpriseLlmProvider]:
        self._cur.execute(self._SELECT + " WHERE id = %s", (provider_id,))
        row = self._cur.fetchone()
        return self._row(row) if row else None

    def list_by_enterprise(self, enterprise_id: str) -> List[EnterpriseLlmProvider]:
        self._cur.execute(
            self._SELECT + " WHERE enterprise_id = %s ORDER BY created_at",
            (enterprise_id,),
        )
        return [self._row(r) for r in self._cur.fetchall()]

    def update(self, p: EnterpriseLlmProvider) -> EnterpriseLlmProvider:
        self._cur.execute(
            "UPDATE enterprise_llm_provider SET display_name=%s, base_url=%s, "
            "api_key=%s, transport=%s, enabled=%s, updated_at=now() WHERE id=%s",
            (p.display_name, p.base_url, p.api_key, p.transport, p.enabled, p.id),
        )
        return p

    def delete(self, provider_id: str) -> None:
        self._cur.execute(
            "DELETE FROM enterprise_llm_provider WHERE id=%s", (provider_id,)
        )

    _SELECT = (
        "SELECT id, enterprise_id, provider_key, display_name, base_url, api_key, "
        "transport, enabled, created_at, updated_at, created_by "
        "FROM enterprise_llm_provider"
    )

    @staticmethod
    def _row(row) -> EnterpriseLlmProvider:
        return EnterpriseLlmProvider(
            id=row[0], enterprise_id=row[1], provider_key=row[2],
            display_name=row[3] or "", base_url=row[4] or "", api_key=row[5] or "",
            transport=row[6] or "openai_chat", enabled=bool(row[7]),
            created_at=str(row[8]), updated_at=str(row[9]), created_by=row[10] or "",
        )


class EnterpriseLlmModelRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, m: EnterpriseLlmModel) -> EnterpriseLlmModel:
        self._cur.execute(
            "INSERT INTO enterprise_llm_model (id, enterprise_id, provider_id, "
            "model_id, label, context_length, enabled, is_default) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (m.id, m.enterprise_id, m.provider_id, m.model_id, m.label,
             m.context_length, m.enabled, m.is_default),
        )
        return m

    def get_by_id(self, model_id: str) -> Optional[EnterpriseLlmModel]:
        self._cur.execute(self._SELECT + " WHERE id = %s", (model_id,))
        row = self._cur.fetchone()
        return self._row(row) if row else None

    def list_by_enterprise(self, enterprise_id: str) -> List[EnterpriseLlmModel]:
        self._cur.execute(
            self._SELECT + " WHERE enterprise_id = %s ORDER BY created_at",
            (enterprise_id,),
        )
        return [self._row(r) for r in self._cur.fetchall()]

    def list_by_provider(self, provider_id: str) -> List[EnterpriseLlmModel]:
        self._cur.execute(
            self._SELECT + " WHERE provider_id = %s ORDER BY created_at",
            (provider_id,),
        )
        return [self._row(r) for r in self._cur.fetchall()]

    def delete(self, model_id: str) -> None:
        self._cur.execute(
            "DELETE FROM enterprise_llm_model WHERE id=%s", (model_id,)
        )

    _SELECT = (
        "SELECT id, enterprise_id, provider_id, model_id, label, context_length, "
        "enabled, is_default, created_at FROM enterprise_llm_model"
    )

    @staticmethod
    def _row(row) -> EnterpriseLlmModel:
        return EnterpriseLlmModel(
            id=row[0], enterprise_id=row[1], provider_id=row[2], model_id=row[3],
            label=row[4] or "", context_length=int(row[5] or 0),
            enabled=bool(row[6]), is_default=bool(row[7]), created_at=str(row[8]),
        )
