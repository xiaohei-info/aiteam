"""Manager control-plane bindings created by the Operator F01 flow.

``tenant_registry`` identifies a tenant, but it does not prove which signed
Operator deployment/origin was authorized to create it.  This small control
record is the post-F01 target authority used by F02/F17.  All lookups are exact;
there is intentionally no wildcard or first-row fallback.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shared.errors import Conflict, Forbidden, NotFound

from .exceptions import ManagerControlPlaneUnavailable


@dataclass(frozen=True)
class OperatorTenantBinding:
    tenant_id: str
    enterprise_id: str
    principal_kid: str
    issuer: str
    subject: str
    audience: str
    deployment_id: str
    origin: str


class OperatorTenantBindingRepository:
    """Admin-connection repository for exact Operator→tenant bindings."""

    def __init__(self, admin_dsn: str):
        self._admin_dsn = admin_dsn

    @staticmethod
    def _value(principal: Any, name: str, alias: str | None = None) -> Any:
        value = getattr(principal, name, None)
        if value is None and alias:
            value = getattr(principal, alias, None)
        if isinstance(principal, dict):
            value = principal.get(name, principal.get(alias) if alias else None)
        return value

    @classmethod
    def from_principal(cls, principal: Any, *, tenant_id: str, enterprise_id: str) -> OperatorTenantBinding:
        aud = cls._value(principal, "aud", "audience")
        if isinstance(aud, (list, tuple)):
            aud = aud[0] if len(aud) == 1 else ",".join(str(item) for item in aud)
        values = {
            "tenant_id": tenant_id,
            "enterprise_id": enterprise_id,
            "principal_kid": cls._value(principal, "kid"),
            "issuer": cls._value(principal, "iss", "issuer"),
            "subject": cls._value(principal, "sub", "subject"),
            "audience": aud,
            "deployment_id": cls._value(principal, "deployment_id"),
            "origin": cls._value(principal, "origin"),
        }
        if any(not isinstance(value, str) or not value.strip() for value in values.values()):
            raise Forbidden("verified Operator service principal is incomplete")
        if any("*" in value for value in values.values()):
            raise Forbidden("wildcard service target bindings are not allowed")
        return OperatorTenantBinding(**values)

    def ensure_binding(self, binding: OperatorTenantBinding) -> None:
        import psycopg

        with psycopg.connect(self._admin_dsn) as conn:
            row = conn.execute(
                "INSERT INTO operator_tenant_binding "
                "(tenant_id, enterprise_id, principal_kid, issuer, subject, audience, deployment_id, origin) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (tenant_id) DO NOTHING "
                "RETURNING tenant_id",
                (
                    binding.tenant_id,
                    binding.enterprise_id,
                    binding.principal_kid,
                    binding.issuer,
                    binding.subject,
                    binding.audience,
                    binding.deployment_id,
                    binding.origin,
                ),
            ).fetchone()
            if row is None:
                existing = self._get_on_connection(conn, tenant_id=binding.tenant_id)
                if existing != binding:
                    raise Conflict("tenant provisioning binding does not match the registered Operator")
            else:
                # The enterprise id has its own unique constraint.  A second
                # row for the same enterprise must never be silently rebound.
                existing = self._get_on_connection(conn, tenant_id=binding.tenant_id)
                if existing != binding:
                    raise Conflict("tenant provisioning binding could not be recorded exactly")

    def get(self, *, tenant_id: str) -> OperatorTenantBinding:
        import psycopg

        with psycopg.connect(self._admin_dsn, autocommit=True) as conn:
            binding = self._get_on_connection(conn, tenant_id=tenant_id)
        if binding is None:
            raise NotFound("tenant provisioning binding not found")
        return binding

    @staticmethod
    def _get_on_connection(conn, *, tenant_id: str) -> OperatorTenantBinding | None:
        row = conn.execute(
            "SELECT tenant_id, enterprise_id, principal_kid, issuer, subject, audience, deployment_id, origin "
            "FROM operator_tenant_binding WHERE tenant_id = %s",
            (tenant_id,),
        ).fetchone()
        if row is None:
            return None
        return OperatorTenantBinding(*(str(value) for value in row))

    def require_exact(
        self,
        principal: Any,
        *,
        tenant_id: str,
        enterprise_id: str | None = None,
        require_enterprise_claim: bool = False,
    ) -> OperatorTenantBinding:
        binding = self.get(tenant_id=tenant_id)
        expected = self.from_principal(principal, tenant_id=binding.tenant_id, enterprise_id=binding.enterprise_id)
        if require_enterprise_claim and self._value(principal, "enterprise_id") != enterprise_id:
            raise Forbidden("service principal enterprise target does not match tenant binding")
        if not require_enterprise_claim and self._value(principal, "enterprise_id") is not None:
            raise Forbidden("owner bootstrap principal must not carry an enterprise target")
        if enterprise_id is not None and binding.enterprise_id != enterprise_id:
            raise Forbidden("service target enterprise does not match tenant binding")
        if expected != binding:
            raise Forbidden("service principal is not bound to this tenant")
        return binding

    def ensure_registry_and_binding(
        self,
        *,
        tenant_id: str,
        enterprise_id: str,
        enterprise_slug: str,
        enterprise_code: str | None,
        principal: Any | None,
        idempotency_key: str | None = None,
        request_fingerprint: str | None = None,
    ) -> bool:
        """Insert an F01 registry row and optional signed-principal binding.

        Returns ``True`` for a newly inserted registry row and ``False`` for an
        exact replay.  A pre-existing row with different identifiers is a
        conflict, never an implicit rebind.
        """
        import psycopg

        if (idempotency_key is None) != (request_fingerprint is None):
            raise ValueError("F01 idempotency key and fingerprint must be supplied together")
        if principal is not None and (not idempotency_key or not request_fingerprint):
            raise Conflict("signed F01 provisioning requires an idempotency key")

        with psycopg.connect(self._admin_dsn) as conn, conn.transaction():
            receipt = None
            if idempotency_key is not None and request_fingerprint is not None:
                receipt = conn.execute(
                    "SELECT idempotency_key, request_fingerprint, tenant_id, enterprise_id, enterprise_slug, enterprise_code "
                    "FROM manager_onboarding_receipt WHERE idempotency_key = %s FOR UPDATE",
                    (idempotency_key,),
                ).fetchone()
                if receipt is not None and (
                    str(receipt[1]) != request_fingerprint
                    or str(receipt[2]) != tenant_id
                    or str(receipt[3]) != enterprise_id
                    or receipt[4] != enterprise_slug
                    or receipt[5] != enterprise_code
                ):
                    raise Conflict("Idempotency-Key was already used for a different F01 request")

            # Reserve the tenant target before recording the receipt.  Both
            # writes share this transaction, so an incomplete target cannot
            # leave behind a durable successful receipt.
            inserted = conn.execute(
                "INSERT INTO tenant_registry (tenant_id, enterprise_id, enterprise_slug, enterprise_code) "
                "VALUES (%s, %s, %s, %s) ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id",
                (tenant_id, enterprise_id, enterprise_slug, enterprise_code),
            ).fetchone()
            existing = conn.execute(
                "SELECT tenant_id, enterprise_id, enterprise_slug, enterprise_code "
                "FROM tenant_registry WHERE tenant_id = %s",
                (tenant_id,),
            ).fetchone()
            if existing is None:
                raise ManagerControlPlaneUnavailable("Manager tenant registry is unavailable")
            existing_enterprise = str(existing[1]) if existing[1] is not None else None
            if (
                existing_enterprise != enterprise_id
                or existing[2] != enterprise_slug
                or existing[3] != enterprise_code
            ):
                raise Conflict("tenant target is already registered with different enterprise data")
            if principal is not None:
                binding = self.from_principal(
                    principal, tenant_id=tenant_id, enterprise_id=enterprise_id
                )
                if inserted is None and self._get_on_connection(conn, tenant_id=tenant_id) is None:
                    raise Conflict("tenant target was not created by a signed F01 provisioning call")
                row = conn.execute(
                    "INSERT INTO operator_tenant_binding "
                    "(tenant_id, enterprise_id, principal_kid, issuer, subject, audience, deployment_id, origin) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
                    "ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id",
                    (
                        binding.tenant_id,
                        binding.enterprise_id,
                        binding.principal_kid,
                        binding.issuer,
                        binding.subject,
                        binding.audience,
                        binding.deployment_id,
                        binding.origin,
                    ),
                ).fetchone()
                if row is None:
                    bound = self._get_on_connection(conn, tenant_id=tenant_id)
                    if bound != binding:
                        raise Conflict("tenant target is bound to a different Operator principal")
                elif self._get_on_connection(conn, tenant_id=tenant_id) != binding:
                    raise Conflict("tenant provisioning binding could not be recorded exactly")

            if receipt is None and idempotency_key is not None and request_fingerprint is not None:
                receipt = conn.execute(
                    "INSERT INTO manager_onboarding_receipt "
                    "(idempotency_key, request_fingerprint, tenant_id, enterprise_id, enterprise_slug, enterprise_code) "
                    "VALUES (%s, %s, %s, %s, %s, %s) "
                    "ON CONFLICT (idempotency_key) DO NOTHING "
                    "RETURNING idempotency_key, request_fingerprint, tenant_id, enterprise_id, enterprise_slug, enterprise_code",
                    (idempotency_key, request_fingerprint, tenant_id, enterprise_id, enterprise_slug, enterprise_code),
                ).fetchone()
                if receipt is None:
                    receipt = conn.execute(
                        "SELECT idempotency_key, request_fingerprint, tenant_id, enterprise_id, enterprise_slug, enterprise_code "
                        "FROM manager_onboarding_receipt WHERE idempotency_key = %s FOR UPDATE",
                        (idempotency_key,),
                    ).fetchone()
                    if receipt is None:
                        raise ManagerControlPlaneUnavailable("Manager onboarding receipt is unavailable")
                    if (
                        str(receipt[1]) != request_fingerprint
                        or str(receipt[2]) != tenant_id
                        or str(receipt[3]) != enterprise_id
                        or receipt[4] != enterprise_slug
                        or receipt[5] != enterprise_code
                    ):
                        raise Conflict("Idempotency-Key was already used for a different F01 request")
            return inserted is not None


__all__ = ["OperatorTenantBinding", "OperatorTenantBindingRepository"]
