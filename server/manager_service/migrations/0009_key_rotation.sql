-- tenant_signing_key：支持 key rotation（D23，03 §9.5）。
-- 幂等：可重复执行（IF NOT EXISTS / DO 块）。
--
-- 设计口径（D23，03 §9.5）：
--   - Manager 按 tenant 持私钥签发；用户端只持公钥/JWKS 验签，绝不下发私钥。
--   - 轮换时：生成新密钥对 → 旧密钥标记 retired_at → 新密钥 is_current=true。
--   - 宽限期（ROTATION_GRACE_SECONDS，默认 86400s/24h）内旧公钥留在 JWKS，保证
--     在用 token 平滑失效、不静默拒绝已登录会话。
--   - kid 格式："{tenant_id}:{version}"，version 单调递增。
--
-- 迁移策略（幂等 + 向后兼容）：
--   1. 修改现有 tenant_signing_key：tenant_id 改为非 PK 普通列，kid 变 PK。
--   2. 添加 is_current / version / retired_at 列（若已存在跳过）。
--   3. 为现有行填充默认值（is_current=true, version=1）。

-- ---- 添加新列（幂等）----
DO $$
BEGIN
    -- is_current: 标识当前签发密钥（每 tenant 只有一行为 true）
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='tenant_signing_key' AND column_name='is_current') THEN
        ALTER TABLE tenant_signing_key ADD COLUMN is_current boolean NOT NULL DEFAULT true;
    END IF;

    -- version: 密钥版本（用于生成 kid，单调递增）
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='tenant_signing_key' AND column_name='version') THEN
        ALTER TABLE tenant_signing_key ADD COLUMN version integer NOT NULL DEFAULT 1;
    END IF;

    -- retired_at: 密钥退役时间（NULL=仍有效；宽限期内旧公钥保留在 JWKS）
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='tenant_signing_key' AND column_name='retired_at') THEN
        ALTER TABLE tenant_signing_key ADD COLUMN retired_at timestamptz;
    END IF;
END
$$;

-- ---- 变更主键：tenant_id → kid（幂等）----
-- 原 PK 是 (tenant_id)，rotation 需要多行/tenant，kid 唯一即可。
DO $$
BEGIN
    -- 检查当前主键是否还是 tenant_id
    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'tenant_signing_key'::regclass
          AND c.contype = 'p'
          AND a.attname = 'tenant_id'
    ) THEN
        ALTER TABLE tenant_signing_key DROP CONSTRAINT tenant_signing_key_pkey;
        ALTER TABLE tenant_signing_key ADD PRIMARY KEY (kid);
        -- 为 tenant_id + is_current 建索引，方便按 tenant 快速定位当前签发密钥
        CREATE INDEX IF NOT EXISTS idx_tenant_signing_key_tenant_current
            ON tenant_signing_key (tenant_id, is_current);
    END IF;
END
$$;
