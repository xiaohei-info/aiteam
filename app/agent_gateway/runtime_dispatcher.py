"""Runtime dispatcher — routes incoming requests to the correct adapter."""

from agent_gateway.adapters import group_conversation, orchestration, scheduled_job, single_agent
from agent_gateway.contracts import (
    GatewayAcceptResponse,
    GroupConversationRunRequest,
    OrchestrationRunRequest,
    ScheduledJobRunRequest,
    SingleAgentRunRequest,
)
from team_panel.transactions.uow import UnitOfWork


def dispatch(*args) -> GatewayAcceptResponse:
    """Dispatch a request to the correct adapter based on request type."""
    uow, request = _normalize_dispatch_args(*args)

    if isinstance(request, SingleAgentRunRequest):
        if uow is None:
            raise TypeError("dispatch() missing required UnitOfWork for SingleAgentRunRequest")
        return single_agent.accept(uow, request)
    if isinstance(request, GroupConversationRunRequest):
        return group_conversation.accept(request)
    if isinstance(request, OrchestrationRunRequest):
        return orchestration.accept(request)
    if isinstance(request, ScheduledJobRunRequest):
        return scheduled_job.accept(request)
    raise NotImplementedError(f"No adapter for {type(request).__name__}")


def _normalize_dispatch_args(*args) -> tuple[UnitOfWork | None, object]:
    if len(args) == 1:
        return None, args[0]
    if len(args) == 2:
        return args[0], args[1]
    raise TypeError(f"dispatch() accepts 1 or 2 positional arguments, got {len(args)}")
