"""L3 gateway tests for orchestration_executor pure planning/wave logic.

These cover the deterministic core (plan parsing, fallback, dependency
waves) without DB or WebUI loopback — the parts most prone to subtle bugs.
"""

from __future__ import annotations

from agent_gateway.orchestration_executor import (
    build_waves,
    fallback_plan,
    parse_plan,
)


TARGETS = ["emp_a", "emp_b", "emp_c"]


# ── parse_plan ─────────────────────────────────────────────────────────────

def test_parse_plan_well_formed():
    text = (
        '{"subtasks": ['
        '{"title": "调研", "description": "查资料", "assignee": "emp_a", "depends_on": []},'
        '{"title": "起草", "description": "写初稿", "assignee": "emp_b", "depends_on": [0]}'
        ']}'
    )
    plan = parse_plan(text, TARGETS)
    assert len(plan) == 2
    assert plan[0]["assignee"] == "emp_a"
    assert plan[1]["depends_on"] == [0]


def test_parse_plan_strips_code_fence():
    text = '```json\n{"subtasks": [{"title": "t", "assignee": "emp_a", "depends_on": []}]}\n```'
    plan = parse_plan(text, TARGETS)
    assert len(plan) == 1
    assert plan[0]["title"] == "t"


def test_parse_plan_reassigns_unknown_assignee():
    text = '{"subtasks": [{"title": "t", "assignee": "ghost", "depends_on": []}]}'
    plan = parse_plan(text, TARGETS)
    assert plan[0]["assignee"] in TARGETS


def test_parse_plan_drops_out_of_range_and_self_deps():
    text = (
        '{"subtasks": ['
        '{"title": "a", "assignee": "emp_a", "depends_on": [0, 5]},'  # self + OOR
        '{"title": "b", "assignee": "emp_b", "depends_on": [0]}'
        ']}'
    )
    plan = parse_plan(text, TARGETS)
    assert plan[0]["depends_on"] == []        # self-dep + OOR removed
    assert plan[1]["depends_on"] == [0]


def test_parse_plan_rejects_non_json():
    assert parse_plan("sorry I cannot do that", TARGETS) == []
    assert parse_plan("", TARGETS) == []
    assert parse_plan('{"subtasks": []}', TARGETS) == []


def test_parse_plan_caps_subtask_count():
    items = ",".join(
        f'{{"title": "t{i}", "assignee": "emp_a", "depends_on": []}}'
        for i in range(20)
    )
    plan = parse_plan(f'{{"subtasks": [{items}]}}', TARGETS)
    assert len(plan) <= 6  # MAX_SUBTASKS default


# ── fallback_plan ──────────────────────────────────────────────────────────

def test_fallback_plan_one_task_per_target():
    plan = fallback_plan(TARGETS, "写一篇报告")
    assert len(plan) == 3
    assert {t["assignee"] for t in plan} == set(TARGETS)
    assert all(t["depends_on"] == [] for t in plan)


# ── build_waves ────────────────────────────────────────────────────────────

def test_build_waves_linear_chain():
    subtasks = [
        {"depends_on": []},
        {"depends_on": [0]},
        {"depends_on": [1]},
    ]
    assert build_waves(subtasks) == [[0], [1], [2]]


def test_build_waves_parallel_first_wave():
    subtasks = [
        {"depends_on": []},
        {"depends_on": []},
        {"depends_on": [0, 1]},
    ]
    assert build_waves(subtasks) == [[0, 1], [2]]


def test_build_waves_cycle_does_not_hang():
    subtasks = [
        {"depends_on": [1]},
        {"depends_on": [0]},
    ]
    waves = build_waves(subtasks)
    # cycle → remaining flushed as final wave; every task scheduled exactly once
    scheduled = [i for wave in waves for i in wave]
    assert sorted(scheduled) == [0, 1]
