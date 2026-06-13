-- 011: 行业方案自带协作编排规则。
-- 设计本意（见《会话群聊编排Loop核心流程详细设计》《技术详细设计》）：
--   "行业方案自带协作模板"、IndustrySolution{..., 默认协作模板}。
-- 系统后台创建方案时定下 planner/subtask/aggregate 三段编排提示词；方案 apply
-- 时下发到企业级 collaboration_template（运行时读取来源不变）。企业只用不管。
--
-- 三段语义与 collaboration_template 一致：
--   planner_prompt   : {roster} {message_text} {max_subtasks}
--   subtask_prompt   : {message_text} {task_title} {task_desc} {dep_block}
--   aggregate_prompt : {message_text} {subtask_results}
-- 留空表示该段回退到运行时内置默认模板，向后兼容（存量方案三段为空 = 行为不变）。

ALTER TABLE industry_solution
    ADD COLUMN IF NOT EXISTS planner_prompt TEXT NOT NULL DEFAULT '';

ALTER TABLE industry_solution
    ADD COLUMN IF NOT EXISTS subtask_prompt TEXT NOT NULL DEFAULT '';

ALTER TABLE industry_solution
    ADD COLUMN IF NOT EXISTS aggregate_prompt TEXT NOT NULL DEFAULT '';
