"""Authorized facade over the external Hindsight memory service.

Manager does not store memory data.  It resolves the current employee snapshot
before every upstream operation so grants and memory policy are enforced against
current tenant state, not caller-supplied scope.
"""

from __future__ import annotations

from typing import Any, Protocol

from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden


class MemoryBackend(Protocol):
    def recall(self, ctx: TenantContext, *, employee_id: str, query: str, limit: int) -> dict: ...

    def retain(self, ctx: TenantContext, *, employee_id: str, content: str, metadata: dict) -> dict: ...

    def list(
        self, ctx: TenantContext, *, employee_id: str, query: str | None, limit: int, offset: int
    ) -> dict: ...

    def update(
        self, ctx: TenantContext, *, employee_id: str, memory_id: str, payload: dict
    ) -> dict: ...

    def delete(self, ctx: TenantContext, *, employee_id: str, memory_id: str, idempotency_key: str) -> dict: ...


class MemoryService:
    """Authorize memory access with a fresh snapshot, then delegate to Hindsight."""

    def __init__(self, *, snapshot, backend: MemoryBackend):
        self._snapshot = snapshot
        self._backend = backend

    def recall(self, ctx: TenantContext, *, employee_id: str, query: str, limit: int) -> dict:
        self._authorize(ctx, employee_id=employee_id, operation="recall")
        return sanitize_metadata(
            self._backend.recall(ctx, employee_id=employee_id, query=query, limit=limit)
        )

    def retain(
        self, ctx: TenantContext, *, employee_id: str, content: str, metadata: dict
    ) -> dict:
        self._authorize(ctx, employee_id=employee_id, operation="retain")
        return sanitize_metadata(self._backend.retain(
            ctx,
            employee_id=employee_id,
            content=content,
            metadata=sanitize_metadata(metadata),
        ))

    def list(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        query: str | None,
        limit: int,
        offset: int,
    ) -> dict:
        self._authorize(ctx, employee_id=employee_id, operation="list")
        raw = sanitize_metadata(self._backend.list(
            ctx, employee_id=employee_id, query=query, limit=limit, offset=offset,
        ))
        return normalize_memory_list(raw, employee_id=employee_id, limit=limit, offset=offset)

    def update(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        memory_id: str,
        payload: dict,
    ) -> dict:
        self._authorize(ctx, employee_id=employee_id, operation="update")
        return sanitize_metadata(self._backend.update(
            ctx, employee_id=employee_id, memory_id=memory_id, payload=sanitize_metadata(payload),
        ))

    def delete(
        self, ctx: TenantContext, *, employee_id: str, memory_id: str, idempotency_key: str
    ) -> dict:
        self._authorize(ctx, employee_id=employee_id, operation="delete")
        # employee_id is deliberately part of the upstream delete contract.  A memory id
        # alone is not an authorization boundary and could select another employee's data.
        return sanitize_metadata(self._backend.delete(
            ctx,
            employee_id=employee_id,
            memory_id=memory_id,
            idempotency_key=idempotency_key,
        ))

    def _authorize(self, ctx: TenantContext, *, employee_id: str, operation: str) -> EmployeeExecutionSnapshot:
        snapshot = self._snapshot.generate(
            ctx, member_id=ctx.user_id, employee_id=employee_id
        )
        if snapshot.employee_id != employee_id:
            raise Forbidden("employee snapshot does not match requested employee")
        policy = snapshot.memory_policy
        if not isinstance(policy, dict) or not policy or policy.get("enabled") is False:
            raise Forbidden("memory policy does not authorize this operation")

        # Accept the neutral policy spellings already used by Manager config while
        # defaulting to deny only when an explicit restriction is present.
        for key in (operation, f"allow_{operation}", f"{operation}_enabled"):
            if key in policy and policy[key] is False:
                raise Forbidden("memory policy does not authorize this operation")
        allowed = policy.get("allowed_operations", policy.get("operations"))
        if allowed is not None and operation not in allowed:
            raise Forbidden("memory policy does not authorize this operation")
        return snapshot


def build_memory_service(*, snapshot, backend: MemoryBackend) -> MemoryService:
    return MemoryService(snapshot=snapshot, backend=backend)


def normalize_memory_list(raw: Any, *, employee_id: str, limit: int, offset: int) -> dict:
    """Expose only stable, non-sensitive fields from Hindsight memory units."""
    items = raw.get("items", []) if isinstance(raw, dict) else []
    if not isinstance(items, list):
        items = []
    normalized = []
    for item in items:
        if not isinstance(item, dict):
            continue
        memory_id = item.get("id") or item.get("memory_id")
        content = item.get("text") or item.get("content")
        if not isinstance(memory_id, str) or not isinstance(content, str):
            continue
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        normalized.append({
            "memory_id": memory_id,
            "employee_id": employee_id,
            "content": content,
            "category": item.get("fact_type") or item.get("category") or "memory",
            "importance": item.get("importance") if isinstance(item.get("importance"), (int, float)) else None,
            "source": item.get("source") or metadata.get("retainSource") or "hindsight",
            "created_at": item.get("date") or item.get("created_at") or item.get("mentioned_at"),
            "last_used_at": item.get("last_used_at"),
            "state": item.get("state") or "valid",
        })
    total = raw.get("total") if isinstance(raw, dict) and isinstance(raw.get("total"), int) else len(normalized)
    return {"items": normalized, "total": total, "limit": limit, "offset": offset}


def sanitize_metadata(value: Any, key: str | None = None) -> Any:
    """Recursively replace token-bearing metadata values before crossing the boundary."""
    if key is not None and _is_sensitive_key(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {
            str(k): "[REDACTED]" if _is_sensitive_key(str(k)) else sanitize_metadata(v, str(k))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [sanitize_metadata(item, key) for item in value]
    return value


_SENSITIVE_METADATA_KEYS = (
    "token", "secret", "password", "passwd", "authorization", "api_key", "apikey",
    "credential", "private_key", "privatekey", "access_key", "cookie",
)


def _is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return any(part in lowered for part in _SENSITIVE_METADATA_KEYS)
