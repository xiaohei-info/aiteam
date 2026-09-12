"""Durable Manager -> Operator usage delivery worker."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Callable, Protocol

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.service_client import ServiceClient

try:
    from shared.config import service_peer_audience
except ImportError:  # pragma: no cover - compatibility before the signed-peer lane lands
    def service_peer_audience(settings) -> str:
        """Use the peer-audience contract when running on the pre-signed base."""

        configured = getattr(settings, "service_identity_peer_audience", None)
        if configured:
            return configured
        if getattr(settings, "is_production", False):
            return ""
        return "aiteam-operation-service" if settings.tier == "manager" else "aiteam-manager-service"

from .rollup_reporter import ServiceClientRollupClient
from .usage_delivery_repository import (
    NullableEnterpriseRollupUpload,
    NullableUsageSummaryPayload,
    UsageOperatorDeliveryRepository,
    UsageOperatorDeliveryRow,
)

logger = logging.getLogger(__name__)

# A sweep is deliberately finite: a large tenant population cannot monopolize
# the Manager process or turn a transient Operator outage into an unbounded loop.
MAX_TENANTS_PER_SWEEP = 32
MAX_DELIVERIES_PER_TENANT_SWEEP = 8
DELIVERY_POLL_SECONDS = 5


class OperatorUsageClient(Protocol):
    def upload(self, payload: NullableEnterpriseRollupUpload, *, idempotency_key: str) -> None: ...


class UsageOperatorDeliveryService:
    """Claim, send, and settle durable usage delivery receipts."""

    def __init__(
        self,
        repository: UsageOperatorDeliveryRepository,
        client: OperatorUsageClient,
        *,
        enterprise_resolver: Callable[[str], str | None] | None = None,
    ) -> None:
        self._repository = repository
        self._client = client
        self._enterprise_resolver = enterprise_resolver

    @property
    def repository(self) -> UsageOperatorDeliveryRepository:
        return self._repository

    def deliver_due(
        self,
        ctx: TenantContext,
        *,
        enterprise_id: str | None = None,
        limit: int = MAX_DELIVERIES_PER_TENANT_SWEEP,
    ) -> dict[str, int]:
        """Deliver due rows for one tenant, preserving failed/sent receipts."""

        resolved = enterprise_id
        if not resolved and self._enterprise_resolver is not None:
            try:
                resolved = self._enterprise_resolver(ctx.tenant_id)
            except Exception:  # noqa: BLE001 - mapping outages are retryable, not upload failures
                # Already mapped receipts can still be delivered; only
                # unresolved rows wait for the next mapping lookup.
                logger.warning(
                    "usage delivery enterprise mapping unavailable",
                    extra={"tenant_id": ctx.tenant_id},
                )
                resolved = None
        if resolved:
            try:
                self._repository.assign_enterprise_id(ctx, enterprise_id=resolved)
            except Exception:  # noqa: BLE001 - durable rows remain for the next sweep
                logger.warning(
                    "usage delivery enterprise mapping update unavailable",
                    extra={"tenant_id": ctx.tenant_id},
                )
                return {"claimed": 0, "sent": 0, "failed": 0, "deferred": 1}

        try:
            rows = self._repository.claim_due(ctx, limit=limit)
        except Exception:  # noqa: BLE001 - do not turn a maintenance hint into request failure
            logger.warning(
                "usage delivery claim unavailable",
                extra={"tenant_id": ctx.tenant_id},
            )
            return {"claimed": 0, "sent": 0, "failed": 0, "deferred": 1}

        result = {"claimed": len(rows), "sent": 0, "failed": 0, "deferred": 0}
        for row in rows:
            try:
                payload = self._operator_payload(row)
                self._client.upload(payload, idempotency_key=row.idempotency_key)
            except Exception as exc:  # noqa: BLE001 - settle the claim and retry with bounded backoff
                # Keep diagnostics bounded and do not persist an upstream body,
                # token, URL, or any other potentially sensitive detail.
                error = f"{type(exc).__name__}: Operator usage delivery failed"
                if self._repository.mark_failed(
                    ctx,
                    delivery_id=row.delivery_id,
                    claim_token=row.claim_token or "",
                    error=error,
                    attempts=row.attempts,
                ):
                    result["failed"] += 1
                continue
            if self._repository.mark_sent(
                ctx,
                delivery_id=row.delivery_id,
                claim_token=row.claim_token or "",
            ):
                result["sent"] += 1
        return result

    @staticmethod
    def _operator_payload(row: UsageOperatorDeliveryRow) -> NullableEnterpriseRollupUpload:
        summary = NullableUsageSummaryPayload.model_validate(row.payload)
        if summary.tenant_id != row.tenant_id:
            raise ValueError("usage delivery tenant attribution is invalid")
        if summary.pricing_status == "unknown" and summary.cost_total is not None:
            summary = summary.model_copy(update={"cost_total": None})
        if not row.enterprise_id:
            raise ValueError("enterprise mapping is unavailable")
        return NullableEnterpriseRollupUpload(
            enterprise_id=row.enterprise_id,
            tenant_id=summary.tenant_id,
            summaries=[summary],
        )

    def list_deliveries(self, ctx: TenantContext, *, limit: int = 200):
        return self._repository.list(ctx, limit=limit)

    def close(self) -> None:
        close = getattr(self._client, "close", None)
        if callable(close):
            close()


def _resolve_enterprise_id(admin_db_url: str, tenant_id: str) -> str | None:
    import psycopg

    with psycopg.connect(admin_db_url, autocommit=True) as connection:
        row = connection.execute(
            "SELECT enterprise_id::text FROM tenant_registry WHERE tenant_id = %s::uuid",
            (tenant_id,),
        ).fetchone()
    return str(row[0]) if row and row[0] else None


def _list_manager_tenants(admin_db_url: str, *, after: str | None = None) -> list[str]:
    import psycopg

    with psycopg.connect(admin_db_url, autocommit=True) as connection:
        if after:
            rows = connection.execute(
                "SELECT tenant_id::text FROM tenant_registry WHERE tenant_id > %s::uuid "
                "ORDER BY tenant_id LIMIT %s",
                (after, MAX_TENANTS_PER_SWEEP),
            ).fetchall()
        else:
            rows = connection.execute(
                "SELECT tenant_id::text FROM tenant_registry ORDER BY tenant_id LIMIT %s",
                (MAX_TENANTS_PER_SWEEP,),
            ).fetchall()
    return [str(row[0]) for row in rows if row and row[0]]


def _build_operator_client(settings) -> ServiceClient | None:
    """Build the peer-audience client without production legacy-token fallback."""

    audience = service_peer_audience(settings)
    if settings.is_production and not audience:
        # A production Manager must fail closed when signed peer configuration
        # is missing; it must not turn SERVICE_TOKEN into a legacy fallback.
        return None
    kwargs = {
        "service_identity": settings.service_name,
        "service_audience": audience,
        "timeout": settings.service_client_timeout_ms / 1000,
    }
    if not settings.is_production and settings.service_token:
        # Explicit dev/test compatibility: the upgraded ServiceClient may use
        # this only when signed configuration is unavailable outside production.
        kwargs["service_token"] = settings.service_token
    try:
        return ServiceClient(settings.operator_url, **kwargs)
    except TypeError:
        # The current base branch predates the signed ServiceClient keyword.
        # Keep dev/test usable with its legacy client, but never do this in prod.
        if settings.is_production:
            logger.error("signed peer ServiceClient is unavailable in production")
            return None
        if not settings.service_token:
            return None
        return ServiceClient(
            settings.operator_url,
            service_identity=settings.service_name,
            service_token=settings.service_token,
            timeout=settings.service_client_timeout_ms / 1000,
        )


def build_usage_operator_delivery_service(settings) -> UsageOperatorDeliveryService | None:
    """Build a peer-audience client only when Manager delivery is configured."""

    if not settings.db_url or not settings.operator_url or not settings.admin_db_url:
        return None
    client = _build_operator_client(settings)
    if client is None:
        return None
    return UsageOperatorDeliveryService(
        UsageOperatorDeliveryRepository(PgTenantRouter(settings.db_url)),
        ServiceClientRollupClient(client),
        enterprise_resolver=lambda tenant_id: _resolve_enterprise_id(settings.admin_db_url, tenant_id),
    )


def install_usage_delivery_lifespan(app) -> None:
    """Install a bounded restart-resumable delivery poller on a Manager app."""

    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(instance):
        async with original(instance):
            settings = instance.state.settings
            service = build_usage_operator_delivery_service(settings)
            if service is None:
                yield
                return
            instance.state._usage_operator_delivery_service = service
            stop = asyncio.Event()

            tenant_cursor: str | None = None

            def sweep() -> None:
                nonlocal tenant_cursor
                try:
                    tenants = _list_manager_tenants(settings.admin_db_url, after=tenant_cursor)
                except Exception:  # noqa: BLE001 - next poll retries the control-plane lookup
                    logger.warning("usage delivery tenant scan unavailable")
                    return
                if not tenants:
                    tenant_cursor = None
                    return
                tenant_cursor = tenants[-1]
                for tenant_id in tenants:
                    service.deliver_due(
                        TenantContext(
                            tenant_id=tenant_id,
                            user_id="usage-delivery-worker",
                            roles=[],
                        ),
                        limit=MAX_DELIVERIES_PER_TENANT_SWEEP,
                    )

            async def poll() -> None:
                while not stop.is_set():
                    try:
                        await asyncio.to_thread(sweep)
                    except Exception:  # noqa: BLE001 - one sweep must not stop future retries
                        logger.warning("usage delivery sweep unavailable")
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=DELIVERY_POLL_SECONDS)
                    except TimeoutError:
                        pass

            task = asyncio.create_task(poll())
            try:
                yield
            finally:
                stop.set()
                await task
                service.close()

    app.router.lifespan_context = lifespan
