"""Authorized facade over the Manager enterprise's employee-private memory.

Manager does not store memory data. It resolves the current employee snapshot
before every upstream operation so grants and memory policy are enforced against
the current enterprise state, not caller-supplied scope.

The bank is shared by every member of the employee. Members read and delete only
memories stamped with their own ``contributor_member_id`` at retain time; memories
retained before stamping carry no contributor and stay visible to managers only.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Protocol

from shared.contracts.enums import EnterpriseRole
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from .active_principal import require_admin
from .hindsight_operation_policy import CONTRIBUTOR_METADATA_KEY
from .memory_policy_service import normalize_policy, require_retention_ready, is_retention_guarded
from shared.errors import AppError, Forbidden

_MAX_ANALYTICS_PAGES = 32
_ANALYTICS_PAGE_SIZE = 200
_MEMORY_MANAGER_ROLES = frozenset({EnterpriseRole.OWNER.value, EnterpriseRole.ENTERPRISE_ADMIN.value})
# A member reading or deleting memories they contributed. It is not a Hindsight
# policy operation: any enabled memory policy (recall or retain) authorizes it.
_OWN_MEMORY_OPERATION = "own"
_RECENT_MEMORY_WINDOW = timedelta(days=7)

MemoryScope = Literal["mine", "all"]


def _is_memory_manager(ctx: TenantContext) -> bool:
    return bool(set(ctx.roles) & _MEMORY_MANAGER_ROLES)


def effective_memory_scope(ctx: TenantContext, requested: MemoryScope | None) -> MemoryScope:
    """Members only ever see what they contributed; managers default to the whole bank."""
    if not _is_memory_manager(ctx):
        return "mine"
    return requested or "all"


class MemoryNotContributed(Forbidden):
    code, title = "memory_not_contributor", "Memory Not Contributed By Caller"


class MemoryBackend(Protocol):
    def recall(self, ctx: TenantContext, *, employee_id: str, query: str, limit: int) -> dict: ...

    def retain(self, ctx: TenantContext, *, employee_id: str, content: str, metadata: dict) -> dict: ...

    def list(
        self, ctx: TenantContext, *, employee_id: str, query: str | None, limit: int, offset: int
    ) -> dict: ...

    def stats(self, ctx: TenantContext, *, employee_id: str) -> dict: ...

    def update(
        self, ctx: TenantContext, *, employee_id: str, memory_id: str, payload: dict
    ) -> dict: ...

    def delete(self, ctx: TenantContext, *, employee_id: str, memory_id: str, idempotency_key: str) -> dict: ...


class MemoryService:
    """Authorize memory access with a fresh snapshot, then delegate to Hindsight."""

    def __init__(self, *, snapshot, backend: MemoryBackend, employee_reader=None, retention_service=None, member_reader=None):
        self._snapshot = snapshot
        self._backend = backend
        self._employee_reader = employee_reader
        self._retention = retention_service
        self._member_reader = member_reader

    def recall(self, ctx: TenantContext, *, employee_id: str, query: str, limit: int) -> dict:
        snapshot = self._authorize(ctx, employee_id=employee_id, operation="recall")
        policy = snapshot.memory_policy
        if self._retention is not None and is_retention_guarded(policy):
            body = self._retention.recall_body(policy, {"query": query, "max_tokens": min(8192, max(256, limit * 256))})
            bank = self._bank(ctx, employee_id)
            raw = self._retention.backend.retention_request(bank, "memories/recall", method="POST", payload=body)
            self._retention.filter_recall(ctx, employee_id=employee_id, bank_id=bank, policy=policy, response=raw)
            self._unchanged_policy(ctx, snapshot, operation="recall")
            return self._retention.filter_recall(ctx, employee_id=employee_id, bank_id=bank, policy=policy, response=raw)
        raw = self._backend.recall(ctx, employee_id=employee_id, query=query, limit=limit)
        self._unchanged_policy(ctx, snapshot, operation="recall")
        return sanitize_metadata(raw)

    def retain(
        self, ctx: TenantContext, *, employee_id: str, content: str, metadata: dict
    ) -> dict:
        snapshot = self._authorize(ctx, employee_id=employee_id, operation="retain")
        if self._retention is not None:
            from .hindsight_operation_policy import scoped_retain_body
            bank = self._bank(ctx, employee_id)
            body = scoped_retain_body({"items": [{"content": content, "metadata": sanitize_metadata(metadata)}]},
                                      tenant_id=ctx.tenant_id, member_id=ctx.user_id, employee_id=employee_id)
            self._retention.backend.ensure_bank(ctx, employee_id=employee_id)
            body = self._retention.prepare(ctx, employee_id=employee_id, bank_id=bank, policy=snapshot.memory_policy, body=body)
            self._unchanged_policy(ctx, snapshot, operation="retain")
            raw = self._retention.backend.retention_request(bank, "memories", method="POST", payload=body)
            self._unchanged_policy(ctx, snapshot, operation="retain")
            self._retention.validate_retain_response(body, raw, bank)
            return {"success": True, "async": True, "operation_id": body["operation_id"]}
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
        scope: MemoryScope | None = None,
    ) -> dict:
        scope = effective_memory_scope(ctx, scope)
        operation, management = _scope_authorization(ctx)
        snapshot = self._authorize(ctx, employee_id=employee_id, operation=operation, management=management)
        if self._retention is not None and is_retention_guarded(snapshot.memory_policy):
            policy = snapshot.memory_policy
            bank, items, visible = self._guarded_scan(
                ctx, employee_id=employee_id, query=query, snapshot=snapshot,
                operation=operation, management=management,
            )
            by_id = {item["id"]: item for item in items}
            if scope == "mine":
                visible = [fact for fact in visible if _contributor(by_id.get(fact.get("id"), {}).get("metadata")) == ctx.user_id]
            # Scanning can take time: recheck selected facts at the final clock.
            selected_ids = {item["id"] for item in visible[offset:offset+limit]}
            selected = [item for item in items if item["id"] in selected_ids][:limit]
            final = self._retention.filter_recall(
                ctx, employee_id=employee_id, bank_id=bank, policy=policy,
                response={"results": selected},
            )["results"]
            # Finite recall deliberately returns only id/text/type.  The
            # Manager list still exposes its stable source/date labels by
            # joining those approved IDs back to the already validated
            # ListMemoryUnitsResponse projection; only the server-stamped
            # contributor is copied from native metadata.
            selected_by_id = {item["id"]: item for item in selected}
            projected = [
                {**fact, **{
                    key: selected_by_id[fact["id"]].get(key)
                    for key in ("source", "date", "importance", "state")
                    if key in selected_by_id[fact["id"]]
                }, "metadata": _contributor_metadata(selected_by_id[fact["id"]].get("metadata"))}
                for fact in final
                if isinstance(fact, dict) and fact.get("id") in selected_by_id
            ]
            result = normalize_memory_list(
                {"items": projected, "total": len(visible) - (len(selected) - len(final))},
                employee_id=employee_id, limit=limit, offset=offset, member_id=ctx.user_id,
            )
            return self._with_contributor_names(ctx, {**result, "scope": scope, "truncated": False})
        if scope == "mine":
            items, truncated = self._scan_items(ctx, employee_id=employee_id, query=query)
            self._unchanged_policy(ctx, snapshot, operation=operation, management=management)
            own = [item for item in items if item["is_mine"] and item["state"] == "valid"]
            return self._with_contributor_names(ctx, {
                "items": own[offset:offset+limit], "total": len(own), "limit": limit, "offset": offset,
                "scope": scope, "truncated": truncated,
            })
        raw = sanitize_metadata(self._backend.list(
            ctx, employee_id=employee_id, query=query, limit=limit, offset=offset,
        ))
        self._unchanged_policy(ctx, snapshot, operation=operation, management=management)
        result = normalize_memory_list(raw, employee_id=employee_id, limit=limit, offset=offset, member_id=ctx.user_id)
        return self._with_contributor_names(ctx, {**result, "scope": scope, "truncated": False})

    def summary(self, ctx: TenantContext, *, employee_id: str, scope: MemoryScope | None = None) -> dict[str, Any]:
        """Counts by contributor without memory text, so members learn only how much others hold."""
        scope = effective_memory_scope(ctx, scope)
        operation, management = _scope_authorization(ctx)
        snapshot = self._authorize(ctx, employee_id=employee_id, operation=operation, management=management)
        items, truncated = self._visible_items(
            ctx, employee_id=employee_id, snapshot=snapshot, operation=operation, management=management,
        )
        self._unchanged_policy(ctx, snapshot, operation=operation, management=management)
        items = [item for item in items if item["state"] == "valid"]
        own_count = sum(1 for item in items if item["is_mine"])
        unattributed_count = sum(1 for item in items if item["contributor_member_id"] is None)
        in_scope = [item for item in items if item["is_mine"]] if scope == "mine" else items
        recent_since = datetime.now(timezone.utc) - _RECENT_MEMORY_WINDOW
        created = [_memory_datetime(item["created_at"]) for item in in_scope]
        used = [(parsed, item["last_used_at"]) for item in in_scope
                if (parsed := _memory_datetime(item["last_used_at"])) is not None]
        return {
            "employee_id": employee_id,
            "scope": scope,
            "total_count": len(in_scope),
            "own_count": own_count,
            "others_count": len(items) - own_count - unattributed_count,
            "unattributed_count": unattributed_count,
            "recent_count": sum(1 for value in created if value is not None and value >= recent_since),
            "latest_used_at": max(used, key=lambda entry: entry[0])[1] if used else None,
            "truncated": truncated,
        }

    def _visible_items(
        self, ctx: TenantContext, *, employee_id: str, snapshot, operation: str, management: bool,
    ) -> tuple[list[dict], bool]:
        """Every normalized item the bank currently exposes, bounded like analytics."""
        if self._retention is not None and is_retention_guarded(snapshot.memory_policy):
            _bank, items, visible = self._guarded_scan(
                ctx, employee_id=employee_id, query=None, snapshot=snapshot,
                operation=operation, management=management,
            )
            by_id = {item["id"]: item for item in items}
            approved = {fact.get("id") for fact in visible if isinstance(fact, dict)}
            result = normalize_memory_list(
                {"items": [item for item_id, item in by_id.items() if item_id in approved]},
                employee_id=employee_id, limit=len(approved), offset=0, member_id=ctx.user_id,
            )
            return result["items"], False
        return self._scan_items(ctx, employee_id=employee_id, query=None)

    def _scan_items(self, ctx: TenantContext, *, employee_id: str, query: str | None) -> tuple[list[dict], bool]:
        items: list[dict] = []
        for page_index in range(_MAX_ANALYTICS_PAGES):
            offset = page_index * _ANALYTICS_PAGE_SIZE
            raw = sanitize_metadata(self._backend.list(
                ctx, employee_id=employee_id, query=query, limit=_ANALYTICS_PAGE_SIZE, offset=offset,
            ))
            page = normalize_memory_list(
                raw, employee_id=employee_id, limit=_ANALYTICS_PAGE_SIZE, offset=offset, member_id=ctx.user_id,
            )
            items.extend(page["items"])
            # Page on the upstream row count: normalization may drop malformed rows.
            raw_items = raw.get("items") if isinstance(raw, dict) else None
            raw_count = len(raw_items) if isinstance(raw_items, list) else 0
            total = raw.get("total") if isinstance(raw, dict) else None
            if raw_count < _ANALYTICS_PAGE_SIZE or (isinstance(total, int) and total <= offset + raw_count):
                return items, False
        return items, True

    def _guarded_scan(
        self, ctx: TenantContext, *, employee_id: str, query: str | None, snapshot, operation: str, management: bool,
    ) -> tuple[str, list[dict], list[dict]]:
        """Bounded native listing; returns the bank, projected candidates and retention-visible facts."""
        items = []
        bank = self._bank(ctx, employee_id)
        for page_index in range(_MAX_ANALYTICS_PAGES):
            raw = self._retention.backend.retention_request(bank, "memories/list", params={"state": "valid", "limit": 200, "offset": page_index*200, **({"q": query} if query else {})})
            page = raw.get("items")
            if not isinstance(page, list) or len(page)>200:
                from .hindsight_client import HindsightUnavailable
                raise HindsightUnavailable("Invalid native memory list")
            # The pinned ListMemoryUnitsResponse calls this discriminator
            # ``type``.  Older Manager fixtures used ``fact_type``; accept
            # that spelling only as a compatibility fallback and keep the
            # bounded text/source projection safe before retention filtering.
            for fact in page:
                if not isinstance(fact, dict):
                    continue
                fact_type = _native_memory_type(fact)
                text = _safe_memory_text(fact.get("text"))
                if fact_type is None or text is None:
                    continue
                metadata = fact.get("metadata") if isinstance(fact.get("metadata"), dict) else {}
                items.append({
                    "id": fact.get("id"),
                    "text": text,
                    "metadata": metadata,
                    "document_id": fact.get("document_id"),
                    "type": fact_type,
                    "source": _memory_source(fact, metadata),
                    "date": fact.get("date") or fact.get("created_at") or fact.get("mentioned_at"),
                    "importance": fact.get("importance"),
                    "state": fact.get("state"),
                })
            if len(page)<200:
                self._unchanged_policy(ctx, snapshot, operation=operation, management=management)
                policy = snapshot.memory_policy
                visible = []
                for start in range(0, len(items), 200):
                    visible.extend(self._retention.filter_recall(ctx, employee_id=employee_id, bank_id=bank, policy=policy, response={"results": items[start:start+200]})["results"])
                self._unchanged_policy(ctx, snapshot, operation=operation, management=management)
                return bank, items, visible
        from .hindsight_client import HindsightUnavailable
        raise HindsightUnavailable("Finite memory listing exceeds the bounded scan")

    def _with_contributor_names(self, ctx: TenantContext, result: dict) -> dict:
        """Attach member display names when the member directory is wired; ids stay authoritative."""
        if self._member_reader is None:
            return result
        names: dict[str, str | None] = {}
        for item in result["items"]:
            member_id = item.get("contributor_member_id")
            if member_id is None or member_id in names:
                continue
            try:
                member = self._member_reader.get_member(ctx, member_id=member_id)
            except Exception:  # noqa: BLE001 - names are cosmetic; the list stays available without them
                member = None
            name = getattr(member, "display_name", None)
            names[member_id] = name[:256] if isinstance(name, str) and name.strip() else None
        for item in result["items"]:
            item["contributor_display_name"] = names.get(item.get("contributor_member_id"))
        return result

    def update(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        memory_id: str,
        payload: dict,
    ) -> dict:
        snapshot = self._authorize(ctx, employee_id=employee_id, operation="update", management=True)
        if self._retention is not None and is_retention_guarded(snapshot.memory_policy):
            self._retention.check_edit(ctx, employee_id=employee_id, bank_id=self._bank(ctx, employee_id), memory_id=memory_id, policy=snapshot.memory_policy)
            self._unchanged_policy(ctx, snapshot, operation="update", management=True)
            raw = self._backend.update(ctx, employee_id=employee_id, memory_id=memory_id, payload=sanitize_metadata(payload))
            self._unchanged_policy(ctx, snapshot, operation="update", management=True)
            if raw.get("state") not in {"valid", "invalidated"}:
                from .hindsight_client import HindsightUnavailable
                raise HindsightUnavailable("Native update was not confirmed")
            return {"id": memory_id, "state": raw["state"]}
        raw = self._backend.update(ctx, employee_id=employee_id, memory_id=memory_id, payload=sanitize_metadata(payload))
        self._unchanged_policy(ctx, snapshot, operation="update", management=True)
        return sanitize_metadata(raw)

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
                snapshot = self._authorize(ctx, employee_id=employee_id, operation="list", management=True)
                items, truncated = self._analytics_items(ctx, employee_id=employee_id)
                stats = {} if is_retention_guarded(snapshot.memory_policy) else self._analytics_stats(ctx, employee_id=employee_id)
                self._unchanged_policy(ctx, snapshot, operation="list", management=True)
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
                stats=stats,
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

    def _analytics_stats(self, ctx: TenantContext, *, employee_id: str) -> dict[str, Any]:
        stats = getattr(self._backend, "stats", None)
        if not callable(stats):
            return {}
        try:
            raw = sanitize_metadata(stats(ctx, employee_id=employee_id))
        except Exception:  # noqa: BLE001 - inventory remains useful if optional stats are unavailable
            return {}
        if not isinstance(raw, dict):
            return {}
        if isinstance(raw.get("data"), dict):
            raw = raw["data"]
        fields = (
            "total_nodes", "total_links", "total_documents", "total_observations",
            "pending_operations", "failed_operations", "pending_consolidation", "failed_consolidation",
            "last_memory_write_at", "last_consolidated_at",
        )
        output: dict[str, Any] = {}
        for field in fields:
            value = raw.get(field)
            if field.endswith("_at"):
                if isinstance(value, str) and len(value) <= 128 and not any(char in value for char in "\x00\r\n"):
                    output[field] = value
            elif isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                output[field] = value
        return output

    def _analytics_items(self, ctx: TenantContext, *, employee_id: str) -> tuple[list[dict], bool]:
        items: list[dict] = []
        offset = 0
        truncated = False
        for _ in range(_MAX_ANALYTICS_PAGES):
            page = self.list(ctx, employee_id=employee_id, query=None, limit=_ANALYTICS_PAGE_SIZE, offset=offset)
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
        if _is_memory_manager(ctx):
            snapshot = self._authorize(ctx, employee_id=employee_id, operation="delete", management=True)
        else:
            # Members may delete only what they contributed. Ownership comes from the
            # server-stamped contributor in the bank, never from the request.
            snapshot = self._authorize(ctx, employee_id=employee_id, operation=_OWN_MEMORY_OPERATION)
            items, _truncated = self._visible_items(
                ctx, employee_id=employee_id, snapshot=snapshot, operation=_OWN_MEMORY_OPERATION, management=False,
            )
            if not any(item["memory_id"] == memory_id and item["is_mine"] for item in items):
                raise MemoryNotContributed("members can only delete memories they contributed")
            self._unchanged_policy(ctx, snapshot, operation=_OWN_MEMORY_OPERATION)
        if is_retention_guarded(snapshot.memory_policy):
            raw = self._backend.delete(ctx, employee_id=employee_id, memory_id=memory_id, idempotency_key=idempotency_key)
            if raw.get("state") != "invalidated":
                from .hindsight_client import HindsightUnavailable
                raise HindsightUnavailable("Native invalidation was not confirmed")
            return {"id": memory_id, "state": "invalidated"}
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
        if management:
            require_admin(ctx)
        ensure_runnable = getattr(self._snapshot, "_ensure_runnable", None)
        if callable(ensure_runnable):
            ensure_runnable(ctx, employee_id=employee_id)
        snapshot = self._snapshot.generate(
            ctx, member_id=ctx.user_id, employee_id=employee_id
        )
        if snapshot.employee_id != employee_id:
            raise Forbidden("employee snapshot does not match requested employee")
        policy = snapshot.memory_policy
        if isinstance(policy, dict):
            (self._retention.require_ready(policy) if self._retention is not None else require_retention_ready(policy))
        is_manager = _is_memory_manager(ctx)
        if management and is_manager:
            return snapshot
        if operation == _OWN_MEMORY_OPERATION:
            if not isinstance(policy, dict) or not normalize_policy(policy)["allowed_operations"]:
                raise Forbidden("memory policy does not authorize this operation")
            return snapshot
        if not isinstance(policy, dict) or operation not in normalize_policy(policy)["allowed_operations"]:
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


    def _unchanged_policy(self, ctx, snapshot, *, operation, management=False):
        current = self._authorize(ctx, employee_id=snapshot.employee_id, operation=operation, management=management)
        if current.memory_policy != snapshot.memory_policy:
            raise Forbidden("Memory policy changed during the operation")

    @staticmethod
    def _bank(ctx, employee_id):
        from .hindsight_credentials import derive_hindsight_bank_id
        return derive_hindsight_bank_id(ctx.tenant_id, ctx.user_id, employee_id, ctx.enterprise_id)


def build_memory_service(
    *, snapshot, backend: MemoryBackend, employee_reader=None, retention_service=None, member_reader=None,
) -> MemoryService:
    return MemoryService(
        snapshot=snapshot, backend=backend, employee_reader=employee_reader,
        retention_service=retention_service, member_reader=member_reader,
    )


def _scope_authorization(ctx: TenantContext) -> tuple[str, bool]:
    """Managers read through memory management; members through their own contributions."""
    return ("list", True) if _is_memory_manager(ctx) else (_OWN_MEMORY_OPERATION, False)


def _contributor(metadata: Any) -> str | None:
    """The server-stamped contributor; memories retained before stamping have none."""
    if not isinstance(metadata, dict):
        return None
    value = metadata.get(CONTRIBUTOR_METADATA_KEY)
    if not isinstance(value, str) or not value.strip() or len(value) > 256 or any(char in value for char in "\x00\r\n"):
        return None
    return value


def _contributor_metadata(metadata: Any) -> dict[str, str]:
    contributor = _contributor(metadata)
    return {CONTRIBUTOR_METADATA_KEY: contributor} if contributor is not None else {}


def normalize_memory_list(raw: Any, *, employee_id: str, limit: int, offset: int, member_id: str | None = None) -> dict:
    """Expose only stable, non-sensitive fields from Hindsight memory units.

    ``member_id`` is the caller; it only marks which items the caller contributed.
    """
    items = raw.get("items", []) if isinstance(raw, dict) else []
    if not isinstance(items, list):
        items = []
    normalized = []
    for item in items:
        if not isinstance(item, dict):
            continue
        memory_id = item.get("id") or item.get("memory_id")
        content = item["text"] if "text" in item else item.get("content")
        if (
            not isinstance(memory_id, str)
            or not memory_id.strip()
            or len(memory_id) > 256
            or not isinstance(content, str)
            or not content.strip()
            or len(content) > 131072
        ):
            continue
        memory_id = memory_id.strip()
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        contributor = _contributor(metadata)
        category = _safe_source(_native_memory_type(item) or item.get("category")) or "memory"
        source = _memory_source(item, metadata) or "hindsight"
        state_value = item.get("state")
        state = state_value if state_value in {"valid", "invalidated"} else "valid"
        importance = item.get("importance")
        if not isinstance(importance, (int, float)) or isinstance(importance, bool) or not math.isfinite(float(importance)):
            importance = None
        normalized.append({
            "memory_id": memory_id,
            "employee_id": employee_id,
            "content": content,
            "category": category,
            "importance": importance,
            "source": source,
            "created_at": _safe_timestamp(item.get("date") or item.get("created_at") or item.get("mentioned_at")),
            "last_used_at": _safe_timestamp(item.get("last_used_at")),
            "state": state,
            "contributor_member_id": contributor,
            "contributor_display_name": None,
            "is_mine": contributor is not None and contributor == member_id,
        })
    total = raw.get("total") if isinstance(raw, dict) and isinstance(raw.get("total"), int) else len(normalized)
    return {"items": normalized, "total": total, "limit": limit, "offset": offset}


def _memory_summary(
    *, employee_id: str, display_name: str, items: list[dict], truncated: bool,
    stats: dict[str, Any] | None = None,
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
        "total_nodes": (stats or {}).get("total_nodes"),
        "total_links": (stats or {}).get("total_links"),
        "total_documents": (stats or {}).get("total_documents"),
        "total_observations": (stats or {}).get("total_observations"),
        "pending_operations": (stats or {}).get("pending_operations"),
        "failed_operations": (stats or {}).get("failed_operations"),
        "pending_consolidation": (stats or {}).get("pending_consolidation"),
        "failed_consolidation": (stats or {}).get("failed_consolidation"),
        "last_memory_write_at": (stats or {}).get("last_memory_write_at"),
        "last_consolidated_at": (stats or {}).get("last_consolidated_at"),
    }


def _native_memory_type(item: Any) -> str | None:
    """Read the pinned native ``type`` field with legacy ``fact_type`` fallback."""
    if not isinstance(item, dict):
        return None
    for key in ("type", "fact_type", "category"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:128]
    return None


def _safe_memory_text(value: Any) -> str | None:
    """Accept only bounded, non-empty native memory text."""
    if not isinstance(value, str) or not value.strip() or len(value) > 131072:
        return None
    return value


def _safe_source(value: Any) -> str | None:
    """Keep native source labels bounded and free of control-line injection."""
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        return None
    value = value.strip()
    if any(char in value for char in "\x00\r\n"):
        return None
    return value


def _memory_source(item: Any, metadata: dict[str, Any]) -> str | None:
    """Prefer native source, then safe metadata aliases, without leaking invalid labels."""
    for value in (item.get("source"), metadata.get("source"), metadata.get("retainSource")):
        source = _safe_source(value)
        if source is not None:
            return source
    return None


def _safe_bucket(value: Any, fallback: str) -> str:
    if not isinstance(value, str) or not value.strip():
        return fallback
    value = value.strip()
    if any(char in value for char in "\x00\r\n"):
        return fallback
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
