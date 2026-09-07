"""Operation-scoped Hindsight transport; bank administration stays in trusted Manager code."""
from __future__ import annotations

import json
import re

import httpx
from fastapi import Request
from starlette.responses import Response

from shared.contracts.tenancy import TenantContext
from shared.errors import AppError
from .active_principal import require_active, require_bound_tenant
from .hindsight_client import HindsightSettings, HindsightUnavailable
from .hindsight_credentials import HindsightLeaseBackend, HindsightLeaseStore, HindsightLeaseUnauthorized
from .hindsight_lease_repository import HindsightLeaseForbidden
from .hindsight_operation_policy import parse_operation_body, scoped_retain_body
from .memory_policy_service import normalize_policy, require_retention_ready
from .schemas_hindsight import HINDSIGHT_CLIENT_PROTOCOL

_BANK_PATH = re.compile(r"^v1/default/banks/([A-Za-z0-9_-]{1,128})/(profile|memories/recall|memories)$")
_MAX_BODY_BYTES = 256 * 1024
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
HindsightLeaseScopeError = HindsightLeaseForbidden


class HindsightFacade:
    def __init__(self, *, settings: HindsightSettings | None = None,
                 leases: HindsightLeaseBackend | None = None, client: httpx.AsyncClient | None = None,
                 principal_repository=None, snapshot_service=None, retention_service=None,
                 deployment_tenant_id: str | None = None):
        self.settings = settings or HindsightSettings.from_env()
        self.leases = leases or HindsightLeaseStore(self.settings.lease_ttl_seconds)
        self._client = client
        self._principals = principal_repository
        self._snapshot = snapshot_service
        self._retention = retention_service
        self._deployment_tenant_id = deployment_tenant_id

    def _authorize(self, lease, operation: str) -> dict:
        bound_tenant = require_bound_tenant(self._deployment_tenant_id)
        if lease.tenant_id != bound_tenant:
            # Opaque leases survive process restarts, so a lease issued before
            # a deployment rebind must never select the old enterprise bank.
            raise HindsightLeaseForbidden("Hindsight lease is not bound to this Manager deployment")
        if self._principals is None or self._snapshot is None:
            raise HindsightUnavailable("online memory authorization is not configured")
        ctx = TenantContext(tenant_id=lease.tenant_id, user_id=lease.member_id)
        try:
            principal = self._principals.find_user(ctx, user_id=lease.member_id)
            require_active(principal)
            ctx = ctx.model_copy(update={"roles": list(getattr(principal, "roles", []) or [])})
            self._snapshot._ensure_runnable(ctx, employee_id=lease.employee_id)
            snapshot = self._snapshot.generate(ctx, member_id=lease.member_id, employee_id=lease.employee_id)
            if snapshot.employee_id != lease.employee_id:
                raise HindsightLeaseForbidden("Employee scope is invalid")
            policy = snapshot.memory_policy
            if not isinstance(policy, dict):
                raise HindsightLeaseForbidden("Memory policy is unavailable")
            (self._retention.require_ready(policy) if self._retention is not None else require_retention_ready(policy))
            current = normalize_policy(policy)
            allowed = set(lease.allowed_operations) & set(current["allowed_operations"])
            if not allowed or (operation != "profile" and operation not in allowed):
                raise HindsightLeaseForbidden("Memory operation is not authorized")
            if operation == "retain" and (
                lease.client_protocol != HINDSIGHT_CLIENT_PROTOCOL
                or type(policy.get("revision")) is not int or policy["revision"] < 1
                or lease.policy_revision != policy["revision"]
            ):
                # Manual and automatic SDK retain use identical POSTs. Cancel all
                # old write scopes on policy change, not a caller-declared intent.
                raise HindsightLeaseForbidden("Memory write lease requires current policy and supported client protocol")
            return policy
        except AppError:
            raise
        except Exception as exc:
            raise HindsightUnavailable("online memory authorization is unavailable") from exc

    async def proxy(self, request: Request, path: str) -> Response:
        # The facade has no user JWT dependency, so its deployment binding is
        # the first authorization boundary.  An unbound Manager must fail before
        # resolving an opaque lease (or touching the Hindsight upstream).
        bound_tenant = require_bound_tenant(self._deployment_tenant_id)
        # Starlette already decodes once. Reject any original percent encoding,
        # including double encoding, rather than applying another URL decoder.
        raw = request.scope.get("raw_path", b"")
        match = _BANK_PATH.fullmatch(path)
        if match is None or b"%" in raw or request.query_params:
            raise HindsightLeaseForbidden("Hindsight path is outside the operation facade")
        bank_id, suffix = match.groups()
        operation = {"profile": "profile", "memories/recall": "recall", "memories": "retain"}[suffix]
        if request.method != ("GET" if operation == "profile" else "POST"):
            raise HindsightLeaseForbidden("Hindsight method is not authorized")
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer ") or not authorization[7:].strip():
            raise HindsightLeaseUnauthorized("Hindsight lease is required")
        token = authorization[7:].strip()
        lease = self.leases.resolve(token, bank_id=bank_id)
        if lease.tenant_id != bound_tenant:
            raise HindsightLeaseForbidden("Hindsight lease is not bound to this Manager deployment")
        # The persisted bank is Manager-derived at issuance, never caller input.
        if not all(isinstance(v, str) and v.strip() for v in (lease.tenant_id, lease.member_id, lease.employee_id)):
            raise HindsightLeaseForbidden("Hindsight lease scope is invalid")
        self._authorize(lease, operation)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > _MAX_BODY_BYTES:
                raise HindsightLeaseForbidden("Hindsight request exceeds the body limit")
        if operation == "profile":
            if body:
                raise HindsightLeaseForbidden("Hindsight profile does not accept a body")
            # The pinned extension only needs a successful profile to avoid PUT.
            # No upstream mission/disposition/settings or memory data are exposed.
            return Response(json.dumps({"bank_id": bank_id, "name": bank_id, "mission": "",
                                        "disposition": {"skepticism": 3, "literalism": 3, "empathy": 3}}),
                            media_type="application/json", headers={"Cache-Control": "no-store"})
        if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
            raise HindsightLeaseForbidden("Hindsight requires a JSON operation body")
        payload = parse_operation_body(operation, bytes(body))
        if operation == "retain":
            payload = scoped_retain_body(payload, tenant_id=lease.tenant_id,
                                         member_id=lease.member_id, employee_id=lease.employee_id)
        if not self.settings.base_url or not self.settings.token:
            raise HindsightUnavailable("Hindsight upstream is not configured")
        # Body streaming can span a revocation/expiry; recheck before side effects.
        lease = self.leases.resolve(token, bank_id=bank_id)
        policy = self._authorize(lease, operation)
        ctx = TenantContext(tenant_id=lease.tenant_id, user_id=lease.member_id)
        if self._retention is not None:
            payload = (self._retention.prepare(ctx, employee_id=lease.employee_id, bank_id=bank_id, policy=policy, body=payload)
                       if operation == "retain" else self._retention.recall_body(policy, payload))
        # Write authorization linearizes at this final current-policy check.
        # A later revocation cannot roll back a native operation already handed off.
        self._authorize(self.leases.resolve(token, bank_id=bank_id), operation)
        client = self._client or httpx.AsyncClient(timeout=60.0, follow_redirects=False)
        try:
            async with client.stream("POST", f"{self.settings.base_url.rstrip('/')}/{path}", json=payload,
                                     headers={"Authorization": f"Bearer {self.settings.token}",
                                              "X-Tenant-ID": lease.tenant_id, "X-Member-ID": lease.member_id,
                                              "X-Employee-ID": lease.employee_id}) as upstream:
                if not 200 <= upstream.status_code < 300:
                    raise HindsightUnavailable("Hindsight operation failed")
                data = bytearray()
                async for chunk in upstream.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > _MAX_RESPONSE_BYTES:
                        raise HindsightUnavailable("Hindsight response exceeds the limit")
            policy = self._authorize(self.leases.resolve(token, bank_id=bank_id), operation)
            # Errors/headers/cookies from the upstream are never relayed.
            result = json.loads(data)
            if self._retention is not None:
                if operation == "retain":
                    result = self._retention.validate_retain_response(payload, result, bank_id)
                else:
                    result = self._retention.filter_recall(ctx, employee_id=lease.employee_id, bank_id=bank_id, policy=policy, response=result)
                    current = self._authorize(self.leases.resolve(token, bank_id=bank_id), operation)
                    if current != policy:
                        raise HindsightLeaseForbidden("Memory policy changed during recall")
                    # Re-filter at the final current clock, not the request timestamp.
                    result = self._retention.filter_recall(ctx, employee_id=lease.employee_id, bank_id=bank_id, policy=current, response=json.loads(data))
            return Response(json.dumps(result), status_code=upstream.status_code, media_type="application/json",
                            headers={"Cache-Control": "no-store"})
        except (httpx.HTTPError, ValueError) as exc:
            raise HindsightUnavailable("Hindsight operation is unavailable") from exc
        finally:
            if self._client is None:
                await client.aclose()
