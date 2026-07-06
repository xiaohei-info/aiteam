-- provider_credential 增加能力目录字段（AITEAM-681）：supported_models + model_catalog_source。
-- 幂等：ADD COLUMN IF NOT EXISTS + 触发器重建，可重复执行。
--
-- 设计口径：
--   - supported_models：非敏感能力目录（jsonb），记录该 provider 支持的模型清单
--     （model/display_name/enabled/capabilities），供后续招募按 model 自动匹配 provider_ref。
--   - model_catalog_source：能力目录来源（manual | discovery），为后续动态调用
--     provider /v1/models discovery 预留；本卡仅 manual。
--   - 两列均纳入 provider_credential_touch 触发器的 BEFORE UPDATE OF 清单，
--     保证能力变更推进 version（供增量 sync / 快照冻结）。

ALTER TABLE provider_credential
    ADD COLUMN IF NOT EXISTS supported_models jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE provider_credential
    ADD COLUMN IF NOT EXISTS model_catalog_source text NOT NULL DEFAULT 'manual';

-- 重建触发器：BEFORE UPDATE OF 纳入 supported_models, model_catalog_source，
-- 使能力目录变更同样推进 version（触发器函数本身只递增 version，无需改函数体）。
DROP TRIGGER IF EXISTS trg_provider_credential_touch ON provider_credential;
CREATE TRIGGER trg_provider_credential_touch
BEFORE UPDATE OF display_name, mode, endpoint, encrypted_secret,
                 visibility, allowed_member_ids,
                 supported_models, model_catalog_source
ON provider_credential
FOR EACH ROW
EXECUTE FUNCTION provider_credential_touch();
