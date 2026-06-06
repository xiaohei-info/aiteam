-- 002: B08/B09 settings and billing control-plane tables

CREATE TABLE IF NOT EXISTS enterprise_settings (
    enterprise_id TEXT PRIMARY KEY REFERENCES enterprise(id) ON DELETE CASCADE,
    logo_url TEXT,
    contact_phone TEXT,
    contact_wechat TEXT,
    invite_code TEXT,
    help_doc_url TEXT,
    feedback_form_url TEXT,
    version_label TEXT,
    version_notes_url TEXT,
    notification_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE enterprise_settings ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE enterprise_settings ADD COLUMN IF NOT EXISTS contact_wechat TEXT;
ALTER TABLE enterprise_settings ADD COLUMN IF NOT EXISTS invite_code TEXT;
ALTER TABLE enterprise_settings ADD COLUMN IF NOT EXISTS help_doc_url TEXT;
ALTER TABLE enterprise_settings ADD COLUMN IF NOT EXISTS feedback_form_url TEXT;
ALTER TABLE enterprise_settings ADD COLUMN IF NOT EXISTS version_label TEXT;
ALTER TABLE enterprise_settings ADD COLUMN IF NOT EXISTS version_notes_url TEXT;
ALTER TABLE enterprise_settings ADD COLUMN IF NOT EXISTS notification_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE
    has_help_contact_url BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'enterprise_settings' AND column_name = 'help_contact_url'
    ) INTO has_help_contact_url;

    IF has_help_contact_url THEN
        EXECUTE $sql$
            UPDATE enterprise_settings
            SET help_doc_url = COALESCE(NULLIF(help_doc_url, ''), NULLIF(help_contact_url, ''), '/docs'),
                feedback_form_url = COALESCE(NULLIF(feedback_form_url, ''), '/support/feedback'),
                invite_code = COALESCE(NULLIF(invite_code, ''), 'INV-' || UPPER(RIGHT(enterprise_id, 6))),
                version_label = COALESCE(NULLIF(version_label, ''), 'MVP'),
                version_notes_url = COALESCE(NULLIF(version_notes_url, ''), '/docs/changelog')
            WHERE help_doc_url IS NULL
               OR help_doc_url = ''
               OR feedback_form_url IS NULL
               OR feedback_form_url = ''
               OR invite_code IS NULL
               OR invite_code = ''
               OR version_label IS NULL
               OR version_label = ''
               OR version_notes_url IS NULL
               OR version_notes_url = ''
        $sql$;
    ELSE
        UPDATE enterprise_settings
        SET help_doc_url = COALESCE(NULLIF(help_doc_url, ''), '/docs'),
            feedback_form_url = COALESCE(NULLIF(feedback_form_url, ''), '/support/feedback'),
            invite_code = COALESCE(NULLIF(invite_code, ''), 'INV-' || UPPER(RIGHT(enterprise_id, 6))),
            version_label = COALESCE(NULLIF(version_label, ''), 'MVP'),
            version_notes_url = COALESCE(NULLIF(version_notes_url, ''), '/docs/changelog')
        WHERE help_doc_url IS NULL
           OR help_doc_url = ''
           OR feedback_form_url IS NULL
           OR feedback_form_url = ''
           OR invite_code IS NULL
           OR invite_code = ''
           OR version_label IS NULL
           OR version_label = ''
           OR version_notes_url IS NULL
           OR version_notes_url = '';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'enterprise_settings' AND column_name = 'id'
    ) THEN
        EXECUTE 'ALTER TABLE enterprise_settings ALTER COLUMN id SET DEFAULT (''entset_'' || substr(md5(random()::text || clock_timestamp()::text), 1, 12))';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS admin_invite (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    invitee_phone TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','enterprise_admin','finance_admin','member')),
    permissions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    invite_code TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked','expired')) DEFAULT 'pending',
    idempotency_key TEXT,
    invited_by TEXT,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

ALTER TABLE admin_invite ADD COLUMN IF NOT EXISTS invitee_phone TEXT;
ALTER TABLE admin_invite ADD COLUMN IF NOT EXISTS permissions_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE admin_invite ADD COLUMN IF NOT EXISTS invite_code TEXT;
ALTER TABLE admin_invite ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE admin_invite ADD COLUMN IF NOT EXISTS invited_by TEXT;
ALTER TABLE admin_invite ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE admin_invite ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE admin_invite ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

DO $$
DECLARE
    has_email BOOLEAN;
    has_invite_token BOOLEAN;
    has_created_by BOOLEAN;
    phone_expr TEXT;
    invite_expr TEXT;
    invited_by_expr TEXT;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_invite' AND column_name = 'email'
    ) INTO has_email;

    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_invite' AND column_name = 'invite_token'
    ) INTO has_invite_token;

    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_invite' AND column_name = 'created_by'
    ) INTO has_created_by;

    phone_expr := CASE WHEN has_email
        THEN 'COALESCE(NULLIF(invitee_phone, ''''), NULLIF(email, ''''), '''')'
        ELSE 'COALESCE(NULLIF(invitee_phone, ''''), '''')'
    END;

    invite_expr := CASE WHEN has_invite_token
        THEN 'COALESCE(NULLIF(invite_code, ''''), NULLIF(invite_token, ''''), ''ADM-'' || UPPER(substr(md5(id), 1, 8)))'
        ELSE 'COALESCE(NULLIF(invite_code, ''''), ''ADM-'' || UPPER(substr(md5(id), 1, 8)))'
    END;

    invited_by_expr := CASE WHEN has_created_by
        THEN 'COALESCE(NULLIF(invited_by, ''''), created_by)'
        ELSE 'COALESCE(NULLIF(invited_by, ''''), ''team_panel'')'
    END;

    EXECUTE format(
        'UPDATE admin_invite
         SET invitee_phone = %s,
             invite_code = %s,
             invited_by = %s
         WHERE invitee_phone IS NULL
            OR invitee_phone = ''''
            OR invite_code IS NULL
            OR invite_code = ''''
            OR invited_by IS NULL',
        phone_expr,
        invite_expr,
        invited_by_expr
    );
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_invite' AND column_name = 'invite_token'
    ) THEN
        EXECUTE 'ALTER TABLE admin_invite ALTER COLUMN invite_token SET DEFAULT (''legacy_'' || substr(md5(random()::text || clock_timestamp()::text), 1, 20))';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_invite' AND column_name = 'email'
    ) THEN
        EXECUTE 'ALTER TABLE admin_invite ALTER COLUMN email SET DEFAULT ''''';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'admin_invite' AND column_name = 'expires_at'
    ) THEN
        EXECUTE 'ALTER TABLE admin_invite ALTER COLUMN expires_at SET DEFAULT (now() + interval ''30 days'')';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uk_admin_invite_enterprise_idempotency
    ON admin_invite(enterprise_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_invite_enterprise_created ON admin_invite(enterprise_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_invite_enterprise_status ON admin_invite(enterprise_id, status);

CREATE TABLE IF NOT EXISTS enterprise_billing_account (
    enterprise_id TEXT PRIMARY KEY REFERENCES enterprise(id) ON DELETE CASCADE,
    balance_cents BIGINT NOT NULL DEFAULT 0,
    token_balance BIGINT NOT NULL DEFAULT 0,
    low_balance_threshold_cents BIGINT NOT NULL DEFAULT 5000,
    warning_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE enterprise_billing_account ADD COLUMN IF NOT EXISTS balance_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE enterprise_billing_account ADD COLUMN IF NOT EXISTS token_balance BIGINT NOT NULL DEFAULT 0;
ALTER TABLE enterprise_billing_account ADD COLUMN IF NOT EXISTS low_balance_threshold_cents BIGINT NOT NULL DEFAULT 5000;
ALTER TABLE enterprise_billing_account ADD COLUMN IF NOT EXISTS warning_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE enterprise_billing_account ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE enterprise_billing_account ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS recharge_order (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    order_no TEXT NOT NULL UNIQUE,
    amount_cents BIGINT NOT NULL CHECK(amount_cents >= 100),
    payment_method TEXT NOT NULL CHECK(payment_method IN ('wechat_pay','alipay','bank_transfer','mock_pay')),
    status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','refunded')),
    token_credited BIGINT NOT NULL DEFAULT 0,
    idempotency_key TEXT,
    mock_provider BOOLEAN NOT NULL DEFAULT FALSE,
    provider_reference TEXT,
    failure_reason TEXT,
    created_by TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS enterprise_id TEXT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS order_no TEXT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS amount_cents BIGINT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS token_credited BIGINT NOT NULL DEFAULT 0;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS mock_provider BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS provider_reference TEXT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE recharge_order ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uk_recharge_order_enterprise_idempotency
    ON recharge_order(enterprise_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recharge_order_enterprise_created ON recharge_order(enterprise_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_order_enterprise_status ON recharge_order(enterprise_id, status);
