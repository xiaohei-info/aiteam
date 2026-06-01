from agent_gateway.adapters import group_conversation, orchestration, scheduled_job
from agent_gateway.contracts import (
    GatewayAcceptResponse,
    GroupConversationRunRequest,
    OrchestrationRunRequest,
    RuntimeHandle,
    ScheduledJobRunRequest,
)
from agent_gateway.runtime_dispatcher import dispatch


def _response(run_id: str, kind: str) -> GatewayAcceptResponse:
    return GatewayAcceptResponse(
        run_id=run_id,
        status="queued",
        runtime_handle=RuntimeHandle(
            enterprise_id="",
            employee_id="",
            run_id=run_id,
            kind=kind,
            profile_name="test-profile",
        ),
        stream_url=f"/api/team/runs/{run_id}/stream?cursor=0",
        events_url=f"/api/team/runs/{run_id}/events?cursor=0",
    )


def test_group_adapter_routes_by_mode(monkeypatch):
    routed = []

    def fake_single(req):
        routed.append(("single_agent", req.route_mode))
        return _response(req.run_id, "session")

    def fake_orchestration(req):
        routed.append(("orchestration", req.root_task_context["source"]))
        return _response(req.run_id, "composite")

    monkeypatch.setattr(group_conversation, "_accept_single_agent_mode", fake_single)
    monkeypatch.setattr(group_conversation.orchestration, "accept", fake_orchestration)

    auto_response = group_conversation.accept(
        GroupConversationRunRequest(
            run_id="run_auto",
            conversation_id="conv_001",
            message_text="hello team",
            route_mode="auto",
            idempotency_key="idem-auto",
        )
    )
    single_response = group_conversation.accept(
        GroupConversationRunRequest(
            run_id="run_single",
            conversation_id="conv_001",
            message_text="hello team",
            route_mode="single_agent",
            idempotency_key="idem-single",
        )
    )
    orchestration_response = group_conversation.accept(
        GroupConversationRunRequest(
            run_id="run_orch",
            conversation_id="conv_001",
            message_text="@a @b please collaborate",
            route_mode="orchestration",
            idempotency_key="idem-orch",
        )
    )

    assert auto_response.runtime_handle.kind == "session"
    assert single_response.runtime_handle.kind == "session"
    assert orchestration_response.runtime_handle.kind == "composite"
    assert routed == [
        ("single_agent", "auto"),
        ("single_agent", "single_agent"),
        ("orchestration", "group_conversation"),
    ]


def test_orchestration_accepts_root_task_context():
    response = orchestration.accept(
        OrchestrationRunRequest(
            run_id="run_orch",
            conversation_id="conv_001",
            root_task_context={"task_id": "task_root", "goal": "coordinate"},
            planner_employee_id="emp_planner",
            target_employee_ids=["emp_a", "emp_b"],
            idempotency_key="idem-orch",
        )
    )

    assert response.run_id == "run_orch"
    assert response.status == "queued"
    assert response.runtime_handle.kind == "composite"
    assert response.runtime_handle.task_id == "task_root"
    assert response.runtime_handle.profile_name == "emp_planner"


def test_scheduled_job_returns_handle():
    response = scheduled_job.accept(
        ScheduledJobRunRequest(
            run_id="run_job",
            job_id="job_001",
            employee_id="emp_001",
            idempotency_key="idem-job",
        )
    )

    assert response.run_id == "run_job"
    assert response.status == "queued"
    assert response.runtime_handle.kind == "cron_job"
    assert response.runtime_handle.job_id == "job_001"
    assert response.runtime_handle.employee_id == "emp_001"


def test_dispatcher_routes_group_orchestration_and_scheduled_job(monkeypatch):
    group_response = _response("run_group", "session")
    orch_response = _response("run_orch", "composite")
    job_response = _response("run_job", "cron_job")

    monkeypatch.setattr(group_conversation, "accept", lambda req: group_response)
    monkeypatch.setattr(orchestration, "accept", lambda req: orch_response)
    monkeypatch.setattr(scheduled_job, "accept", lambda req: job_response)

    assert dispatch(
        GroupConversationRunRequest(
            run_id="run_group",
            conversation_id="conv_001",
            message_text="hello",
            idempotency_key="idem-group",
        )
    ) is group_response
    assert dispatch(
        OrchestrationRunRequest(
            run_id="run_orch",
            conversation_id="conv_001",
            root_task_context={"task_id": "task_root"},
            idempotency_key="idem-orch",
        )
    ) is orch_response
    assert dispatch(
        ScheduledJobRunRequest(
            run_id="run_job",
            job_id="job_001",
            employee_id="emp_001",
            idempotency_key="idem-job",
        )
    ) is job_response
