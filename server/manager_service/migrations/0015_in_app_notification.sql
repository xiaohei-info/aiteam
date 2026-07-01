-- 运营通知企业的站内信存储 in_app_notification（F17，04 §6.1.1/D22，05 §5.1）。
-- 设计口径：
--   - Operator 经窄通道（ManagerGateway.notify_enterprise）把运营消息递给 Manager；
--     Manager 在租户上下文内写入本表（Operator 不写 Manager 租户库，红线）。
--   - tenant_id 唯一来源是 TenantContext；业务 SQL 不接受调用方手写 tenant 过滤。
--   - 站内信字段：org_id（运营端企业 id，关联展示）、message（正文）、notify_type/severity（分类）。
--   - D13：不承载会话/配置内容，仅运营侧管理消息。

CREATE TABLE IF NOT EXISTS in_app_notification (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    org_id          text NOT NULL,           -- 运营端企业 id（org_id）
    message         text NOT NULL,           -- 运营通知正文
    notify_type     text NOT NULL DEFAULT 'operation_announcement',
    severity        text NOT NULL DEFAULT 'info',  -- info | warning | critical
    read            boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_in_app_notification_tenant_created
    ON in_app_notification (tenant_id, created_at DESC);

-- ---- RLS：ENABLE + FORCE + 租户隔离策略（照 0008/0007 范式，04 §6.1.1）----
DO $$
BEGIN
    EXECUTE 'ALTER TABLE in_app_notification ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE in_app_notification FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON in_app_notification';
    EXECUTE
        'CREATE POLICY tenant_isolation ON in_app_notification '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
    EXECUTE 'GRANT SELECT, INSERT ON in_app_notification TO app_rw';
END
$$;
