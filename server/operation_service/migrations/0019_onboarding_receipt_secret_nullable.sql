-- 开通 / 重置回执里的一次性 bootstrap 明文只保留 24 小时：到期后把密文清空，
-- 因此该列必须允许 NULL。回执本身（状态、响应体、幂等指纹）继续保留。
ALTER TABLE onboarding_receipt ALTER COLUMN bootstrap_secret_ciphertext DROP NOT NULL;
