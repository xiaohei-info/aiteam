---
created: 2026-08-19
status: design-supplement
implementation: deferred-by-user
scope: aiteam-rag
---

# AI Team RAG 详细设计

> 本文是 AI Team Pi 重构后的 RAG 详细设计补充。当前 RAG/MCP 实现按用户要求暂缓，本文只冻结数据模型、授权边界、部署和读写流程，后续恢复开发时以本文为设计输入。
>
> 本文不修改冻结的 `app/`、`./.hermes/hermes-agent/`，也不迁移旧库/旧知识数据。

## 0. 结论摘要

### 0.1 LightRAG 自己有认证，但没有 AI Team 业务授权模型

LightRAG Server 原生提供：

- `LIGHTRAG_API_KEY` + `X-API-Key`；
- 可选 `AUTH_ACCOUNTS` + JWT 登录；
- `WHITELIST_PATHS` 路径免认证；
- `WORKSPACE` 逻辑命名空间；
- 不同 KV/vector/graph/doc-status 存储后端。

这些能力解决的是 **LightRAG 服务入口认证和存储命名空间**，不等价于 AI Team 的：

- tenant/member/employee 身份；
- member grant；
- employee snapshot；
- knowledge_space / document binding；
- 部门/方案/成员级可见性；
- 撤权后的查询失效；
- citation 是否属于当前员工授权范围。

因此，业务授权必须由 AI Team 的 Manager/Manager-owned RAG capability 层负责。LightRAG 只能作为 Manager 持有的 RAG 引擎，不能成为 AI Team 的权限真相源。

### 0.2 企业共享知识库不需要复制给每个用户

同一个 tenant 内建立一个企业共享知识空间并索引一次：

```text
tenant A / enterprise_shared
  ├─ employee 1 可读
  ├─ employee 2 可读
  ├─ member 3 可读
  └─ finance department 可读
```

Manager 通过 binding/grant 控制谁可以查询同一个 workspace。不同 tenant 永远不能共用同一个企业 workspace。

### 0.3 当前目标路线

RAG 路线后续可采用 Agent 直连 MCP，但不能把原始 LightRAG Server 直接暴露给 Agent：

```text
Agent Pi
  → 受控 MCP Client / Pi MCP adapter
  → Manager-owned RAG MCP facade（只读、按 capability 授权）
  → LightRAG REST/API
```

Manager-owned MCP facade 不是第二套业务 RAG；它只是把 LightRAG 的 query/data 能力包装成受控 MCP 工具，负责身份、workspace、工具白名单和 citation 授权。

本轮暂不实现该链路。

---

## 1. 设计目标与非目标

### 1.1 目标

1. Manager 是企业知识源、知识空间、索引状态和授权绑定的业务真相源。
2. LightRAG 负责解析、切块、embedding、图谱构建和检索。
3. Agent/Pi 只消费当前员工授权的只读检索能力，不写企业知识主数据。
4. 企业共享知识只索引一次，多成员/多员工按授权复用。
5. query 结果必须带最小 citation/provenance，且不能泄漏跨 tenant 数据。
6. RAG 不把普通会话、Pi Session JSONL、raw runtime event 上传 Manager。
7. RAG query 和 memory 操作是显式的能力调用窄通道，不等同于普通会话上传。

### 1.2 非目标

- 不在 Agent SQLite 建立企业知识索引真相。
- 不在 Agent 本地复制完整企业文档库。
- 不让 Agent 直接传入 LightRAG `workspace`。
- 不把 LightRAG WebUI 当作 AI Team 的权限管理面。
- 不把 LightRAG 原生文档写入/删除/图谱修改工具暴露给 Pi。
- 不迁移旧 MVP 知识数据；旧文档需要重新 intake。
- 不在本轮实现 RAG/MCP 代码；本轮只补设计。

---

## 2. 当前 taiyi LightRAG 基线

当前 taiyi 使用 LightRAG `1.5.6` 容器：

```text
container:   aiteam-lightrag
docker image: ghcr.1ms.run/hkuds/lightrag:latest
listen:      127.0.0.1:9621 → container:9621
working_dir: /data
input_dir:   /app/data/inputs
```

主要配置：

```text
HOST=0.0.0.0                 # 容器内监听；主机端口仅绑定 loopback
PORT=9621
LLM_BINDING=openai
LLM_MODEL=gpt-5.3-codex-spark
EMBEDDING_BINDING=openai
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B
EMBEDDING_DIM=4096
EMBEDDING_MAX_TOKEN_SIZE=8192
LOG_LEVEL=INFO
WHITELIST_PATHS=/health
```

当前没有显式设置：

```text
LIGHTRAG_KV_STORAGE
LIGHTRAG_DOC_STATUS_STORAGE
LIGHTRAG_GRAPH_STORAGE
LIGHTRAG_VECTOR_STORAGE
WORKSPACE
RERANK_BINDING
```

因此按 LightRAG 官方默认配置，当前属于测试型 JSON/Nano/NetworkX 存储组合，通常对应：

```text
JsonKVStorage
JsonDocStatusStorage
NetworkXStorage
NanoVectorDBStorage
```

它适合单机测试，不适合多副本、并发写入、正式备份和企业共享知识规模化运行。

---

## 3. LightRAG 原生数据模型

LightRAG 的存储对象都带有 namespace/workspace 语义。官方 namespace 包括：

```text
KV_STORE_FULL_DOCS          full_docs
KV_STORE_TEXT_CHUNKS        text_chunks
KV_STORE_LLM_RESPONSE_CACHE llm_response_cache
KV_STORE_FULL_ENTITIES      full_entities
KV_STORE_FULL_RELATIONS     full_relations
KV_STORE_ENTITY_CHUNKS      entity_chunks
KV_STORE_RELATION_CHUNKS    relation_chunks

VECTOR_STORE_ENTITIES       entities
VECTOR_STORE_RELATIONSHIPS  relationships
VECTOR_STORE_CHUNKS         chunks

GRAPH_STORE_CHUNK_ENTITY_RELATION  chunk_entity_relation
DOC_STATUS                    doc_status
```

### 3.1 Full document

保存原始文档或文档主内容，以及文档 ID、来源、workspace、处理状态等。

### 3.2 Text chunks

一份文档被切成多个 chunk，每个 chunk 通常包含：

```text
chunk_id
full_doc_id
chunk_order_index
content
tokens
vector/reference metadata
```

### 3.3 Entity / Relation

LLM 从 chunks 中抽取：

```text
entity
  name
  description
  source chunks

relation
  source entity
  target entity
  description
  weight/source chunks
```

### 3.4 Vector stores

主要向量集合：

```text
entities
relationships
chunks
```

embedding 模型和 dimension 是向量数据的结构契约。修改后必须清理受影响 workspace 并重新索引。

### 3.5 Graph store

保存 entity 节点和 relation 边。图谱和 chunk/vector 不是相互替代，而是 `local/global/hybrid/mix` 查询时组合使用。

### 3.6 Doc status

记录文档 intake/index pipeline 状态，例如：

```text
PENDING
PARSING
ANALYZING
PROCESSING
READY
FAILED
```

在 LightRAG 1.5.x 中，pipeline 还包含分阶段队列、重试和 scheduling 状态。多实例共享存储时必须停止旧 writer 再启动新 writer，不能让旧版本 worker 和新版本 worker 同时写同一 workspace。

---

## 4. AI Team Manager 业务数据模型

LightRAG 原生表/文件不是 AI Team 的业务表。Manager 需要维护以下业务模型。

### 4.1 `knowledge_space`

知识空间是授权和 workspace 路由的业务对象。

```text
id                  knowledge_space_id
tenant_id           所属企业
display_name
scope_type          enterprise | department | member | employee | solution
workspace_key       Manager 推导的 LightRAG workspace
status              active | paused | archived
version
created_at
updated_at
```

约束：

```text
unique(tenant_id, id)
unique(tenant_id, workspace_key)
```

`workspace_key` 不接受前端/Agent直接传入；由 Manager 从 tenant + space identity 推导。

### 4.2 `knowledge_document`

Manager 持有文档源和 intake 状态。

```text
document_id
 tenant_id
 knowledge_space_id
 display_name
 source_type          file | url | text
 source_uri/storage_key
 content_hash
 file_type
 file_size
 status               uploaded | parsing | indexing | ready | failed
 lightrag_document_id
 error_code
 error_message
 version
 created_at
 updated_at
```

LightRAG 的 document ID、file path、chunk ID 只能作为外部索引 provenance，不能替代 Manager document 主键。

### 4.3 `knowledge_ingestion_job`

保存异步 ingest/index 任务状态：

```text
job_id
tenant_id
knowledge_space_id
document_id
requested_by
status
attempts
started_at
finished_at
error_code
```

Manager 是 ingestion job 的状态真相源；LightRAG `doc_status` 是引擎内部状态。

### 4.4 `knowledge_document_binding`

文档到员工/知识空间的索引绑定：

```text
id
tenant_id
knowledge_space_id
document_id
employee_id              nullable
solution_id              nullable
department_id            nullable
status                   pending | ready | stale
lightrag_reference
version
```

### 4.5 `knowledge_space_binding`

把知识空间授权给部门、成员、员工或方案：

```text
id
tenant_id
knowledge_space_id
resource_type            enterprise | department | member | employee | solution
resource_id
permission               read | manage
status                   active | revoked
version
```

企业共享知识库通常绑定到 `enterprise` 或多个 `employee/member`，而不是复制文档。

---

## 5. 授权模型

### 5.1 LightRAG 原生授权能做什么

LightRAG 原生可以做：

```text
服务入口认证
  ├─ X-API-Key
  ├─ AUTH_ACCOUNTS + JWT
  └─ whitelist path

存储命名空间
  └─ workspace
```

它不能原生表达：

```text
tenant A 的 member 1 可以读 enterprise_shared
tenant A 的 member 2 只能读 finance
employee X 可以读 shared + private
member 3 被撤权后 query 立即失效
```

这些必须由 AI Team 业务层实现。

### 5.2 三层授权边界

```text
Layer 1：Agent/Manager 身份
  JWT tenant_id/member_id/roles

Layer 2：AI Team 业务授权
  member_grant
  employee snapshot
  knowledge_space_binding
  document binding

Layer 3：LightRAG 服务防护
  API key/JWT
  workspace
  network boundary
```

LightRAG 的 API key 只能证明“请求者可以访问这个 LightRAG 服务”，不能证明“请求者可以访问某个企业/部门/员工知识空间”。

### 5.3 推荐 MCP 授权形态

如果未来使用 Agent → MCP → LightRAG：

```text
Agent JWT / capability token
  → Manager-owned MCP facade
  → 根据 tenant/member/employee 解析允许的 space
  → 注入固定 workspace
  → 调用 LightRAG REST/query_data
```

MCP 工具只允许：

```text
knowledge_search
knowledge_get
query_data
```

禁止暴露：

```text
insert_text
upload_document
delete_document
merge_entities
create_entity
create_relation
reprocess_failed
pipeline_admin
```

模型不能传：

```text
workspace
tenant_id
member_id
knowledge_space_id
arbitrary file path
```

### 5.4 撤权语义

撤权时必须同时处理：

1. Manager binding 变为 revoked；
2. 新的 capability/MCP token 立即失效或不再包含该 space；
3. Agent 新 prompt 不能得到该 space；
4. 已打开 Session 的下一次 knowledge tool call 重新检查 capability；
5. citation get 重新检查 employee binding；
6. 不要求删除企业共享文档，只删除授权关系。

---

## 6. 企业共享知识库与多用户隔离

### 6.1 推荐 workspace 命名

workspace 只允许 ASCII 字母、数字和下划线，并由 Manager 派生：

```text
tenant_<tenant_hash>_enterprise
 tenant_<tenant_hash>_dept_finance
 tenant_<tenant_hash>_member_<member_hash>
 tenant_<tenant_hash>_employee_<employee_hash>
 tenant_<tenant_hash>_solution_<solution_hash>
```

不能使用：

```text
enterprise_shared
finance
default
```

作为全局 workspace，因为它们不包含 tenant 隔离。

### 6.2 企业共享知识库

```text
tenant A
  knowledge_space: enterprise_shared
  workspace: tenant_A_enterprise

  document 1 ─┐
  document 2 ─┼─ LightRAG index once
  document 3 ─┘

  employee X ─ read binding
  employee Y ─ read binding
  finance dept ─ read binding
```

所有被授权对象查询同一份索引，不复制向量和图谱。

### 6.3 企业共享 + 部门/个人知识

一个员工可以获得多个 space：

```text
employee X
  ├─ enterprise_shared
  ├─ department_finance
  └─ employee_private_X
```

如果 LightRAG 一次只能查询一个 workspace，Manager-owned MCP facade 做 fan-out：

```text
query(q)
  ├─ query tenant_A_enterprise
  ├─ query tenant_A_dept_finance
  └─ query tenant_A_employee_X
        ↓
  merge/rerank references
        ↓
  return bounded context + citations
```

不建议把不同权限等级的文档放在同一个 workspace 后再依赖 prompt 过滤。LightRAG graph/vector 检索可能先把受限 chunk/entity 取出来，事后过滤容易产生侧信道或图谱泄漏。

如果需要强文档级 ACL，优先拆成不同 knowledge space/workspace，而不是在同一个图谱中做软过滤。

### 6.4 单实例还是多实例

#### 测试环境

可以：

```text
一个 LightRAG 实例
多个 tenant/workspace
```

但必须做跨 workspace 负向测试，尤其是 query、query/data、graph 和 document APIs。

#### 小规模生产

推荐：

```text
一个 tenant 一个 LightRAG instance
一个 tenant 内多个 knowledge_space/workspace
```

优点是网络、文件、API key 和数据目录更容易隔离。

#### 大规模生产

推荐：

```text
LightRAG 多副本
PostgreSQL/PGVector 等共享存储
Manager-owned MCP gateway
workspace + tenant capability mapping
```

LightRAG 官方的 multi-site 方案是多个实例、不同 prefix、不同 working directory 和 API key；这说明 `workspace`/实例隔离是有效的存储边界，但仍不是 AI Team 的成员级 RBAC。

---

## 7. LightRAG 读写流程

### 7.1 Manager 写入流程

```text
Manager create knowledge_space
  ↓
Manager upload/import document
  ↓
写 knowledge_document = uploaded
  ↓
创建 knowledge_ingestion_job
  ↓
派生 tenant/workspace
  ↓
调用 LightRAG document/text ingestion
  ↓
LightRAG parse/chunk/extract/embed/upsert
  ↓
轮询 doc_status/pipeline
  ↓
Manager 校验 ready、doc hash、引用映射
  ↓
knowledge_document = ready
  ↓
创建/更新 binding
```

Agent 不拥有企业文档写入入口。

### 7.2 Agent 查询流程

目标路线暂缓，恢复开发后采用：

```text
Pi knowledge_search(query)
  ↓
受控 MCP client
  ↓
Manager-owned RAG MCP facade
  ↓
校验 Agent token + employee snapshot + binding
  ↓
解析允许的 workspace 集合
  ↓
调用 LightRAG query/data
  ↓
返回 bounded context + citation
  ↓
作为 Pi tool result
  ↓
Agent LLM 生成最终回答
```

如果 Agent 是最终回答模型，优先使用：

```text
/query/data
```

或者：

```text
/query + only_need_context=true
```

避免 LightRAG 先调用一次 LLM 生成完整答案，Agent Pi 再调用一次 LLM 重写。

### 7.3 删除、重建、重索引

```text
Manager delete document
  ↓
标记 document deleting
  ↓
调用 LightRAG 删除/重建操作
  ↓
等待 doc_status 和索引状态稳定
  ↓
删除 citation mapping
  ↓
更新 document/binding version
```

修改以下任意内容通常需要重新索引：

- embedding model；
- embedding dimension；
- asymmetric embedding/prefix；
- parser；
- chunk size/overlap；
- 文档内容；
- workspace storage backend。

通常只影响 query、不必重新索引的参数：

- reranker；
- `top_k`；
- `chunk_top_k`；
- `max_*_tokens`；
- query mode；
- query timeout。

---

## 8. 性能优化参数

### 8.1 推荐调优顺序

```text
1. 先固定 embedding/parser/chunk/storage
2. 建立 query quality baseline
3. 调 top_k/chunk_top_k/token budget
4. 引入 reranker
5. 调整 LLM/embedding concurrency
6. 再考虑 cache 和多副本
```

### 8.2 参数矩阵

| 类别 | 参数 | 建议 | 是否需要重索引 |
|---|---|---|---|
| 查询 | `mode` | `mix`/`hybrid` 做基线 | 否 |
| 查询 | `TOP_K` | 20–40 起步 | 否 |
| 查询 | `CHUNK_TOP_K` | 10–20 起步 | 否 |
| 查询 | `MAX_ENTITY_TOKENS` | 4000–6000 | 否 |
| 查询 | `MAX_RELATION_TOKENS` | 4000–8000 | 否 |
| 查询 | `MAX_TOTAL_TOKENS` | 不超过模型上下文并留回答空间 | 否 |
| 查询 | `COSINE_THRESHOLD` | 先保持 0.2，再用评测集调 | 否 |
| 查询 | `KG_CHUNK_PICK_METHOD` | `VECTOR`/`WEIGHT` 对比 | 否 |
| 查询 | `RELATED_CHUNK_NUMBER` | 3–5 起步 | 否 |
| 查询 | `RERANK_BINDING` | 有可靠 reranker 后再启用 | 否 |
| 查询 | `MIN_RERANK_SCORE` | 0.0 基线，质量不足再提高 | 否 |
| 查询 | `ENABLE_LLM_CACHE` | 多租户场景确认 workspace 进入 cache key 后再开 | 否 |
| LLM | `LLM_TIMEOUT` | 180–240 秒 | 否 |
| LLM | `MAX_ASYNC_LLM` | 先 4，按 provider 限流调 | 否 |
| LLM | `QUERY_LLM_MODEL` | 选择回答模型 | 否 |
| LLM | `KEYWORD_LLM_MODEL` | 可用小模型降低成本 | 新索引可能受影响 |
| Embedding | `EMBEDDING_MODEL` | 当前 Qwen3-Embedding-8B | 是 |
| Embedding | `EMBEDDING_DIM` | 当前 4096，不能随意改 | 是 |
| Embedding | `EMBEDDING_MAX_TOKEN_SIZE` | 当前 8192 | 通常是 |
| Parser | `LIGHTRAG_PARSER` | 固定版本和策略 | 新文档/重处理 |
| Parser | `SUMMARY_LANGUAGE` | 中文语料建议 `Chinese` | 重索引建议 |
| Pipeline | `MAX_PARALLEL_INSERT` | 2–3 起步 | 否 |
| Pipeline | `QUEUE_SIZE_*` | 根据内存和 provider 并发调 | 否 |
| Capacity | `MAX_PENDING_DOCUMENTS` | 防止单租户占满 pipeline | 否 |
| Capacity | `MAX_UPLOAD_SIZE` | 和 Nginx/container 限制一致 | 否 |
| Storage | `WORKING_DIR` | 持久化卷，不能使用临时目录 | 数据迁移 |
| Storage | `WORKSPACE` | 每个 tenant/space 唯一 | 新 workspace |

### 8.3 当前 taiyi 的优先建议

1. 暂时保持 `Qwen/Qwen3-Embedding-8B + 4096`，不要改维度。
2. 为中文知识明确测试 `SUMMARY_LANGUAGE=Chinese`。
3. 固定 parser 和 chunk 参数，再重新 intake 测试文档。
4. 使用 `mix` 和 `include_references=true` 做检索基线。
5. 当前 `RERANK_BINDING=null`，先测无 rerank，再引入多语言 reranker。
6. 当前默认文件存储只用于测试；共享企业知识库应改为持久化数据库/向量存储。
7. 多租户场景暂不启用 LLM cache，直到确认 cache key 包含 workspace/tenant 维度。

---

## 9. 部署架构

### 9.1 当前 taiyi 测试架构

```text
Operation :8781
Manager   :8782
Agent     :8783
Postgres  :5434
Hindsight :9290
LightRAG  :9621
```

当前 LightRAG 仅主机 loopback 暴露，且启用 API key。它适合作为测试环境的 Manager 侧组件。

### 9.2 目标部署架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Manager deployment                                          │
│                                                             │
│  Manager Service                                             │
│   ├─ knowledge_space/document/binding                        │
│   ├─ ingestion orchestration                                 │
│   ├─ tenant/member/employee authorization                    │
│   └─ MCP capability gateway                                  │
│             │                                               │
│             ├── Hindsight service                            │
│             └── LightRAG service                             │
│                                                             │
│  LightRAG storage                                             │
│   ├─ full docs/chunks                                        │
│   ├─ vector stores                                           │
│   ├─ graph store                                             │
│   └─ doc status/pipeline                                     │
└─────────────────────────────────────────────────────────────┘
                 ▲
                 │ Agent outbound only
                 │ scoped capability/MCP token
┌────────────────┴────────────────────────────────────────────┐
│ Agent local machine                                         │
│  Pi Session → Hindsight Extension / RAG MCP client           │
│  local session/attachments/sandbox                           │
└────────────────────────────────────────────────────────────┘
```

### 9.3 存储建议

测试：

```text
JSON/Nano/NetworkX
```

企业共享知识库：

```text
LIGHTRAG_KV_STORAGE=PGKVStorage
LIGHTRAG_DOC_STATUS_STORAGE=PGDocStatusStorage
LIGHTRAG_GRAPH_STORAGE=PGTableGraphStorage
LIGHTRAG_VECTOR_STORAGE=PGVectorStorage
```

或者大规模向量检索使用 Milvus/Qdrant 等专用 vector backend。

LightRAG 官方推荐 `PGTableGraphStorage` 时不需要 Apache AGE，适合托管 PostgreSQL；只有选择 `PGGraphStorage` 才需要 AGE 专用镜像。具体后端必须结合当前 LightRAG 版本和实际 adapter 做一次 clean-install spike。

---

## 10. 可观测与运维

必须记录结构化但脱敏的指标：

```text
tenant_id（按聚合策略脱敏）
knowledge_space_id
workspace_hash
document_id/hash
ingestion_job_id
query_id
mode
latency
retrieved_count
citation_count
rerank_enabled
error_code
```

禁止记录：

```text
完整 query
完整文档正文
完整 chunk 内容
API key
LightRAG 内部路径
跨 tenant workspace
```

重点指标：

- ingestion pending/processing/failed/ready 数量；
- parse/analyze/embed/index 各阶段延迟；
- query p50/p95/p99；
- LightRAG LLM 调用数和失败率；
- embedding/reranker 调用数；
- 每 workspace 文档/chunk/entity/relation 数；
- citation 命中率；
- cross-tenant denial 数量；
- queue backlog 和 `MAX_PENDING_DOCUMENTS` 拒绝数。

---

## 11. 验收矩阵

### 11.1 数据和索引

- 同 tenant enterprise_shared 文档只索引一次；
- re-index 后 document/chunk/citation 版本一致；
- embedding dimension 与存储一致；
- 失败文档不会被错误标记为 ready；
- 删除/撤销后 citation 不再返回旧内容。

### 11.2 授权

- tenant A 不能查询 tenant B workspace；
- member A 不能查询 member B private workspace；
- employee 被 revoke 后新 query/get 立即失败；
- 部门知识只对部门 grant 生效；
- 企业共享知识对授权成员可读；
- Agent 不能传 workspace 绕过授权；
- LightRAG API key 不作为唯一业务授权依据。

### 11.3 查询质量

- `mix`、`hybrid`、`naive` 形成对比基线；
- query 返回 citation；
- citation 能映射回 Manager document/chunk；
- 大 query/context 被限制；
- rerank 开关前后有评测数据；
- Agent 最终回答只调用一次主 LLM，避免 LightRAG/Agent 双重生成。

### 11.4 故障与部署

- LightRAG 不可用时 Agent tool 明确 unavailable；
- pipeline worker 重启不会造成重复/丢失文档；
- Manager 重启后 workspace/storage 仍可读；
- 数据卷恢复后 document status 和引用可校验；
- API key、文档正文、query 不进入普通日志。

---

## 12. 当前暂缓项

本轮用户明确暂停：

- Agent → LightRAG MCP 的具体实现；
- LightRAG MCP package 选型；
- Manager-owned MCP facade 的接口冻结；
- RAG query/get API；
- 当前 Agent local knowledge bundle/index 的清理。

恢复 RAG 工作时，优先做一个小型 spike：

1. 用当前 LightRAG `1.5.6` 验证 workspace header/query/graph/vector 是否完全按 workspace 隔离；
2. 验证 `query_data` 的引用结构和 chunk provenance；
3. 对比原始社区 `lightrag-mcp` 与 Manager-owned 两工具 facade；
4. 冻结 enterprise_shared + private/department space 的授权矩阵；
5. 再决定是否把 `pi-mcp-adapter` 纳入 Agent 生产依赖。

---

## 13. 官方参考

- LightRAG API Server：<https://github.com/HKUDS/LightRAG/blob/main/docs/LightRAG-API-Server.md>
- LightRAG 环境变量完整示例：<https://raw.githubusercontent.com/HKUDS/LightRAG/HEAD/env.example>
- LightRAG QueryRequest：<https://github.com/HKUDS/LightRAG/blob/main/lightrag/api/routers/query_routes.py>
- LightRAG namespace：<https://github.com/HKUDS/LightRAG/blob/main/lightrag/namespace.py>
- LightRAG Multi-Site Deployment：<https://github.com/HKUDS/LightRAG/blob/main/docs/MultiSiteDeployment.md>
- LightRAG Programming With Core：<https://github.com/HKUDS/LightRAG/blob/main/docs/ProgramingWithCore.md>
