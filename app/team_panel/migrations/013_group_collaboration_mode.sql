-- 013: 群聊协作模式 — 自由讨论 / 规则编排。
-- 设计本意（见《会话群聊编排Loop核心流程详细设计》）：
--   群聊默认由 system planner "自由讨论"式自行决定如何协作（free）。
--   新增"规则编排"（orchestrated）：用户在拉群时预先描述 planner 应如何组织
--   各 agent 协作，相当于给 planner 注入一段预设编排系统指令。
--
--   collaboration_mode : 'free'（默认，行为不变）| 'orchestrated'
--   orchestration_brief: 规则编排下用户填写的编排指令；free 模式恒为空串。
-- 存量会话 collaboration_mode='free' / orchestration_brief='' = 行为完全不变，向后兼容。

ALTER TABLE conversation
    ADD COLUMN IF NOT EXISTS collaboration_mode TEXT NOT NULL DEFAULT 'free'
        CHECK (collaboration_mode IN ('free', 'orchestrated'));

ALTER TABLE conversation
    ADD COLUMN IF NOT EXISTS orchestration_brief TEXT NOT NULL DEFAULT '';
