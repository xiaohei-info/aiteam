-- AITEAM-689 (M1): Run 记录绑定专家快照元数据。
-- 新增列允许一次 run 追溯所用的专家快照版本、服务专家、runtime、provider 引用与技能引用。
-- 全部可空/带默认，旧行回填安全（snapshot_source 默认 'none'，skill_refs 默认 '[]'）。

ALTER TABLE runs ADD COLUMN snapshot_version TEXT;
ALTER TABLE runs ADD COLUMN snapshot_source TEXT NOT NULL DEFAULT 'none';
ALTER TABLE runs ADD COLUMN employee_id TEXT;
ALTER TABLE runs ADD COLUMN runtime TEXT;
ALTER TABLE runs ADD COLUMN provider_ref TEXT;
ALTER TABLE runs ADD COLUMN skill_refs TEXT NOT NULL DEFAULT '[]';
