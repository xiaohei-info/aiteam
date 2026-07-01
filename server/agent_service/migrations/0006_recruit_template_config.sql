-- AITEAM-288：Recruit 继承模板配置（skills/knowledge/connectors/model）。
-- loaded_expert_projections 新增模板能力配置列；存量行 ALTER TABLE ADD COLUMN 默认 NULL，
-- 由 _row_to_projection 走默认值（Pydantic Field default_factory）。

ALTER TABLE loaded_expert_projections ADD COLUMN persona             TEXT;
ALTER TABLE loaded_expert_projections ADD COLUMN model_policy        TEXT NOT NULL DEFAULT '{}';
ALTER TABLE loaded_expert_projections ADD COLUMN runtime_policy      TEXT NOT NULL DEFAULT '{}';
ALTER TABLE loaded_expert_projections ADD COLUMN tools               TEXT NOT NULL DEFAULT '[]';
ALTER TABLE loaded_expert_projections ADD COLUMN skills              TEXT NOT NULL DEFAULT '[]';
ALTER TABLE loaded_expert_projections ADD COLUMN knowledge_refs      TEXT NOT NULL DEFAULT '[]';
ALTER TABLE loaded_expert_projections ADD COLUMN connector_refs      TEXT NOT NULL DEFAULT '[]';
ALTER TABLE loaded_expert_projections ADD COLUMN memory_policy       TEXT;
