-- 010: 发布可见范围 — 系统侧专家模板/行业方案可选择发布给哪些企业。
-- publish_scope_json 语义：
--   {"mode":"all"}                                  全部企业可见（默认，保证存量数据不破坏）
--   {"mode":"selected","enterprise_ids":["e1",...]} 仅指定企业可见
-- 默认 all：现有 published 模板/方案对所有企业保持可见，向后兼容。

ALTER TABLE agent_template
    ADD COLUMN IF NOT EXISTS publish_scope_json JSONB NOT NULL DEFAULT '{"mode":"all"}'::jsonb;

ALTER TABLE industry_solution
    ADD COLUMN IF NOT EXISTS publish_scope_json JSONB NOT NULL DEFAULT '{"mode":"all"}'::jsonb;
