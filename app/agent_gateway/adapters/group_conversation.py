from agent_gateway.adapters import orchestration
from agent_gateway.contracts import (
    GatewayAcceptResponse,
    GroupConversationRunRequest,
    OrchestrationRunRequest,
    RuntimeHandle,
)


def accept(req: GroupConversationRunRequest) -> GatewayAcceptResponse:
    if not req.conversation_id:
        raise ValueError("conversation_id is required for GroupConversationRunRequest")
    if not req.message_text.strip():
        raise ValueError("message_text is required for GroupConversationRunRequest")

    if req.route_mode == "orchestration":
        return orchestration.accept(
            OrchestrationRunRequest(
                run_id=req.run_id,
                conversation_id=req.conversation_id,
                root_task_context={
                    "conversation_id": req.conversation_id,
                    "message_text": req.message_text,
                    "source": "group_conversation",
                },
                idempotency_key=req.idempotency_key,
            )
        )
    return _accept_single_agent_mode(req)


def _accept_single_agent_mode(req: GroupConversationRunRequest) -> GatewayAcceptResponse:
    handle = RuntimeHandle(
        enterprise_id="",
        employee_id="",
        run_id=req.run_id,
        kind="session",
        profile_name=f"group:{req.conversation_id}",
        session_id=f"group_{req.conversation_id}",
    )
    return GatewayAcceptResponse(
        run_id=req.run_id,
        status="queued",
        runtime_handle=handle,
        stream_url=f"/api/team/runs/{req.run_id}/stream?cursor=0",
        events_url=f"/api/team/runs/{req.run_id}/events?cursor=0",
    )
