"""Content-free historical inventory; never authorizes or performs a cleanup.

Deployment operators must obtain a separate approval before any historical
adoption/invalidation. Unknown legacy timestamps are not acceptance evidence.
"""
import hashlib

from .active_principal import require_admin
from .hindsight_client import HindsightUnavailable
from .memory_retention_service import proves_fact


def historical_preflight(ctx, *, employee_id, bank_id, backend, repository):
    require_admin(ctx)
    items = []
    truncated = True
    for page in range(32):
        response = backend.retention_request(bank_id, "memories/list", params={"limit": 200, "offset": page * 200})
        facts = response.get("items")
        if not isinstance(facts, list) or len(facts) > 200:
            raise HindsightUnavailable("Historical preflight page is unavailable")
        for fact in facts:
            document = fact.get("document_id")
            row = repository.get(ctx, bank_id=bank_id, document_id=document) if isinstance(document, str) else None
            trusted = proves_fact(row, fact, employee_id=employee_id, bank_id=bank_id)
            items.append({"memory_id": fact.get("id"),
                          "document_sha256": hashlib.sha256(document.encode()).hexdigest() if isinstance(document, str) else None,
                          "source": "manager_acceptance" if trusted else "unknown",
                          "accepted_at": row["accepted_at"].isoformat() if trusted else None,
                          "expires_at": row["expires_at"].isoformat() if trusted and row["expires_at"] else None})
        if len(facts) < 200:
            truncated = False
            break
    return {"employee_id": employee_id, "bank_id": bank_id, "count": len(items),
            "unknown_count": sum(item["source"] == "unknown" for item in items), "truncated": truncated,
            "items": items, "cleanup_authorized": False}
