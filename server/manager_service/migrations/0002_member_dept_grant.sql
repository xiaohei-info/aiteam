-- M1 成员/部门/角色 + member_grant 授权（issue #35；04 §6.1，03 §9.7，D12）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 落点（04 §6.1 所有权：企业端 Manager tenant data space）：
--   - department：部门（tenant 作用域）
--   - member_grant：成员级授权「专家/方案 → 授权部门/成员」映射（D12）
--   - app_user 扩展 department_ids：成员所属部门（角色经 app_user.roles，EnterpriseRole 枚举定义取值）
--
-- 隔离硬约束同 0001（ENABLE + FORCE RLS、业务唯一性带 tenant_id、app_rw 受约束角色）。

-- ---- app_user 扩展：成员所属部门（成员多属部门，存 department id 列表）----
-- roles 已存（EnterpriseRole 取值）；本字段表达成员→部门归属，供 member_grant 部门授权范围匹配。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'app_user' AND column_name = 'department_ids'
    ) THEN
        ALTER TABLE app_user ADD COLUMN department_ids text[] NOT NULL DEFAULT '{}';
    END IF;
END
$$;

-- ---- 部门（tenant 作用域）----
CREATE TABLE IF NOT EXISTS department (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    department_slug text NOT NULL,
    display_name  text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_department_slug UNIQUE (tenant_id, department_slug)
);

-- ---- 成员级授权（tenant 作用域，D12）----
-- 专家/方案 → 授权部门/成员。resource_type 取 expert|solution（对齐 MemberGrant 契约）。
-- 一个资源在该 tenant 内一条授权（聚合授权面），unique(tenant_id, resource_type, resource_id)。
CREATE TABLE IF NOT EXISTS member_grant (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    resource_type  text NOT NULL,
    resource_id    uuid NOT NULL,
    department_ids text[] NOT NULL DEFAULT '{}',
    member_ids     uuid[] NOT NULL DEFAULT '{}',
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_member_grant_resource UNIQUE (tenant_id, resource_type, resource_id),
    CONSTRAINT chk_member_grant_resource_type CHECK (resource_type IN ('expert', 'solution'))
);

-- ---- RLS：ENABLE + FORCE + 策略 + app_rw 授权（同 0001 口径）----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['department', 'member_grant']
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
