-- 0027: 直接招募专家的模板来源与租户内防重。
-- 方案展开的 employee 不写 source_template_id，因此不占用直接招募名额。

ALTER TABLE employee
    ADD COLUMN IF NOT EXISTS source_template_id text,
    ADD COLUMN IF NOT EXISTS source_template_version text;

-- 兼容已存在的直接招募数据。若历史上已有重复，只标记一个存活实例，
-- 从而阻止继续重复，同时不让迁移因旧数据失败。
WITH direct_recruits AS (
    SELECT
        r.tenant_id,
        r.source_template_id,
        r.source_template_version,
        ids.employee_id,
        row_number() OVER (
            PARTITION BY r.tenant_id, r.source_template_id
            ORDER BY (e.status = 'archived'), r.created_at DESC, r.id DESC
        ) AS rank
    FROM recruit_event r
    CROSS JOIN LATERAL unnest(r.target_employee_ids) AS ids(employee_id)
    JOIN employee e ON e.id = ids.employee_id
    WHERE r.action = 'recruit_expert'
      AND r.source_template_id IS NOT NULL
)
UPDATE employee e
SET source_template_id = r.source_template_id,
    source_template_version = r.source_template_version
FROM direct_recruits r
WHERE r.rank = 1
  AND e.id = r.employee_id
  AND e.tenant_id = r.tenant_id
  AND e.source_template_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_live_direct_template
    ON employee (tenant_id, source_template_id)
    WHERE source_template_id IS NOT NULL AND status <> 'archived';
