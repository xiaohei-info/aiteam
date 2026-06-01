"""Idempotency service — deduplicates create requests via UNIQUE constraint.

Design decision (§1.2 of the plan): repeated idempotency_key returns the
existing run_id with HTTP 200, not 409.
"""

from team_panel.repositories.team_run_repo import TeamRunRepo


def check_or_create(
    run_repo: TeamRunRepo,
    idempotency_key: str,
    run_id: str,
    conversation_id: str,
    employee_id: str | None,
    extra: dict | None = None,
) -> str:
    """Check for an existing run with *idempotency_key*; return the stored run_id if found.

    If no existing run is found, the caller is responsible for creating the new run
    and writing it via the repo — the UNIQUE constraint on ``team_run.idempotency_key``
    ensures at-most-once semantics at the database level.

    Returns the run_id (existing or the supplied one).
    Raises ValueError if idempotency_key is empty/missing.
    """
    if not idempotency_key:
        raise ValueError("idempotency_key is required for create operations")

    existing = run_repo.get_by_idempotency_key(idempotency_key)
    if existing is not None:
        return existing.id
    return run_id
