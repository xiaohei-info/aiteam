"""Layer 0 gateway contract tests — request/response schemas and validation."""
import pytest
from agent_gateway.contracts import (
    RuntimeHandle,
    SingleAgentRunRequest,
    GroupConversationRunRequest,
    OrchestrationRunRequest,
    ScheduledJobRunRequest,
    GatewayAcceptResponse,
    validate_runtime_handle_kind,
    validate_route_mode,
    validate_idempotency_key,
)


# ── S03-T01: SingleAgentRunRequest requires business identity fields ─────

def test_single_agent_request_requires_business_identity_fields():
    """SingleAgentRunRequest must carry run_id, employee_id, conversation_id."""
    # All three required fields present → success
    req = SingleAgentRunRequest(
        run_id="run_001",
        employee_id="emp_001",
        conversation_id="conv_001",
        message_text="Hello",
        idempotency_key="idem_001",
    )
    assert req.run_id == "run_001"
    assert req.employee_id == "emp_001"
    assert req.conversation_id == "conv_001"

    # Missing run_id raises TypeError (required field with no default)
    with pytest.raises(TypeError):
        SingleAgentRunRequest(  # noqa:  missing run_id
            employee_id="emp_001",
            conversation_id="conv_001",
            message_text="Hello",
        )

    # Missing employee_id raises TypeError
    with pytest.raises(TypeError):
        SingleAgentRunRequest(  # noqa:  missing employee_id
            run_id="run_001",
            conversation_id="conv_001",
            message_text="Hello",
        )

    # Missing conversation_id raises TypeError
    with pytest.raises(TypeError):
        SingleAgentRunRequest(  # noqa:  missing conversation_id
            run_id="run_001",
            employee_id="emp_001",
            message_text="Hello",
        )


# ── S03-T02: Dataclasses exist — covered by successful imports above ─────


# ── S03-T03: Invalid route_mode rejection ────────────────────────────────

_VALID_ROUTE_MODES = {"auto", "single_agent", "orchestration"}


def test_reject_invalid_route_mode():
    """GroupConversationRunRequest must reject route_mode outside auto/single_agent/orchestration."""
    for valid in _VALID_ROUTE_MODES:
        req = GroupConversationRunRequest(
            run_id="run_001",
            conversation_id="conv_001",
            message_text="Hello",
            route_mode=valid,
            idempotency_key="idem_001",
        )
        assert req.route_mode == valid

    invalid_modes = ["manual", "random", "", "AUTO", "orchestrate", "single"]
    for invalid in invalid_modes:
        with pytest.raises(ValueError, match="Invalid route_mode"):
            GroupConversationRunRequest(
                run_id="run_001",
                conversation_id="conv_001",
                message_text="Hello",
                route_mode=invalid,
                idempotency_key="idem_001",
            )


# ── S03-T04: Missing idempotency_key rejection ──────────────────────────

def test_reject_missing_idempotency_key_for_create_requests():
    """All create-type requests (single, group, orchestration, scheduled)
    must reject empty or missing idempotency_key."""

    # SingleAgentRunRequest
    with pytest.raises(ValueError, match="idempotency_key"):
        SingleAgentRunRequest(
            run_id="run_001",
            employee_id="emp_001",
            conversation_id="conv_001",
            message_text="Hello",
        )
    # Explicit empty string
    with pytest.raises(ValueError, match="idempotency_key"):
        SingleAgentRunRequest(
            run_id="run_001",
            employee_id="emp_001",
            conversation_id="conv_001",
            message_text="Hello",
            idempotency_key="",
        )

    # GroupConversationRunRequest
    with pytest.raises(ValueError, match="idempotency_key"):
        GroupConversationRunRequest(
            run_id="run_001",
            conversation_id="conv_001",
            message_text="Hello",
        )
    with pytest.raises(ValueError, match="idempotency_key"):
        GroupConversationRunRequest(
            run_id="run_001",
            conversation_id="conv_001",
            message_text="Hello",
            idempotency_key="",
        )

    # OrchestrationRunRequest
    with pytest.raises(ValueError, match="idempotency_key"):
        OrchestrationRunRequest(
            run_id="run_001",
            conversation_id="conv_001",
            root_task_context={"task": "test"},
        )
    with pytest.raises(ValueError, match="idempotency_key"):
        OrchestrationRunRequest(
            run_id="run_001",
            conversation_id="conv_001",
            root_task_context={"task": "test"},
            idempotency_key="",
        )

    # ScheduledJobRunRequest
    with pytest.raises(ValueError, match="idempotency_key"):
        ScheduledJobRunRequest(
            run_id="run_001",
            job_id="job_001",
            employee_id="emp_001",
        )
    with pytest.raises(ValueError, match="idempotency_key"):
        ScheduledJobRunRequest(
            run_id="run_001",
            job_id="job_001",
            employee_id="emp_001",
            idempotency_key="",
        )

    # Whitespace-only is also rejected
    with pytest.raises(ValueError, match="idempotency_key"):
        SingleAgentRunRequest(
            run_id="run_001",
            employee_id="emp_001",
            conversation_id="conv_001",
            message_text="Hello",
            idempotency_key="   ",
        )

    # Standalone validator also rejects
    with pytest.raises(ValueError, match="idempotency_key"):
        validate_idempotency_key("")
    with pytest.raises(ValueError, match="idempotency_key"):
        validate_idempotency_key("   ")
    # Valid key passes
    validate_idempotency_key("idem_001")


# ── S03-T05: GatewayAcceptResponse requires runtime_handle ───────────────

def test_accept_response_has_runtime_handle():
    """GatewayAcceptResponse must contain a valid RuntimeHandle."""
    handle = RuntimeHandle(
        enterprise_id="ent_001",
        employee_id="emp_001",
        run_id="run_001",
        kind="session",
        profile_name="backend-eng",
    )
    resp = GatewayAcceptResponse(
        run_id="run_001",
        status="queued",
        runtime_handle=handle,
        stream_url="/api/team/runs/run_001/stream",
        events_url="/api/team/runs/run_001/events",
    )
    assert resp.runtime_handle is handle
    assert resp.runtime_handle.kind == "session"
    assert resp.run_id == "run_001"
    assert resp.status == "queued"

    # GatewayAcceptResponse requires runtime_handle — missing it raises TypeError
    with pytest.raises(TypeError):
        GatewayAcceptResponse(  # noqa:  missing runtime_handle
            run_id="run_001",
            status="queued",
            stream_url="/stream",
            events_url="/events",
        )


# ── S03-T06: RuntimeHandle kind validation ───────────────────────────────

def test_runtime_handle_kind_is_valid():
    """RuntimeHandle.kind must be one of session/kanban_task/cron_job/composite."""
    valid_kinds = {"session", "kanban_task", "cron_job", "composite"}
    for kind in valid_kinds:
        handle = RuntimeHandle(
            enterprise_id="ent_001",
            employee_id="emp_001",
            run_id="run_001",
            kind=kind,
            profile_name="backend-eng",
        )
        assert handle.kind == kind

    invalid_kinds = ["profile", "task", "session_task", "", "SESSION", "unknown"]
    for invalid in invalid_kinds:
        with pytest.raises(ValueError, match="Invalid RuntimeHandle kind"):
            RuntimeHandle(
                enterprise_id="ent_001",
                employee_id="emp_001",
                run_id="run_001",
                kind=invalid,
                profile_name="backend-eng",
            )

    # Standalone validator
    for invalid in invalid_kinds:
        with pytest.raises(ValueError, match="Invalid RuntimeHandle kind"):
            validate_runtime_handle_kind(invalid)

    # Valid kinds pass the standalone validator too
    for kind in valid_kinds:
        validate_runtime_handle_kind(kind)

    # validate_route_mode standalone
    with pytest.raises(ValueError, match="Invalid route_mode"):
        validate_route_mode("random")
    validate_route_mode("auto")
    validate_route_mode("single_agent")
    validate_route_mode("orchestration")
