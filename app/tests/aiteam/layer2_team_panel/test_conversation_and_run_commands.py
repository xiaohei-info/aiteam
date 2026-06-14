"""L2-S03 Layer2 tests: conversation, run, orchestration, scheduled job services + gateway fake."""

import json
import pytest

from team_panel.application.commands.conversation_service import (
    create_private_conversation,
    create_group_conversation,
    submit_group_message,
)
from team_panel.application.commands.run_command_service import create_run
from team_panel.application.commands.orchestration_service import create_orchestration_run
from team_panel.application.commands.scheduled_job_service import (
    create_scheduled_job,
    create_scheduled_job_run,
    pause_job,
    resume_job,
)
from team_panel.domain.entities import Employee
from team_panel.domain.entities import Conversation
from team_panel.domain.enums import EmployeeStatus
from team_panel.integration.gateway_client import submit_group_conversation, submit_run, submit_orchestration
from agent_gateway.contracts import GatewayAcceptResponse, RuntimeHandle


class _FakeSystemPlannerEmployees:
    def __init__(self, planner=None):
        self.planner = planner
        self.created = []

    def get_system_planner(self, enterprise_id):
        return self.planner

    def create(self, employee):
        self.created.append(employee)
        self.planner = employee
        return employee

    def get_by_id(self, employee_id):
        return Employee(id=employee_id, enterprise_id="ent_test", status=EmployeeStatus.ACTIVE)


class _FakeRepo:
    def __init__(self, item=None):
        self.item = item
        self.created = []

    def create(self, item):
        self.created.append(item)
        self.item = item
        return item

    def get_by_id(self, item_id):
        return self.item

    def get_by_idempotency_key(self, idempotency_key):
        return None

    def get_by_owner(self, owner_type, owner_id):
        return None

    def update_latest_run(self, *args):
        return None


class _FakeCursor:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))


class _FakeConversationUow:
    def __init__(self, planner=None):
        self.cur = _FakeCursor()
        self.employee_repo = _FakeSystemPlannerEmployees(planner)
        self.conversation_repo = _FakeRepo(Conversation(
            id="conv_existing",
            enterprise_id="ent_test",
            type="group",
            status="active",
            title="Existing Group",
            created_by="user_test",
        ))
        self.message_repo = _FakeRepo()
        self.run_repo = _FakeRepo()
        self.binding_repo = _FakeRepo()
        self.audit_repo = _FakeRepo()

    def employees(self):
        return self.employee_repo

    def conversations(self):
        return self.conversation_repo

    def conversation_messages(self):
        return self.message_repo

    def team_runs(self):
        return self.run_repo

    def runtime_bindings(self):
        return self.binding_repo

    def audit_events(self):
        return self.audit_repo


def test_create_group_conversation_auto_adds_system_planner_without_duplicate():
    """Group creation auto-seeds and joins one system planner member."""
    uow = _FakeConversationUow()

    conv_id = create_group_conversation(
        uow, "ent_test", "Auto Planner Group", ["emp_test"], "user_test",
    )

    member_params = [params for sql, params in uow.cur.executed if "INSERT INTO conversation_member" in sql]
    member_ref_ids = [params[3] for params in member_params]
    assert conv_id.startswith("conv_")
    assert "emp_test" in member_ref_ids
    assert uow.employee_repo.created[0].id in member_ref_ids
    assert len([employee_id for employee_id in member_ref_ids if employee_id == uow.employee_repo.created[0].id]) == 1


def test_submit_group_message_excludes_system_planner_from_worker_candidates(monkeypatch):
    """The system planner coordinates orchestration but is not a worker target."""
    planner = Employee(
        id="emp_sys_planner",
        enterprise_id="ent_test",
        profile_name="sys_planner_ent_test",
        display_name="协作主持人",
        role_name="orchestrator",
        status=EmployeeStatus.ACTIVE,
        created_from="admin_seed",
        capabilities_json=json.dumps({"is_system_planner": True}),
    )
    uow = _FakeConversationUow(planner)
    members = [
        {"employee_id": "emp_test", "display_name": "Test", "role_name": "分析师", "profile_name": "emp-test", "is_system_planner": False},
        {"employee_id": "emp_member", "display_name": "Member", "role_name": "研究员", "profile_name": "emp-member", "is_system_planner": False},
        {"employee_id": "emp_sys_planner", "display_name": "协作主持人", "role_name": "orchestrator", "profile_name": "sys_planner_ent_test", "is_system_planner": True},
    ]
    captured = {}

    import team_panel.application.commands.conversation_service as service

    monkeypatch.setattr(service, "_get_active_members", lambda *_: list(members))
    monkeypatch.setattr(service, "build_knowledge_preview_for_employees", lambda *_, **__: None)

    def fake_submit(request):
        captured.update(request)
        return GatewayAcceptResponse(
            run_id=request["run_id"],
            status="queued",
            runtime_handle=RuntimeHandle(
                enterprise_id=request.get("enterprise_id", ""),
                employee_id=request.get("planner_employee_id", request.get("employee_id", "")),
                run_id=request["run_id"],
                kind="composite",
                task_id="task_fake",
                profile_name="fake-profile",
            ),
            stream_url=f"/api/team/runs/{request['run_id']}/stream?cursor=0",
            events_url=f"/api/team/runs/{request['run_id']}/events?cursor=0",
        )

    monkeypatch.setattr(service, "submit_group_conversation", fake_submit)

    result = submit_group_message(
        uow, "conv_existing", "请大家一起完成这份报告", "auto", "idem_no_planner_worker", "emp_test",
    )

    assert result["route_decision"]["planner_employee_id"] == "emp_sys_planner"
    assert result["route_decision"]["candidate_employee_ids"] == ["emp_test", "emp_member"]
    assert captured["planner_employee_id"] == "emp_sys_planner"
    assert captured["target_employee_ids"] == ["emp_test", "emp_member"]


def test_submit_group_message_lazily_adds_missing_system_planner(monkeypatch):
    """Existing groups get the system planner lazily before route decision."""
    planner = Employee(
        id="emp_sys_planner",
        enterprise_id="ent_test",
        profile_name="sys_planner_ent_test",
        display_name="协作主持人",
        role_name="orchestrator",
        status=EmployeeStatus.ACTIVE,
        created_from="admin_seed",
        capabilities_json=json.dumps({"is_system_planner": True}),
    )
    uow = _FakeConversationUow(planner)
    member_reads = [
        [
            {"employee_id": "emp_test", "display_name": "Test", "role_name": "分析师", "profile_name": "emp-test"},
            {"employee_id": "emp_member", "display_name": "Member", "role_name": "研究员", "profile_name": "emp-member"},
        ],
        [
            {"employee_id": "emp_test", "display_name": "Test", "role_name": "分析师", "profile_name": "emp-test"},
            {"employee_id": "emp_member", "display_name": "Member", "role_name": "研究员", "profile_name": "emp-member"},
            {"employee_id": "emp_sys_planner", "display_name": "协作主持人", "role_name": "orchestrator", "profile_name": "sys_planner_ent_test", "is_system_planner": True},
        ],
    ]

    import team_panel.application.commands.conversation_service as service

    monkeypatch.setattr(service, "_get_active_members", lambda *_: member_reads.pop(0))
    monkeypatch.setattr(service, "build_knowledge_preview_for_employees", lambda *_, **__: None)
    monkeypatch.setattr(service, "submit_group_conversation", lambda request: GatewayAcceptResponse(
        run_id=request["run_id"],
        status="queued",
        runtime_handle=RuntimeHandle(
            enterprise_id=request.get("enterprise_id", ""),
            employee_id=request.get("planner_employee_id", request.get("employee_id", "")),
            run_id=request["run_id"],
            kind="composite",
            task_id="task_fake",
            profile_name="fake-profile",
        ),
        stream_url=f"/api/team/runs/{request['run_id']}/stream?cursor=0",
        events_url=f"/api/team/runs/{request['run_id']}/events?cursor=0",
    ))

    result = submit_group_message(
        uow, "conv_existing", "请处理这个需求", "auto", "idem_lazy_planner", "emp_test",
    )

    member_params = [params for sql, params in uow.cur.executed if "INSERT INTO conversation_member" in sql]
    assert member_params[0][3] == "emp_sys_planner"
    assert result["route_decision"]["route_mode"] == "orchestration"
    assert result["route_decision"]["planner_employee_id"] == "emp_sys_planner"
    assert set(result["route_decision"]["target_employee_ids"]) == {"emp_test", "emp_member"}


# ── T01: create private conversation + team_run ───────────────────────

def test_create_private_conversation_and_run(uow, clean_tables_with_enterprise):
    """Create a private conversation, then create a run for it."""
    with uow:
        conv_id = create_private_conversation(
            uow, "ent_test", "emp_test", "user_test",
        )
        assert conv_id.startswith("conv_")

        conv = uow.conversations().get_by_id(conv_id)
        assert conv is not None
        assert conv.type == "private"
        assert conv.status == "active"
        assert conv.enterprise_id == "ent_test"
        assert conv.entry_employee_id == "emp_test"

        # Now create a run for this conversation
        result = create_run(
            uow, conv_id, "emp_test", "Hello, team!",
            "idem_private_001",
        )
        assert result["run_id"].startswith("run_")
        assert result["status"] == "queued"
        assert "stream_url" in result
        assert "events_url" in result
        assert result["runtime_handle"]["session_id"] is not None

        # Verify run persisted
        run = uow.team_runs().get_by_id(result["run_id"])
        assert run is not None
        assert run.execution_mode == "single_agent"
        assert run.conversation_id == conv_id
        assert run.idempotency_key == "idem_private_001"

        # Verify RuntimeBinding
        binding = uow.runtime_bindings().get_by_owner("team_run", result["run_id"])
        assert binding is not None
        assert binding.owner_type == "team_run"
        assert binding.sync_status == "pending"

        # Verify conversation mirror updated
        conv = uow.conversations().get_by_id(conv_id)
        assert conv.latest_run_id == result["run_id"]


# ── T02: group message submit uses route_decision_service and persists ──

def test_group_message_sets_route_mode(uow, clean_tables_with_enterprise):
    """Group message submission resolves route_mode via route_decision_service."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Test Group",
            ["emp_test", "emp_member"], "user_test",
        )
        assert conv_id.startswith("conv_")

        conv = uow.conversations().get_by_id(conv_id)
        assert conv.type == "group"
        assert conv.status == "active"

        # Submit with explicit single_agent hint
        result = submit_group_message(
            uow, conv_id, "Task for everyone", "single_agent",
            "idem_group_001", "emp_test",
        )
        assert result["route_decision"]["route_mode"] == "single_agent"
        assert result["route_decision"]["target_employee_ids"] == []

        # Submit with orchestration hint
        result = submit_group_message(
            uow, conv_id, "Complex task", "orchestration",
            "idem_group_002", "emp_test",
        )
        assert result["route_decision"]["route_mode"] == "orchestration"
        targets = set(result["route_decision"]["target_employee_ids"])
        assert "emp_test" in targets and "emp_member" in targets

        # Submit with auto hint → 2+ non-planner members → defaults to orchestration
        result = submit_group_message(
            uow, conv_id, "Auto task", "auto",
            "idem_group_003", "emp_test",
        )
        assert result["route_decision"]["route_mode"] == "orchestration"

        # Submit with unknown hint → treated as auto, 2+ non-planner → orchestration
        result = submit_group_message(
            uow, conv_id, "Unknown", "unknown_hint",
            "idem_group_004", "emp_test",
        )
        assert result["route_decision"]["route_mode"] == "orchestration"

        # Verify all four runs were persisted
        runs = uow.team_runs().list_by_conversation(conv_id)
        assert len(runs) == 4
        execution_modes = {r.execution_mode for r in runs}
        assert "single_agent" in execution_modes
        assert "kanban_orchestration" in execution_modes


def test_group_message_persistence_team_run_and_binding(uow, clean_tables_with_enterprise):
    """Submit persists TeamRun with correct execution_mode, status, fields."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Persist Group",
            ["emp_test", "emp_member"], "user_test",
        )
        result = submit_group_message(
            uow, conv_id, "Hello group", "single_agent",
            "idem_persist_001", "emp_test",
        )
        run_id = result["run_id"]
        assert run_id.startswith("run_")

        # Verify TeamRun row
        run = uow.team_runs().get_by_id(run_id)
        assert run is not None
        assert run.trigger_type == "group_message"
        assert run.execution_mode == "single_agent"
        assert run.status == "queued"
        assert run.conversation_id == conv_id
        assert run.enterprise_id == "ent_test"
        assert run.idempotency_key == "idem_persist_001"

        # Verify input_message_json
        input_data = json.loads(run.input_message_json)
        assert input_data["message_text"] == "Hello group"
        assert input_data["route_hint"] == "single_agent"

        # Verify result_summary_json stores route_decision
        result_data = json.loads(run.result_summary_json)
        assert result_data["route_mode"] == "single_agent"
        assert result_data["target_employee_ids"] == []

        # Verify RuntimeBinding
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        assert binding is not None
        assert binding.owner_type == "team_run"
        assert binding.owner_id == run_id
        assert binding.runtime_kind == "session"
        assert binding.sync_status == "pending"
        assert binding.runtime_session_id is not None

        # Verify conversation mirror
        conv = uow.conversations().get_by_id(conv_id)
        assert conv.latest_run_id == run_id
        assert conv.last_message_preview == "Hello group"


def test_group_message_persistence_audit_event(uow, clean_tables_with_enterprise):
    """Submit persists an audit_event for group_message.accepted."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Audit Group",
            ["emp_test"], "user_test",
        )
        result = submit_group_message(
            uow, conv_id, "Audit me", "auto",
            "idem_audit_001", "emp_test",
        )
        run_id = result["run_id"]

        # Verify audit events exist for this target
        events = uow.audit_events().list_by_target("team_run", run_id)
        accepted_events = [e for e in events if e.event_type == "group_message.accepted"]
        assert len(accepted_events) == 1
        event = accepted_events[0]
        assert event.enterprise_id == "ent_test"
        assert event.actor_type == "user"
        assert event.actor_id == "emp_test"
        assert event.target_type == "team_run"
        assert event.target_id == run_id
        assert event.request_id == "idem_audit_001"


def test_group_message_orchestration_persistence(uow, clean_tables_with_enterprise):
    """Orchestration route persists kanban_orchestration run and kanban_task binding."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Orch Persist Group",
            ["emp_test", "emp_member", "emp_planner"], "user_test",
        )
        result = submit_group_message(
            uow, conv_id, "Orchestrate this", "orchestration",
            "idem_orch_persist_001", "emp_test",
        )
        assert result["route_decision"]["route_mode"] == "orchestration"

        run_id = result["run_id"]
        run = uow.team_runs().get_by_id(run_id)
        assert run.execution_mode == "kanban_orchestration"
        assert run.trigger_type == "group_message"
        assert run.status == "queued"

        # result_summary_json should contain route_decision
        result_data = json.loads(run.result_summary_json)
        assert result_data["route_mode"] == "orchestration"
        assert {"emp_test", "emp_member", "emp_planner"}.issubset(set(result_data["target_employee_ids"]))

        # RuntimeBinding should be kanban_task
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        assert binding is not None
        assert binding.runtime_kind == "kanban_task"


def test_group_message_mentions_drive_orchestration(uow, clean_tables_with_enterprise):
    """@mentions of >1 employee in message with route_hint=auto triggers orchestration."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Mention Group",
            ["emp_test", "emp_member", "emp_planner"], "user_test",
        )
        # Both emp_test and emp_member mentioned → orchestration
        result = submit_group_message(
            uow, conv_id,
            "Hey emp_test and emp_member, please help",
            "auto", "idem_mention_001", "emp_test",
        )
        assert result["route_decision"]["route_mode"] == "orchestration"
        assert set(result["route_decision"]["target_employee_ids"]) == {"emp_test", "emp_member"}

        run = uow.team_runs().get_by_id(result["run_id"])
        assert run.execution_mode == "kanban_orchestration"

        # Only one employee mentioned → single_agent
        result2 = submit_group_message(
            uow, conv_id,
            "emp_test only",
            "auto", "idem_mention_002", "emp_test",
        )
        assert result2["route_decision"]["route_mode"] == "single_agent"


def test_group_message_orchestration_caps_candidate_replies_at_three(uow, clean_tables_with_enterprise):
    """A single group message must not schedule more than 3 employee replies."""
    with uow:
        uow.employees().create(Employee(
            id="emp_4",
            enterprise_id="ent_test",
            profile_name="p-emp-4",
            display_name="Drew",
            role_name="分析师",
            status=EmployeeStatus.ACTIVE,
        ))
        conv_id = create_group_conversation(
            uow, "ent_test", "Capped Group",
            ["emp_test", "emp_member", "emp_planner", "emp_4"], "user_test",
        )
        result = submit_group_message(
            uow, conv_id, "请大家一起协作完成这份复盘", "orchestration",
            "idem_group_cap_001", "emp_test",
        )

        assert result["route_decision"]["route_mode"] == "orchestration"
        assert len(result["route_decision"]["candidate_employee_ids"]) == 3
        assert len(result["route_decision"]["target_employee_ids"]) >= 4
        assert "emp_planner" in result["route_decision"]["candidate_employee_ids"]
        assert "emp_planner" in result["route_decision"]["target_employee_ids"]

        run = uow.team_runs().get_by_id(result["run_id"])
        assert run is not None
        result_data = json.loads(run.result_summary_json or "{}")
        assert len(result_data["candidate_employee_ids"]) == 3
        assert len(result_data["target_employee_ids"]) >= 4


def test_group_message_idempotency(uow, clean_tables_with_enterprise):
    """Duplicate idempotency_key returns existing run without creating duplicates."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Idem Group",
            ["emp_test", "emp_member"], "user_test",
        )
        result1 = submit_group_message(
            uow, conv_id, "First message", "single_agent",
            "idem_group_idempotent_001", "emp_test",
        )
        result2 = submit_group_message(
            uow, conv_id, "Second message (should be ignored)", "orchestration",
            "idem_group_idempotent_001", "emp_test",
        )
        assert result1["run_id"] == result2["run_id"]
        assert result1["route_decision"]["route_mode"] == result2["route_decision"]["route_mode"]

        # Verify only one run exists
        runs = uow.team_runs().list_by_conversation(conv_id)
        assert len(runs) == 1

        # Verify only one runtime_binding
        uow.cur.execute(
            "SELECT COUNT(*) FROM runtime_binding WHERE owner_id = %s",
            (result1["run_id"],),
        )
        assert uow.cur.fetchone()[0] == 1


# ── T03: orchestration run creates root task ──────────────────────────

def test_orchestration_run_creates_root_task(uow, clean_tables_with_enterprise):
    """Orchestration run persists TeamRun + root TeamTask."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Orch Group",
            ["emp_test", "emp_member", "emp_planner"], "user_test",
        )

        root_context = {
            "title": "Build Q3 Report",
            "description": "Analyze Q3 data and produce summary report",
            "priority": "high",
        }
        result = create_orchestration_run(
            uow, conv_id, root_context,
            ["emp_test", "emp_member"],
            "emp_planner",
            "idem_orch_001",
        )
        assert result["run_id"].startswith("run_")
        assert result["status"] == "queued"
        assert "stream_url" in result
        assert "events_url" in result
        assert result["runtime_handle"]["kind"] == "composite"
        assert result["root_team_task_id"].startswith("task_")

        # Verify run persisted
        run = uow.team_runs().get_by_id(result["run_id"])
        assert run is not None
        assert run.execution_mode == "kanban_orchestration"
        assert run.planner_employee_id == "emp_planner"
        assert run.root_team_task_id == result["root_team_task_id"]

        # Verify root task persisted
        task = uow.team_tasks().get_by_id(result["root_team_task_id"])
        assert task is not None
        assert task.run_id == result["run_id"]
        assert task.title == "Build Q3 Report"
        assert task.status == "planned"
        assert task.depth == 0
        assert task.sequence_no == 1

        # Verify RuntimeBinding with kanban_task kind
        binding = uow.runtime_bindings().get_by_owner("team_run", result["run_id"])
        assert binding is not None
        assert binding.runtime_kind == "kanban_task"
        assert binding.runtime_task_id is not None

        # Verify conversation mirror updated
        conv = uow.conversations().get_by_id(conv_id)
        assert conv.latest_run_id == result["run_id"]


# ── T04: scheduled_job create/pause/resume lifecycle ──────────────────

def test_scheduled_job_lifecycle(uow, clean_tables_with_enterprise):
    """ScheduledJob create → pause → resume lifecycle transitions."""
    with uow:
        job_config = {
            "name": "Daily Report",
            "goal": "Generate daily summary",
            "auto_enable": True,
            "notification_policy": {"on_failure": "email"},
        }
        job_id = create_scheduled_job(
            uow, "ent_test", "emp_test",
            "0 9 * * *", job_config,
        )
        assert job_id.startswith("job_")

        job = uow.scheduled_jobs().get_by_id(job_id)
        assert job is not None
        assert job.enterprise_id == "ent_test"
        assert job.employee_id == "emp_test"
        assert job.schedule_expr == "0 9 * * *"
        assert job.name == "Daily Report"
        assert job.status == "enabled"  # auto_enable=True
        assert job.runtime_job_id == job_id

        binding = uow.runtime_bindings().get_by_owner("scheduled_job", job_id)
        assert binding is not None
        assert binding.runtime_kind == "cron_job"
        assert binding.runtime_job_id == job_id
        # The cron runs under the employee's provisioned profile_name (emp-test),
        # not the raw employee_id — create_scheduled_job now resolves it so
        # `hermes cron create --profile` targets a real profile.
        assert binding.profile_name == "emp-test"
        assert binding.sync_status == "pending"

        # Pause the job
        pause_job(uow, job_id)
        job = uow.scheduled_jobs().get_by_id(job_id)
        assert job.status == "paused"

        # Resume the job
        resume_job(uow, job_id)
        job = uow.scheduled_jobs().get_by_id(job_id)
        assert job.status == "enabled"


def test_scheduled_job_no_auto_enable(uow, clean_tables_with_enterprise):
    """ScheduledJob created with auto_enable=False stays draft."""
    with uow:
        job_id = create_scheduled_job(
            uow, "ent_test", "emp_test",
            "0 18 * * 1-5",
            {"name": "Evening Report", "auto_enable": False},
        )
        job = uow.scheduled_jobs().get_by_id(job_id)
        assert job.status == "draft"


def test_scheduled_job_pause_requires_enabled(uow, clean_tables_with_enterprise):
    """Pausing a draft job raises ValueError."""
    with uow:
        job_id = create_scheduled_job(
            uow, "ent_test", "emp_test",
            "*/15 * * * *",
            {"name": "Frequent Job", "auto_enable": False},
        )
        with pytest.raises(ValueError, match="Cannot pause"):
            pause_job(uow, job_id)


def test_scheduled_job_tick_run_persists_team_run_and_binding(uow, clean_tables_with_enterprise):
    """An enabled ScheduledJob tick creates a TeamRun linked to the cron job."""
    with uow:
        job_id = create_scheduled_job(
            uow, "ent_test", "emp_test",
            "*/30 * * * *",
            {"name": "Tick Job", "goal": "Send reminder", "auto_enable": True},
        )
        result = create_scheduled_job_run(uow, job_id, "idem_job_tick_001")

        assert result["run_id"].startswith("run_")
        assert result["status"] == "queued"
        assert result["runtime_handle"]["job_id"] == job_id

        run = uow.team_runs().get_by_id(result["run_id"])
        assert run is not None
        assert run.trigger_type == "scheduled_job"
        assert run.execution_mode == "cron_single_agent"
        assert run.scheduled_job_id == job_id
        assert run.entry_employee_id == "emp_test"

        binding = uow.runtime_bindings().get_by_owner("team_run", result["run_id"])
        assert binding is not None
        assert binding.runtime_kind == "cron_job"
        assert binding.runtime_job_id == job_id
        assert binding.profile_name == "emp_test"


# ── T05: idempotency on create_run ────────────────────────────────────

def test_create_run_idempotency(uow, clean_tables_with_enterprise):
    """Duplicate idempotency_key returns same run without creating a second one."""
    with uow:
        conv_id = create_private_conversation(
            uow, "ent_test", "emp_test", "user_test",
        )
        result1 = create_run(
            uow, conv_id, "emp_test", "First message",
            "idem_idempotent_001",
        )
        result2 = create_run(
            uow, conv_id, "emp_test", "Second message (should be ignored)",
            "idem_idempotent_001",
        )
        assert result1["run_id"] == result2["run_id"]
        assert result1["status"] == result2["status"]

        # Verify only one run exists
        runs = uow.team_runs().list_by_conversation(conv_id)
        assert len(runs) == 1


# ── T06: orchestration run idempotency ────────────────────────────────

def test_orchestration_run_idempotency(uow, clean_tables_with_enterprise):
    """Duplicate idempotency_key for orchestration returns existing run."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Orch Idem Group",
            ["emp_test", "emp_planner"], "user_test",
        )
        ctx = {"title": "Idempotent Orch"}
        result1 = create_orchestration_run(
            uow, conv_id, ctx, ["emp_test"], "emp_planner",
            "idem_orch_idem_001",
        )
        result2 = create_orchestration_run(
            uow, conv_id, {"title": "Should be ignored"}, ["emp_test"],
            "emp_planner", "idem_orch_idem_001",
        )
        assert result1["run_id"] == result2["run_id"]
        assert result1["root_team_task_id"] == result2["root_team_task_id"]

        runs = uow.team_runs().list_by_conversation(conv_id)
        assert len(runs) == 1
        tasks = uow.team_tasks().list_by_run(result1["run_id"])
        assert len(tasks) == 1


# ── T07: gateway fake seam ────────────────────────────────────────────

def test_gateway_fake_seam_submit_run():
    """Fake gateway submit_run returns valid GatewayAcceptResponse."""
    response = submit_run({
        "run_id": "run_test_001",
        "enterprise_id": "ent_test",
        "employee_id": "emp_test",
        "conversation_id": "conv_test",
        "message_text": "Hello",
    })
    assert isinstance(response, GatewayAcceptResponse)
    assert response.run_id == "run_test_001"
    assert response.status == "queued"
    assert isinstance(response.runtime_handle, RuntimeHandle)
    assert response.runtime_handle.kind == "session"
    assert response.runtime_handle.session_id is not None
    assert response.stream_url.startswith("/api/team/runs/")
    assert response.events_url.startswith("/api/team/runs/")


def test_gateway_fake_seam_submit_orchestration():
    """Fake gateway submit_orchestration returns composite handle."""
    response = submit_orchestration({
        "run_id": "run_orch_001",
        "enterprise_id": "ent_test",
        "planner_employee_id": "emp_planner",
        "root_task_context": {"title": "Test"},
    })
    assert isinstance(response, GatewayAcceptResponse)
    assert response.run_id == "run_orch_001"
    assert response.runtime_handle.kind == "composite"
    assert response.runtime_handle.task_id is not None


def test_gateway_group_conversation_routes_orchestration():
    """Group-conversation seam preserves orchestration routing to task handles."""
    response = submit_group_conversation({
        "run_id": "run_group_orch_001",
        "conversation_id": "conv_test",
        "message_text": "Please collaborate",
        "route_mode": "orchestration",
        "idempotency_key": "idem-group-orch-001",
    })
    assert isinstance(response, GatewayAcceptResponse)
    assert response.run_id == "run_group_orch_001"
    assert response.runtime_handle.kind == "composite"
    assert response.runtime_handle.task_id is not None
    assert response.runtime_handle.session_id is None


def test_gateway_fake_seam_missing_fields_uses_defaults():
    """Fake gateway fills in defaults when fields are missing."""
    response = submit_run({})
    assert response.run_id.startswith("run_")
    assert response.status == "queued"
    assert response.runtime_handle.profile_name == "fake-profile"


# ── T08: submit_group_message rejects non-group conversations ─────────

def test_submit_group_message_rejects_private_conversation(uow, clean_tables_with_enterprise):
    """Submitting to a private conversation raises ValueError."""
    with uow:
        conv_id = create_private_conversation(
            uow, "ent_test", "emp_test", "user_test",
        )
        with pytest.raises(ValueError, match="not a group conversation"):
            submit_group_message(
                uow, conv_id, "Hello", "auto",
                "idem_reject_001", "emp_test",
            )


# ── T09: submit_group_message rejects non-active conversation ─────────

def test_submit_group_message_rejects_draft_conversation(uow, clean_tables_with_enterprise):
    """Submitting to a non-active conversation raises ValueError."""
    # We can test with an archived conversation
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Draft Group",
            ["emp_test"], "user_test",
        )
        conv = uow.conversations().get_by_id(conv_id)
        conv.archive()
        uow.conversations().update_status(conv)

        with pytest.raises(ValueError, match="Cannot submit"):
            submit_group_message(
                uow, conv_id, "Hello", "auto",
                "idem_reject_002", "emp_test",
            )


def test_submit_group_message_requires_sender_id(uow, clean_tables_with_enterprise):
    """Submitting without a sender_id raises ValueError instead of minting a fake principal."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Missing Sender Group",
            ["emp_test"], "user_test",
        )
        with pytest.raises(ValueError, match="sender_id is required"):
            submit_group_message(
                uow, conv_id, "Hello", "auto",
                "idem_reject_003", "",
            )


# ── T10: create_group_conversation creates members ────────────────────

def test_create_group_conversation_members(uow, clean_tables_with_enterprise):
    """Group conversation persists membership entries."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Members Group",
            ["emp_test", "emp_member", "emp_planner"], "user_test",
        )
        # Query members via raw cursor
        uow.cur.execute(
            "SELECT member_ref_id, role FROM conversation_member "
            "WHERE conversation_id = %s AND status = 'active' "
            "ORDER BY member_ref_id",
            (conv_id,),
        )
        members = uow.cur.fetchall()
        member_ids = {row[0] for row in members}
        assert "emp_test" in member_ids
        assert "emp_member" in member_ids
        assert "emp_planner" in member_ids
        for row in members:
            assert row[1] == "participant"


# ── T11: create_run updates conversation mirror ───────────────────────

def test_create_run_updates_conversation(uow, clean_tables_with_enterprise):
    """create_run updates conversation latest_run_id and last_message_preview."""
    with uow:
        conv_id = create_private_conversation(
            uow, "ent_test", "emp_test", "user_test",
        )
        result = create_run(
            uow, conv_id, "emp_test",
            "A longer message that should get truncated preview",
            "idem_mirror_001",
        )
        conv = uow.conversations().get_by_id(conv_id)
        assert conv.latest_run_id == result["run_id"]
        assert conv.last_message_preview is not None
        assert len(conv.last_message_preview) <= 200
        assert "A longer message" in conv.last_message_preview


# ── T12: scheduled_job resume from already-enabled is no-op ───────────

def test_scheduled_job_resume_already_enabled(uow, clean_tables_with_enterprise):
    """Resuming an already-enabled job is a no-op."""
    with uow:
        job_id = create_scheduled_job(
            uow, "ent_test", "emp_test",
            "0 0 * * 0",
            {"name": "Weekly Report", "auto_enable": True},
        )
        # Resume an already-enabled job should work (no-op)
        resume_job(uow, job_id)
        job = uow.scheduled_jobs().get_by_id(job_id)
        assert job.status == "enabled"


# ── T13: conversation_message artifact persistence (L2-REWORK-F01b) ───

def test_submit_group_message_persists_conversation_message_artifact(
    uow, clean_tables_with_enterprise,
):
    """submit_group_message persists a durable ConversationMessage artifact."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Msg Artifact Group",
            ["emp_test", "emp_member"], "user_test",
        )
        result = submit_group_message(
            uow, conv_id, "Hello group from T13", "auto",
            "idem_msg_artifact_001", "emp_test",
        )
        msg_id = result["message_id"]
        assert msg_id.startswith("msg_")

        # Verify ConversationMessage row exists
        msg = uow.conversation_messages().get_by_id(msg_id)
        assert msg is not None
        assert msg.conversation_id == conv_id
        assert msg.run_id == result["run_id"]
        assert msg.sender_id == "emp_test"
        assert msg.sender_type == "user"
        assert msg.message_text == "Hello group from T13"

        # Verify message_json includes route_hint and idempotency_key
        import json
        msg_json = json.loads(msg.message_json)
        assert msg_json["route_hint"] == "auto"
        assert msg_json["idempotency_key"] == "idem_msg_artifact_001"


def test_submit_group_message_sets_latest_message_id(
    uow, clean_tables_with_enterprise,
):
    """submit_group_message writes latest_message_id to conversation mirror."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "LatestMsgId Group",
            ["emp_test"], "user_test",
        )
        result = submit_group_message(
            uow, conv_id, "Check latest_message_id", "single_agent",
            "idem_latest_msg_001", "emp_test",
        )
        msg_id = result["message_id"]

        # Verify conversation.latest_message_id
        conv = uow.conversations().get_by_id(conv_id)
        assert conv.latest_message_id == msg_id
        assert conv.latest_run_id == result["run_id"]
        assert conv.last_message_preview == "Check latest_message_id"


def test_submit_group_message_result_includes_message_id(
    uow, clean_tables_with_enterprise,
):
    """submit_group_message result includes message_id per API contract section 7.4."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "ResultMsg Group",
            ["emp_test"], "user_test",
        )
        result = submit_group_message(
            uow, conv_id, "API contract check", "auto",
            "idem_result_msg_001", "emp_test",
        )
        assert "message_id" in result
        assert result["message_id"].startswith("msg_")
        assert "run_id" in result
        assert "route_decision" in result
        assert "stream_url" in result
        assert "events_url" in result


def test_submit_group_message_idempotency_preserves_message_id(
    uow, clean_tables_with_enterprise,
):
    """Idempotent resubmission returns the original message_id."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "IdemMsgId Group",
            ["emp_test"], "user_test",
        )
        result1 = submit_group_message(
            uow, conv_id, "First try", "auto",
            "idem_msg_id_001", "emp_test",
        )
        result2 = submit_group_message(
            uow, conv_id, "Duplicate try", "orchestration",
            "idem_msg_id_001", "emp_test",
        )
        assert result1["message_id"] == result2["message_id"]
        assert result1["run_id"] == result2["run_id"]

        # Only one message row
        uow.cur.execute(
            "SELECT COUNT(*) FROM conversation_message WHERE run_id = %s",
            (result1["run_id"],),
        )
        assert uow.cur.fetchone()[0] == 1


def test_submit_group_message_preserves_existing_route_decision_integration(
    uow, clean_tables_with_enterprise,
):
    """Existing route_decision + run/binding/audit behavior remains intact."""
    with uow:
        conv_id = create_group_conversation(
            uow, "ent_test", "Compat Group",
            ["emp_test", "emp_member"], "user_test",
        )
        result = submit_group_message(
            uow, conv_id, "Hello compatibility", "orchestration",
            "idem_compat_001", "emp_test",
        )
        # Route decision still works
        assert result["route_decision"]["route_mode"] == "orchestration"

        run = uow.team_runs().get_by_id(result["run_id"])
        assert run.trigger_type == "group_message"
        assert run.execution_mode == "kanban_orchestration"

        binding = uow.runtime_bindings().get_by_owner("team_run", result["run_id"])
        assert binding is not None

        events = uow.audit_events().list_by_target("team_run", result["run_id"])
        assert any(e.event_type == "group_message.accepted" for e in events)
