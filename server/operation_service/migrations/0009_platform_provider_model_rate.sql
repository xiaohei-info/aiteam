-- Operator-owned platform Provider/model/rate and tenant Relay access truth (D18).
CREATE TABLE IF NOT EXISTS platform_provider (
    provider_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_code text NOT NULL UNIQUE,
    display_name text NOT NULL,
    relay_base_url text NOT NULL,
    api_protocol text NOT NULL CHECK (api_protocol IN ('openai-completions','openai-responses','anthropic-messages')),
    newapi_channel_id integer,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','disabled')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_model (
    provider_id uuid NOT NULL REFERENCES platform_provider(provider_id) ON DELETE CASCADE,
    model_id text NOT NULL,
    display_name text NOT NULL DEFAULT '',
    capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','disabled')),
    source text NOT NULL DEFAULT 'discovery' CHECK (source IN ('discovery','manual')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS platform_model_rate (
    rate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id uuid NOT NULL,
    model_id text NOT NULL,
    pricing_version integer NOT NULL CHECK (pricing_version > 0),
    pricing_status text NOT NULL CHECK (pricing_status IN ('known','unknown')),
    billing_mode text NOT NULL DEFAULT 'token' CHECK (billing_mode IN ('token','request')),
    input_usd_per_million numeric(20,6),
    output_usd_per_million numeric(20,6),
    cache_read_usd_per_million numeric(20,6),
    cache_write_usd_per_million numeric(20,6),
    request_usd numeric(20,6),
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    source text NOT NULL CHECK (source IN ('manual','provider','public_reference','unknown')),
    source_version text,
    effective_from timestamptz NOT NULL DEFAULT now(),
    effective_to timestamptz,
    manually_overridden boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (provider_id, model_id) REFERENCES platform_model(provider_id, model_id) ON DELETE CASCADE,
    UNIQUE (provider_id, model_id, pricing_version),
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_model_rate_active
ON platform_model_rate(provider_id, model_id) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS platform_provider_tenant_access (
    access_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    provider_id uuid NOT NULL REFERENCES platform_provider(provider_id) ON DELETE CASCADE,
    encrypted_token bytea NOT NULL,
    encrypted_management_token bytea NOT NULL,
    allowed_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    newapi_username text NOT NULL,
    newapi_user_id integer,
    newapi_token_id integer,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider_id)
);
