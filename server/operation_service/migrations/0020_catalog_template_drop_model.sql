-- 专家模板不再携带模型 / 思考档位（模型由企业在招募时选择）。
-- 清除存量模板 payload 中的 platform_model_ref 与 thinking_level；已招募员工的模型存在 Manager，不受影响。
UPDATE catalog_template
   SET payload = payload - 'platform_model_ref' - 'thinking_level'
 WHERE catalog_type = 'expert_template'
   AND (payload ? 'platform_model_ref' OR payload ? 'thinking_level');
