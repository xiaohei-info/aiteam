"""Authorized facade over the Manager enterprise's employee-private memory.

Manager does not store memory data. It resolves the current employee snapshot
before every upstream operation so grants and memory policy are enforced against
the current enterprise state, not caller-supplied scope.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Protocol

from shared.contracts.enums import EnterpriseRole
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Forbidden

_MAX_ANALYTICS_PAGES = 32
_ANALYTICS_PAGE_SIZE = 200


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

    def __init__(self, *, snapshot, backend: MemoryBackend, employee_reader=None):
        self._snapshot = snapshot
        self._backend = backend
        self._employee_reader = employee_reader

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
        self._authorize(ctx, employee_id=employee_id, operation="list", management=True)
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
        self._authorize(ctx, employee_id=employee_id, operation="update", management=True)
        return sanitize_metadata(self._backend.update(
            ctx, employee_id=employee_id, memory_id=memory_id, payload=sanitize_metadata(payload),
        ))

    def analytics(self, ctx: TenantContext) -> dict[str, Any]:
        """Return bounded per-employee Hindsight statistics without memory text."""
        if self._employee_reader is None:
            return {
                "status": "not_configured", "employee_count": 0,
                "total_memory_count": 0, "refreshed_at": datetime.now(timezone.utc),
                "employees": [], "unavailable_employee_count": 0,
            }
        summaries: list[dict[str, Any]] = []
        unavailable_count = 0
        for employee in self._employee_reader.list_all(ctx):
            employee_id = str(getattr(employee, "employee_id", ""))
            if not employee_id:
                continue
            try:
                self._authorize(ctx, employee_id=employee_id, operation="list", management=True)
                items, truncated = self._analytics_items(ctx, employee_id=employee_id)
            except Forbidden:
                # Member-level policy/grant denial must not reveal that an employee exists.
                continue
            except AppError as exc:
                if exc.status == 503:
                    unavailable_count += 1
                    continue
                if exc.status in (403, 404):
                    continue
                raise
            summaries.append(_memory_summary(
                employee_id=employee_id,
                display_name=str(getattr(employee, "display_name", "") or "未命名专家"),
                items=items,
                truncated=truncated,
            ))
        status = "available"
        if unavailable_count:
            status = "partial" if summaries else "unavailable"
        return {
            "status": status,
            "employee_count": len(summaries),
            "total_memory_count": sum(item["memory_count"] for item in summaries),
            "refreshed_at": datetime.now(timezone.utc),
            "employees": summaries,
            "unavailable_employee_count": unavailable_count,
        }

    def _analytics_items(self, ctx: TenantContext, *, employee_id: str) -> tuple[list[dict], bool]:
        items: list[dict] = []
        offset = 0
        truncated = False
        for _ in range(_MAX_ANALYTICS_PAGES):
            raw = sanitize_metadata(self._backend.list(
                ctx, employee_id=employee_id, query=None,
                limit=_ANALYTICS_PAGE_SIZE, offset=offset,
            ))
            page = normalize_memory_list(
                raw, employee_id=employee_id, limit=_ANALYTICS_PAGE_SIZE, offset=offset,
            )
            page_items = page["items"]
            items.extend(page_items)
            total = page.get("total")
            if len(page_items) < _ANALYTICS_PAGE_SIZE or (
                isinstance(total, int) and total <= offset + len(page_items)
            ):
                return items, truncated
            offset += len(page_items)
        truncated = True
        return items, truncated

    def delete(
        self, ctx: TenantContext, *, employee_id: str, memory_id: str, idempotency_key: str
    ) -> dict:
        self._authorize(ctx, employee_id=employee_id, operation="delete", management=True)
        # employee_id is deliberately part of the upstream delete contract.  A memory id
        # alone is not an authorization boundary and could select another employee's data.
        return sanitize_metadata(self._backend.delete(
            ctx,
            employee_id=employee_id,
            memory_id=memory_id,
            idempotency_key=idempotency_key,
        ))

    def _authorize(
        self, ctx: TenantContext, *, employee_id: str, operation: str, management: bool = False,
    ) -> EmployeeExecutionSnapshot:
        snapshot = self._snapshot.generate(
            ctx, member_id=ctx.user_id, employee_id=employee_id
        )
        if snapshot.employee_id != employee_id:
            raise Forbidden("employee snapshot does not match requested employee")
        policy = snapshot.memory_policy
        is_manager = bool(set(ctx.roles) & {
            EnterpriseRole.OWNER.value, EnterpriseRole.ENTERPRISE_ADMIN.value,
        })
        if management and is_manager:
            return snapshot
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


def build_memory_service(*, snapshot, backend: MemoryBackend, employee_reader=None) -> MemoryService:
    return MemoryService(snapshot=snapshot, backend=backend, employee_reader=employee_reader)


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
        if not isinstance(memory_id, str) or not memory_id.strip() or len(memory_id) > 256 or not isinstance(content, str):
            continue
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        importance = item.get("importance")
        if not isinstance(importance, (int, float)) or isinstance(importance, bool) or not math.isfinite(float(importance)):
            importance = None
        normalized.append({
            "memory_id": memory_id,
            "employee_id": employee_id,
            "content": content,
            "category": _safe_bucket(item.get("fact_type") or item.get("category"), "memory"),
            "importance": importance,
            "source": _safe_bucket(item.get("source") or metadata.get("retainSource"), "hindsight"),
            "created_at": _safe_timestamp(item.get("date") or item.get("created_at") or item.get("mentioned_at")),
            "last_used_at": _safe_timestamp(item.get("last_used_at")),
            "state": _safe_bucket(item.get("state"), "valid"),
        })
    total = raw.get("total") if isinstance(raw, dict) and isinstance(raw.get("total"), int) else len(normalized)
    return {"items": normalized, "total": total, "limit": limit, "offset": offset}


def _memory_summary(
    *, employee_id: str, display_name: str, items: list[dict], truncated: bool,
) -> dict[str, Any]:
    state_counts: dict[str, int] = {}
    category_counts: dict[str, int] = {}
    created: list[tuple[datetime, str]] = []
    used: list[tuple[datetime, str]] = []
    importance: list[float] = []
    for item in items:
        state = _safe_bucket(item.get("state"), "valid")
        category = _safe_bucket(item.get("category"), "memory")
        state_counts[state] = state_counts.get(state, 0) + 1
        category_counts[category] = category_counts.get(category, 0) + 1
        for field, target in (("created_at", created), ("last_used_at", used)):
            value = item.get(field)
            parsed = _memory_datetime(value)
            if parsed is not None and isinstance(value, str):
                target.append((parsed, value))
        value = item.get("importance")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
            importance.append(float(value))
    created.sort(key=lambda entry: entry[0])
    used.sort(key=lambda entry: entry[0])
    return {
        "employee_id": employee_id,
        "display_name": display_name[:256],
        "memory_count": len(items),
        "state_counts": state_counts,
        "category_counts": category_counts,
        "latest_created_at": created[-1][1] if created else None,
        "oldest_created_at": created[0][1] if created else None,
        "latest_used_at": used[-1][1] if used else None,
        "average_importance": sum(importance) / len(importance) if importance else None,
        "max_importance": max(importance) if importance else None,
        "truncated": truncated,
    }


def _safe_bucket(value: Any, fallback: str) -> str:
    if not isinstance(value, str) or not value.strip():
        return fallback
    value = value.strip()
    return value[:128]


def _safe_timestamp(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 128 or any(char in value for char in "\x00\r\n"):
        return None
    return value


def _memory_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


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
