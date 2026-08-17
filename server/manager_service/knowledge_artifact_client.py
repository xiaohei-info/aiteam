"""HTTP adapter for the external knowledge artifact/index service.

Manager owns authorization; the index service owns artifact search and citation
content.  There is deliberately no local fallback or artifact store here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

from shared.contracts.tenancy import TenantContext
from shared.errors import AppError


class KnowledgeArtifactUnavailable(AppError):
    status, code, title = 503, "knowledge_artifact_unavailable", "Knowledge artifact service unavailable"


@dataclass(frozen=True)
class KnowledgeArtifactSettings:
    """Required connection details for the external artifact/index service."""

    base_url: str | None
    token: str | None
    search_path: str | None
    get_path: str | None

    @classmethod
    def from_env(cls) -> "KnowledgeArtifactSettings":
        return cls(
            base_url=os.getenv("KNOWLEDGE_INDEX_URL"),
            token=os.getenv("KNOWLEDGE_INDEX_SERVICE_TOKEN"),
            search_path=os.getenv("KNOWLEDGE_INDEX_SEARCH_PATH"),
            get_path=os.getenv("KNOWLEDGE_INDEX_GET_PATH"),
        )


class KnowledgeArtifactClient:
    """Transport-only facade; artifact semantics remain external."""

    def __init__(
        self,
        settings: KnowledgeArtifactSettings | None = None,
        *,
        client: httpx.Client | None = None,
    ):
        self._settings = settings or KnowledgeArtifactSettings.from_env()
        self._client = client

    def _request(
        self,
        ctx: TenantContext,
        path: str | None,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        settings = self._settings
        if not settings.base_url or not path:
            raise KnowledgeArtifactUnavailable(
                "KNOWLEDGE_INDEX_URL, KNOWLEDGE_INDEX_SEARCH_PATH and "
                "KNOWLEDGE_INDEX_GET_PATH must be configured"
            )

        client = self._client or httpx.Client(
            base_url=settings.base_url.rstrip("/"), timeout=10.0
        )
        headers = {"X-Tenant-ID": ctx.tenant_id, "Accept": "application/json"}
        if settings.token:
            headers["Authorization"] = f"Bearer {settings.token}"
        try:
            response = client.post(
                f"{settings.base_url.rstrip('/')}/{path.lstrip('/')}",
                json=payload,
                headers=headers,
            )
            if response.status_code >= 400:
                raise KnowledgeArtifactUnavailable(
                    f"Knowledge artifact service returned HTTP {response.status_code}"
                )
            value = response.json() if response.content else {}
            if not isinstance(value, dict):
                raise KnowledgeArtifactUnavailable("Knowledge artifact service returned invalid JSON")
            return value
        except KnowledgeArtifactUnavailable:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise KnowledgeArtifactUnavailable("Knowledge artifact request failed") from exc
        finally:
            if self._client is None:
                client.close()

    def search(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        knowledge_refs: list[str],
        query: str,
        limit: int,
    ) -> dict[str, Any]:
        return self._request(
            ctx,
            self._settings.search_path,
            {
                "employee_id": employee_id,
                "knowledge_refs": knowledge_refs,
                "query": query,
                "limit": limit,
            },
        )

    def get(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        knowledge_refs: list[str],
        citation_id: str,
    ) -> dict[str, Any]:
        return self._request(
            ctx,
            self._settings.get_path,
            {
                "employee_id": employee_id,
                "knowledge_refs": knowledge_refs,
                "citation_id": citation_id,
            },
        )
