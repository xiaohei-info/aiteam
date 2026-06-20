-- M6 招募专家 / 应用方案（issue #40；05 F06/F07；04 §6.1，D12）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 落点（04 §6.1 所有权：企业端 Manager tenant data space）：
--   - solution_instance：本 tenant 的方案实例（从 Operator 拉的方案包展开后的租户真相，
--     04 §6.1 表归属「企业端 Manager / solution_instance」）。
--   - recruit_event：招募/应用方案的审计事件（F06/F07 审计，企业审计口径，04 §6.1.3）。
--
-- 红线（05 F06/F07）：
--   - Operator 不写 Manager 库（本卡 Manager 单向拉，Operator 模板/方案真相只在 Operator 侧；
--     拉下来只读用，落本地 employee / solution_instance 实例，不改模板真相）。
--   - solution_instance 记录的是「本 tenant 展开后的方案实例真相」，不是模板副本的主数据源。
--   - tenant_id 唯一来源是 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。
--
-- 隔离硬约束（04 §6.1.1）：solution_instance / recruit_event 均 ENABLE + FORCE RLS，
-- 业务唯一性带 tenant_id，app_rw 受约束角色（非 superuser、非 BYPASSRLS、非表 owner）。

-- ---- 方案实例（tenant 作用域）----
-- 一个 (tenant_id, solution_id, solution_version) 唯一标识本 tenant 内的方案实例。
-- status 取 draft | applied | archived（初始 applied：拉下来即在本 tenant 展开完成）。
-- template_meta：从 Operator 拉到的方案包原样元信息（只读快照，不改模板真相）。
-- expert_employee_ids：本方案展开出的 employee 实例 id 列表（落 employee 表真相）。
-- knowledge_refs / skill_refs：方案包携带的知识/技能引用（展开后绑定给各 employee）。
-- default_grants_meta：方案包默认授权元信息（展开时按 D12 落 member_grant）。
CREATE TABLE IF NOT EXISTS solution_instance (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    solution_id         text NOT NULL,
    solution_version    text NOT NULL,
    display_name        text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'applied',
    expert_employee_ids uuid[] NOT NULL DEFAULT '{}',
    knowledge_refs      jsonb   NOT NULL DEFAULT '[]'::jsonb,
    skill_refs          jsonb   NOT NULL DEFAULT '[]'::jsonb,
    default_grants_meta jsonb,
    template_meta       jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_solution_instance UNIQUE (tenant_id, solution_id, solution_version),
    CONSTRAINT chk_solution_instance_status CHECK (status IN ('draft', 'applied', 'archived'))
);

-- ---- 招募/应用方案审计事件（tenant 作用域，F06/F07 审计）----
-- action 取 recruit_expert | apply_solution（F06 招募专家 / F07 应用方案）。
-- source_template_id / source_solution_id：Operator 侧模板/方案的只读来源标识（不改其真相）。
-- target_employee_ids / target_solution_instance_id：本 tenant 落地的实例真相。
-- detail：脱敏审计补充（不记会话内容；04 §6.1.3 审计日志口径）。
CREATE TABLE IF NOT EXISTS recruit_event (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL,
    action                   text NOT NULL,
    actor_user_id            uuid,
    source_template_id       text,
    source_template_version  text,
    source_solution_id       text,
    source_solution_version  text,
    target_employee_ids      uuid[] NOT NULL DEFAULT '{}',
    target_solution_instance_id uuid,
    detail                   jsonb,
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_recruit_event_action CHECK (action IN ('recruit_expert', 'apply_solution'))
);

-- ---- RLS：ENABLE + FORCE + 策略 + app_rw 授权（同 0001/0002 口径）----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['solution_instance', 'recruit_event']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
            t
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rw', t);
    END LOOP;
END
$$;
