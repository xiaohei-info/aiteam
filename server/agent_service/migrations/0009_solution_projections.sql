-- 方案实例本地投影（来源：Manager F10 authorized config pull 的 solutions[]）。
-- 供 Agent 端"从解决方案创建群聊"入口使用——列出本端已可用的方案实例 + prompts 快照。

CREATE TABLE IF NOT EXISTS solution_projections (
    solution_id         TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL DEFAULT '',
    version             TEXT NOT NULL DEFAULT '',
    planner_prompt      TEXT NOT NULL DEFAULT '',
    subtask_prompt      TEXT NOT NULL DEFAULT '',
    aggregate_prompt    TEXT NOT NULL DEFAULT ''
);
