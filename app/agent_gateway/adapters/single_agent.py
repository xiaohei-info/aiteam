"""Single-agent run adapter — handles private chat dispatch."""

import uuid

from agent_gateway.contracts import (
    GatewayAcceptResponse,
    RuntimeHandle,
    SingleAgentRunRequest,
)
from team_panel.domain.entities import RuntimeBinding
from team_panel.transactions.uow import UnitOfWork


def validate_request(req: SingleAgentRunRequest) -> None:
    """Validate required fields.  Raises ValueError on failure."""
    if not req.employee_id.strip():
        raise ValueError("employee_id is required")
    if not req.conversation_id.strip():
        raise ValueError("conversation_id is required")
    if not req.message_text.strip():
        raise ValueError("message_text is required")


def accept(uow: UnitOfWork, req: SingleAgentRunRequest) -> GatewayAcceptResponse:
    """Accept a single-agent run request.  Returns synchronous acceptance response.

    Creates a ``RuntimeBinding`` via the Unit of Work repository and returns
    a ``GatewayAcceptResponse`` with the generated runtime handle and stream /
    events URLs.  The caller is expected to manage the UoW transaction boundary.
    """
    validate_request(req)

    enterprise_id = req.enterprise_id or ""
    profile_name = req.profile_name or req.employee_id
    session_id = f"sess_{uuid.uuid4().hex[:8]}"

    binding = RuntimeBinding(
        id=f"binding_{uuid.uuid4().hex[:8]}",
        enterprise_id=enterprise_id,
        owner_type="team_run",
        owner_id=req.run_id,
        profile_name=profile_name,
        runtime_kind="session",
        runtime_session_id=session_id,
    )
    uow.runtime_bindings().create(binding)

    handle = RuntimeHandle(
        enterprise_id=enterprise_id,
        employee_id=req.employee_id,
        run_id=req.run_id,
        kind="session",
        profile_name=profile_name,
        session_id=session_id,
    )
    return GatewayAcceptResponse(
        run_id=req.run_id,
        status="queued",
        runtime_handle=handle,
        stream_url=f"/api/team/runs/{req.run_id}/stream?cursor=0",
        events_url=f"/api/team/runs/{req.run_id}/events?cursor=0",
    )
