"""Gateway client -- fake seam for Layer 2, replaced by real adapter in Layer 3."""

import uuid

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
            idempotency_key=request.get("idempotency_key", ""),
        )
    )


def create_scheduled_job(request: dict) -> RuntimeHandle:
    """Fake: provision a cron job handle for a ScheduledJob control-plane object."""
    enterprise_id = request.get("enterprise_id", "")
    employee_id = request.get("employee_id", "")
    job_id = request.get("job_id", f"job_{uuid.uuid4().hex[:8]}")
    return RuntimeHandle(
        enterprise_id=enterprise_id,
        employee_id=employee_id,
        run_id="",
        kind="cron_job",
        profile_name=employee_id or "fake-profile",
        job_id=job_id,
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
