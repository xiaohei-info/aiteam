"""L5 flow tests for orchestration task-tree closeout stitching."""

from __future__ import annotations

import ast
import json

from team_panel.application.commands.orchestration_service import create_orchestration_run
from team_panel.integration.event_ingest_service import ingest_timeline_event
from team_panel.transactions.uow import UnitOfWork


def _create_orchestration_seed(db_conn) -> tuple[str, str, str]:
    with UnitOfWork(db_conn) as uow:
        result = create_orchestration_run(
            uow,
            "conv_test",
            {
                "title": "Root orchestration task",
                "description": "Coordinate closeout flow",
                "input": {"goal": "Close the orchestration tree"},
            },
            ["emp_test", "emp_member"],
            "emp_planner",
            idempotency_key=f"l5-orch-{id(db_conn)}-{uow.cur.connection.get_backend_pid()}",
        )
    return result["run_id"], result["root_team_task_id"], result["runtime_handle"]["task_id"]


def test_orchestration_task_tree_closeout_flow(db_conn, clean_tables_with_enterprise):
    run_id, root_team_task_id, root_runtime_task_id = _create_orchestration_seed(db_conn)

    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_task_created",
                "enterprise_id": "ent_test",
                "run_id": run_id,
                "cursor_no": 1,
                "event_type": "task_created",
                "source_type": "kanban_task",
                "source_id": "task_child_001",
                "employee_id": "emp_member",
                "preview_text": "Task placeholder from runtime",
                "payload_json": {},
            },
        )
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_task_started",
                "enterprise_id": "ent_test",
                "run_id": run_id,
                "cursor_no": 2,
                "event_type": "task_started",
                "source_type": "kanban_task",
                "source_id": "task_child_001",
                "employee_id": "emp_member",
                "event_ts": "2026-06-01T00:00:02Z",
                "preview_text": "Research in progress",
                "payload_json": {
                    "title": "Research the workflow state",
                    "description": "Inspect child cards and summarize blockers.",
                    "parent_task_id": root_runtime_task_id,
                    "phase": "worker",
                    "input": {"goal": "Summarize blockers"},
                },
            },
        )
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_task_completed",
                "enterprise_id": "ent_test",
                "run_id": run_id,
                "cursor_no": 3,
                "event_type": "task_completed",
                "source_type": "kanban_task",
                "source_id": "task_child_001",
                "employee_id": "emp_member",
                "event_ts": "2026-06-01T00:00:03Z",
                "preview_text": "Research finished",
                "payload_json": {
                    "parent_task_id": root_runtime_task_id,
                    "summary": "All child tasks reconciled.",
                },
            },
        )

    with UnitOfWork(db_conn) as uow:
        root_task = uow.team_tasks().get_by_id(root_team_task_id)
        child_task = uow.team_tasks().get_by_runtime_task_id(run_id, "task_child_001")

        assert root_task is not None
        assert child_task is not None
        assert child_task.parent_team_task_id == root_team_task_id
        assert child_task.depth == 1
        assert child_task.assignee_employee_id == "emp_member"
        assert child_task.status == "succeeded"
        assert child_task.title == "Research the workflow state"
        assert child_task.description == "Inspect child cards and summarize blockers."
        assert child_task.parent_team_task_id == root_team_task_id
        assert ast.literal_eval(child_task.input_payload_json or "{}") == {
            "summary": "All child tasks reconciled.",
            "parent_task_id": root_runtime_task_id,
        }
        assert child_task.started_at.startswith("2026-06-01 00:00:02")
        assert child_task.finished_at.startswith("2026-06-01 00:00:03")
        assert ast.literal_eval(child_task.output_summary_json or "{}") == {"summary": "Research finished"}


def test_task_events_are_idempotent_for_existing_runtime_task(db_conn, clean_tables_with_enterprise):
    run_id, _, root_runtime_task_id = _create_orchestration_seed(db_conn)

    event = {
        "id": "evt_l5_task_duplicate",
        "enterprise_id": "ent_test",
        "run_id": run_id,
        "cursor_no": 1,
        "event_type": "task_created",
        "source_type": "kanban_task",
        "source_id": "task_child_dup",
        "employee_id": "emp_member",
        "preview_text": "Duplicate-safe child",
        "payload_json": {
            "title": "Duplicate-safe child",
            "parent_task_id": root_runtime_task_id,
        },
    }

    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(uow, event)
    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(uow, event)

    with UnitOfWork(db_conn) as uow:
        tasks = uow.team_tasks().list_by_run(run_id)
        mirrored = [task for task in tasks if task.runtime_task_id == "task_child_dup"]
        assert len(mirrored) == 1
        assert mirrored[0].status == "queued"


def test_task_events_correct_existing_mirror_parent_depth_and_assignee(db_conn, clean_tables_with_enterprise):
    run_id, root_team_task_id, root_runtime_task_id = _create_orchestration_seed(db_conn)

    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_task_placeholder_parent",
                "enterprise_id": "ent_test",
                "run_id": run_id,
                "cursor_no": 1,
                "event_type": "task_created",
                "source_type": "kanban_task",
                "source_id": "task_placeholder_parent",
                "employee_id": "emp_planner",
                "preview_text": "Placeholder parent",
                "payload_json": {
                    "title": "Placeholder parent",
                    "parent_task_id": root_runtime_task_id,
                },
            },
        )
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_task_child_created_wrong",
                "enterprise_id": "ent_test",
                "run_id": run_id,
                "cursor_no": 2,
                "event_type": "task_created",
                "source_type": "kanban_task",
                "source_id": "task_child_corrected",
                "employee_id": "emp_planner",
                "preview_text": "Child placeholder",
                "payload_json": {
                    "title": "Child placeholder",
                    "parent_task_id": "task_placeholder_parent",
                },
            },
        )
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_task_child_started_corrected",
                "enterprise_id": "ent_test",
                "run_id": run_id,
                "cursor_no": 3,
                "event_type": "task_started",
                "source_type": "kanban_task",
                "source_id": "task_child_corrected",
                "event_ts": "2026-06-01T00:02:00Z",
                "preview_text": "Child running",
                "payload_json": {
                    "title": "Child corrected",
                    "parent_task_id": root_runtime_task_id,
                    "assignee_employee_id": "emp_member",
                },
            },
        )
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_task_child_completed_corrected",
                "enterprise_id": "ent_test",
                "run_id": run_id,
                "cursor_no": 4,
                "event_type": "task_completed",
                "source_type": "kanban_task",
                "source_id": "task_child_corrected",
                "event_ts": "2026-06-01T00:02:05Z",
                "preview_text": "Child done",
                "payload_json": {
                    "parent_task_id": root_runtime_task_id,
                    "employee_id": "emp_member",
                    "summary": "Corrected and persisted.",
                },
            },
        )

    with UnitOfWork(db_conn) as uow:
        placeholder_parent = uow.team_tasks().get_by_runtime_task_id(run_id, "task_placeholder_parent")
        child_task = uow.team_tasks().get_by_runtime_task_id(run_id, "task_child_corrected")

        assert placeholder_parent is not None
        assert child_task is not None
        assert child_task.parent_team_task_id == root_team_task_id
        assert child_task.parent_team_task_id != placeholder_parent.id
        assert child_task.depth == 1
        assert child_task.assignee_employee_id == "emp_member"
        assert child_task.status == "succeeded"
        assert child_task.title == "Child corrected"
        assert ast.literal_eval(child_task.input_payload_json or "{}") == {
            "employee_id": "emp_member",
            "parent_task_id": root_runtime_task_id,
            "summary": "Corrected and persisted.",
        }



def test_non_created_task_event_does_not_speculatively_create_mirror(db_conn, clean_tables_with_enterprise):
    run_id, _, root_runtime_task_id = _create_orchestration_seed(db_conn)

    with UnitOfWork(db_conn) as uow:
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_task_started_unknown",
                "enterprise_id": "ent_test",
                "run_id": run_id,
                "cursor_no": 1,
                "event_type": "task_started",
                "source_type": "kanban_task",
                "source_id": "task_unknown_001",
                "employee_id": "emp_member",
                "event_ts": "2026-06-01T00:01:00Z",
                "preview_text": "Unknown task start",
                "payload_json": {
                    "title": "Should not be created",
                    "description": "Unknown runtime task must be ignored.",
                    "parent_task_id": root_runtime_task_id,
                },
            },
        )

    with UnitOfWork(db_conn) as uow:
        assert uow.team_tasks().get_by_runtime_task_id(run_id, "task_unknown_001") is None
