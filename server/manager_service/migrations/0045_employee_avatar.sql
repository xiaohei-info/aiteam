CREATE TABLE IF NOT EXISTS employee_avatar (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, employee_id uuid NOT NULL, storage_key text NOT NULL, avatar_url text NOT NULL, mime_type text NOT NULL, byte_size integer NOT NULL, sha256 text NOT NULL, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, CONSTRAINT uq_employee_avatar_tenant_employee UNIQUE (tenant_id, employee_id), CONSTRAINT ck_employee_avatar_mime CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')), CONSTRAINT ck_employee_avatar_size CHECK (byte_size > 0 AND byte_size <= 5242880)
);
CREATE INDEX IF NOT EXISTS idx_employee_avatar_tenant_employee ON employee_avatar (tenant_id, employee_id);
ALTER TABLE employee_avatar ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_avatar FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee_avatar;
CREATE POLICY tenant_isolation ON employee_avatar
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_avatar TO app_rw;
