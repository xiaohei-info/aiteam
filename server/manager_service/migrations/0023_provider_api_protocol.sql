-- Provider runtime protocol; mode=relay|direct is removed because endpoint+credential
-- already identify both official providers and compatible gateways.
ALTER TABLE provider_credential
    ADD COLUMN IF NOT EXISTS api_protocol text NOT NULL DEFAULT 'openai-completions';

DROP TRIGGER IF EXISTS trg_provider_credential_touch ON provider_credential;
ALTER TABLE provider_credential
    DROP CONSTRAINT IF EXISTS chk_provider_mode;
ALTER TABLE provider_credential
    DROP COLUMN IF EXISTS mode;

ALTER TABLE provider_credential
    DROP CONSTRAINT IF EXISTS chk_provider_api_protocol;
ALTER TABLE provider_credential
    ADD CONSTRAINT chk_provider_api_protocol
    CHECK (api_protocol IN ('openai-completions', 'openai-responses', 'anthropic-messages'));

CREATE TRIGGER trg_provider_credential_touch
BEFORE UPDATE OF display_name, endpoint, api_protocol, encrypted_secret,
                 visibility, allowed_member_ids,
                 supported_models, model_catalog_source
ON provider_credential
FOR EACH ROW
EXECUTE FUNCTION provider_credential_touch();
