"""Narrow Manager facade for the external Hindsight memory service.

Hindsight is the only long-term memory store.  This module intentionally does not
implement a local fallback: an unconfigured or unavailable upstream is surfaced as
503 so callers never silently write to a second backend.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx

from shared.errors import AppError
from shared.contracts.tenancy import TenantContext


class HindsightUnavailable(AppError):
    status, code, title = 503, "hindsight_unavailable", "Memory service unavailable"


def _lease_ttl_seconds(raw: str | None) -> int:
    try:
        return max(30, min(int(raw or "300"), 3600))
    except (TypeError, ValueError):
        return 300


@dataclass(frozen=True)
class HindsightSettings:
    base_url: str | None
    token: str | None = field(repr=False)
    recall_path: str | None
    retain_path: str | None
    delete_path: str | None
    # Agent receives this Manager facade URL, never the direct Hindsight URL.
    facade_url: str | None = None
    lease_ttl_seconds: int = 300
    # Positional test/legacy settings retain the old bank shape; env-backed
    # production clients use the same deterministic bank id as Agent leases.
    bank_id_mode: str = "legacy"
    # Native Hindsight uses a trailing slash for the list route.  Keep these
    # optional so existing positional test/legacy settings remain valid.
    list_path: str | None = None
    update_path: str | None = None

    @classmethod
    def from_env(cls) -> "HindsightSettings":
        recall_path = os.getenv("HINDSIGHT_RECALL_PATH")
        delete_path = os.getenv("HINDSIGHT_DELETE_PATH")
        return cls(
            base_url=os.getenv("HINDSIGHT_URL"),
            token=os.getenv("HINDSIGHT_SERVICE_TOKEN"),
            recall_path=recall_path,
            retain_path=os.getenv("HINDSIGHT_RETAIN_PATH"),
            delete_path=delete_path,
            list_path=os.getenv("HINDSIGHT_LIST_PATH") or _derive_list_path(recall_path),
            update_path=os.getenv("HINDSIGHT_UPDATE_PATH") or delete_path,
            facade_url=os.getenv("HINDSIGHT_FACADE_URL") or "/api/manager/hindsight",
            lease_ttl_seconds=_lease_ttl_seconds(os.getenv("HINDSIGHT_LEASE_TTL_SECONDS")),
            bank_id_mode="scoped",
        )


def _derive_list_path(recall_path: str | None) -> str:
    if isinstance(recall_path, str) and recall_path.rstrip("/").endswith("/memories/recall"):
        return recall_path.rsplit("/", 1)[0] + "/list"
    return "/v1/default/banks/{bank_id}/memories/list"


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
        params: dict[str, Any] | None = None,
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
        if settings.bank_id_mode == "scoped":
            # Import lazily to keep the transport module usable by the lease
            # module without an import cycle during Manager startup.
            from .hindsight_credentials import derive_hindsight_bank_id

            bank_id = derive_hindsight_bank_id(ctx.tenant_id, ctx.user_id, employee_id)
        else:
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
                    json={"name": bank_id, "retain_extraction_mode": "verbatim"},
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
                params=params,
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

    def list(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        query: str | None,
        limit: int,
        offset: int,
    ) -> dict:
        return self._request(
            ctx,
            self._settings.list_path,
            None,
            employee_id=employee_id,
            method="GET",
            params={
                key: value for key, value in {
                    "q": query.strip() if isinstance(query, str) and query.strip() else None,
                    "limit": limit,
                    "offset": offset,
                }.items() if value is not None
            },
        )

    def update(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        memory_id: str,
        payload: dict[str, Any],
    ) -> dict:
        return self._request(
            ctx,
            self._settings.update_path or self._settings.delete_path,
            payload,
            employee_id=employee_id,
            memory_id=memory_id,
            method="PATCH",
        )

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
