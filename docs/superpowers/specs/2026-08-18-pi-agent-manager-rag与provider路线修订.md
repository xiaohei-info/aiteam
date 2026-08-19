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

Memory 与 RAG 同属 Manager 能力面：

```text
Pi Session
  → Agent memory_recall / memory_retain / memory_delete custom tool
  → Agent HttpManagerClient
  → Manager memory facade
  → Hindsight
```

当前代码的 Manager Hindsight memory client/facade 方向正确，应保留；Agent 不部署本地 Hindsight，不暴露 bank id，不建立第二套本地长期 memory backend。

## 4. Provider 配置与 Relay

### 4.1 当前 Manager 配置流程

Provider 真相在 Manager：

1. owner/enterprise_admin 调用 `POST /api/manager/provider-credentials`；
2. 请求包含 `provider_ref`、`mode`（`relay`/`direct`）、`endpoint`、明文 `secret`、可见性和 supported models；
3. Manager 使用 `MANAGER_CREDENTIAL_KEY` 加密 secret 写入 `provider_credential`；
4. API 响应只返回 provider_ref、endpoint、mode、可见性、版本和模型能力，不返回明文或密文；
5. Employee model policy 只引用 `provider_ref + model`；
6. authorized-config/snapshot 只下发引用和非敏感模型策略。

当前代码已完成的是 1–6 的管理面和可见性控制；Agent runtime 的 provider credential pull/injection 尚未完成。

### 4.2 Relay 定义

Relay 是一个 OpenAI/Anthropic 兼容的模型出站服务：

```text
Agent Pi ModelRuntime → AI Relay → 实际 Provider/NewAPI
```

Manager 负责配置 Relay endpoint、企业级 token、provider_ref 和成员授权；Manager 本身不执行用户 prompt，也不代替 Agent 调用模型。默认模式下真实 provider key 留在 Relay，Agent 只拿受限 token。

当前仓库没有独立 Relay 服务实现；当前 `mode=relay` 只是 Manager 的配置语义和加密存储，不能宣称已经完成 Relay 执行链。

### 4.3 测试环境执行

本轮目标是 taiyi 测试部署与验证：

- 可以使用现有测试 provider/NewAPI 配置验证真实 Pi prompt；
- 测试 direct 或现有兼容 Relay 端点必须显式标为 test-only；
- 不能把测试环境的本地 `auth.json/models.json` 配置写成生产架构；
- 生产实现仍需完成 Manager 授权 → Agent secure store/短期 Relay token → Pi ModelRuntime 最小作用域注入；secret 不进入 Session、SSE、日志、SQLite 或 crash report。

## 5. 需要删除/替换的当前实现

以下当前实现不再是目标路线：

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
