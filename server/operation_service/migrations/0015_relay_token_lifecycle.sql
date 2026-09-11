-- Durable Operator-side NewAPI relay credential lifecycle (S07 / D18).
-- Secrets stay in platform_provider_tenant_access.encrypted_*; these tables only
-- contain token identifiers, policy metadata, and bounded lifecycle receipts.

ALTER TABLE platform_provider_tenant_access
    ADD COLUMN IF NOT EXISTS policy_revision text NOT NULL DEFAULT '';

ALTER TABLE platform_provider_tenant_access
    ADD COLUMN IF NOT EXISTS encrypted_bootstrap_password bytea;

CREATE TABLE IF NOT EXISTS platform_provider_relay_token (
    lifecycle_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    provider_id uuid NOT NULL REFERENCES platform_provider(provider_id) ON DELETE CASCADE,
    newapi_user_id integer,
    newapi_token_id integer NOT NULL,
    token_name text NOT NULL DEFAULT '',
    allowed_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    expires_at timestamptz,
    policy_revision text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','unknown')),
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider_id, newapi_token_id)
);

CREATE INDEX IF NOT EXISTS ix_platform_provider_relay_token_scope
    ON platform_provider_relay_token (tenant_id, provider_id, created_at);

CREATE TABLE IF NOT EXISTS platform_provider_relay_token_operation (
    operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    provider_id uuid NOT NULL REFERENCES platform_provider(provider_id) ON DELETE CASCADE,
    newapi_user_id integer,
    newapi_token_id integer,
    token_name text NOT NULL DEFAULT '',
    operation_type text NOT NULL CHECK (operation_type IN ('bootstrap','issue','update','revoke','delete')),
    operation_key text NOT NULL UNIQUE,
    desired_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    desired_expires_at timestamptz,
    policy_revision text NOT NULL DEFAULT '',
    expected_access_version integer,
    expected_access_token_id integer,
    bootstrap_state text NOT NULL DEFAULT 'planned' CHECK (bootstrap_state IN ('planned','user_created','quota_pending','quota_applied','management_ready','completed')),
    quota_before bigint,
    quota_delta bigint,
    create_attempt_state text NOT NULL DEFAULT 'not_started' CHECK (create_attempt_state IN ('not_started','in_flight','unknown','observed','succeeded')),
    user_create_state text NOT NULL DEFAULT 'not_started' CHECK (user_create_state IN ('not_started','in_flight','unknown','observed','succeeded')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz DEFAULT now(),
    lease_until timestamptz,
    claim_owner text,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

ALTER TABLE platform_provider_relay_token_operation
    ADD COLUMN IF NOT EXISTS claim_owner text;
ALTER TABLE platform_provider_relay_token_operation
    ADD COLUMN IF NOT EXISTS expected_access_version integer;
ALTER TABLE platform_provider_relay_token_operation
    ADD COLUMN IF NOT EXISTS expected_access_token_id integer;
ALTER TABLE platform_provider_relay_token_operation
    ADD COLUMN IF NOT EXISTS bootstrap_state text NOT NULL DEFAULT 'planned';
ALTER TABLE platform_provider_relay_token_operation
    ADD COLUMN IF NOT EXISTS quota_before bigint;
ALTER TABLE platform_provider_relay_token_operation
    ADD COLUMN IF NOT EXISTS quota_delta bigint;
ALTER TABLE platform_provider_relay_token_operation
    ADD COLUMN IF NOT EXISTS create_attempt_state text NOT NULL DEFAULT 'not_started';
ALTER TABLE platform_provider_relay_token_operation
    ADD COLUMN IF NOT EXISTS user_create_state text NOT NULL DEFAULT 'not_started';

-- Replay-safe upgrade for a previously created partial version of this table.
DO $$
BEGIN
    -- A process can die after marking a receipt running but before writing
    -- its lease.  Make that row retryable instead of leaving it permanently
    -- invisible to the due-claim query.
    UPDATE platform_provider_relay_token_operation
       SET status='failed',
           next_attempt_at=now(),
           lease_until=NULL,
           claim_owner=NULL,
           last_error=COALESCE(last_error,'recovered running receipt without a lease'),
           updated_at=now()
     WHERE status='running' AND lease_until IS NULL;
    UPDATE platform_provider_relay_token_operation
       SET bootstrap_state='planned'
     WHERE bootstrap_state IS NULL;
    ALTER TABLE platform_provider_relay_token_operation
        ALTER COLUMN bootstrap_state SET DEFAULT 'planned';
    ALTER TABLE platform_provider_relay_token_operation
        ALTER COLUMN bootstrap_state SET NOT NULL;
    UPDATE platform_provider_relay_token_operation
       SET create_attempt_state='not_started'
     WHERE create_attempt_state IS NULL;
    UPDATE platform_provider_relay_token_operation
       SET user_create_state='not_started'
     WHERE user_create_state IS NULL;
    -- Pre-lifecycle receipts cannot prove whether their upstream write
    -- completed.  Conservatively route every retriable historical issue and
    -- bootstrap through deterministic reconciliation instead of another POST.
    UPDATE platform_provider_relay_token_operation
       SET create_attempt_state='unknown'
     WHERE operation_type='issue'
       AND create_attempt_state='not_started'
       AND (status IN ('running','failed') OR attempt_count > 0);
    UPDATE platform_provider_relay_token_operation
       SET user_create_state='unknown'
     WHERE operation_type='bootstrap'
       AND user_create_state='not_started'
       AND (status IN ('running','failed') OR attempt_count > 0
            OR bootstrap_state <> 'planned');
    ALTER TABLE platform_provider_relay_token_operation
        ALTER COLUMN create_attempt_state SET DEFAULT 'not_started';
    ALTER TABLE platform_provider_relay_token_operation
        ALTER COLUMN user_create_state SET DEFAULT 'not_started';
    ALTER TABLE platform_provider_relay_token_operation
        ALTER COLUMN create_attempt_state SET NOT NULL;
    ALTER TABLE platform_provider_relay_token_operation
        ALTER COLUMN user_create_state SET NOT NULL;
    ALTER TABLE platform_provider_relay_token_operation
        DROP CONSTRAINT IF EXISTS platform_provider_relay_token_operation_operation_type_check;
    ALTER TABLE platform_provider_relay_token_operation
        ADD CONSTRAINT platform_provider_relay_token_operation_operation_type_check
        CHECK (operation_type IN ('bootstrap','issue','update','revoke','delete'));
    ALTER TABLE platform_provider_relay_token_operation
        DROP CONSTRAINT IF EXISTS platform_provider_relay_token_operation_bootstrap_state_check;
    ALTER TABLE platform_provider_relay_token_operation
        ADD CONSTRAINT platform_provider_relay_token_operation_bootstrap_state_check
        CHECK (bootstrap_state IN ('planned','user_created','quota_pending','quota_applied','management_ready','completed'));
    ALTER TABLE platform_provider_relay_token_operation
        DROP CONSTRAINT IF EXISTS platform_provider_relay_token_operation_create_attempt_state_check;
    ALTER TABLE platform_provider_relay_token_operation
        ADD CONSTRAINT platform_provider_relay_token_operation_create_attempt_state_check
        CHECK (create_attempt_state IN ('not_started','in_flight','unknown','observed','succeeded'));
    ALTER TABLE platform_provider_relay_token_operation
        DROP CONSTRAINT IF EXISTS platform_provider_relay_token_operation_user_create_state_check;
    ALTER TABLE platform_provider_relay_token_operation
        ADD CONSTRAINT platform_provider_relay_token_operation_user_create_state_check
        CHECK (user_create_state IN ('not_started','in_flight','unknown','observed','succeeded'));
END
$$;

CREATE INDEX IF NOT EXISTS ix_platform_provider_relay_token_operation_due
    ON platform_provider_relay_token_operation (status, next_attempt_at, created_at);

-- Preserve already-observable token IDs when this migration is introduced.
-- Rows without an ID are intentionally omitted: there is no safe upstream
-- object to revoke by guessing a token name.
INSERT INTO platform_provider_relay_token (
    tenant_id, provider_id, newapi_user_id, newapi_token_id, allowed_model_ids,
    expires_at, policy_revision, status
)
SELECT tenant_id, provider_id, newapi_user_id, newapi_token_id, allowed_model_ids,
       expires_at, policy_revision, status
  FROM platform_provider_tenant_access
 WHERE newapi_token_id IS NOT NULL
 ON CONFLICT (tenant_id, provider_id, newapi_token_id) DO NOTHING;

-- Lifecycle history and receipts are append/update-only for app_rw;
-- destructive cleanup is an administrative migration concern.  Revoke the
-- privilege explicitly because this migration previously granted DELETE.
REVOKE DELETE ON platform_provider_relay_token FROM app_rw;
REVOKE DELETE ON platform_provider_relay_token_operation FROM app_rw;
GRANT SELECT, INSERT, UPDATE ON platform_provider_relay_token TO app_rw;
GRANT SELECT, INSERT, UPDATE ON platform_provider_relay_token_operation TO app_rw;
