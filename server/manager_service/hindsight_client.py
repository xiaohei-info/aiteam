"""Narrow Manager facade for the external Hindsight memory service.

Hindsight is the only long-term memory store.  This module intentionally does not
implement a local fallback: an unconfigured or unavailable upstream is surfaced as
503 so callers never silently write to a second backend.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

from shared.errors import AppError
from shared.contracts.tenancy import TenantContext


class HindsightUnavailable(AppError):
    status, code, title = 503, "hindsight_unavailable", "Memory service unavailable"


@dataclass(frozen=True)
class HindsightSettings:
    base_url: str | None
    token: str | None
    recall_path: str | None
    retain_path: str | None
    delete_path: str | None

    @classmethod
    def from_env(cls) -> "HindsightSettings":
        return cls(
            base_url=os.getenv("HINDSIGHT_URL"),
            token=os.getenv("HINDSIGHT_SERVICE_TOKEN"),
            recall_path=os.getenv("HINDSIGHT_RECALL_PATH"),
            retain_path=os.getenv("HINDSIGHT_RETAIN_PATH"),
            delete_path=os.getenv("HINDSIGHT_DELETE_PATH"),
        )


class HindsightClient:
    """HTTP transport only; Hindsight owns memory semantics and persistence."""

    def __init__(self, settings: HindsightSettings | None = None, *, client: httpx.Client | None = None):
        self._settings = settings or HindsightSettings.from_env()
        self._client = client

    def _request(self, ctx: TenantContext, path: str | None, payload: dict[str, Any]) -> dict:
        if not self._settings.base_url or not path:
            raise HindsightUnavailable("HINDSIGHT_URL and operation paths must be configured")
        client = self._client or httpx.Client(base_url=self._settings.base_url.rstrip("/"), timeout=10.0)
        headers = {"X-Tenant-ID": ctx.tenant_id}
        if self._settings.token:
            headers["Authorization"] = f"Bearer {self._settings.token}"
        try:
            response = client.post(
                f"{self._settings.base_url.rstrip('/')}/{path.lstrip('/')}",
                json=payload, headers=headers,
            )
            if response.status_code >= 400:
                raise HindsightUnavailable(f"Hindsight returned HTTP {response.status_code}")
            return response.json() if response.content else {}
        except HindsightUnavailable:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise HindsightUnavailable("Hindsight request failed") from exc
        finally:
            if self._client is None:
                client.close()

    def recall(self, ctx: TenantContext, *, employee_id: str, query: str, limit: int) -> dict:
        return self._request(ctx, self._settings.recall_path, {
            "employee_id": employee_id, "query": query, "limit": limit,
        })

    def retain(self, ctx: TenantContext, *, employee_id: str, content: str, metadata: dict) -> dict:
        return self._request(ctx, self._settings.retain_path, {
            "employee_id": employee_id, "content": content, "metadata": metadata,
        })

    def delete(self, ctx: TenantContext, *, memory_id: str) -> dict:
        return self._request(ctx, self._settings.delete_path, {"memory_id": memory_id})
