from agent_gateway.contracts import GatewayAcceptResponse, OrchestrationRunRequest, RuntimeHandle


def accept(req: OrchestrationRunRequest) -> GatewayAcceptResponse:
    if not req.conversation_id:
        raise ValueError("conversation_id is required for OrchestrationRunRequest")
    if not isinstance(req.root_task_context, dict) or not req.root_task_context:
        raise ValueError("root_task_context is required for OrchestrationRunRequest")

    handle = RuntimeHandle(
        enterprise_id="",
        employee_id=req.planner_employee_id,
        run_id=req.run_id,
        kind="composite",
        profile_name=req.planner_employee_id or "orchestration",
        task_id=req.root_task_context.get("task_id") or f"root_{req.run_id}",
    )
    return GatewayAcceptResponse(
        run_id=req.run_id,
        status="queued",
        runtime_handle=handle,
        stream_url=f"/api/team/runs/{req.run_id}/stream?cursor=0",
        events_url=f"/api/team/runs/{req.run_id}/events?cursor=0",
    )
