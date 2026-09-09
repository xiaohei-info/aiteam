-- Keep Operator business repositories on the constrained app_rw role.
-- Migrations/signing-key loading continue to use ADMIN_DB_URL; runtime catalog,
-- enterprise, rollup and provider access must not require a superuser DSN.
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_provider TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_model TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_model_rate TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_provider_tenant_access TO app_rw;
