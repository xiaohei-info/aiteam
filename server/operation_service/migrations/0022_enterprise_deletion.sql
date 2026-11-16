-- R5 企业删除：closed → deleting → deleted（30 天保留期内可恢复为 closed），之后清理并匿名化。
ALTER TABLE enterprise_account ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE enterprise_account ADD COLUMN IF NOT EXISTS purged_at timestamptz;
ALTER TABLE enterprise_account DROP CONSTRAINT IF EXISTS ck_enterprise_account_operation_status;
ALTER TABLE enterprise_account ADD CONSTRAINT ck_enterprise_account_operation_status
    CHECK (operation_status IN ('active','suspended','banned','closed','deleting','deleted'));
