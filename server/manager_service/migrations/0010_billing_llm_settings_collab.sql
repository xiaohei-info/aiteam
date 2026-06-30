-- M-billing/LLM/settings/collaboration 管理表（v1 功能补全）。
-- 幂等：可重复执行（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DO 块）。
--
-- 隔离硬约束同 0001：ENABLE + FORCE RLS、tenant_id 唯一来源 TenantContext（D22）、
-- app_rw 受约束角色。
--
-- 新增表：
--   billing_balance — 租户账户余额（B09）
--   recharge_record — 充值记录（B09）
--   llm_provider — LLM Provider 配置（B01）
--   llm_model — LLM Model 配置（B01）
--   collaboration_template — 协作模板
--   enterprise_settings — 企业设置（B08）

-- ---- billing_balance：租户账户余额 ----
CREATE TABLE IF NOT EXISTS billing_balance (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    balance           numeric(18,6) NOT NULL DEFAULT 0,
    estimated_tokens  bigint NOT NULL DEFAULT 0,
    warning_threshold numeric(18,6) NOT NULL DEFAULT 50,
    reserved_tokens   bigint NOT NULL DEFAULT 0,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_billing_balance_tenant UNIQUE (tenant_id)
);

-- ---- recharge_record：充值记录 ----
CREATE TABLE IF NOT EXISTS recharge_record (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    amount          numeric(18,6) NOT NULL CHECK (amount > 0),
    payment_method  text NOT NULL,
    status          text NOT NULL DEFAULT 'pending',
    order_no        text NOT NULL,
    token_credited  integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---- llm_provider：LLM Provider 配置 ----
CREATE TABLE IF NOT EXISTS llm_provider (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    name         text NOT NULL,
    provider_key text NOT NULL,
    base_url     text,
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_llm_provider_key UNIQUE (tenant_id, provider_key)
);

-- ---- llm_model：LLM Model 配置 ----
CREATE TABLE IF NOT EXISTS llm_model (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    provider_id    uuid NOT NULL REFERENCES llm_provider(id) ON DELETE CASCADE,
    model_uid      text NOT NULL,
    model_name     text NOT NULL,
    context_window integer,
    input_price    text,
    output_price   text,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_llm_model_uid UNIQUE (tenant_id, provider_id, model_uid)
);

-- ---- collaboration_template：协作模板 ----
CREATE TABLE IF NOT EXISTS collaboration_template (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    config      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- enterprise_settings：企业设置 ----
CREATE TABLE IF NOT EXISTS enterprise_settings (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL,
    enterprise_name        text NOT NULL DEFAULT '',
    contact_email          text NOT NULL DEFAULT '',
    contact_phone          text NOT NULL DEFAULT '',
    logo_url               text,
    default_runtime        text NOT NULL DEFAULT 'hermes_acp',
    invite_required        boolean NOT NULL DEFAULT true,
    member_approval        boolean NOT NULL DEFAULT true,
    max_employees          integer NOT NULL DEFAULT 100,
    features               jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_enterprise_settings_tenant UNIQUE (tenant_id)
);

-- ---- 子管理员邀请 ----
CREATE TABLE IF NOT EXISTS admin_invite (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    email       text NOT NULL,
    roles       text[] NOT NULL DEFAULT '{}',
    status      text NOT NULL DEFAULT 'pending',
    created_by  uuid NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

-- ---- RLS + 权限 ----
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'billing_balance', 'recharge_record', 'llm_provider', 'llm_model',
        'collaboration_template', 'enterprise_settings', 'admin_invite'
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
