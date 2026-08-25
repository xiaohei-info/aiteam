---
created: 2026-08-25
status: active
scope: mandatory-production-closure
---

# AI Team 必须项收口计划

## 目标与边界

在不扩展可选产品功能的前提下，完成生产交付前的三项硬门槛：

1. 专家招募/私聊 E2E 使用独立 tenant/provider seed，不再以 skip 代替验收；
2. Manager 方案应用后的知识绑定具备幂等、失败可见、可重试/恢复语义，避免半成功状态；
3. 执行并固化最小生产发布闸门：固定版本、密钥边界、备份/恢复/回滚、健康检查和发布 smoke 有可重复证据。

## 非目标

- 不实现可选的 workflow Skill Operator UI；
- 不恢复方案级 knowledge_refs/裸 skill_refs 或旧 planner 编排；
- 不为满足测试而放宽 skip、授权或安全校验；
- 不引入分布式事务、消息总线或新的执行抽象。

## 实施步骤

1. **隔离 E2E**
   - 复核 `web/e2e/support/globalSetup.ts` 与 `seed-e2e-tenant.py` 的独立 seed 能力；
   - 为 taiyi/CI 提供不落库的 provider secret 注入方式；
   - 运行专家发布→provider 单匹配→招募→授权→sync→私聊 prompt 全链路；
   - 若仍失败，修复根因并补最小回归测试。

2. **知识绑定可靠性**
   - 以当前 `SolutionsPage` 的批量绑定流程为入口，定义一次应用的绑定 operation 结果；
   - 重试只调用现有幂等 binding API，不复制方案级知识配置；
   - 失败必须保留成功项、明确失败项，并能从 Manager 页面或受控接口恢复；
   - 补前端与 Manager API/服务测试，覆盖重复重试、撤权和跨租户拒绝。

3. **生产发布闸门**
   - 运行 `scripts/check-deploy.sh`、sandbox dry-run、LightRAG/NewAPI 运维 dry-run；
   - 在 taiyi 执行真实 health/readiness、前端 HTML、备份/恢复/回滚 smoke 所需证据；
   - 对仍未满足的闸门只做最小修复，不新增平台能力。

4. **独立验证与交付**
   - Python、Agent、web typecheck/unit/build；
   - 专家私聊 E2E、完整 cross-tier E2E、部署检查；
   - 更新路线图与本计划，记录 skip、外部依赖和残余风险。

## 完成标准

- 专家私聊用例在独立 seed 下通过，不依赖共享 tenant/provider；
- 方案知识绑定失败不会伪报全成功，重复操作可安全重试；
- 最小生产发布闸门有命令输出或 taiyi 实际 endpoint/日志证据；
- 所有变更已提交、推送，工作树干净；可选 UI 与非首发平台验证仍明确列为后续项。
