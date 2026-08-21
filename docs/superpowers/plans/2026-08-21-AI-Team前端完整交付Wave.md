---
created: 2026-08-21
status: active
scope: frontend-complete-wave
---

# AI Team 前端完整交付 Wave

## 目标

按 Demo.html 验收面和当前 v1/Pi 架构一次性收口三端前端，不再把“页面 shell/smoke”当成完整交付。

## 必须保留的边界

- Operation/Manager/Agent 只调用本端同源 API；
- Agent 不调用 LightRAG、Hindsight、Manager 业务 API 以外的跨端地址；
- Agent 企业知识只由 Pi MCP knowledge_search/knowledge_get 使用；
- 不恢复 runs/tasks/timeline/local enterprise knowledge 真相；
- 页面没有真实后端能力时显示明确 unavailable，不造假数据；
- 所有 destructive action 需要确认，所有 loading/error/empty/offline/unauthorized 状态可见。

## Wave 范围

### Operation

- 登录、企业开通、人才模板、行业方案、Rollup/治理页面真实数据；
- 注册/发布/详情/确认/错误状态；
- visual/a11y/keyboard/console gate。

### Manager

- members/departments/grants/providers/experts/marketplace/solutions/governance；
- Knowledge space/document intake、ready/failed/retry/reindex/binding；
- citation/source 状态，delete API 不存在时不显示假按钮；
- Provider/Hindsight/Skill/usage 管理边界；
- real data/empty/error/read-only projection。

### Agent

- workspace/private chat/group chat/delegation；
- Pi streaming/entries/tool/abort/attachments/skills/model controls；
- Office/Org/Marketplace/Usage/Sync；
- 删除 Agent-local knowledge 页面和废弃 endpoint；
- 仅通过当前 Agent API 和 Pi MCP；
- no localStorage truth、no old run/task/timeline。

## 验收

- web workspace typecheck/test/build 全通过；
- 三端 smoke 48 项全通过；
- cross-tier 55 项全通过；
- 各端 no-legacy/static endpoint gate 通过；
- Manager Knowledge 221 tests、Agent 现有 tests 不回归；
- taiyi latest static dist 部署后 Operation/Manager/Agent 页面 smoke 通过；
- 输出完整页面矩阵：已完成、明确 unavailable、尚未实现后端能力和生产残余风险。
