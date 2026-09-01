-- Operator-owned enterprise platform-model allow-list.
-- NULL means no explicit restriction (legacy/backward-compatible); [] means
-- the enterprise has explicitly closed every model. The entries are
-- PlatformModelRef JSON objects so provider/model versions remain auditable.
ALTER TABLE enterprise_account
    ADD COLUMN IF NOT EXISTS allowed_model_refs jsonb;
