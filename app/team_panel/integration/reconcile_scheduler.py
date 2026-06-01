"""Reconcile scheduler — V1 minimal no-op seam.

Design: §11 of Team Panel内部服务与聚合视图详细设计.
V2 will implement real reconciliation against Gateway.
"""


def schedule_reconcile(uow, run_id: str, last_known_cursor: int) -> dict:
    """Schedule a reconcile check for this run.

    V1: no-op that returns a predictable result for testability.
    V2: real reconciliation against Gateway.

    Returns
    -------
    dict
        {"scheduled": False, "run_id": run_id, "reason": "noop-v1"}
    """
    return {
        "scheduled": False,
        "run_id": run_id,
        "reason": "noop-v1",
    }
