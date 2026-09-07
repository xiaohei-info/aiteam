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
                handle = service._rag_handle(ctx, job.knowledge_space_id)
                client = service._ingestion_client
                client.validate_submission(workspace=handle.workspace, file_source=job.file_source, text=text)
                if not repo.fence_submission(ctx, job, owner=owner, text_chars=len(text)):
                    return True
                # From this commit onward absence is NOT evidence of rejection.
                track_id = client.submit_text(workspace=handle.workspace, file_source=job.file_source, text=text)
                if not repo.record_track(ctx, job, owner=owner, track_id=track_id):
                    return True
                job = repo.get(ctx, ingestion_id=job.id)
            else:
                handle = service._rag_handle(ctx, job.knowledge_space_id)
            result = service._ingestion_client.reconcile_ingestion(
                workspace=handle.workspace, file_source=job.file_source, track_id=job.track_id,
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


def install_knowledge_intake_lifespan(app):
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(instance):
        async with original(instance):
            stop = asyncio.Event()

            def sweep():
                # Stage A: do not enumerate tenants or guess registry first-row.
                # Stage E claims due jobs per tenant_id. Request-path recovery
                # still runs under the caller's TenantContext.
                return

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
