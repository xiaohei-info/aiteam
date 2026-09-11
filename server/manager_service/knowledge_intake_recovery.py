"""Restartable Manager-owned ingestion: one bounded claim, never replay a fenced POST."""
from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from shared.contracts.tenancy import TenantContext

from .document_parser import UnsupportedFormatError, extract_text

log = logging.getLogger(__name__)


class KnowledgeIntakeRecovery:
    def __init__(self, intake):
        self.intake = intake
        # The cursor only rotates the bounded admin inventory between sweeps;
        # claims and tenant data remain governed by the per-job lease/RLS path.
        self._tenant_cursor: str | None = None

    def process(self, ctx: TenantContext, *, job_id: str | None = None) -> bool:
        service = self.intake
        repo = service._job_repo
        owner = uuid.uuid4().hex
        job = repo.claim(ctx, owner=owner, job_id=job_id)
        if job is None:
            return False
        doc = service._require_doc(ctx, knowledge_space_id=job.knowledge_space_id, document_id=job.document_id)
        try:
            # Pre-S05 jobs used document_id itself as file_source.  Once more
            # than one generation exists that alias cannot identify which
            # upstream generation this row represents.  Protect every state,
            # including not_submitted: absence of a track is not proof that a
            # POST was never accepted, so neither POST nor reconciliation is
            # safe until an operator resolves the legacy rows.
            if job.file_source == job.document_id:
                generations = repo.list_by_document(ctx, document_id=job.document_id)
                if len(generations) != 1:
                    repo.settle(
                        ctx, job, owner=owner, state="unknown",
                        error_code="SUBMISSION_UNKNOWN",
                    )
                    return True
            # Resolve the persisted workspace/endpoint mapping once per job and
            # carry its instance_id through every downstream call. Re-hashing
            # the workspace after a registry reorder could send a valid job to
            # another endpoint.
            handle = service._rag_handle(ctx, job.knowledge_space_id)
            if job.submission_state == "not_submitted":
                from .knowledge_intake_service import _resolve_path
                try:
                    text = extract_text(_resolve_path(service._storage_root, doc.storage_key))
                    if not text.strip():
                        repo.settle(ctx, job, owner=owner, state="failed", error_code="EMPTY_TEXT")
                        return True
                except (UnsupportedFormatError, FileNotFoundError) as exc:
                    code = "UNSUPPORTED_FORMAT" if isinstance(exc, UnsupportedFormatError) else "FILE_NOT_FOUND"
                    repo.settle(ctx, job, owner=owner, state="failed", error_code=code)
                    return True
                except Exception:
                    repo.settle(ctx, job, owner=owner, state="failed", error_code="PARSE_FAILED")
                    return True
                # Resolve all local routing/configuration failures before the fence.
                client = service._ingestion_client
                client.validate_submission(
                    workspace=handle.workspace, file_source=job.file_source, text=text,
                    instance_id=getattr(handle, "instance_id", "legacy"),
                )
                if not repo.fence_submission(ctx, job, owner=owner, text_chars=len(text)):
                    return True
                # From this commit onward absence is NOT evidence of rejection.
                track_id = client.submit_text(
                    workspace=handle.workspace, file_source=job.file_source, text=text,
                    instance_id=getattr(handle, "instance_id", "legacy"),
                )
                if not repo.record_track(ctx, job, owner=owner, track_id=track_id):
                    return True
                job = repo.get(ctx, ingestion_id=job.id)
            result = service._ingestion_client.reconcile_ingestion(
                workspace=handle.workspace, file_source=job.file_source, track_id=job.track_id,
                instance_id=getattr(handle, "instance_id", "legacy"),
            )
            if result.state == "processed" and result.upstream_document_id:
                now = datetime.now(timezone.utc)
                service._binding_repo.publish_ready(
                    ctx, knowledge_space_id=job.knowledge_space_id, document_id=job.document_id,
                    employee_ids=sorted(set(service._employee_index_port.list_employees_by_space(ctx, knowledge_space_id=job.knowledge_space_id))),
                    rag_document_id=result.upstream_document_id, job_id=job.id,
                    chunk_count=result.chunk_count, text_chars=job.text_chars or doc.text_chars or 0,
                    completed_at=now, synced_at=now, claim_owner=owner,
                )
            else:
                repo.settle(ctx, job, owner=owner, state=result.state,
                            error_code="INDEX_FAILED" if result.state == "failed" else None,
                            upstream_document_id=result.upstream_document_id)
        except Exception:
            # No raw upstream errors, source paths, text or credentials in logs.
            log.warning("knowledge ingestion reconciliation pending", extra={"tenant_id": ctx.tenant_id, "job_id": job.id})
            current = repo.get(ctx, ingestion_id=job.id)
            if current and current.submission_state == "not_submitted":
                repo.settle(ctx, job, owner=owner, state="failed", error_code="INDEX_UNCONFIGURED")
            else:
                repo.settle(ctx, job, owner=owner, state="unknown")
        return True

    def maintain_once(self, ctx: TenantContext, *, limit: int = 8) -> int:
        count = 0
        for _ in range(min(8, max(0, limit))):
            if not self.process(ctx):
                break
            count += 1
        return count

    @staticmethod
    def due_tenant_ids(
        admin_dsn: str,
        *,
        limit: int = 32,
        after_tenant_id: str | None = None,
    ) -> list[str]:
        """Inventory a bounded set of tenants with due intake rows.

        The admin connection is used only for this metadata inventory.  Actual
        claims still run through ``TenantContext`` and the business router/RLS
        boundary.  ``after_tenant_id`` lets a long-lived worker rotate through
        more tenants than one bounded inventory without fetching an unbounded
        registry.
        """
        import psycopg

        clauses = [
            "next_attempt_at <= now()",
            "(lease_until IS NULL OR lease_until <= now())",
            "(status NOT IN ('done','failed') OR submission_state='submitted')",
        ]
        params: list[object] = []
        if after_tenant_id is not None:
            clauses.append("tenant_id > %s::uuid")
            params.append(after_tenant_id)
        params.append(max(1, min(limit, 64)))
        with psycopg.connect(admin_dsn, autocommit=True) as conn:
            rows = conn.execute(
                "SELECT tenant_id FROM knowledge_ingestion_job WHERE "
                + " AND ".join(clauses)
                + " GROUP BY tenant_id ORDER BY tenant_id LIMIT %s",
                tuple(params),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def maintain_all(self, admin_dsn: str, *, limit: int = 8) -> int:
        """Claim at most eight jobs, rotating one claim per tenant per pass.

        A tenant-local exception is isolated so a broken tenant cannot consume
        the sweep.  The cursor advances even when a tenant has no claim or
        fails, preserving fairness across subsequent bounded inventories.
        """
        budget = min(8, max(0, limit))
        if not budget:
            return 0
        tenant_ids = (
            self.due_tenant_ids(admin_dsn)
            if self._tenant_cursor is None
            else self.due_tenant_ids(admin_dsn, after_tenant_id=self._tenant_cursor)
        )
        if not tenant_ids and self._tenant_cursor is not None:
            # Wrap only between passes; each returned tenant is still visited
            # once in this pass, so the global budget remains bounded.
            tenant_ids = self.due_tenant_ids(admin_dsn)
        total = 0
        attempts = 0
        for tenant_id in tenant_ids:
            if attempts >= budget:
                break
            self._tenant_cursor = tenant_id
            attempts += 1
            try:
                total += self.maintain_once(
                    TenantContext(tenant_id=tenant_id, user_id="knowledge-recovery"),
                    limit=1,
                )
            except Exception:
                # Do not let one tenant's DB/upstream failure stop the rest of
                # this bounded sweep.  Cancellation/ shutdown use BaseException
                # and therefore remain visible to the lifespan caller.
                log.warning(
                    "knowledge ingestion tenant sweep failed",
                    extra={"tenant_id": tenant_id, "code": "tenant_recovery_failed"},
                )
        return total


def install_knowledge_intake_lifespan(app):
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(instance):
        async with original(instance):
            stop = asyncio.Event()
            worker = None

            def sweep():
                nonlocal worker
                settings = getattr(instance.state, "settings", None)
                service = getattr(instance.state, "_knowledge_intake_service", None)
                admin_dsn = getattr(settings, "admin_db_url", None)
                if service is None or not admin_dsn:
                    return 0
                if worker is None or worker.intake is not service:
                    worker = KnowledgeIntakeRecovery(service)
                return worker.maintain_all(admin_dsn)

            async def poll():
                while not stop.is_set():
                    try:
                        await asyncio.to_thread(sweep)
                    except Exception:
                        log.warning("knowledge ingestion recovery unavailable")
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=5)
                    except TimeoutError:
                        pass

            task = asyncio.create_task(poll())
            try:
                yield
            finally:
                stop.set()
                await task
    app.router.lifespan_context = lifespan
