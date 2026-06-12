-- 008: Enterprise-level LLM provider/model configuration catalog.
--
-- DB is the single source of truth for which LLM providers + models an
-- enterprise has configured. The Gateway materializes these into the Hermes
-- root config.yaml (one-way DB -> config.yaml) so runtime profiles inherit
-- the provider credentials. Employees pick a model from enterprise_llm_model.

CREATE TABLE IF NOT EXISTS enterprise_llm_provider (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    provider_key TEXT NOT NULL,          -- config.yaml providers.<key> (ASCII slug)
    display_name TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL DEFAULT 'openai_chat',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL DEFAULT '',
    UNIQUE (enterprise_id, provider_key)
);

CREATE INDEX IF NOT EXISTS idx_llm_provider_enterprise
    ON enterprise_llm_provider (enterprise_id);

CREATE TABLE IF NOT EXISTS enterprise_llm_model (
    id TEXT PRIMARY KEY,
    enterprise_id TEXT NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL REFERENCES enterprise_llm_provider(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,              -- model identifier sent to the provider
    label TEXT NOT NULL DEFAULT '',
    context_length INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_llm_model_enterprise
    ON enterprise_llm_model (enterprise_id);
CREATE INDEX IF NOT EXISTS idx_llm_model_provider
    ON enterprise_llm_model (provider_id);
