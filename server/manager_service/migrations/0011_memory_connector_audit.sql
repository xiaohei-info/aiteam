-- 记忆条目 / 连接器操作 / 审计事件管理表（issue #265 功能补全）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 隔离硬约束同 0001：ENABLE + FORCE RLS、tenant_id 唯一来源 TenantContext（D22）、
-- app_rw 受约束角色。
--
-- 新增表：
--   memory_item — 员工记忆条目（B07）
--   connector_status — 连接器健康状态
--   connector_test — 连接器测试记录
--   connector_grant — 连接器→员工可见性授权
--   audit_event — 审计事件

-- ---- memory_item：员工记忆条目 ----
CREATE TABLE IF NOT EXISTS memory_item (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    employee_id   uuid NOT NULL,
    content       text NOT NULL,
    category      text NOT NULL DEFAULT 'preference',
    importance    integer NOT NULL DEFAULT 3 CHECK (importance >= 1 AND importance <= 5),
    source        text NOT NULL DEFAULT 'manual',
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_memory_item_employee ON memory_item(tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_memory_item_category ON memory_item(tenant_id, category);

-- ---- connector_status：连接器健康状态（每连接器一条，upsert 更新）----
CREATE TABLE IF NOT EXISTS connector_status (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    connector_id  text NOT NULL,
    status        text NOT NULL DEFAULT 'disconnected',
    last_check_at timestamptz NOT NULL DEFAULT now(),
    error_message text,
    CONSTRAINT uq_connector_status UNIQUE (tenant_id, connector_id)
);

-- ---- connector_test：连接器测试记录（追加，不覆盖）----
CREATE TABLE IF NOT EXISTS connector_test (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    connector_id  text NOT NULL,
    success       boolean NOT NULL DEFAULT false,
    latency_ms    integer NOT NULL DEFAULT 0,
    message       text NOT NULL DEFAULT '',
    tested_at     timestamptz NOT NULL DEFAULT now()
);

-- ---- connector_grant：连接器→员工可见性授权 ----
CREATE TABLE IF NOT EXISTS connector_grant (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    connector_id  text NOT NULL,
    employee_ids  uuid[] NOT NULL DEFAULT '{}',
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_connector_grant UNIQUE (tenant_id, connector_id)
);

-- ---- audit_event：审计事件 ----
CREATE TABLE IF NOT EXISTS audit_event (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    event_type    text NOT NULL,
    actor_id      uuid,
    target_type   text,
    target_id     uuid,
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_event(tenant_id, event_type);
CREATE INDEX IF NOT EXISTS idx_audit_event_target ON audit_event(tenant_id, target_type, target_id);

-- ---- RLS + 权限 ----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'memory_item', 'connector_status', 'connector_test',
        'connector_grant', 'audit_event'
    ]
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
