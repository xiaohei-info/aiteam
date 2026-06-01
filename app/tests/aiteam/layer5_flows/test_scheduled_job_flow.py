"""L5 flow tests for the Loop / ScheduledJob closed-loop slice."""

from team_panel.application.commands.scheduled_job_service import (
    create_scheduled_job,
    create_scheduled_job_run,
)
from team_panel.integration.event_ingest_service import ingest_timeline_event


def test_scheduled_job_tick_success_updates_closed_loop(uow, clean_tables_with_enterprise):
    with uow:
        job_id = create_scheduled_job(
            uow,
            "ent_test",
            "emp_test",
            "0 9 * * *",
            {
                "name": "Daily Digest",
                "goal": "Summarize yesterday activity",
                "auto_enable": True,
                "max_consecutive_failures": 2,
            },
        )
        tick = create_scheduled_job_run(uow, job_id, "idem_l5_job_success_001")
        run_id = tick["run_id"]

        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_job_success_1",
                "enterprise_id": "ent_test",
                "run_id": run_id,
                "cursor_no": 1,
                "event_type": "run_succeeded",
                "source_type": "cron_job",
                "source_id": job_id,
                "employee_id": "emp_test",
                "event_ts": "2026-06-01T09:00:00Z",
                "preview_text": "Daily digest delivered.",
                "payload_json": {"summary": "Daily digest delivered."},
            },
        )

        run = uow.team_runs().get_by_id(run_id)
        job = uow.scheduled_jobs().get_by_id(job_id)
        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)

        assert run is not None
        assert run.status == "succeeded"
        assert run.trigger_type == "scheduled_job"
        assert run.execution_mode == "cron_single_agent"
        assert run.scheduled_job_id == job_id

        assert binding is not None
        assert binding.runtime_kind == "cron_job"
        assert binding.runtime_job_id == job_id
        assert binding.event_cursor == 1
        assert binding.sync_status == "synced"

        assert job is not None
        assert job.status == "enabled"
        assert job.runtime_job_id == job_id
        assert job.last_run_status == "succeeded"
        assert job.last_run_at.startswith("2026-06-01 09:00:00")
        assert job.last_success_at.startswith("2026-06-01 09:00:00")
        assert job.consecutive_failures == 0


def test_scheduled_job_tick_failures_reach_error_threshold(uow, clean_tables_with_enterprise):
    with uow:
        job_id = create_scheduled_job(
            uow,
            "ent_test",
            "emp_test",
            "*/15 * * * *",
            {
                "name": "Frequent Watcher",
                "goal": "Check upstream source",
                "auto_enable": True,
                "max_consecutive_failures": 2,
            },
        )

        first_tick = create_scheduled_job_run(uow, job_id, "idem_l5_job_fail_001")
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_job_fail_1",
                "enterprise_id": "ent_test",
                "run_id": first_tick["run_id"],
                "cursor_no": 1,
                "event_type": "run_failed",
                "source_type": "cron_job",
                "source_id": job_id,
                "employee_id": "emp_test",
                "event_ts": "2026-06-01T09:15:00Z",
                "preview_text": "First attempt failed.",
                "payload_json": {"error_code": "upstream_timeout", "error_message": "First attempt failed."},
            },
        )
        job = uow.scheduled_jobs().get_by_id(job_id)
        assert job is not None
        assert job.status == "enabled"
        assert job.last_run_status == "failed"
        assert job.last_run_at.startswith("2026-06-01 09:15:00")
        assert job.consecutive_failures == 1

        second_tick = create_scheduled_job_run(uow, job_id, "idem_l5_job_fail_002")
        ingest_timeline_event(
            uow,
            {
                "id": "evt_l5_job_fail_2",
                "enterprise_id": "ent_test",
                "run_id": second_tick["run_id"],
                "cursor_no": 1,
                "event_type": "run_failed",
                "source_type": "cron_job",
                "source_id": job_id,
                "employee_id": "emp_test",
                "event_ts": "2026-06-01T09:30:00Z",
                "preview_text": "Second attempt failed.",
                "payload_json": {"error_code": "upstream_timeout", "error_message": "Second attempt failed."},
            },
        )

        second_run = uow.team_runs().get_by_id(second_tick["run_id"])
        job = uow.scheduled_jobs().get_by_id(job_id)
        assert second_run is not None
        assert second_run.status == "failed"
        assert job is not None
        assert job.status == "error"
        assert job.last_run_status == "failed"
        assert job.last_run_at.startswith("2026-06-01 09:30:00")
        assert job.consecutive_failures == 2
