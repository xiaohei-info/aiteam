-- R3 发布范围：企业增加行业 / 标签；目录 visible_scope 统一为结构化形态。
ALTER TABLE enterprise_account ADD COLUMN IF NOT EXISTS industry text;
ALTER TABLE enterprise_account ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

-- 旧的空值 / 自由 JSON（无 mode）一律迁移为“全部企业可见”。
UPDATE catalog_template
   SET visible_scope = '{"mode": "all"}'::jsonb
 WHERE visible_scope IS NULL
    OR jsonb_typeof(visible_scope) <> 'object'
    OR NOT (visible_scope ? 'mode');
