-- Exact signed Operator principal/origin binding created by F01.
-- F02/F17 may target only this persisted pair; no wildcard or first-row fallback.

CREATE TABLE IF NOT EXISTS operator_tenant_binding (
    tenant_id       uuid PRIMARY KEY,
    enterprise_id   uuid NOT NULL UNIQUE,
    principal_kid   text NOT NULL,
    issuer          text NOT NULL,
    subject         text NOT NULL,
    audience        text NOT NULL,
    deployment_id   text NOT NULL,
    origin          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_operator_tenant_binding_principal
    ON operator_tenant_binding (principal_kid, deployment_id, origin);

-- This is a Manager control-plane table.  The service routes use ADMIN_DB_URL
-- for exact lookup/write; app_rw receives no access, preventing tenant data
-- paths from treating this registry as a user-visible fallback.
REVOKE ALL ON operator_tenant_binding FROM app_rw;
