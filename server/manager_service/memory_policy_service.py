"""One effective employee memory policy; legacy JSON is input/provenance, not authority."""
from __future__ import annotations

import json
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, NotFound, ValidationProblem

OPERATIONS = ("recall", "retain")
_POLICY_FIELDS = {"enabled", "allowed_operations", "operations", "recall", "retain",
                  "allow_recall", "allow_retain", "recall_enabled", "retain_enabled",
                  "explicit_auto_retain", "retention_days", "scope"}


class MemoryRetentionUnverified(AppError):
    status, code, title = 503, "memory_retention_unverified", "Memory retention unavailable"


def is_retention_guarded(policy: dict) -> bool:
    return policy.get("retention_days") is not None or policy.get("retention_guarded") is True


def require_retention_ready(policy: dict) -> None:
    # Do not silently reinterpret a finite policy as unlimited while the deployed
    # native invalidation/derived-data contract is awaiting isolated verification.
    if policy.get("retention_days") is not None or policy.get("retention_guarded"):
        raise MemoryRetentionUnverified("Finite memory retention requires verified native support")


def normalize_policy(raw: Any, *, retention_days: int | None = None) -> dict:
    """Missing operations permits recall only; an explicit empty set denies all."""
    value = raw if isinstance(raw, dict) else {}
    enabled = value.get("enabled", True) is True
    explicit_sets = [value[key] for key in ("allowed_operations", "operations") if key in value]
    allowed = set(OPERATIONS) if explicit_sets else {"recall"}
    for operations in explicit_sets:
        allowed &= set(operations) if isinstance(operations, list) and all(isinstance(x, str) for x in operations) else set()
    for operation in OPERATIONS:
        if any(value.get(key) is False for key in (operation, f"allow_{operation}", f"{operation}_enabled")):
            allowed.discard(operation)
    if not enabled:
        allowed.clear()
    retention = retention_days if retention_days is not None else value.get("retention_days")
    if retention is not None and (type(retention) is not int or retention < 1):
        # Unknown legacy retention must never grant an unlimited policy.
        retention = 1
    return {"enabled": enabled, "allowed_operations": [op for op in OPERATIONS if op in allowed],
            "explicit_auto_retain": value.get("explicit_auto_retain") is True and "retain" in allowed,
            "retention_days": retention, "scope": "employee"}


def validate_policy_patch(patch: dict) -> None:
    if not isinstance(patch, dict) or set(patch) - _POLICY_FIELDS:
        raise ValidationProblem("Unsupported memory policy fields")
    for key, value in patch.items():
        if key in {"allowed_operations", "operations"}:
            if not isinstance(value, list) or any(op not in OPERATIONS for op in value):
                raise ValidationProblem("Memory operations must be recall or retain")
        elif key == "retention_days":
            if value is not None and (type(value) is not int or not 1 <= value <= 36500):
                raise ValidationProblem("retention_days must be positive or null")
        elif key == "scope":
            if value != "employee":
                raise ValidationProblem("Memory banks are employee-private")
        elif type(value) is not bool:
            raise ValidationProblem("Memory policy flags must be boolean")


def merge_policy(current: dict, patch: dict) -> dict:
    # Legacy config GET/PUT round-trips may include the server projection. These
    # fields are never copied into the effective source or accepted as authority.
    patch = {key: value for key, value in patch.items() if key not in {"source", "revision", "retention_guarded"}}
    validate_policy_patch(patch)
    merged = {**current, **patch}
    if "operations" in patch:
        merged["allowed_operations"] = patch["operations"]
    # Historical alias restrictions have already been normalized. A deliberate
    # new operation set is not intersected with a stale second spelling.
    merged.pop("operations", None)
    return normalize_policy(merged)


class MemoryPolicyService:
    def __init__(self, repository):
        self._repo = repository

    def effective(self, ctx: TenantContext, *, employee_id: str) -> dict:
        row = self._repo.get(ctx, employee_id=employee_id)
        if row is None:
            # A missing migration/new-employee row must not fall back to legacy
            # config which might still contain implicit auto-retain defaults.
            raise NotFound("Effective employee memory policy is unavailable")
        return policy_projection(row.policy, revision=row.revision, source=row.source, guarded=row.retention_guarded)


def policy_projection(policy: dict, *, revision: int, source: str, guarded: bool = False) -> dict:
    return {**normalize_policy(policy), "revision": revision, "source": source, "retention_guarded": guarded}


def write_policy_in_session(session, ctx: TenantContext, *, employee_id: str,
                            fields: dict, source: str, project_employee: bool = True,
                            require_existing: bool = False):
    """Called by both repositories inside their existing TenantContext transaction."""
    # All writers take the employee lock first, including legacy config writers.
    if session.execute("SELECT id FROM employee WHERE id = %s FOR UPDATE", (employee_id,)).fetchone() is None:
        raise NotFound("employee not found in this tenant")
    previous = session.execute(
        "SELECT policy, seed_memories, retention_days, scope, revision, source, provenance "
        "FROM employee_memory_setting WHERE employee_id = %s FOR UPDATE", (employee_id,),
    ).fetchone()
    if previous is None and require_existing:
        raise NotFound("memory setting not found for this employee")
    current = previous[0] if previous else normalize_policy(None)
    patch = fields.get("policy", {})
    if "retention_days" in fields:
        patch = {**patch, "retention_days": fields["retention_days"]}
    if "scope" in fields:
        patch = {**patch, "scope": fields["scope"]}
    policy = merge_policy(current, patch)
    seeds = fields.get("seed_memories", previous[1] if previous else [])
    changed = previous is None or policy != current or seeds != previous[1]
    revision = (int(previous[4]) + 1 if changed else int(previous[4])) if previous else 1
    effective_source = source if changed else previous[5]
    provenance = previous[6] if previous else {"initial_source": source}
    session.execute(
        "INSERT INTO employee_memory_setting "
        "(tenant_id, employee_id, policy, seed_memories, retention_days, scope, revision, source, explicit_auto_retain, provenance) "
        "VALUES (%s,%s,%s,%s,%s,'employee',%s,%s,%s,%s) "
        "ON CONFLICT (tenant_id,employee_id) DO UPDATE SET policy=EXCLUDED.policy, "
        "seed_memories=EXCLUDED.seed_memories, retention_days=EXCLUDED.retention_days, scope=EXCLUDED.scope, "
        "revision=EXCLUDED.revision, source=EXCLUDED.source, explicit_auto_retain=EXCLUDED.explicit_auto_retain, "
        "updated_at=CASE WHEN employee_memory_setting.revision<>EXCLUDED.revision THEN now() ELSE employee_memory_setting.updated_at END",
        (ctx.tenant_id, employee_id, json.dumps(policy), json.dumps(seeds), policy["retention_days"],
         revision, effective_source, policy["explicit_auto_retain"], json.dumps(provenance)),
    )
    if policy["retention_days"] is not None:
        from .hindsight_credentials import derive_hindsight_bank_id
        bank = derive_hindsight_bank_id(ctx.tenant_id, ctx.user_id, employee_id, ctx.enterprise_id)
        session.execute("INSERT INTO memory_bank_guard(tenant_id,employee_id,bank_id,source) VALUES(%s,%s,%s,'effective_finite') ON CONFLICT DO NOTHING",
                        (ctx.tenant_id, employee_id, bank))
        session.execute("UPDATE memory_acceptance SET expires_at=LEAST(expires_at,accepted_at+%s*interval '1 day'), "
                        "next_attempt=LEAST(next_attempt,now()) WHERE employee_id=%s AND cleanup_state<>'cleaned'",
                        (policy["retention_days"], employee_id))
    guarded = bool(session.execute("SELECT 1 FROM memory_bank_guard WHERE employee_id=%s LIMIT 1", (employee_id,)).fetchone())
    projection = policy_projection(policy, revision=revision, source=effective_source, guarded=guarded)
    if project_employee:
        session.execute("UPDATE employee SET memory_policy=%s WHERE id=%s AND memory_policy IS DISTINCT FROM %s::jsonb",
                        (json.dumps(projection), employee_id, json.dumps(projection)))
    return projection
