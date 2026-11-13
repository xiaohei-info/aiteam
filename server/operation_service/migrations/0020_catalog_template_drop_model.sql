-- 专家模板不再携带模型 / 思考档位（模型由企业在招募时选择）。
-- 清除存量模板 payload 中的 platform_model_ref 与 thinking_level；已招募员工的模型存在 Manager，不受影响。
-- deploy-compat: contract
-- 收缩型：上一版本的人才市场列表 / 拉取仍读取 platform_model_ref，所以本迁移必须在停应用之后执行，
-- 且启动失败不自动回滚。前置条件：企业端「招募时选模型」（R6）已先行上线。
UPDATE catalog_template
   SET payload = payload - 'platform_model_ref' - 'thinking_level'
 WHERE catalog_type = 'expert_template'
   AND (payload ? 'platform_model_ref' OR payload ? 'thinking_level');
