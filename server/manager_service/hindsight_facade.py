"""Bank-scoped Hindsight facade transport.

The Agent talks to this route with an opaque lease token. The route validates
that token and the URL bank segment, then substitutes Manager's private
HINDSIGHT_SERVICE_TOKEN for the upstream request. Native Hindsight 0.12.0
cannot enforce this scope itself, so direct Agent access to Hindsight is not a
supported deployment shape.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import unquote

import httpx
from fastapi import Request
from starlette.responses import Response

from .hindsight_client import HindsightSettings, HindsightUnavailable
from .hindsight_credentials import (
    HindsightLeaseBackend,
    HindsightLeaseForbidden,
    HindsightLeaseStore,
    HindsightLeaseUnauthorized,
    derive_hindsight_bank_id,
)


_BANK_PATH = re.compile(r"^v1/default/banks/([^/]+)(?:/.*)?$")
_PROXY_HEADERS = ("accept", "content-type", "idempotency-key", "user-agent")
_MAX_BODY_BYTES = 8 * 1024 * 1024


class HindsightFacade:
    """Proxy only the bank path authorized by a Manager-issued lease."""

    def __init__(
        self,
        *,
        settings: HindsightSettings | None = None,
        leases: HindsightLeaseBackend | None = None,
        client: httpx.AsyncClient | None = None,
    ):
        self.settings = settings or HindsightSettings.from_env()
        self.leases = leases or HindsightLeaseStore(self.settings.lease_ttl_seconds)
        self._client = client

    async def proxy(self, request: Request, path: str) -> Response:
        decoded_path = unquote(path).lstrip("/")
        match = _BANK_PATH.fullmatch(decoded_path)
        if match is None or ".." in decoded_path.split("/") or any(char in decoded_path for char in "?#\\"):
            raise HindsightLeaseScopeError("Hindsight path is outside the bank facade")
        bank_id = match.group(1)
        if "bank_id" in request.query_params or "bank" in request.query_params:
            raise HindsightLeaseScopeError("bank scope is controlled by the lease")

        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer ") or not authorization[7:].strip():
            raise HindsightLeaseUnauthorized("Hindsight lease is required")
        lease = self.leases.resolve(authorization[7:].strip(), bank_id=bank_id)
        # The URL bank is untrusted input: use it only as a candidate and bind
        # it to the lease's complete Manager-owned scope before proxying.
        scope_values = (lease.tenant_id, lease.member_id, lease.employee_id)
        derived_bank = (
            derive_hindsight_bank_id(*scope_values)
            if all(isinstance(value, str) and value.strip() for value in scope_values)
            else None
        )
        if (
            lease.bank_id != bank_id
            or not all(isinstance(value, str) and value.strip() for value in scope_values)
            or (lease.bank_id.startswith("aiteam-") and lease.bank_id != derived_bank)
        ):
            raise HindsightLeaseScopeError("Hindsight lease scope is not valid")
        self._require_upstream()

        body = await request.body()
        if len(body) > _MAX_BODY_BYTES:
            raise HindsightUnavailable(
                "Hindsight request exceeds the facade body limit"
            )
        if _body_contains_bank_selector(request, body):
            raise HindsightLeaseScopeError("bank scope is controlled by the lease")
        upstream_headers = {
            header: request.headers[header]
            for header in _PROXY_HEADERS
            if header in request.headers
        }
        upstream_headers.update(
            {
                "Authorization": f"Bearer {self.settings.token}",
                "X-Tenant-ID": lease.tenant_id,
                "X-Member-ID": lease.member_id,
                "X-Employee-ID": lease.employee_id,
            }
        )
        target = f"{self.settings.base_url.rstrip('/')}/{decoded_path}"
        client = self._client or httpx.AsyncClient(timeout=60.0)
        try:
            upstream = await client.request(
                request.method,
                target,
                content=body,
                headers=upstream_headers,
                params=list(request.query_params.multi_items()),
            )
            # Never mirror authentication or cookie headers from Hindsight to the Agent.
            headers = (
                {"content-type": upstream.headers["content-type"]}
                if "content-type" in upstream.headers
                else None
            )
            return Response(
                content=upstream.content,
                status_code=upstream.status_code,
                headers=headers,
            )
        except HindsightUnavailable:
            raise
        except httpx.HTTPError as exc:
            raise HindsightUnavailable("Hindsight facade request failed") from exc
        finally:
            if self._client is None:
                await client.aclose()

    def _require_upstream(self) -> None:
        if not (
            isinstance(self.settings.base_url, str)
            and self.settings.base_url.strip()
            and isinstance(self.settings.token, str)
            and self.settings.token.strip()
        ):
            raise HindsightUnavailable(
                "Hindsight facade requires HINDSIGHT_URL and HINDSIGHT_SERVICE_TOKEN"
            )


HindsightLeaseScopeError = HindsightLeaseForbidden


def _body_contains_bank_selector(request: Request, body: bytes) -> bool:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json" or not body:
        return False
    try:
        value = json.loads(body)
    except (TypeError, ValueError):
        return False
    return _contains_bank_selector(value)


def _contains_bank_selector(value: Any) -> bool:
    if isinstance(value, dict):
        if "bank_id" in value or "bank" in value:
            return True
        return any(_contains_bank_selector(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_bank_selector(item) for item in value)
    return False
