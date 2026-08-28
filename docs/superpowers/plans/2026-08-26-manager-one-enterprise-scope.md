---
created: 2026-08-26
status: approved-by-current-request
scope: manager-one-enterprise
---

# Manager 单企业部署与双层知识隔离调整计划

## 已确认架构

- Operator 是平台级多企业服务，负责跨企业目录、开通、治理汇总。
- 一个 Manager 部署实例只服务一个企业；Manager 不在同一实例内承载多个企业的 RAG/知识空间。独立部署的账号库和数据库即为企业边界，不需要额外的运行时绑定配置。
- Manager 只保留两类能力隔离：
  1. 企业共享知识库（一个固定 LightRAG workspace）；
  2. 员工个人级长期记忆（Hindsight employee scope）。
- `tenant_id`/`enterprise_id` 在现有认证、审计和数据库契约中暂时保留作数据关联与兼容键；Manager 的独立数据库/账号库天然只属于部署所在企业，不增加额外的运行时部署绑定配置。

## 目标与非目标

### 目标

- 修订 canonical 设计口径，删除“Manager 同一服务多企业 + tenant_id + knowledge_space_id 多 workspace”作为目标部署形态的表述。
- Manager RAG 固定为当前企业唯一 `enterprise_shared`（部署可配置内部 ID）workspace；普通管理员不再创建/选择多个知识空间。
- 保留内部旧 `knowledge_space_id`/文档字段作为迁移兼容键，避免直接破坏现有 citation、binding 和 taiyi 数据；API/UI 不再把它作为产品概念暴露。
- Hindsight bank 改为企业内 employee-private scope：成员鉴权仍按当前成员执行，但 bank 数据范围不再按 member 拆分（除非后续另行裁决）。
- 企业知识页面改成单一“企业知识库”入口，继续通过 Manager-owned ingestion → LightRAG；员工授权只做访问控制，不复制文档。

### 非目标

- 本轮不把 Manager 所有业务表从 `tenant_id` 迁成另一套新 schema；不删除数据库 RLS，避免扩大迁移面。
- 本轮不实现员工个人文档 RAG；“员工个人级”先落实为 Hindsight 长期记忆。若个人文档也需要索引，另开独立设计，不能混入企业共享索引。
- 不恢复 Agent 本地企业知识库，不让浏览器/Agent 直连 LightRAG。
- 不做多 Manager 合并部署或跨企业数据迁移。

## 实施顺序

1. **设计口径**：新增本决策补充并更新 v1 00/03/04/05/09 关键段落；明确单企业 Manager、企业共享 RAG、employee-private Hindsight；账号库/独立数据库即为企业边界。
2. **RAG 内部固定空间**：增加 Manager enterprise knowledge identity/config，`ManagerRagService` 与 ingestion/query/MCP 只接受固定企业空间；legacy `knowledge_space_id` 仅作为内部兼容映射，未知空间 fail-closed。
3. **Manager API/UI 收口**：保留旧路径作为内部兼容，新增/调整单一企业知识查询与文档操作 seam；移除知识空间创建、删除、ID 输入和多空间选择，页面始终操作默认企业知识库；企业账号授权直接控制员工访问，不复制文档。
4. **个人记忆 scope**：Hindsight bank derivation 从 `(tenant, member, employee)` 收口为企业内 employee scope，同时保持 Agent 不传 bank_id、Manager lease/facade 授权边界；补旧 bank 兼容/迁移策略和负向测试。
5. **部署**：Manager 只需要一个固定 LightRAG endpoint/workspace；`LIGHTRAG_INSTANCES` 不再表达多企业路由，最多作为单企业高可用扩展；更新 taiyi/Compose/ctl 的变量边界与文档。
6. **验证**：Server RAG/MCP/Hindsight/knowledge tests、Manager Web tests/typecheck/build、OpenAPI、真实 taiyi 企业文档 ready/citation 与 employee memory 隔离 smoke；保留此前 Agent/其他未提交改动。

## 当前实现进度与剩余项

已完成 Manager 侧固定企业 RAG、企业知识库单一 UI、employee-private Hindsight bank、配置与文档口径、以及 taiyi smoke。Operator 仍只有一个静态 `MANAGER_URL` gateway；多企业正式运营前需要独立的企业→Manager deployment registry/route，这属于 Operator 部署编排，不在本轮 Manager 内部增加额外绑定配置。

## 完成标准

- Manager 页面只展示一个“企业知识库”，上传/URL ingestion 不要求管理员填写空间 ID；不额外要求企业绑定配置。
- LightRAG workspace 不接受请求传入或切换；Manager 进程只路由部署配置的固定企业 workspace。
- 同一企业不同员工的 Hindsight 个人记忆不能互读；不同成员对同一 employee 的 scope 行为符合 employee-private 裁决。
- 旧已存在的 `knowledge_space_id`/citation/binding 数据不因本轮发布直接失效，或有明确一次性兼容映射；旧 member-derived Hindsight bank 在现有环境切换前必须按 Hindsight runbook 显式迁移。
- 不出现 Agent/浏览器直连 LightRAG、跨企业 RAG、或把 employee-private memory 混入 enterprise KB 的路径。
