-- 0012: employee 加 department_ids + admin_invite 加 display_name
-- 修复 org_service build_tree/update_assignment 和 settings_repository create_invite 的数据模型缺口。

ALTER TABLE employee ADD COLUMN IF NOT EXISTS department_ids text[] NOT NULL DEFAULT '{}';

ALTER TABLE admin_invite ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
