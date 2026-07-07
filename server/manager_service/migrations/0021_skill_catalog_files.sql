-- M2 技能真相持久化（issue #691；04 §6.6）：
--   files        ：技能文件列表（相对路径 + 内容 + sha16 内容指纹），jsonb；供 Agent skill_cache 投影。
--   content_hash ：包级内容指纹（SkillPackage.content_hash），供 Agent 按 version/hash 判定更新。
-- 与 0004 兼容：不破坏原有唯一约束/RPS/触发器，增量扩展。
ALTER TABLE skill_catalog
    ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS content_hash text NOT NULL DEFAULT '';

-- 更新触发器：files / content_hash 变化也递增 catalog_version（保持已知版本键单调）。
DROP TRIGGER IF EXISTS trg_skill_catalog_touch ON skill_catalog;
CREATE TRIGGER trg_skill_catalog_touch
BEFORE UPDATE OF display_name, version, install_policy, binding_policy, visibility, config, files, content_hash
ON skill_catalog
FOR EACH ROW
EXECUTE FUNCTION capability_catalog_touch();
