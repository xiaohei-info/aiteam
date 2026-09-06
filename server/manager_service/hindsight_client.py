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
from contextlib import contextmanager
from typing import Any
from time import monotonic
from urllib.parse import quote

import httpx

from shared.errors import AppError
from shared.contracts.tenancy import TenantContext

_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_NATIVE_RECALL_PATH = "/v1/default/banks/{bank_id}/memories/recall"
_NATIVE_RETAIN_PATH = "/v1/default/banks/{bank_id}/memories"
_NATIVE_DELETE_PATH = "/v1/default/banks/{bank_id}/memories/{memory_id}"


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
    stats_path: str | None = None

    @classmethod
    def from_env(cls) -> "HindsightSettings":
        recall_path = os.getenv("HINDSIGHT_RECALL_PATH") or _NATIVE_RECALL_PATH
        retain_path = os.getenv("HINDSIGHT_RETAIN_PATH") or _NATIVE_RETAIN_PATH
        delete_path = os.getenv("HINDSIGHT_DELETE_PATH") or _NATIVE_DELETE_PATH
        list_path = os.getenv("HINDSIGHT_LIST_PATH") or _derive_list_path(recall_path)
        update_path = os.getenv("HINDSIGHT_UPDATE_PATH") or _derive_update_path(list_path, delete_path)
        stats_path = os.getenv("HINDSIGHT_STATS_PATH") or _derive_stats_path(list_path)
        return cls(
            base_url=os.getenv("HINDSIGHT_URL"),
            token=os.getenv("HINDSIGHT_SERVICE_TOKEN"),
            recall_path=recall_path,
            retain_path=retain_path,
            delete_path=delete_path,
            list_path=list_path,
            update_path=update_path,
            stats_path=stats_path,
            facade_url=os.getenv("HINDSIGHT_FACADE_URL") or "/api/manager/hindsight",
            lease_ttl_seconds=_lease_ttl_seconds(os.getenv("HINDSIGHT_LEASE_TTL_SECONDS")),
            bank_id_mode="scoped",
        )


def _derive_list_path(recall_path: str | None) -> str:
    if isinstance(recall_path, str) and recall_path.rstrip("/").endswith("/memories/recall"):
        return recall_path.rsplit("/", 1)[0] + "/list"
    return "/v1/default/banks/{bank_id}/memories/list"


def _derive_stats_path(list_path: str | None) -> str | None:
    if not isinstance(list_path, str) or not list_path.strip():
        return None
    normalized = list_path.rstrip("/")
    if normalized.endswith("/memories/list"):
        return normalized[:-len("/memories/list")] + "/stats"
    return None


def _derive_update_path(list_path: str | None, delete_path: str | None) -> str | None:
    """Derive an item PATCH path without accidentally targeting a delete action."""
    for candidate in (list_path, delete_path):
        if not isinstance(candidate, str) or not candidate.strip():
            continue
        if "{memory_id}" in candidate:
            return candidate
        normalized = candidate.rstrip("/")
        if normalized.endswith("/list"):
            return normalized[:-len("/list")] + "/{memory_id}"
        if normalized.endswith("/delete"):
            return normalized[:-len("/delete")] + "/{memory_id}"
    return None


class HindsightClient:
    """HTTP transport only; Hindsight owns memory semantics and persistence."""

    def __init__(self, settings: HindsightSettings | None = None, *, client: httpx.Client | None = None, router=None):
        self._settings = settings or HindsightSettings.from_env()
        self._client = client
        self._router = router

    @contextmanager
    def _bank_lock(self, ctx: TenantContext, employee_id: str):
        if self._router is None:  # Isolated HTTP fixtures; production assembly always supplies PgTenantRouter.
            yield
            return
        with self._router.session(ctx) as session:
            session.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                            (f"hindsight-bank:{ctx.tenant_id}:{employee_id}",))
            yield

    def ensure_bank(self, ctx: TenantContext, *, employee_id: str) -> None:
        from .hindsight_credentials import derive_hindsight_bank_id
        settings = self._settings
        if not settings.base_url or not settings.token:
            raise HindsightUnavailable("Hindsight bank provisioning is not configured")
        bank = derive_hindsight_bank_id(ctx.tenant_id, ctx.user_id, employee_id, ctx.enterprise_id)
        client = self._client or httpx.Client(timeout=10.0, follow_redirects=False)
        headers = {"Authorization": f"Bearer {settings.token}"}
        target = f"{settings.base_url.rstrip('/')}/v1/default/banks/{quote(bank, safe='')}"
        try:
            with self._bank_lock(ctx, employee_id):
                response = client.get(target + "/profile", headers=headers)
                if response.status_code == 404:
                    created = client.put(target, headers=headers,
                                         json={"name": bank, "retain_extraction_mode": "verbatim"})
                    if created.status_code not in (200, 201, 409):
                        raise HindsightUnavailable("Hindsight bank provisioning failed")
                    response = client.get(target + "/profile", headers=headers)
                if response.status_code != 200 or len(response.content) > _MAX_RESPONSE_BYTES:
                    raise HindsightUnavailable("Hindsight bank status is unavailable")
                if response.json().get("bank_id") != bank:
                    raise HindsightUnavailable("Hindsight bank profile scope is invalid")
        except HindsightUnavailable:
            raise
        except (httpx.HTTPError, ValueError, AttributeError) as exc:
            raise HindsightUnavailable("Hindsight bank provisioning is unavailable") from exc
        finally:
            if self._client is None:
                client.close()

    def retention_request(self, bank_id: str | None, suffix: str, *, method="GET", payload=None, params=None) -> dict:
        """Trusted maintenance transport; suffixes are fixed by the retention service."""
        settings = self._settings
        if not settings.base_url or not settings.token:
            raise HindsightUnavailable("Hindsight retention is not configured")
        path = (f"/v1/default/banks/{quote(bank_id, safe='')}/{suffix}" if bank_id else "/openapi.json")
        client = self._client or httpx.Client(timeout=10.0, follow_redirects=False)
        until = monotonic() + 10
        try:
            with client.stream(method, settings.base_url.rstrip('/') + path,
                               headers={"Authorization": f"Bearer {settings.token}"}, json=payload, params=params,
                               follow_redirects=False, timeout=10.0) as response:
                if response.status_code != 200:
                    raise HindsightUnavailable("Hindsight retention request failed")
                data = bytearray()
                for chunk in response.iter_bytes():
                    if monotonic() >= until:
                        raise HindsightUnavailable("Hindsight retention response timed out")
                    data.extend(chunk)
                    if len(data) > _MAX_RESPONSE_BYTES:
                        raise HindsightUnavailable("Hindsight retention response exceeds the limit")
            value = json.loads(data)
            if not isinstance(value, dict):
                raise HindsightUnavailable("Invalid Hindsight retention response")
            return value
        except (httpx.HTTPError, ValueError) as exc:
            raise HindsightUnavailable("Hindsight retention is unavailable") from exc
        finally:
            if self._client is None:
                client.close()

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
        if settings.bank_id_mode == "scoped" or "/v1/default/" in path:
            # Import lazily to keep the transport module usable by the lease
            # module without an import cycle during Manager startup.
            from .hindsight_credentials import derive_hindsight_bank_id

            bank_id = derive_hindsight_bank_id(
                ctx.tenant_id, ctx.user_id, employee_id, ctx.enterprise_id,
            )
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
                self.ensure_bank(ctx, employee_id=employee_id)
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
            if not 200 <= response.status_code < 300:
                raise HindsightUnavailable(f"Hindsight returned HTTP {response.status_code}")
            if len(response.content) > _MAX_RESPONSE_BYTES:
                raise HindsightUnavailable("Hindsight response is too large")
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
        # Governance retain is still append-only; document_id is never an
        # authority to replace an existing native document.
        item["metadata"] = metadata
        operation_id = hashlib.sha256(
            f"{ctx.tenant_id}:{ctx.user_id}:{employee_id}:"
            f"{content}:{json.dumps(metadata, sort_keys=True, default=str)}".encode()
        ).hexdigest()
        operation_id = (
            f"{operation_id[:8]}-{operation_id[8:12]}-{operation_id[12:16]}-"
            f"{operation_id[16:20]}-{operation_id[20:32]}"
        )
        from .hindsight_operation_policy import scoped_retain_body
        payload = scoped_retain_body({"items": [item], "async": True, "operation_id": operation_id},
                                     tenant_id=ctx.tenant_id, member_id=ctx.user_id, employee_id=employee_id)
        return self._request(ctx, self._settings.retain_path, payload, employee_id=employee_id)

    def stats(self, ctx: TenantContext, *, employee_id: str) -> dict:
        path = self._settings.stats_path or _derive_stats_path(self._settings.list_path)
        return self._request(
            ctx, path, None, employee_id=employee_id, method="GET",
        )

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
        update_path = self._settings.update_path or _derive_update_path(
            self._settings.list_path, self._settings.delete_path,
        )
        return self._request(
            ctx,
            update_path,
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
