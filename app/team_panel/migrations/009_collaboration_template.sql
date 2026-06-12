-- 009: Enterprise collaboration (orchestration) prompt templates.
--
-- The group-chat orchestration planner/subtask/aggregate prompts were hardcoded
-- in agent_gateway/orchestration_executor.py. This table lets an enterprise
-- configure those prompt templates (with placeholders) from the admin UI; the
-- executor resolves the enterprise's default template at runtime and falls back
-- to the built-in defaults when none is configured.
--
-- Placeholders (rendered by agent_gateway/orchestration_templates.py):
--   planner_prompt   : {roster} {message_text} {max_subtasks}
--   subtask_prompt   : {message_text} {task_title} {task_desc} {dep_block}
--   aggregate_prompt : {message_text} {subtask_results}

CREATE TABLE IF NOT EXISTS collaboration_template (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '默认协作模板',
    planner_prompt TEXT NOT NULL DEFAULT '',
    subtask_prompt TEXT NOT NULL DEFAULT '',
    aggregate_prompt TEXT NOT NULL DEFAULT '',
    is_default BOOLEAN NOT NULL DEFAULT TRUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_collab_template_enterprise
    ON collaboration_template (enterprise_id);
