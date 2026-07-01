"""Run 触发类型 / 执行模式 / 完整生命周期 漂移守卫（AITEAM-237 / #283）。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# server package on path when launched from repo root; make import robust for any cwd.
SERVER_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SERVER_DIR))
from agent_service.mainline.models import (  # noqa: E402
    Run,
    RunStatus,
    RunTriggerType,
    RunExecutionMode,
)


# T01: enum + full lifecycle state machine ────────────────────────────

_EXPECTED_RUN_STATUSES = {
    "queued", "routing", "submitting", "running",
    "waiting_human", "succeeded", "failed", "cancelled",
}
_EXPECTED_TRIGGER_TYPES = {
    "private_message", "group_message", "manual_run", "scheduled_job", "api_call",
}
_EXPECTED_EXECUTION_MODES = {
    "single_agent", "kanban_orchestration", "cron_single_agent",
}


def test_run_status_complete_lifecycle():
    values = {s.value for s in RunStatus}
    assert values == _EXPECTED_RUN_STATUSES, f"RunStatus expects 8 lifecycle states, got {values}"


def test_run_trigger_type_values():
    values = {t.value for t in RunTriggerType}
    assert values == _EXPECTED_TRIGGER_TYPES


def test_run_execution_mode_values():
    values = {m.value for m in RunExecutionMode}
    assert values == _EXPECTED_EXECUTION_MODES


# T02: default Run carries trigger_type + execution_mode + starts QUEUED ──

def test_run_default_state_and_new_fields():
    run = Run(id="r1", conversation_id="c1")
    assert run.status == RunStatus.QUEUED
    assert run.trigger_type == RunTriggerType.MANUAL_RUN
    assert run.execution_mode == RunExecutionMode.SINGLE_AGENT


def test_run_accepts_explicit_trigger_and_mode():
    run = Run(id="r2", conversation_id="c1",
              trigger_type=RunTriggerType.GROUP_MESSAGE,
              execution_mode=RunExecutionMode.KANBAN_ORCHESTRATION)
    assert run.trigger_type == RunTriggerType.GROUP_MESSAGE
    assert run.execution_mode == RunExecutionMode.KANBAN_ORCHESTRATION


# T03: lifecycle happy path: queued -> routing -> submitting -> running -> succeeded

def test_run_happy_lifecycle():
    run = Run(id="r3", conversation_id="c1")
    assert run.status == RunStatus.QUEUED
    run.start_routing(); assert run.status == RunStatus.ROUTING
    run.submit(); assert run.status == RunStatus.SUBMITTING
    run.start_running(); assert run.status == RunStatus.RUNNING
    run.mark_succeeded(); assert run.status == RunStatus.SUCCEEDED
    assert run.is_terminal() is True
    assert run.is_runnable() is False


def test_run_wait_for_human_resume():
    run = Run(id="r4", conversation_id="c1")
    run.start_routing(); run.submit(); run.start_running()
    run.wait_for_human(); assert run.status == RunStatus.WAITING_HUMAN
    run.start_running(); assert run.status == RunStatus.RUNNING
    run.mark_succeeded(); assert run.status == RunStatus.SUCCEEDED


def test_run_failed_with_error():
    run = Run(id="r5", conversation_id="c1")
    run.start_routing(); run.submit(); run.start_running()
    run.mark_failed("boom")
    assert run.status == RunStatus.FAILED
    assert run.error == "boom"


def test_run_cancel_from_pre_terminal():
    run = Run(id="r6", conversation_id="c1")
    run.start_routing()
    run.cancel()
    assert run.status == RunStatus.CANCELLED
    assert run.is_terminal()


# T04: terminal states block double transitions ─────────────────────────

@pytest.mark.parametrize("terminal_op", ["mark_succeeded", "mark_failed", "cancel"])
def test_run_no_transition_from_terminal(terminal_op):
    run = Run(id="rt", conversation_id="c1")
    getattr(run, terminal_op)()
    assert run.is_terminal()
    with pytest.raises(ValueError):
        getattr(run, terminal_op)()


def test_run_invalid_transition_raises():
    run = Run(id="rx", conversation_id="c1")
    with pytest.raises(ValueError):
        run.start_running()  # cannot skip routing/submitting/cancel path


# T05: persistence round-trip via in-memory repo ────────────────────────

def test_run_repo_persists_trigger_and_mode():
    from agent_service.mainline.store import InMemoryRunRepository

    repo = InMemoryRunRepository()
    run = Run(id="rp", conversation_id="c1",
              trigger_type=RunTriggerType.SCHEDULED_JOB,
              execution_mode=RunExecutionMode.CRON_SINGLE_AGENT)
    repo.create(run)

    got = repo.get("rp")
    assert got.status == RunStatus.QUEUED
    assert got.trigger_type == RunTriggerType.SCHEDULED_JOB
    assert got.execution_mode == RunExecutionMode.CRON_SINGLE_AGENT

    run.start_routing(); run.submit(); run.start_running(); run.mark_succeeded()
    repo.update_status("rp", run)
    assert repo.get("rp").status == RunStatus.SUCCEEDED
    assert repo.get("rp").trigger_type == RunTriggerType.SCHEDULED_JOB
