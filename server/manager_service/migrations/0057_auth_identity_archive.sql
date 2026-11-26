-- 企业注销 / 删除时归档该企业的登录身份（缺陷记录 2026-11-25「登录企业解析缺陷」）。
-- 归档身份不再参与「按账号解析企业」；企业恢复为其他状态时取消归档；保留期满 purge 时随租户数据删除。
-- 按企业标识登录仍能命中身份，从而给出「企业已注销 / 已删除」的明确提示。
ALTER TABLE auth_identity ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- 存量：已处于注销 / 删除状态的企业一次性补归档。
UPDATE auth_identity ai SET archived_at = COALESCE(tr.status_changed_at, now())
  FROM tenant_registry tr
 WHERE tr.tenant_id = ai.tenant_id AND tr.status IN ('closed', 'deleted') AND ai.archived_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_auth_identity_account_active
    ON auth_identity (external_id) WHERE archived_at IS NULL;
