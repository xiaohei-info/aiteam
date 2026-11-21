-- 0025: 平台自建技能（设计 2026-11-20 §4.7）。幂等：每次部署都会重跑。
-- source=custom：运营端上传（文件夹 / zip / .md）、粘贴 SKILL.md、网址或在线编辑的技能；
-- external_owner 固定为 'platform'，external_slug 为 SKILL.md 的 name。ClawHub 技能仍为 source=clawhub。
-- 每次保存都是新的不可变版本（platform_skill_version），企业端按版本看到「可更新」。

ALTER TABLE platform_skill DROP CONSTRAINT IF EXISTS chk_platform_skill_source;
ALTER TABLE platform_skill ADD CONSTRAINT chk_platform_skill_source CHECK (source IN ('clawhub', 'custom'));
