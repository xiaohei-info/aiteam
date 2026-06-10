"""ScheduledJob command service -- write-side operations for scheduled job lifecycle."""

import json
import logging
import uuid

from agent_gateway import profile_capability
from team_panel.domain.entities import RuntimeBinding, ScheduledJob, TeamRun
from team_panel.integration.gateway_client import (
    create_scheduled_job as gateway_create_scheduled_job,
    submit_scheduled_job_run,
)

_logger = logging.getLogger(__name__)


def create_scheduled_job(uow, enterprise_id: str, employee_id: str,
                         schedule_expr: str, job_config: dict) -> str:
    """Create a ScheduledJob, optionally enable it, and return its id."""
    if not enterprise_id or not employee_id:
        raise ValueError("enterprise_id and employee_id are required")
    if not schedule_expr:
        raise ValueError("schedule_expr is required")

    name = job_config.get("name", "Scheduled Job")
    goal = job_config.get("goal", "")
    auto_enable = job_config.get("auto_enable", True)

    job_id = f"job_{uuid.uuid4().hex[:12]}"
    job = ScheduledJob(
        id=job_id,
        enterprise_id=enterprise_id,
        employee_id=employee_id,
        name=name,
        goal=goal,
        schedule_expr=schedule_expr,
        status="draft",
        max_consecutive_failures=job_config.get("max_consecutive_failures", 3),
        consecutive_failures=0,
        notification_policy_json=json.dumps(job_config.get("notification_policy", {})),
        created_by=job_config.get("created_by", "system"),
    )
    uow.scheduled_jobs().create(job)

    if auto_enable:
        runtime_handle = gateway_create_scheduled_job(
            {
                "enterprise_id": enterprise_id,
                "employee_id": employee_id,
                "job_id": job_id,
            }
        )
        binding = RuntimeBinding(
            id=f"rb_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            owner_type="scheduled_job",
            owner_id=job_id,
            profile_name=runtime_handle.profile_name,
            runtime_kind="cron_job",
            runtime_job_id=runtime_handle.job_id,
            sync_status="pending",
            event_cursor=0,
            created_by=job.created_by,
        )
        uow.runtime_bindings().create(binding)
        job.runtime_job_id = runtime_handle.job_id
        job.enable()
        uow.scheduled_jobs().update_status(job)

    return job_id


def pause_job(uow, job_id: str) -> None:
    """Pause an enabled scheduled job."""
    job = uow.scheduled_jobs().get_by_id(job_id)
    if job is None:
        raise ValueError(f"ScheduledJob {job_id} not found")
    job.pause()
    uow.scheduled_jobs().update_status(job)
    if job.runtime_job_id:
        ok, msg = profile_capability.cron_pause(job.runtime_job_id)
        if not ok:
            _logger.warning("cron_pause(%s) failed: %s", job.runtime_job_id, msg)


def resume_job(uow, job_id: str) -> None:
    """Resume a paused scheduled job (transition back to enabled)."""
    job = uow.scheduled_jobs().get_by_id(job_id)
    if job is None:
        raise ValueError(f"ScheduledJob {job_id} not found")
    if job.status == "paused":
        job.enable()
    elif job.status != "enabled":
        raise ValueError(f"Cannot resume from {job.status}; must be paused or enabled")
    uow.scheduled_jobs().update_status(job)
    if job.runtime_job_id:
        ok, msg = profile_capability.cron_resume(job.runtime_job_id)
        if not ok:
            _logger.warning("cron_resume(%s) failed: %s", job.runtime_job_id, msg)


def create_scheduled_job_run(uow, job_id: str, idempotency_key: str) -> dict:
    """Create a TeamRun for one scheduled-job tick and bind it to the cron job."""
    if not idempotency_key.strip():
        raise ValueError("idempotency_key is required")

    existing = uow.team_runs().get_by_idempotency_key(idempotency_key)
    if existing is not None:
        binding = uow.runtime_bindings().get_by_owner("team_run", existing.id)
        return {
            "run_id": existing.id,
            "status": existing.status,
            "stream_url": f"/api/team/runs/{existing.id}/stream?cursor=0",
            "events_url": f"/api/team/runs/{existing.id}/events?cursor=0",
            "runtime_handle": {
                "job_id": binding.runtime_job_id if binding else existing.scheduled_job_id,
            },
        }

    job = uow.scheduled_jobs().get_by_id(job_id)
    if job is None:
        raise ValueError(f"ScheduledJob {job_id} not found")
    if job.status != "enabled":
        raise ValueError(f"Cannot create scheduled-job run from {job.status}; must be enabled")

    run_id = f"run_{uuid.uuid4().hex[:12]}"
    run = TeamRun(
        id=run_id,
        enterprise_id=job.enterprise_id,
        trigger_type="scheduled_job",
        execution_mode="cron_single_agent",
        status="queued",
        entry_employee_id=job.employee_id,
        scheduled_job_id=job.id,
        idempotency_key=idempotency_key,
        input_message_json=json.dumps(
            {
                "scheduled_job_id": job.id,
                "goal": job.goal,
                "schedule_expr": job.schedule_expr,
            }
        ),
        created_by=job.created_by or "system",
    )
    uow.team_runs().create(run)

    gw_response = submit_scheduled_job_run(
        {
            "run_id": run_id,
            "job_id": job.runtime_job_id or job.id,
            "employee_id": job.employee_id,
            "idempotency_key": idempotency_key,
        }
    )
    binding = RuntimeBinding(
        id=f"rb_{uuid.uuid4().hex[:12]}",
        enterprise_id=job.enterprise_id,
        owner_type="team_run",
        owner_id=run_id,
        profile_name=gw_response.runtime_handle.profile_name,
        runtime_kind="cron_job",
        runtime_job_id=gw_response.runtime_handle.job_id,
        sync_status="pending",
        event_cursor=0,
        created_by=job.created_by,
    )
    uow.runtime_bindings().create(binding)

    return {
        "run_id": run_id,
        "status": run.status,
        "stream_url": gw_response.stream_url,
        "events_url": gw_response.events_url,
        "runtime_handle": {
            "job_id": gw_response.runtime_handle.job_id,
        },
    }
