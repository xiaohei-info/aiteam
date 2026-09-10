-- Durable Operator F01 idempotency receipt.
-- The bootstrap secret is encrypted before persistence; Operator does not store a
-- plaintext or long-lived enterprise password.  Request body contains only the
-- original F01 input (no bootstrap secret) and is retained for safe resume.

CREATE TABLE IF NOT EXISTS onboarding_receipt (
    idempotency_key                 text PRIMARY KEY,
    request_fingerprint             text NOT NULL,
    state                           text NOT NULL DEFAULT 'prepared',
    request_body                    jsonb NOT NULL,
    enterprise_id                   uuid NOT NULL,
    tenant_id                       uuid NOT NULL,
    enterprise_name                 text NOT NULL,
    enterprise_code                 text,
    owner_phone                     text NOT NULL,
    bootstrap_secret_ciphertext     text NOT NULL,
    response_body                   jsonb,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    completed_at                    timestamptz,
    CONSTRAINT ck_onboarding_receipt_state CHECK (state IN ('prepared', 'completed'))
);

CREATE INDEX IF NOT EXISTS ix_onboarding_receipt_state_created
    ON onboarding_receipt (state, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON onboarding_receipt TO app_rw;
