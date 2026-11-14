-- R7 专家来源标识：recruited（市场招募）/ solution（应用方案）/ copied（复制）/ custom（企业自建）。
-- 存量回填只在列首次创建时执行一次，之后新增行由写入路径显式给出来源。
-- copied_from_employee_id 仅作溯源，不建外键：源专家被删除后复制品照常使用。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'employee' AND column_name = 'origin'
    ) THEN
        ALTER TABLE employee ADD COLUMN origin text NOT NULL DEFAULT 'recruited';
        UPDATE employee SET origin = 'custom' WHERE source_template_id IS NULL;
        UPDATE employee e SET origin = 'solution'
        FROM recruit_event r
        WHERE r.action = 'apply_solution'
          AND r.tenant_id = e.tenant_id
          AND e.id = ANY(r.target_employee_ids);
    END IF;
END $$;
-- 灰度修正（每次部署都可安全重跑）：迁移先于新代码上线，期间旧代码新建的自建专家拿到列默认值 recruited。
-- 新代码只在有来源模板时写 recruited，所以“recruited 且无来源模板”只可能来自这段时间。
UPDATE employee SET origin = 'custom' WHERE origin = 'recruited' AND source_template_id IS NULL;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS copied_from_employee_id uuid;
ALTER TABLE employee DROP CONSTRAINT IF EXISTS chk_employee_origin;
ALTER TABLE employee ADD CONSTRAINT chk_employee_origin
    CHECK (origin IN ('recruited', 'solution', 'copied', 'custom'));
