-- employee/expert 配置 + prompt + runtime_binding（M2，06 §7.6 / 04 §6.1，D16）。
-- 幂等：可重复执行（IF NOT EXISTS / ALTER ... ADD COLUMN IF NOT EXISTS）。
--
-- 设计口径（06 §7.5/§7.6，D16）：employee 配置 **runtime 中立**——只存中立字段
-- （persona/model/provider_ref/thinking_level/runtime_binding/skills/...），**绝不**写 runtime
-- 原生 profile（旧 SOUL.md/MEMORY.md/skills 目录/config.yaml 直写废弃）。runtime 翻译由
-- 用户端 Driver 负责（06 §7.5.3）。Manager 只产出配置真相，供 M7 生成 EmployeeExecutionSnapshot。
--
-- 隔离硬约束（04 §6.1.1）：employee 表已有 RLS（0001 建立）；本迁移仅扩列，不动隔离策略。
--   - tenant_id 唯一来源是 TenantContext（D22），业务 SQL 不接受手写 tenant 过滤。
--   - version 单调递增，供增量 sync（F10 known_versions）与并发控制（02 §10.3.6）。

-- ---- employee 扩列：中立运行配置真相（runtime 无关）----
-- persona：中立 persona 文本（不写 SOUL.md）；model/provider_ref/thinking_level：中立模型策略。
-- runtime_binding：employee 默认 runtime（06 §7.6，如 hermes_acp / claude_code_json_stream），
--                  是中立标识，不含任何 runtime 启动参数（路径/参数归用户端 Driver，06 §7.3）。
-- tools/skills/knowledge_refs/connector_refs：能力引用（A 类能力，本地经 MCP 注入，06 §7.5.2）。
-- memory_policy：记忆策略/种子（04 §6.6，mem0），runtime 中立。
-- version：配置版本，供快照冻结（04 §6.3）与增量 pull。
ALTER TABLE employee ADD COLUMN IF NOT EXISTS persona          text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS model            text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS provider_ref     text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS thinking_level   text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS runtime_binding  text;
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
                 runtime_binding, timeout_seconds, tools, skills,
                 knowledge_refs, connector_refs, memory_policy
ON employee
FOR EACH ROW
EXECUTE FUNCTION employee_touch_updated_at();
