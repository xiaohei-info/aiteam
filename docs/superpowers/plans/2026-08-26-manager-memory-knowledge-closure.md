---
created: 2026-08-26
status: superseded-by-stage-b
scope: manager-memory-knowledge
---

# Manager 记忆与企业知识库闭环计划（历史）

> 2026-09-07 Stage A/B 已覆盖本计划的固定单企业/workspace 假设。当前 Manager 按 JWT/TenantContext 服务多个 tenant，每个 tenant 一个持久化映射的共享 workspace；保留本文的 Hindsight facade、权限、intake 有界失败语义，不按旧产品空间创建语义实施。

## 目标

按 v1/PI-native 口径补齐 Manager 两个可用管理面：

1. 记忆条目管理通过 Manager Hindsight facade 提供按员工授权的 list/create/update/delete，不建立第二个本地 memory backend。
2. 企业知识库页面在 Manager 导航可见，上传文件/URL 后经 Manager-owned intake 推送 LightRAG，展示空间、文档、索引状态和绑定。

## 当前缺口

- `routes_memory_items.py` 只有 `/recall`、`/retain` 和带 employee query 的 DELETE，没有前端使用的 collection GET/POST/PATCH 契约；Hindsight transport 也没有 list/update。
- `web/manager` 已有 MemoryPage 与 KnowledgePage，但 MemoryPage 调用缺失的 collection route，KnowledgePage 没有加入 shell 导航。
- LightRAG ingestion 已存在且必须继续保持 Manager 推导 workspace、Manager-only credential、ready/failed 状态机；不新增浏览器直连 LightRAG。

## 实施步骤

1. 扩展 Hindsight client/service：增加受 employee snapshot 授权的 list/update，规范化 Hindsight memory unit 为 Manager 安全出参；保留现有 Agent recall/retain/delete facade 兼容。
2. 增加 Manager collection GET/POST/PATCH 路由，修正前端 delete 的 employee scope；前端增加员工筛选并使用真实 collection contract。
3. 将 `/knowledge` 加入 Manager shell 导航，保持现有文件/URL intake、LightRAG indexing、retry/reindex/delete/reconcile 与 binding 流程，不暴露 workspace 或 LightRAG endpoint。
4. 补充后端路由/transport、前端 MemoryPage/shell/Knowledge 导航回归测试；执行 typecheck、Manager 测试、构建与 taiyi API/UI smoke。

## 完成标准

- `GET /api/manager/memories?employee_id=...` 返回 Hindsight 条目 envelope，未授权员工 fail-closed；创建/编辑/删除走同一 Manager facade。
- Manager 侧栏可进入“知识库”，可读取当前 tenant 唯一空间、上传文件/导入 URL，并看到 indexing/ready/failed 状态；不会由浏览器直连 LightRAG。
- 相关 server/web 测试、typecheck/build 通过；taiyi Manager OpenAPI、记忆接口和知识库页面/文档 intake 获得实际验证。
