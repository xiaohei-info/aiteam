"""Narrow Manager facade for the external Hindsight memory service.

Hindsight is the only long-term memory store.  This module intentionally does not
implement a local fallback: an unconfigured or unavailable upstream is surfaced as
503 so callers never silently write to a second backend.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

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

    def _request(
        self,
        ctx: TenantContext,
        path: str | None,
        payload: dict[str, Any] | None,
        *,
        employee_id: str,
        method: str = "POST",
        memory_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        settings = self._settings
        # Validate the complete service contract before constructing a transport or
        # making an outbound request.  Hindsight must never be contacted unauthenticated.
        if not all(
            isinstance(value, str) and value.strip()
            for value in (settings.base_url, settings.token, path)
        ):
            raise HindsightUnavailable(
                "HINDSIGHT_URL, HINDSIGHT_SERVICE_TOKEN and operation paths must be configured"
            )
        client = self._client or httpx.Client(base_url=settings.base_url.rstrip("/"), timeout=60.0)
        headers = {
            "X-Tenant-ID": ctx.tenant_id,
            "X-Member-ID": ctx.user_id,
            "Authorization": f"Bearer {settings.token}",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        bank_id = f"tenant_{ctx.tenant_id}_member_{ctx.user_id}_employee_{employee_id}"
        native = "/v1/default/" in path and "{bank_id}" in path
        try:
            encoded_bank_id = quote(bank_id, safe="")
            target = path.format(
                bank_id=encoded_bank_id,
                employee_id=quote(employee_id, safe=""),
                memory_id=quote(memory_id or "", safe=""),
            )
            if native:
                # Hindsight creates banks via PUT; making this idempotent call before
                # each operation keeps first-use employees working after a fresh deploy.
                bank_response = client.put(
                    f"{self._settings.base_url.rstrip('/')}/v1/default/banks/{encoded_bank_id}",
                    json={"name": bank_id},
                    headers=headers,
                )
                if bank_response.status_code >= 400:
                    raise HindsightUnavailable(
                        f"Hindsight bank initialization returned HTTP {bank_response.status_code}"
                    )
            if native and method == "DELETE":
                # Hindsight exposes reversible invalidation (PATCH), not a per-memory
                # DELETE endpoint.  Keep the Manager delete contract destructive to
                # callers while preserving the upstream audit trail.
                method = "PATCH"
                payload = {"state": "invalidated", "reason": "deleted by Manager"}
            response = client.request(
                method,
                f"{self._settings.base_url.rstrip('/')}/{target.lstrip('/')}",
                json=payload,
                headers=headers,
            )
            if response.status_code >= 400:
                raise HindsightUnavailable(f"Hindsight returned HTTP {response.status_code}")
            return response.json() if response.content else {}
        except HindsightUnavailable:
            raise
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            raise HindsightUnavailable("Hindsight request failed") from exc
        finally:
            if self._client is None:
                client.close()

    def recall(self, ctx: TenantContext, *, employee_id: str, query: str, limit: int) -> dict:
        return self._request(ctx, self._settings.recall_path, {
            "query": query, "max_tokens": max(256, min(limit * 256, 8192)),
        }, employee_id=employee_id)

    def retain(self, ctx: TenantContext, *, employee_id: str, content: str, metadata: dict) -> dict:
        context = metadata.get("context") if isinstance(metadata.get("context"), str) else None
        item = {"content": content}
        if context:
            item["context"] = context
        if isinstance(metadata.get("document_id"), str):
            item["document_id"] = metadata["document_id"]
        operation_id = hashlib.sha256(
            f"{ctx.tenant_id}:{ctx.user_id}:{employee_id}:"
            f"{content}:{json.dumps(metadata, sort_keys=True, default=str)}".encode()
        ).hexdigest()
        operation_id = (
            f"{operation_id[:8]}-{operation_id[8:12]}-{operation_id[12:16]}-"
            f"{operation_id[16:20]}-{operation_id[20:32]}"
        )
        return self._request(ctx, self._settings.retain_path, {
            "items": [item], "async": True, "operation_id": operation_id,
        }, employee_id=employee_id)

    def delete(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        memory_id: str,
        idempotency_key: str,
    ) -> dict:
        return self._request(
            ctx,
            self._settings.delete_path,
            None,
            employee_id=employee_id,
            memory_id=memory_id,
            method="DELETE",
            idempotency_key=idempotency_key,
        )
