-- employee/expert 配置 + Pi 会话策略（M2，04 §6.1，D16）。
-- 幂等：可重复执行（IF NOT EXISTS / ALTER ... ADD COLUMN IF NOT EXISTS）。
--
-- 设计口径（D16）：employee 配置只存 Pi 会话中立字段
-- （persona/model/provider_ref/thinking_level/skills/...），**绝不**写底层执行器
-- 原生 profile。Manager 只产出配置真相，供 Agent 生成 Pi 会话快照。
--
-- 隔离硬约束（04 §6.1.1）：employee 表已有 RLS（0001 建立）；本迁移仅扩列，不动隔离策略。
--   - tenant_id 唯一来源是 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。
--   - version 单调递增，供增量 sync（F10 known_versions）与并发控制（02 §10.3.6）。

-- ---- employee 扩列：Pi 会话配置真相 ----
-- persona：中立 persona 文本（不写 SOUL.md）；model/provider_ref/thinking_level：中立模型策略。
-- tools/skills/knowledge_refs/connector_refs：能力引用，由 Agent 按授权装配。
-- memory_policy：记忆策略/种子（04 §6.6），由 Agent 按授权使用。
-- version：配置版本，供快照冻结（04 §6.3）与增量 pull。
ALTER TABLE employee ADD COLUMN IF NOT EXISTS persona          text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS model            text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS provider_ref     text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS thinking_level   text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS timeout_seconds  integer;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS tools            jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS skills           jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS knowledge_refs   jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS connector_refs   jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS memory_policy    jsonb;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS version          integer NOT NULL DEFAULT 1;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- 配置变更时刷新 updated_at（供增量 sync 比对）。
CREATE OR REPLACE FUNCTION employee_touch_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.version := COALESCE(OLD.version, 0) + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_employee_config_touch ON employee;
-- 仅在配置相关列被改写时推进 version + updated_at（tenant_id/employee_slug 调整不算配置变更）。
CREATE TRIGGER trg_employee_config_touch
BEFORE UPDATE OF persona, model, provider_ref, thinking_level,
                 timeout_seconds, tools, skills,
                 knowledge_refs, connector_refs, memory_policy
ON employee
FOR EACH ROW
EXECUTE FUNCTION employee_touch_updated_at();
