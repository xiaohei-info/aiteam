"""Gateway client -- fake seam for Layer 2, replaced by real adapter in Layer 3."""

import logging
import uuid

from agent_gateway import profile_capability
from agent_gateway.contracts import (
    GatewayAcceptResponse,
    GroupConversationRunRequest,
    RuntimeHandle,
    ScheduledJobRunRequest,
)
from agent_gateway.runtime_dispatcher import dispatch


def submit_run(request: dict) -> GatewayAcceptResponse:
    """Fake: returns a preset accept response. Layer 3 replaces with real call."""
    run_id = request.get("run_id", f"run_{uuid.uuid4().hex[:8]}")
    enterprise_id = request.get("enterprise_id", "")
    employee_id = request.get("employee_id", "")
    return GatewayAcceptResponse(
        run_id=run_id,
        status="queued",
        runtime_handle=RuntimeHandle(
            enterprise_id=enterprise_id,
            employee_id=employee_id,
            run_id=run_id,
            kind="session",
            profile_name=employee_id or "fake-profile",
            session_id=f"sess_{uuid.uuid4().hex[:8]}",
        ),
        stream_url=f"/api/team/runs/{run_id}/stream?cursor=0",
        events_url=f"/api/team/runs/{run_id}/events?cursor=0",
    )


def submit_orchestration(request: dict) -> GatewayAcceptResponse:
    """Fake: returns a preset accept response for orchestration runs."""
    run_id = request.get("run_id", f"run_{uuid.uuid4().hex[:8]}")
    enterprise_id = request.get("enterprise_id", "")
    planner_id = request.get("planner_employee_id", "")
    return GatewayAcceptResponse(
        run_id=run_id,
        status="queued",
        runtime_handle=RuntimeHandle(
            enterprise_id=enterprise_id,
            employee_id=planner_id or "fake-planner",
            run_id=run_id,
            kind="composite",
            profile_name=planner_id or "fake-planner",
            task_id=f"task_{uuid.uuid4().hex[:8]}",
        ),
        stream_url=f"/api/team/runs/{run_id}/stream?cursor=0",
        events_url=f"/api/team/runs/{run_id}/events?cursor=0",
    )


def submit_group_conversation(request: dict) -> GatewayAcceptResponse:
    """Route a group-conversation request through the Gateway dispatcher."""
    return dispatch(
        GroupConversationRunRequest(
            run_id=request.get("run_id", f"run_{uuid.uuid4().hex[:8]}"),
            conversation_id=request.get("conversation_id", ""),
            message_text=request.get("message_text", ""),
            route_mode=request.get("route_mode", "auto"),
            employee_id=request.get("employee_id", ""),
            planner_employee_id=request.get("planner_employee_id", ""),
            target_employee_ids=list(request.get("target_employee_ids") or []),
            message_id=request.get("message_id", ""),
            idempotency_key=request.get("idempotency_key", ""),
        )
    )


_logger = logging.getLogger(__name__)


def create_scheduled_job(request: dict) -> RuntimeHandle:
    """Provision a cron job in Hermes via profile_capability, fall back to stub on error."""
    enterprise_id = request.get("enterprise_id", "")
    employee_id = request.get("employee_id", "")
    job_id = request.get("job_id", f"job_{uuid.uuid4().hex[:8]}")
    schedule_expr = request.get("schedule_expr", "0 9 * * 1-5")
    goal = request.get("goal", "")
    name = request.get("name", job_id)
    # Prefer the provisioned profile_name; fall back to employee_id only if the
    # caller didn't resolve one. The cron runs under this profile.
    profile = request.get("profile_name") or employee_id or ""
    ok, runtime_job_id = profile_capability.cron_create(
        schedule_expr=schedule_expr,
        goal=goal,
        name=name,
        profile=profile,
    )
    if not ok:
        _logger.warning("cron_create failed for %s: %s; using stub job_id", job_id, runtime_job_id)
        runtime_job_id = job_id
    return RuntimeHandle(
        enterprise_id=enterprise_id,
        employee_id=employee_id,
        run_id="",
        kind="cron_job",
        profile_name=profile or "system",
        job_id=runtime_job_id,
    )


def submit_scheduled_job_run(request: dict) -> GatewayAcceptResponse:
    """Route a scheduled-job tick request through the Gateway dispatcher."""
    return dispatch(
        ScheduledJobRunRequest(
            run_id=request.get("run_id", f"run_{uuid.uuid4().hex[:8]}"),
            job_id=request.get("job_id", f"job_{uuid.uuid4().hex[:8]}"),
            employee_id=request.get("employee_id", ""),
            idempotency_key=request.get("idempotency_key", ""),
        )
    )
