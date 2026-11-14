-- R3 发布范围：企业增加行业 / 标签；目录 visible_scope 统一为结构化形态。
ALTER TABLE enterprise_account ADD COLUMN IF NOT EXISTS industry text;
ALTER TABLE enterprise_account ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

-- main 上的“隐藏”（{"hidden": true}）保持不可见：先改成“暂不对任何企业开放”，再处理其余旧值。
UPDATE catalog_template
   SET visible_scope = '{"mode": "none"}'::jsonb
 WHERE jsonb_typeof(visible_scope) = 'object'
   AND NOT (visible_scope ? 'mode')
   AND visible_scope @> '{"hidden": true}'::jsonb;

-- 其余旧的空值 / 自由 JSON（无 mode）一律迁移为“全部企业可见”。
UPDATE catalog_template
   SET visible_scope = '{"mode": "all"}'::jsonb
 WHERE visible_scope IS NULL
    OR jsonb_typeof(visible_scope) <> 'object'
    OR NOT (visible_scope ? 'mode');
