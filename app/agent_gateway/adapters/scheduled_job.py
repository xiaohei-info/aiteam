from agent_gateway.contracts import GatewayAcceptResponse, RuntimeHandle, ScheduledJobRunRequest


def accept(req: ScheduledJobRunRequest) -> GatewayAcceptResponse:
    if not req.job_id:
        raise ValueError("job_id is required for ScheduledJobRunRequest")
    if not req.employee_id:
        raise ValueError("employee_id is required for ScheduledJobRunRequest")

    handle = RuntimeHandle(
        enterprise_id="",
        employee_id=req.employee_id,
        run_id=req.run_id,
        kind="cron_job",
        profile_name=req.employee_id,
        job_id=req.job_id,
    )
    return GatewayAcceptResponse(
        run_id=req.run_id,
        status="queued",
        runtime_handle=handle,
        stream_url=f"/api/team/runs/{req.run_id}/stream?cursor=0",
        events_url=f"/api/team/runs/{req.run_id}/events?cursor=0",
    )
