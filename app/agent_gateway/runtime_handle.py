"""Runtime handle management — creates, tracks, and updates handles.

注意区分两层枚举：
- runtime_binding.runtime_kind (DB): profile|session|kanban_task|cron_job
- RuntimeHandle.kind (Gateway): session|kanban_task|cron_job|composite
"""

import uuid

from agent_gateway.contracts import RuntimeHandle
from team_panel.domain.entities import RuntimeBinding
from team_panel.transactions.uow import UnitOfWork

# Gateway kind → DB runtime_kind
_GATEWAY_TO_DB_KIND = {
    "session": "session",
    "kanban_task": "kanban_task",
    "cron_job": "cron_job",
    "composite": "session",
}


def create_handle(
    uow: UnitOfWork,
    enterprise_id: str,
    employee_id: str,
    run_id: str,
    kind: str,
    profile_name: str,
    task_id: str | None = None,
    job_id: str | None = None,
) -> RuntimeHandle:
    """Create a new RuntimeHandle and persist to runtime_binding table."""
    session_id = f"sess_{uuid.uuid4().hex[:8]}" if kind == "session" else None
    task_id_val = f"task_{uuid.uuid4().hex[:8]}" if kind == "kanban_task" else task_id
    job_id_val = f"job_{uuid.uuid4().hex[:8]}" if kind == "cron_job" else job_id

    handle = RuntimeHandle(
        enterprise_id=enterprise_id,
        employee_id=employee_id,
        run_id=run_id,
        kind=kind,
        profile_name=profile_name,
        session_id=session_id,
        task_id=task_id_val,
        job_id=job_id_val,
    )

    db_runtime_kind = _GATEWAY_TO_DB_KIND.get(kind, "session")

    binding = RuntimeBinding(
        id=f"binding_{uuid.uuid4().hex[:8]}",
        enterprise_id=enterprise_id,
        owner_type="team_run",
        owner_id=run_id,
        profile_name=profile_name,
        runtime_kind=db_runtime_kind,
        runtime_session_id=session_id,
        runtime_task_id=task_id_val,
        runtime_job_id=job_id_val,
        sync_status="synced",
        event_cursor=0,
    )
    uow.runtime_bindings().create(binding)
    return handle


def advance_cursor(uow: UnitOfWork, run_id: str, new_cursor: int) -> None:
    """Advance the event cursor for a run binding.

    Raises DomainError if no binding exists, or ValueError if cursor does not
    increase (enforced by RuntimeBinding.advance_cursor).
    """
    binding_repo = uow.runtime_bindings()
    binding = binding_repo.get_by_owner("team_run", run_id)
    if binding is None:
        raise ValueError(f"No runtime binding found for run {run_id}")
    binding.advance_cursor(new_cursor)
    binding.mark_synced()
    binding_repo.update_sync(binding)
