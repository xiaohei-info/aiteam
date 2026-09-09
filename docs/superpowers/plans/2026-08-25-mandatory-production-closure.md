---
created: 2026-08-25
status: completed-historical-snapshot
scope: mandatory-production-closure
---

# AI Team 必须项收口计划（历史快照）

> 本文记录 2026-08-25 的阶段性完成证据；其中 taiyi `56 passed`、生产 smoke 和基础闸门均不代表当前部署或当前 release。当前以 2026-09-07/08 Stage A/B 父控、最新 CI checkout SHA 与独立审查为准，未合并/未部署的工作树不得按本文宣称完成。

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

1. **隔离 E2E**（已完成）
   - `seed-e2e-tenant.py` 在 external seed 下读取已发布 Operator provider/model，生成版本化快照，并校验真实 Manager runtime-config；
   - 专家 E2E 更新为当前 `platform_model_ref` 契约，不再创建旧式 Manager provider；
   - 历史 taiyi external clean seed（2026-08-25）专家私聊 2/2 通过，完整 cross-tier `56 passed / 0 skipped`；provider secret 未写入仓库；不代表当前部署。

2. **知识绑定可靠性**（已完成最小生产闭环）
   - 批量绑定继续调用现有幂等 binding API，不复制方案级知识配置；
   - 网络/5xx/408/429 失败自动最多重试一次，4xx/授权/校验错误立即暴露；
   - 成功项保留，失败项明确列出，并可从 Manager Knowledge 页面重试；
   - 新增瞬态失败回归测试，Manager 前端全量 244 项测试通过。

3. **生产发布闸门**（基础闸门已完成）
   - `scripts/check-deploy.sh`、Agent sandbox dry-run、LightRAG/NewAPI 运维 dry-run 通过；
   - taiyi 三端 healthz 200，Linux bwrap/Landlock native matrix 12/12 通过；
   - fixed images、secret boundary、stale PID/process-group、launch guards 和 release smoke 均有验证；
   - 完整生产切换、真实灾备演练和轮换自动化仍属于部署窗口/后续运维，不伪称已完成。

4. **独立验证与交付**
   - Python、Agent、web typecheck/unit/build；
   - 专家私聊 E2E、完整 cross-tier E2E、部署检查；
   - 更新路线图与本计划，记录 skip、外部依赖和残余风险。

## 完成标准

- 专家私聊用例在独立 seed 下通过，不依赖共享 tenant/provider；
- 方案知识绑定失败不会伪报全成功，重复操作可安全重试；
- 最小生产发布闸门有命令输出或 taiyi 实际 endpoint/日志证据；
- 所有变更已提交、推送，工作树干净；可选 UI 与非首发平台验证仍明确列为后续项。
