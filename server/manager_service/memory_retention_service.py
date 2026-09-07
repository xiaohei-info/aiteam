"""Verified native invalidation plus conservative finite, fact-only recall.

This is acceptance/cleanup metadata, not a second memory store or hard erasure.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden
from .hindsight_client import HindsightClient, HindsightUnavailable
from .memory_policy_service import MemoryRetentionUnverified, is_retention_guarded

log = logging.getLogger(__name__)
SCHEMA_FINGERPRINT = "ea124758762dfd8ebcdda85dabdbadd5b5171d55cf90d17776f1b1a27965e3fb"
_PATHS = ("profile", "memories", "memories/recall", "memories/list", "memories/{memory_id}", "operations/{operation_id}")
_SCHEMAS = ("RecallRequest", "RecallResponse", "RecallResult", "RetainRequest", "RetainResponse", "MemoryItem",
            "ListMemoryUnitsResponse", "UpdateMemoryRequest", "OperationResponse", "BankProfileResponse")
_TERMINAL = {"completed", "failed", "cancelled"}
_META = ("aiteam_operation", "aiteam_policy_revision", "aiteam_accepted_at")


class MemoryRetentionOptionUnsupported(Forbidden):
    code, title = "memory_retention_option_unsupported", "Fact-only memory option unsupported"


def schema_fingerprint(schema):
    value = {"version": schema["info"]["version"],
             "paths": {"/v1/default/banks/{bank_id}/"+p: schema["paths"]["/v1/default/banks/{bank_id}/"+p] for p in _PATHS},
             "schemas": {name: schema["components"]["schemas"][name] for name in _SCHEMAS}}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def utcnow():
    return datetime.now(timezone.utc)


def deadline(row, policy):
    expires = row["expires_at"]
    days = policy.get("retention_days")
    if days is not None:
        current = row["accepted_at"] + timedelta(days=days)
        expires = min(expires, current) if expires else current
    return expires


def acceptance_metadata(row):
    return dict(zip(_META, (row["operation_id"], str(row["policy_revision"]), row["accepted_at"].isoformat())))


def proves_fact(row, fact, *, employee_id, bank_id):
    return row is not None and isinstance(fact.get("metadata"), dict) and row["employee_id"] == employee_id and row["bank_id"] == bank_id \
        and fact.get("document_id") == row["document_id"] \
        and all((fact.get("metadata") or {}).get(k) == v for k, v in acceptance_metadata(row).items())


class MemoryRetentionService:
    def __init__(self, repository, backend: HindsightClient, *, now=utcnow, bound_tenant_id: str | None = None):
        self.repository = repository
        self.backend = backend
        self._now = now
        # The deployment binding is explicit; a repository's bound value is
        # accepted only as the already-configured production source.  Neither
        # maintenance caller arguments nor a DB inventory may establish it.
        repository_bound = getattr(repository, "_bound_tenant_id", None)
        repository_bound = repository_bound if isinstance(repository_bound, str) and repository_bound else None
        if bound_tenant_id and repository_bound and bound_tenant_id != repository_bound:
            self._bound_tenant_id = None
        else:
            self._bound_tenant_id = bound_tenant_id or repository_bound
        self._verified_until = 0.0

    def require_ready(self, policy):
        if not is_retention_guarded(policy):
            return
        if time.monotonic() < self._verified_until:
            return
        try:
            if schema_fingerprint(self.backend.retention_request(None, "")) != SCHEMA_FINGERPRINT:
                raise ValueError("schema mismatch")
        except Exception as exc:
            raise MemoryRetentionUnverified("Native retention contract is unavailable or incompatible") from exc
        self._verified_until = time.monotonic() + 60

    def recall_body(self, policy, body):
        if not is_retention_guarded(policy):
            return body
        self.require_ready(policy)
        if any(t not in {"world", "experience"} for t in body.get("types", [])) or body.get("prefer_observations") \
                or any(value is not None for value in body.get("include", {}).values()):
            raise MemoryRetentionOptionUnsupported("Finite retention supports raw facts only, without derived inclusions")
        return {**body, "types": ["world", "experience"], "prefer_observations": False,
                "include": {"entities": None, "chunks": None, "source_facts": None}, "trace": False}

    def prepare(self, ctx, *, employee_id, bank_id, policy, body):
        self.require_ready(policy)
        items = []
        for item in body["items"]:
            row = self.repository.accept(ctx, employee_id=employee_id, bank_id=bank_id,
                                         document_id=item["document_id"], operation_id=body["operation_id"], policy=policy)
            expiry = deadline(row, policy)
            if row["cleanup_state"] == "cleaned" or (expiry and self._now() >= expiry):
                raise Forbidden("This memory acceptance has expired; retries cannot renew retention")
            metadata = {k: v for k, v in item.get("metadata", {}).items() if not k.lower().startswith("aiteam")}
            items.append({**item, "metadata": {**metadata, **acceptance_metadata(row)}})
        return {**body, "items": items}

    def validate_retain_response(self, body, response, bank_id):
        if not isinstance(response, dict) or response.get("success") is not True or response.get("bank_id") != bank_id \
                or response.get("operation_id") != body["operation_id"] or response.get("async") is not True:
            raise HindsightUnavailable("Native retain acceptance was not confirmed")
        return {"success": True, "bank_id": bank_id, "operation_id": body["operation_id"], "async": True}

    def filter_recall(self, ctx, *, employee_id, bank_id, policy, response):
        if not is_retention_guarded(policy):
            return response
        self.require_ready(policy)
        results = response.get("results") if isinstance(response, dict) else None
        if not isinstance(results, list) or len(results) > 256:
            raise HindsightUnavailable("Native memory results are not bounded")
        output = []
        for fact in results:
            if not isinstance(fact, dict) or fact.get("type") not in {"world", "experience"}:
                continue
            document = fact.get("document_id")
            if not isinstance(document, str):
                continue
            row = self.repository.get(ctx, bank_id=bank_id, document_id=document)
            if not proves_fact(row, fact, employee_id=employee_id, bank_id=bank_id):
                continue
            expiry = deadline(row, policy)
            if row["operation_state"] != "completed" or row["cleanup_state"] != "waiting" or (expiry is not None and self._now() >= expiry):
                continue
            text = fact.get("text")
            if not isinstance(fact.get("id"), str) or not 1 <= len(fact["id"]) <= 256 \
                    or not isinstance(text, str) or not text.strip() or len(text) > 131072:
                raise HindsightUnavailable("Invalid native fact")
            output.append(({"id": fact["id"], "text": text, "type": fact["type"]}, expiry))
        # A bounded set can still span a deadline while its ledger rows are read.
        now = self._now()
        return {"results": [fact for fact, expiry in output if expiry is None or now < expiry]}

    def check_edit(self, ctx, *, employee_id, bank_id, memory_id, policy):
        self.require_ready(policy)
        if not is_retention_guarded(policy):
            return
        try:
            memory_id = str(uuid.UUID(memory_id))
        except ValueError as exc:
            raise Forbidden("A native memory ID is required") from exc
        fact = self.backend.retention_request(bank_id, f"memories/{memory_id}")
        row = self.repository.get(ctx, bank_id=bank_id, document_id=fact.get("document_id", ""))
        if not proves_fact(row, fact, employee_id=employee_id, bank_id=bank_id) \
                or row["operation_state"] != "completed" or row["cleanup_state"] != "waiting" \
                or (deadline(row, policy) is not None and self._now() >= deadline(row, policy)):
            raise Forbidden("Cannot edit or reactivate an expired or unproven memory")

    def maintain_once(self, bound_tenant_id: str | None = None):
        """Run bounded cleanup for this deployment's tenant only.

        A missing binding is a deliberate no-op rather than permission to scan
        the admin database and construct contexts for arbitrary tenants.
        """
        configured = self._bound_tenant_id
        if not configured or (bound_tenant_id is not None and bound_tenant_id != configured):
            return
        owner = uuid.uuid4().hex
        budget = 16
        until = time.monotonic() + 20
        for tenant in self.repository.tenant_ids_due(configured):
            if tenant != configured:
                continue
            ctx = TenantContext(tenant_id=tenant, user_id="memory-retention")
            while budget and time.monotonic() < until:
                job = self.repository.claim(ctx, owner=owner)
                if not job:
                    break
                budget -= 1
                self._maintain_job(ctx, job, owner)

    def _maintain_job(self, ctx, job, owner):
        state, cleaned, error = job["operation_state"], job["cleanup_state"], None
        batch_sha256 = None
        until = time.monotonic() + 20
        next_attempt = self._now() + timedelta(seconds=5)
        try:
            # Both finite cleanup and op reconciliation rely on the verified native contract.
            self.require_ready({"retention_days": 1})
            if state not in _TERMINAL:
                operation = self.backend.retention_request(job["bank_id"], f"operations/{job['operation_id']}", params={"include_payload": "false"})
                if operation.get("operation_id") != job["operation_id"] or operation.get("status") not in _TERMINAL | {"pending", "processing"}:
                    raise HindsightUnavailable("Unconfirmed async operation state")
                state = operation["status"]
                # Persist terminal proof independently of subsequent cleanup failures.
                if state in _TERMINAL:
                    if not self.repository.settled(ctx, job, owner=owner, state=state):
                        return
            expired = job["expires_at"] and self._now() >= job["expires_at"]
            if state in {"failed", "cancelled"} or (state == "completed" and expired):
                cleaned = "invalidating"
                page = self.backend.retention_request(job["bank_id"], "memories/list", params={
                    "document_id": job["document_id"], "state": "valid", "limit": 100, "offset": 0,
                })
                items = page.get("items")
                if not isinstance(items, list) or len(items) > 100 or type(page.get("total")) is not int \
                        or page["total"] < len(items) or any(not isinstance(fact, dict) for fact in items):
                    raise HindsightUnavailable("Native cleanup page is unconfirmed")
                if not items:
                    if page["total"] != 0:
                        raise HindsightUnavailable("Native cleanup made no progress")
                    cleaned = "cleaned"
                if items:
                    candidate_hash = hashlib.sha256(json.dumps(sorted(fact.get("id", "") for fact in items)).encode()).hexdigest()
                    if candidate_hash == job.get("last_batch_sha256"):
                        raise HindsightUnavailable("Native cleanup made no progress")
                for fact in items:
                    if time.monotonic() >= until:
                        break
                    if not proves_fact(job, fact, employee_id=job["employee_id"], bank_id=job["bank_id"]):
                        raise HindsightUnavailable("Unproven cleanup source")
                    if not self.repository.owned(ctx, job, owner):
                        return
                    mid = str(uuid.UUID(fact["id"]))
                    result = self.backend.retention_request(job["bank_id"], f"memories/{mid}", method="PATCH",
                                                            payload={"state": "invalidated", "reason": "Manager retention expired"})
                    if result.get("id") != mid or result.get("state") != "invalidated":
                        raise HindsightUnavailable("Native invalidation was not confirmed")
                else:
                    if items:
                        batch_sha256 = candidate_hash
            elif state in _TERMINAL:
                next_attempt = job["expires_at"] or datetime(9999, 1, 1, tzinfo=timezone.utc)
        except Exception:
            # Upstream errors can contain text, payloads or credentials. Never log them.
            error = "memory_retention_reconciliation_failed"
            next_attempt = self._now() + timedelta(seconds=min(300, 2 ** min(job["attempts"], 8)))
            log.warning("memory retention reconciliation pending", extra={"tenant_id": ctx.tenant_id, "employee_id": job["employee_id"], "code": error})
        self.repository.finish(ctx, job, owner=owner, operation_state=state, cleanup_state=cleaned,
                               next_attempt=next_attempt, error=error, batch_sha256=batch_sha256)


def build_memory_retention_service(request):
    service = getattr(request.app.state, "_memory_retention_service", None)
    if service is None:
        from shared.db import PgTenantRouter
        from .memory_retention_repository import MemoryRetentionRepository
        settings = request.app.state.settings
        if not settings.db_url:
            raise MemoryRetentionUnverified("Manager memory metadata database is unavailable")
        router = PgTenantRouter(settings.db_url)
        service = MemoryRetentionService(
            MemoryRetentionRepository(router, settings.admin_db_url, bound_tenant_id=settings.manager_tenant_id),
            HindsightClient(router=router), bound_tenant_id=settings.manager_tenant_id,
        )
        request.app.state._memory_retention_service = service
    return service


def install_memory_retention_lifespan(app):
    original = app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(instance):
        async with original(instance):
            stop = asyncio.Event()
            async def poll():
                while not stop.is_set():
                    try:
                        from types import SimpleNamespace
                        service = build_memory_retention_service(SimpleNamespace(app=instance))
                        await asyncio.to_thread(service.maintain_once, instance.state.settings.manager_tenant_id)
                    except Exception:
                        log.warning("memory retention maintenance unavailable")
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
