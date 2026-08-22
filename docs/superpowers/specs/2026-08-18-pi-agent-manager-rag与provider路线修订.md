---
created: 2026-08-18
status: active-addendum
supersedes: docs/superpowers/specs/2026-08-17-pi-coding-agent-sdk-agent架构重构设计.md §9.1 及其本地知识 bundle 实施段落
---

# Pi Agent Manager RAG / Provider 路线修订

> 本文记录 2026-08-18 用户对当前实现方向的明确修订。与旧的“Agent pull knowledge bundle + 本地索引”方案冲突时，以本文为准。

## 1. Agent 职责边界

Agent 端只负责：

- Pi Session 生命周期；
- prompt / steer / follow-up / abort；
- Pi tool 执行和事件流；
- 本地会话、附件、workspace、sandbox；
- 通过受认证窄通道调用 Manager 能力。

Agent 不负责：

- 企业 RAG 索引或检索；
- 企业长期记忆存储或检索；
- Manager 的 provider/模型配置主数据；
- 企业知识文档主数据。

## 2. RAG 路线

知识检索由 Manager 处理，Agent 只提供 Pi custom tools 并转发请求：

```text
Pi Session
  → Agent knowledge_search / knowledge_get custom tool
  → Agent HttpManagerClient
  → Manager authenticated RAG facade
  → ManagerRagService
  → LightRAG(workspace = derive(tenant_id, knowledge_space_id))
  → citation/result
  → Agent Pi tool result
```

约束：

- Agent 请求不得传任意 LightRAG workspace；workspace 由 Manager `TenantContext` 和授权知识空间推导。
- Manager 必须根据当前 member、employee snapshot、employee knowledge binding 和 memory/knowledge policy 授权。
- Agent 不保存企业 knowledge index、bundle、citation corpus 或本地知识 artifact 作为真相。
- Manager 侧 query/search/get 失败时，Agent tool 明确返回 unavailable；不偷偷切换到本地企业知识索引。
- Agent→Manager 的 knowledge query 是本产品明确允许的能力调用例外；仍不得上传完整会话、Pi JSONL、raw runtime event 或附件正文。
- citation 返回只包含展示和继续 `knowledge_get` 所需的最小字段，不能泄漏 workspace、内部存储路径或跨 tenant 数据。

建议接口（具体 envelope 以 Manager OpenAPI 为准）：

```http
POST /api/manager/knowledge/search
GET  /api/manager/knowledge/citations/{citation_id}
```

或保留现有 artifact 路由前缀，但语义必须是 Manager RAG query，不得把 Agent bundle/local-index 当主路线。

## 3. Memory 路线

Memory 直接复用成熟的 Pi Hindsight Extension：

```text
Pi Session
  → @luxusai/pi-hindsight
  → Manager 部署的 Hindsight service
```

裁决：

- 固定 `@luxusai/pi-hindsight@0.12.0`；已实测可通过 `DefaultResourceLoader.extensionFactories` 注入 Pi SDK `0.84.2`。
- Extension 负责 context 前自动 recall、`agent_end` 后 retain、队列、flush、显式 recall/retain/reflect 工具；不再重写同类生命周期。
- Agent 不部署 Hindsight server，但可直接访问随 Manager 部署的 Hindsight endpoint。
- Manager 负责创建/授权 bank、memory policy、管理面 list/delete/disable/retention，并下发当前成员获授权的 Hindsight URL、bank ID 和 bank-scoped credential。
- 禁止向 Agent 下发能访问全部 tenant/bank 的全局 service token；若当前 self-hosted Hindsight 不支持 bank-scoped credential，先补 Manager 侧签发/鉴权层。
- Extension 只激活产品允许的工具；模型不能选择任意 bank。
- 完成 Extension 接入后，删除 Agent 自定义 `memory.ts` 和运行时 `ManagerClient.memoryRecall/memoryRetain` 主链；Manager 管理面 API 可继续保留。

## 4. Provider 配置

### 4.1 最终配置模型

Provider 真相在 Manager。删除 `mode=relay|direct`：对 AI Team 而言，官方 Provider、NewAPI 或未来自建中转站都只是不同的 `base_url` 和 credential。

保留多协议字段，因为未来中转站支持多种 API 协议：

```text
provider_ref
base_url
api_protocol          # Pi Api，例如 openai-completions / openai-responses / anthropic-messages
api_key               # Manager 加密保存
supported_models[]
visibility / allowed_member_ids[]
version
```

Employee model policy 只引用 `provider_ref + model + thinking_level`。未来内部中转站通过修改 `base_url/api_key/api_protocol` 接入，不增加新的 mode 分支。

### 4.2 当前实现缺口

当前代码：

- Manager 已实现 provider credential CRUD、Fernet 加密、成员可见性和 `provider_ref/model` snapshot；
- Agent `createConfiguredModelRuntime()` 仍只读取本地 `<agentDir>/auth.json`、`models.json`，或使用 `AITEAM_PI_FAKE=true`；
- Manager 尚未向 Agent 下发可执行的 `base_url/api_protocol/api_key/model`；
- 因此未手工配置本地 Pi auth/models 且未启用 faux 时，Agent **无法发起真实 LLM 请求**。

目标执行链：

```text
Agent 使用当前用户 token + employee_id 请求 runtime provider config
  → Manager 验证 tenant/member grant 和 fresh employee snapshot
  → Manager 从 snapshot 得到 provider_ref/model
  → Manager 解密该 provider 的 api_key
  → TLS 专用响应返回 base_url/api_protocol/api_key/model/version
  → Agent 注册 Pi provider/model
  → ModelRuntime.setRuntimeApiKey(providerId, apiKey)
  → Agent 发起 LLM 请求
```

约束：

- Agent 请求不能指定任意 credential_id；Manager 必须从已授权 employee snapshot 解析 provider_ref。
- secret 不进入普通 authorized-config/snapshot、SQLite、Pi Session、SSE、日志、trace 或 crash report。
- 本轮测试环境使用进程内 credential；Agent 重启后重新向 Manager 拉取，不写 `auth.json`。
- 非敏感 provider/model/version 可缓存；API key 只保存在进程内，替换或 shutdown 时清理。
- 同一 Agent 进程若允许多个 member 登录，Provider/ModelRuntime 必须按 tenant/member 隔离，不能共享一个 provider ID 的 runtime key。
- Manager 不代理普通 LLM prompt；Agent 直接请求配置中的 `base_url`。

### 4.3 taiyi 测试环境执行

- 关闭 `AITEAM_PI_FAKE`；
- 使用 Manager 中已配置的 NewAPI base URL、测试 key、`minimax-m3` 和对应 `api_protocol`；
- 验证 provider config pull → Pi ModelRuntime 注册 → 真实 prompt/stream/tool call；
- 扫描 Manager/Agent 日志、SQLite、Session JSONL 和 SSE，确认没有 API key。

## 5. 历史路线（已归档；不作为当前实现）

以下实现不再是目标路线，legacy local bundle 路径已删除且不保留兼容入口：

- `pullKnowledgeArtifacts` bundle 主链；
- Agent `knowledge_artifact` 企业知识真相；
- `SqliteKnowledgeIndex` 企业 RAG 检索；
- `Agent → localKnowledgeIndex` custom tool 闭包；
- `Manager → Agent bundle sync` 作为正常检索路径。

应替换为：

- `HttpManagerClient.knowledgeSearch/knowledgeGet`；
- ManagerRagService 的 tenant/member/employee 授权 query facade；
- Agent custom tools 只绑定 caller + employee snapshot，不能让模型传 knowledge_refs/workspace；
- Manager LightRAG query/get、citation ownership 和跨 tenant negative tests。
