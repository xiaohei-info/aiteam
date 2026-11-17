-- 方案类型与群聊编排（2026-11-17）。幂等：可重复执行。
-- mode：solo（单人，1 位专家，不建群）/ group（组群）。旧实例按 group 处理（与旧行为一致）。
-- orchestration_rules：群聊编排规则（collaboration-markdown-v1），成员引用已在应用时换成本 tenant 的 employee_id。
-- recommended_capabilities：方案推荐的 skill / MCP（非强制提示，不绑定专家，不参与授权）。
ALTER TABLE solution_instance
    ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'group' CHECK (mode IN ('solo', 'group')),
    ADD COLUMN IF NOT EXISTS orchestration_rules text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS recommended_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb;
