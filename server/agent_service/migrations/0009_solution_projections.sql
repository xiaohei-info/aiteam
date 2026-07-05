-- Local projection of applied solution instances (Agent side).
-- Source: Manager F10 authorized-config pull solutions[].
-- solution_instance_id = response.id (Manager instance id, NOT Operator template id).
-- expert_employee_ids = list of employee_ids composing this instance (roster filter).
CREATE TABLE IF NOT EXISTS solution_projections (
    solution_id         TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL DEFAULT '',
    version             TEXT NOT NULL DEFAULT '',
    expert_employee_ids TEXT NOT NULL DEFAULT '[]',
    template_solution_id TEXT NOT NULL DEFAULT '',
    planner_prompt      TEXT NOT NULL DEFAULT '',
    subtask_prompt      TEXT NOT NULL DEFAULT '',
    aggregate_prompt    TEXT NOT NULL DEFAULT ''
);
