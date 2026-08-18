# 天问可信数据空间 · 企业级 Memory Server 详细设计

> 文档版本：v1.0 | 编写人：微贷数据团队 · 隐私计算平台
> 阶段：详细设计 | 关联文档：《tianwen-ai-overview-design.md》5.5.2a 节、《tianwen-ai-detailed-design.md》第四章
>
> 本文档专门阐述 L5 跨会话记忆层的企业级建设方案。承接概要设计 5.5.2a 节"选用 Hindsight + `@luxusai/pi-hindsight`"的决策，展开三部分内容：① Hindsight 底层框架的核心机制（记忆模型、检索流水线、存储设计）；② self-hosted 无状态可扩展服务的构建（部署拓扑、水平扩展、多租户隔离）；③ 通过 `@luxusai/pi-hindsight` 集成到 pi 的工作机制、流程与参数配置。所有机制描述基于 Hindsight 官方文档（`hindsight-docs/docs/developer/`）与 `@luxusai/pi-hindsight` 源码（`extensions/`）核实，非推断。

---

## 目录

- [一、Hindsight 底层框架核心机制](#一hindsight-底层框架核心机制)
  - [1.1 记忆三阶段生命周期：retain → consolidate → recall/reflect](#11-记忆三阶段生命周期retain--consolidate--recallreflect)
  - [1.2 记忆分层模型：facts → observations → disposition](#12-记忆分层模型facts--observations--disposition)
  - [1.3 知识图谱与 entity 链接](#13-知识图谱与-entity-链接)
  - [1.4 retain 流水线（写入路径）](#14-retain-流水线写入路径)
  - [1.5 recall 流水线：TEMPR 四维并行检索](#15-recall-流水线tempr-四维并行检索)
  - [1.6 reflect：agentic 推理循环](#16-reflectagentic-推理循环)
  - [1.7 存储设计：单库 PostgreSQL 承载全部能力](#17-存储设计单库-postgresql-承载全部能力)
- [二、Self-hosted 无状态可扩展服务构建](#二self-hosted-无状态可扩展服务构建)
  - [2.1 部署形态：standalone vs external-PG](#21-部署形态standalone-vs-external-pg)
  - [2.2 生产部署拓扑：无状态 API + 共享 PG](#22-生产部署拓扑无状态-api--共享-pg)
  - [2.3 水平扩展：hindsight-app 无状态特性](#23-水平扩展hindsight-app-无状态特性)
  - [2.4 多租户隔离：bank 物理隔离模型](#24-多租户隔离bank-物理隔离模型)
  - [2.5 LLM/Embedding 接入内部网关](#25-llmembedding-接入内部网关)
  - [2.6 配置项清单（server 侧）](#26-配置项清单server-侧)
- [三、pi 集成：`@luxusai/pi-hindsight` 工作机制](#三pi-集成luxuspi-hindsight-工作机制)
  - [3.1 Extension 载入方式（SDK 代码注入）](#31-extension-载入方式sdk-代码注入)
  - [3.2 生命周期钩子挂载点](#32-生命周期钩子挂载点)
  - [3.3 端到端工作流程](#33-端到端工作流程)
  - [3.4 Agent 可调用的记忆工具](#34-agent-可调用的记忆工具)
  - [3.5 配置项清单（extension 侧）](#35-配置项清单extension-侧)
  - [3.6 bank 路由与多租户落地](#36-bank-路由与多租户落地)
- [四、企业级建设要点与风险处置](#四企业级建设要点与风险处置)
  - [4.1 安全边界与注入防护](#41-安全边界与注入防护)
  - [4.2 降级策略](#42-降级策略)
  - [4.3 可观测性](#43-可观测性)
  - [4.4 容量与性能](#44-容量与性能)
  - [4.5 性能参数调优配置](#45-性能参数调优配置)
    - [4.5.1 性能基线（官方 performance.md）](#451-性能基线官方-performancemd)
    - [4.5.2 Hindsight server 端调优参数](#452-hindsight-server-端调优参数)
    - [4.5.3 `@luxusai/pi-hindsight` 客户端调优参数](#453-luxuspi-hindsight-客户端调优参数)
    - [4.5.4 天问调优基线建议](#454-天问调优基线建议)
  - [4.6 已知限制与演进方向](#46-已知限制与演进方向)

---

## 一、Hindsight 底层框架核心机制

> 本章基于 Hindsight 官方文档 `hindsight-docs/docs/developer/`（`retain.md`、`retrieval.md`、`observations.mdx`、`reflect.mdx`、`storage.md`）核实整理。Hindsight 的核心定位是"让 agent 学习，而不只是记住"——它不是 RAG，也不是知识图谱，而是结合两者优势的语义记忆系统。

### 1.1 记忆三阶段生命周期：retain → consolidate → recall/reflect

Hindsight 的记忆生命周期分三个阶段，每个阶段有明确的输入输出与触发时机：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Hindsight 记忆生命周期                         │
│                                                                 │
│  ① retain（写入）          ② consolidate（巩固）   ③ recall/reflect │
│  ─────────────────         ──────────────────       ────────────── │
│  对话/文档 →               新 facts →                query →       │
│  LLM 事实提取 →            后台自动归纳 →            四维并行检索 → │
│  entity 识别 →             去重/合并/证据追踪         RRF fusion →  │
│  写入 bank                  生成 observations         cross-encoder │
│                                                        重排 → 结果  │
│                                                                 │
│  触发：显式调用 /            触发：retain 完成后      触发：每次      │
│  message_end 自动           后台异步运行             agent turn 前  │
└─────────────────────────────────────────────────────────────────┘
```

三个阶段的关系：retain 产生原始 facts，consolidate 把 facts 归纳成更高层的 observations，recall/reflect 在检索时优先用 observations（更精炼、去重），不足时回退到原始 facts（ground truth）。

### 1.2 记忆分层模型：facts → observations → disposition

Hindsight 的记忆不是扁平的向量堆，而是分层结构。官方文档明确两层抽象 + 一层 disposition：

```
┌──────────────────────────────────────────────────────────────┐
│                    记忆分层模型                                │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Facts（原始事实）                                    │    │
│  │  每次 retain 后 LLM 从内容提取的具体事实              │    │
│  │  与 document 绑定（stable document_id），支持 append  │    │
│  │  标注 entity / timestamp / tags                       │    │
│  │  分两类：                                            │    │
│  │    • experience：bank 自身 agent 的第一人称经历       │    │
│  │      （"我给 Alice 推荐了 Python"）                  │    │
│  │    • world：关于其他人/事/物的客观事实                │    │
│  │      （"Alice 在 Google 工作"）                      │    │
│  └───────────────────────┬─────────────────────────────┘    │
│                          │ 后台 consolidate                  │
│                          ▼                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Observations（观察/信念）                            │    │
│  │  由多条 facts 归纳而来的去重信念                       │    │
│  │  每个 observation 跟踪支持证据（带原文引用）+ proof     │    │
│  │  count，新证据到来时 refine 而非覆盖，保留历史         │    │
│  │  示例：                                              │    │
│  │    facts: "Alice 偏好 Python"                         │    │
│  │           "Alice 不喜欢冗长代码"                      │    │
│  │           "Alice 推荐类型注解"                        │    │
│  │    → observation: "Alice 是注重可读性与简洁的         │    │
│  │       Python 开发者"                                  │    │
│  └───────────────────────┬─────────────────────────────┘    │
│                          │                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Disposition（性格倾向，可选）                        │    │
│  │  bank 级别的 personality traits，影响 reflect 推理    │    │
│  │  shape reasoning based on bank's personality          │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

**Observations 的关键特性**（官方 `observations.mdx` 核实）：
- **去重**：一个持久信念替代多条重叠 facts。
- **证据落地**：每个 observation 引用支持它的具体 facts（带 quotes），不是 LLM 即兴编造的摘要。
- **演化**：新证据增强/削弱/矛盾时 refine，历史保留（非覆盖）。
- **新鲜度感知**：当较新 memory 尚未 consolidate 时，`reflect` 把受影响的 observations 标记为 stale，回退到原始 facts 校验。
- **近重复调和**：consolidation 可能产出措辞近似的两个 observation，Hindsight 自动比对——高度相似则合并证据，有实质差异（数字、否定、命名实体）则保留。

### 1.3 知识图谱与 entity 链接

每次 retain 时，Hindsight 同步提取记忆涉及的实体（entity）并建立关联，形成知识图谱。这是 Hindsight 区别于纯向量检索（如 mem0）的核心能力：

```
┌──────────────────────────────────────────────────────────────┐
│                   知识图谱与 entity 链接                       │
│                                                              │
│   retain "Alice 在 Google 做 ML，上次 PSI 任务因 id 编码失败"  │
│                          │                                   │
│                          ▼ entity 提取                        │
│   ┌──────────┐    ┌───────────┐    ┌──────────────┐         │
│   │ PERSON   │    │ ORG       │    │ TASK         │         │
│   │ Alice    │    │ Google    │    │ PSI 任务     │         │
│   └────┬─────┘    └─────┬─────┘    └──────┬───────┘         │
│        │                │                 │                  │
│        └──── works_at ──┘                 │                  │
│        │                                  │                  │
│        └──────── caused_by ───────────────┘                  │
│                         │                                    │
│   ┌─────────────────────▼──────────────────────┐             │
│   │ FACT: "id 字段编码不一致导致 PSI 失败"       │             │
│   └────────────────────────────────────────────┘             │
│                                                              │
│   recall "card_no 字段问题" 时：                              │
│     向量检索：card_no 语义相似度                              │
│     图谱遍历：card_no → INSTITUTION(建设银行) → 上次任务失败   │
│     → 召回"虽然语义远但实体关联可达"的记忆                     │
└──────────────────────────────────────────────────────────────┘
```

**实体类型**：PERSON、DATASET、INSTITUTION、TASK、CONCEPT 等，可自动识别或手动注入。
**链接类型**：`entity`（归属关系）/ `semantic`（语义相似）/ `temporal`（时序因果）/ `caused_by`（显式因果）。
**图谱作用**：recall 时除向量相似度外，走图谱遍历路径（graph recall），能找到"语义距离远但通过实体关联可达"的记忆——对天问跨机构协作场景下"某机构的特定数据问题关联到上次任务失败"这类检索尤其有价值。

### 1.4 retain 流水线（写入路径）

每次调用 `POST /v1/default/banks/{bank_id}/memories` 时，后台执行：

```
┌─────────────────────────────────────────────────────────────┐
│                  retain 流水线（写入路径）                    │
│                                                             │
│  ① 内容预处理                                                │
│     └─ 按 maxMessageLength 切片（默认 25000 字符），分片并行  │
│                                                             │
│  ② 事实提取（LLM: retain_extract_facts）                     │
│     ├─ 提取结构化事实列表（why/how/what it means，非原文）    │
│     ├─ 每条 fact 标注 timestamp / relevance / entity 引用    │
│     ├─ 分类 experience（第一人称）/ world（客观事实）         │
│     └─ 需 LLM 支持 structured JSON output                    │
│                                                             │
│  ③ 实体识别与归一化                                          │
│     ├─ 提取 content 中的 entity                              │
│     └─ 与已有 entity 去重合并，写入 entities 表，建立链路     │
│                                                             │
│  ④ fact 写库                                                │
│     ├─ 按 document_id + update_mode(append/replace) 管理     │
│     └─ 写入 memories 表，关联 entity 链路与 tags             │
│                                                             │
│  ⑤ 异步 consolidation 触发                                   │
│     ├─ 后台 worker 将新 facts 归纳为 observations            │
│     ├─ 更新/合并已有 observation，追踪证据                    │
│     └─ 近重复 observation 自动调和（合并 or 保留）           │
└─────────────────────────────────────────────────────────────┘
```

**保留上下文**：Hindsight 不像传统系统把信息碎片化（"Bob 建议 Summer Vibes" / "Alice 想要独特的" / "选了 Beach Beats"三条孤立事实），而是保留完整叙事（"Alice 和 Bob 讨论给夏日派对歌单命名……最终选了 Beach Beats"），让 search 结果含完整上下文。

**async 模式**：retain 支持 `async: true`（立即返回，后台处理）与 `async: false`（同步等待完成）。天问场景：`message_end` 自动 retain 走 `async: true` 不阻塞响应；用户主动确认写入时走 `async: false` 确保落库。

### 1.5 recall 流水线：TEMPR 四维并行检索

recall 是 Hindsight 的核心差异化能力。官方文档称之为 **TEMPR**——四种互补检索策略并行执行，再 fusion：

```
┌──────────────────────────────────────────────────────────────────┐
│                recall 流水线（TEMPR 四维并行检索）                 │
│                                                                  │
│                        ┌─────────┐                               │
│                        │  Query  │                               │
│                        └────┬────┘                               │
│          ┌──────────┬────────┼────────┬──────────┐               │
│          ▼          ▼        ▼        ▼          │               │
│   ┌────────────┐ ┌─────────┐ ┌──────┐ ┌────────┐ │               │
│   │ Semantic   │ │Keyword  │ │Graph │ │Temporal│ │               │
│   │ 向量相似度  │ │BM25全文 │ │图谱  │ │时序    │ │               │
│   │ (pgvector  │ │tsvector │ │遍历  │ │窗口    │ │               │
│   │  HNSW)     │ │GIN索引  │ │CTE   │ │        │ │               │
│   └─────┬──────┘ └────┬────┘ └───┬──┘ └───┬────┘ │               │
│         │             │          │         │      │               │
│         └─────────────┴──────────┴─────────┘      │               │
│                       │                            │               │
│                       ▼                            │               │
│              ┌────────────────┐                    │               │
│              │ RRF Fusion     │ 多策略命中排序更高  │               │
│              │ (Reciprocal    │ rank > score       │               │
│              │  Rank Fusion)  │                    │               │
│              └───────┬────────┘                    │               │
│                      ▼                             │               │
│              ┌────────────────┐                    │               │
│              │ Cross-Encoder  │ 神经重排，考虑      │               │
│              │ Re-ranker      │ query-memory 交互   │               │
│              └───────┬────────┘                    │               │
│                      ▼                             │               │
│              ┌────────────────┐                    │               │
│              │ Token Budget   │ 按 token 预算截断  │               │
│              │ Control        │ 非 top-k 条数      │               │
│              └───────┬────────┘                    │               │
│                      ▼                             │               │
│                 最终结果                           │               │
└──────────────────────────────────────────────────────────────────┘
```

**四维策略各自适用场景**（官方 `retrieval.md` 核实）：

| 策略 | 解决的问题 | 示例 |
|---|---|---|
| **Semantic**（语义）| 理解意思，非匹配字面 | "Alice 的工作" → "Alice 是软件工程师" |
| **Keyword**（BM25）| 精确名字/术语/标识符 | "PostgreSQL"、"Alice Chen"、URL |
| **Graph**（图谱遍历）| 间接关系、多跳推理 | "Alice 的同事" → Bob → 共享项目 |
| **Temporal**（时序）| 时间范围、历史查询 | "去年春天 Alice 做了什么" |

**BM25 后端可选**（`HINDSIGHT_API_TEXT_SEARCH_EXTENSION`）：`native`（PG tsvector）、`vchord`、`pg_textsearch`、`pgroonga`、`pg_search`（ParadeDB，支持 jieba 分词，Citus 兼容）。天问中文场景优先评估 `pg_search` + jieba 或 `pgroonga`（TokenBigram 多语言分词）。

**Fusion 机制**：出现在多个策略结果中的记忆排名更高（共识机制）；rank 比 score 更重要（跨不同评分系统更鲁棒）；最终用神经模型重排，考虑 query 与 memory 的交互。

**Token Budget 管理**：Hindsight 面向 agent 而非人类，不返回 top-k 条数，而是按 token 预算填充——`max_tokens`（默认 4096）控制返回内容量，`budget`（low/mid/high）控制检索深度。

### 1.6 reflect：agentic 推理循环

除了 recall（检索返回记忆片段），Hindsight 还提供 `reflect`——一个 agentic loop，自主收集证据并基于 bank 的 disposition 推理出语境化答案：

```
┌──────────────────────────────────────────────────────────────┐
│                  reflect agentic 推理循环                     │
│                                                              │
│   ┌─────────┐                                               │
│   │  Query  │                                               │
│   └────┬────┘                                               │
│        ▼                                                    │
│   ┌─────────────┐    是    ┌─────────────────────────┐      │
│   │ 需要更多信息? │───────→│ 调用工具（分层检索）：     │      │
│   └─────┬───────┘          │  ① search_mental_models  │      │
│         │ 否               │     （用户策展摘要，最高）  │      │
│         ▼                  │  ② search_observations    │      │
│   ┌─────────────┐          │     （巩固知识）           │      │
│   │ 生成响应     │◀─────────│  ③ recall（原始 facts）    │      │
│   │ + citations │          │  ④ expand（扩展上下文）    │      │
│   └─────────────┘          └─────────────────────────┘      │
│                                                              │
│   特性：分层检索（mental models → observations → facts）       │
│         应用 disposition（bank 性格倾向 shape reasoning）      │
│         强制 directives（全局规则 + tag scope 规则）           │
│         引用来源（哪些 memory/observation 被使用）             │
└──────────────────────────────────────────────────────────────┘
```

reflect 的分层检索顺序：先查 mental models（用户策展的高层摘要），再查 observations（巩固知识），最后回退 recall（原始 facts 作为 ground truth）。stale observations 会回退到 facts 校验。天问场景中，reflect 适合"综合分析某机构历史协作模式"这类需要推理而非单纯检索的问题。

**默认不自动开启，按需调用。** reflect 有两个开关层面，默认都是关的（源码 `extensions/config/config-defaults.ts` 核实）：

- **自动 reflect（`postRetainReflect`）默认 `false`**：retain 后不会自动触发 reflect 推理。即每轮对话后只做 retain（事实提取），不跑 reflect 的 agentic loop。
- **`hindsight_reflect` 工具按需调用**：工具会注册暴露给 Agent，但默认不主动触发——Agent 判断需要综合推理时才调用。工具本身在 `retain.toolFilter` 排除列表中（防止 reflect 结果被自动 retain 造成自引用污染），但工具可用。

天问应保持 `postRetainReflect: false` 默认——reflect 的 agentic loop 成本高（多轮 LLM 调用），只适合需要推理的复杂问题，简单 recall 不走 reflect。

**agentic loop 在 Hindsight server 端执行，不在 pi 客户端。** 这是关键架构特性（源码 `hindsight-api-slim/hindsight_api/engine/reflect/agent.py` 核实）：

```
pi 客户端 (@luxusai/pi-hindsight)          Hindsight server (Python)
─────────────────────────────              ─────────────────────────
hindsight_reflect 工具被 Agent 调用
  → client.reflect(bankId, query)
  → POST /reflect HTTP ──────────────────→  run_reflect_agent()
                                              for iteration in range(max_iterations):
  ← 等待...                                    LLM 决定调哪个工具
                                                ├─ search_mental_models
                                                ├─ search_observations
                                                ├─ recall
                                                └─ expand
                                              判断证据是否收集够
                                              没够 → 继续 loop（默认上限 10 轮）
                                              够了 → 生成响应 + citations
  ← 返回 reflect 结果 ←──────────────────────  返回 ReflectAgentResult
```

- **server 端**：`engine/reflect/agent.py` 的 `run_reflect_agent()` 函数实现完整 agentic loop，核心是 `for iteration in range(max_iterations)`（默认 `DEFAULT_MAX_ITERATIONS = 10`），每轮调 LLM + 调内部工具（`search_mental_models`/`search_observations`/`recall`/`expand`），判断证据是否收集够。
- **pi 客户端**：`@luxusai/pi-hindsight` 的 `client.reflect()` 只构造 `ReflectRequest`（query + budget + filters）POST 到 server，等 server 跑完返回结果，客户端不做任何 loop 逻辑。

**架构含义**：reflect 的多轮 LLM 调用与工具调用全部在 hindsight-app server 进程内执行，消耗 server 侧 LLM 调用与算力，不占 pi 客户端（tianwen-ai 副本）资源。这进一步印证了 self-hosted 部署的必要性——reflect 这种重计算放 server 端，hindsight-app 多副本独立扩缩容，reflect 的负载由 server 集群承接，不与 Agent Loop 抢资源。

### 1.7 存储设计：单库 PostgreSQL 承载全部能力

Hindsight 的存储设计是其"部署简单"优势的根源——**单个 PostgreSQL 承载向量、全文、关系、JSON、图查询全部能力，无存储抽象层**（官方 `storage.md` 核实）：

```
┌──────────────────────────────────────────────────────────────┐
│              存储设计：单库 PostgreSQL 全承载                  │
│                                                              │
│   ┌────────────────────────────────────────────────────┐    │
│   │           PostgreSQL 15+ / Oracle AI Database       │    │
│   │                                                    │    │
│   │  ┌──────────────┐  pgvector + HNSW 索引            │    │
│   │  │ 向量搜索      │  semantic recall                │    │
│   │  └──────────────┘                                  │    │
│   │  ┌──────────────┐  tsvector + GIN 索引             │    │
│   │  │ 全文搜索      │  keyword/BM25 recall            │    │
│   │  └──────────────┘                                  │    │
│   │  ┌──────────────┐  原生关系表                      │    │
│   │  │ 关系数据      │  memories / entities /          │    │
│   │  │              │  observations / documents        │    │
│   │  └──────────────┘                                  │    │
│   │  ┌──────────────┐  JSONB + 索引                    │    │
│   │  │ JSON 文档     │  metadata / tags / context      │    │
│   │  └──────────────┘                                  │    │
│   │  ┌──────────────┐  Recursive CTE                   │    │
│   │  │ 图查询        │  graph traversal recall          │    │
│   │  └──────────────┘                                  │    │
│   └────────────────────────────────────────────────────┘    │
│                                                              │
│   收益：单一连接串 / 单一备份恢复 / 单一监控 / ACID 跨类型    │
│   对照 mem0：图谱要额外 Neo4j；Hindsight 一个 PG 全搞定       │
└──────────────────────────────────────────────────────────────┘
```

**为何不抽象存储**（官方明确）：抽象会增加代码/测试/文档/运维复杂度，违背"as simple as possible to run"目标。押注 PostgreSQL 成为标准数据库 API（含 serverless、分布式 PG 兼容生态）。

**两种数据库后端**：
- **PostgreSQL 15+**（默认，需 pgvector 0.5.0+）：开发用内嵌 pg0（单 binary 含 PG+pgvector，自动初始化，存 `~/.hindsight/pg0/`）；生产用 external PG（`HINDSIGHT_API_DATABASE_URL`）。
- **Oracle AI Database**（企业级，full feature parity）：retain/recall/reflect 行为完全一致，drop-in 替换。天问若已有 Oracle 可评估。

---

## 二、Self-hosted 无状态可扩展服务构建

### 2.1 部署形态：standalone vs external-PG

Hindsight 提供两种官方部署形态（`docker/standalone` 与 `docker/docker-compose/external-pg`）：

| 形态 | 组件 | 适用 | 状态特性 |
|---|---|---|---|
| **standalone**（单容器）| app + 内嵌 pg0，一条 `docker run`，暴露 8888(API) + 9999(UI) | 开发 / 小规模 / 单机 | pg0 内嵌，不可水平扩展 |
| **external-PG**（两容器）| hindsight-app（无状态 API）+ 外置 PostgreSQL(pgvector) | **生产推荐** | app 无状态，可多副本 |

天问生产选用 **external-PG 形态**：hindsight-app 是无状态 API 进程，全部状态在外置 PG，可直接多副本 + 负载均衡水平扩展。

### 2.2 生产部署拓扑：无状态 API + 共享 PG

```
┌──────────────────────────────────────────────────────────────────────┐
│              天问 Memory Server 生产部署拓扑                          │
│                                                                      │
│   ┌────────────────────────────────────────────────────┐            │
│   │  tianwen-ai agent server 集群（n 台，无状态）        │            │
│   │  每台 SDK 集成 pi，载入 @luxusai/pi-hindsight        │            │
│   │  注入 HINDSIGHT_BASE_URL / HINDSIGHT_BANK_ID        │            │
│   └───────────────────────┬────────────────────────────┘            │
│                           │ HTTP REST                                │
│                           │ (POST /v1/default/banks/{id}/memories)   │
│                           │ (POST /v1/default/banks/{id}/memories/    │
│                           │  recall)                                 │
│                           ▼                                          │
│   ┌───────────────────────────────────────────────────────┐         │
│   │  负载均衡（公司既有 LB）                                │         │
│   └───────────────────────┬───────────────────────────────┘         │
│                           │                                          │
│            ┌──────────────┼──────────────┐                          │
│            ▼              ▼              ▼                          │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐               │
│   │ hindsight-app│ │ hindsight-app│ │ hindsight-app│  无状态 API    │
│   │  :8888       │ │  :8888       │ │  :8888       │  可水平扩展    │
│   │  :9999(UI)   │ │  :9999       │ │  :9999       │                │
│   └──────┬───────┘ └──────┬───────┘ └──────┬───────┘               │
│          └────────────────┼────────────────┘                        │
│                           ▼                                          │
│   ┌───────────────────────────────────────────────────────┐         │
│   │  共享 PostgreSQL（pgvector，公司现有 PG 集群）          │         │
│   │  向量 + 图谱 entity/relationship + BM25 tsvector 同库  │         │
│   │  按 bank_id 物理隔离记忆数据                            │         │
│   └───────────────────────────────────────────────────────┘         │
│                           │                                          │
│                           ▼                                          │
│   ┌───────────────────────────────────────────────────────┐         │
│   │  内部 LLM 网关（OpenAI 兼容端点）                       │         │
│   │  hindsight-app 用于 retain 事实提取 / consolidation    │         │
│   │  / embedding 向量化                                    │         │
│   └───────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.3 水平扩展：hindsight-app 无状态特性

hindsight-app 在 external-PG 模式下是**纯无状态 API 进程**——这是它相对 mem0 server 的关键架构优势（mem0 server 进程内持全局单例 `Memory` 实例，多副本有一致性顾虑）。

**无状态保证**：
- 全部记忆数据（向量、facts、observations、entities、documents）落 external PG。
- app 进程不持有跨请求的可变状态，任意副本可处理任意请求。
- consolidate 后台任务由 app 触发，但产物落 PG——多副本时需避免重复 consolidate（见 4.4 容量与性能的并发控制）。

**水平扩展操作**：
- 扩容：直接加 hindsight-app 副本，注册到 LB，无预热、无状态迁移。
- 缩容：直接摘除副本，进行中的 retain 请求靠 HTTP 重试由其他副本接管。
- 故障恢复：副本崩溃不影响数据（全在 PG），LB 自动剔除。

**多副本下的 consolidate 并发控制**（需注意）：retain 完成后 consolidate 在 app 侧后台触发，多副本可能对同一 bank 重复 consolidate。Hindsight 的 observation 设计本身幂等（refine 而非覆盖、近重复自动调和），重复 consolidate 不会产生错误数据，但会浪费 LLM 调用。生产规模下可通过 bank 级分布式锁（如 PG advisory lock）让同一 bank 的 consolidate 串行化，或接受幂等重复（小规模下开销可忽略）。

### 2.4 多租户隔离：bank 物理隔离模型

Hindsight 的多租户隔离靠 **bank 模型**——这是它相对 mem0（同表 `filters.user_id` 逻辑过滤）的核心安全优势，对金融/隐私计算场景决定性：

```
┌──────────────────────────────────────────────────────────────┐
│              bank 物理隔离模型                                 │
│                                                              │
│   ┌────────────────────────────────────────────────────┐    │
│   │           Hindsight Service                        │    │
│   │                                                    │    │
│   │  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │    │
│   │  │ bank:        │  │ bank:        │  │ bank:    │ │    │
│   │  │ tianwen_     │  │ tianwen_     │  │ tianwen_ │ │    │
│   │  │ user_1001    │  │ user_1002    │  │ global   │ │    │
│   │  │              │  │              │  │          │ │    │
│   │  │ 用户1001的   │  │ 用户1002的   │  │ 平台级   │ │    │
│   │  │ 全部记忆     │  │ 全部记忆     │  │ 共性知识  │ │    │
│   │  │ (facts/obs/  │  │ (facts/obs/  │  │ (world   │ │    │
│   │  │  entities)   │  │  entities)   │  │  facts)  │ │    │
│   │  └──────────────┘  └──────────────┘  └──────────┘ │    │
│   │        │                  │                │       │    │
│   │        └──────────────────┴────────────────┘       │    │
│   │                           │                        │    │
│   │                    物理隔离：                       │    │
│   │                    bank 间数据完全不互见            │    │
│   │                    即使代码漏传 bank_id 也不会串    │    │
│   └────────────────────────────────────────────────────┘    │
│                                                              │
│   对照 mem0：所有用户记忆在同一 pgvector 表，靠 WHERE       │
│   user_id=? 过滤，filter 构造 bug 会跨租户泄漏              │
└──────────────────────────────────────────────────────────────┘
```

**天问的 bank 规划**：
- **用户级 bank**：`tianwen_user_{userId}`，每用户一个，承载该用户的个性化记忆（被纠正的判断、偏好、常用机构）。`HINDSIGHT_AUTO_CREATE_BANK=true`，首次遇到新用户自动创建。
- **平台级 bank**：`tianwen_global`，承载跨用户共性事实（如"某机构数据类型扫描总是报 false positive"），对所有用户生效。recall 时 Extension 自动合并用户级 bank 与 global bank 的结果。

**物理隔离的安全意义**：bank 间数据完全不互见。即使 extension 代码有 bug（如漏传 bank_id、或 recall query 未带 bank 过滤），bank 间的数据也不会串——最坏情况是查不到，而非泄漏到其他租户。对金融/隐私计算场景，这种"最坏情况可控"是合规底线。

### 2.5 LLM/Embedding 接入内部网关

hindsight-app 需要 LLM（retain 事实提取、consolidation 归纳、reflect 推理）与 embedding（向量化）。Hindsight 支持多 provider（官方 `models.mdx`）：`openai`/`anthropic`/`gemini`/`groq`/`ollama`/`lmstudio`/`minimax`/`atlas`。

**天问接入内部 LLM 网关的两条路**：

| 路径 | 做法 | 前提 | 优先级 |
|---|---|---|---|
| **路①（优先）** | 网关提供 OpenAI 兼容端点 → 配 `HINDSIGHT_API_LLM_PROVIDER=openai` + `HINDSIGHT_API_LLM_API_KEY` + `HINDSIGHT_API_LLM_BASE_URL` 指向网关 | 网关支持 OpenAI 兼容 | **优先验证** |
| **路②** | 网关非 OpenAI 兼容 → 用 `ollama`/`lmstudio` provider（若网关兼容其协议），或自建 Hindsight 镜像扩展 provider | 网关协议兼容 ollama/lmstudio | 备选 |

**json_object 注意事项**：retain 的事实提取与 consolidation 需 LLM 返回结构化 JSON。当网关不支持 `response_format: {type: "json_object"}` 时，需将 provider 标签设为 `lmstudio` 或 `volcano`（这两个标签会跳过 json_object 参数，改 schema-in-prompt 方式）。天问接入前必须验证网关对 json_object 的支持情况。

### 2.6 配置项清单（server 侧）

hindsight-app 进程的环境变量配置（与 extension 侧配置分开）：

| 环境变量 | 天问设定 | 说明 |
|---|---|---|
| `HINDSIGHT_API_DATABASE_URL` | `postgresql://host/tianwen_hindsight` | external PG 连接串，指向公司 PG 集群（需 pgvector 0.5.0+）|
| `HINDSIGHT_API_LLM_PROVIDER` | `openai`（优先）| 事实提取/consolidation LLM provider |
| `HINDSIGHT_API_LLM_API_KEY` | 内部网关 key | LLM API key |
| `HINDSIGHT_API_LLM_BASE_URL` | 内部网关 OpenAI 兼容端点 | 路①接入方式 |
| `HINDSIGHT_API_LLM_MODEL` | 与 tianwen-ai 主模型一致 | 事实提取模型 |
| `HINDSIGHT_API_EMBEDDER_PROVIDER` | `openai` | embedding provider |
| `HINDSIGHT_API_EMBEDDER_MODEL` | `text-embedding-3-small` | embedding 模型 |
| `HINDSIGHT_API_TEXT_SEARCH_EXTENSION` | `pg_search`（jieba）或 `pgroonga` | BM25 后端，中文场景优先；`native` 为默认 tsvector |
| `HINDSIGHT_API_AUTO_CREATE_BANK` | `true` | 首次遇到新用户自动创建 bank |
| 端口 8888 | API | REST 接口 |
| 端口 9999 | UI | 管理面板（生产可关闭或限内网）|

---

## 三、pi 集成：`@luxusai/pi-hindsight` 工作机制

> 本章基于 `@luxusai/pi-hindsight` 源码（`extensions/index.ts`、`extensions/lifecycle/`、`extensions/config/config-defaults.ts`、`extensions/types.ts`）核实整理。

### 3.1 Extension 载入方式（SDK 代码注入）

遵循 5.1b 节统一载入方式：`@luxusai/pi-hindsight` 声明为 `tianwen-ai` 的 npm 依赖，随 `npm install` 进 `node_modules`，构造 `DefaultResourceLoader` 时经 `extensionFactories: InlineExtension[]` 注入其 factory 函数，设 `noExtensions: true` 关闭 `~/.pi/agent/extensions/` 文件系统发现。**不使用 `pi install`**，确保多副本水平扩展无需逐机手动安装。

```typescript
// tianwen-ai 构造会话时（伪代码）
import hindsightExtension from "@luxusai/pi-hindsight";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [
    hindsightExtension,        // L5 记忆
    telemetryExtension,        // 可观测性
    hitlExtension,             // HITL（自研）
    gondolinRouterExtension,   // Gondolin 路由（自研）
    // ...
  ],
  noExtensions: true,          // 关闭文件系统发现
});
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader, ... });
```

### 3.2 生命周期钩子挂载点

`@luxusai/pi-hindsight` 的 extension 入口（`extensions/index.ts` 源码核实）注册了四个 pi 生命周期钩子：

```
┌──────────────────────────────────────────────────────────────────┐
│            @luxusai/pi-hindsight 钩子挂载与工作流                  │
│                                                                  │
│  pi 会话生命周期                                                  │
│  ════════════════                                                │
│                                                                  │
│  session_start ──→ initialize()                                  │
│   │              ├─ 读取配置（HINDSIGHT_BASE_URL/BANK_ID 等）     │
│   │              ├─ 连接 Hindsight service                        │
│   │              └─ 自动创建不存在的 bank（autoCreateBank）       │
│   │                                                              │
│  每个 user turn：                                                 │
│   ├─ context ────→ recall()                                      │
│   │              ├─ 从 user input 派生 recall query               │
│   │              ├─ 调 Hindsight recall API（TEMPR 四维检索）     │
│   │              ├─ 结果封装为 <hindsight_memories> 注入 context  │
│   │              └─ ephemeral，不写 session history               │
│   │              ├─ 过滤旧 hindsight-recall 消息防污染            │
│   │              └─ 按 token 预算截断                             │
│   │                                                              │
│   ├─ [Agent 执行：模型调用 + 工具调用]                            │
│   │                                                              │
│   └─ agent_end ─→ retain()                                       │
│                  ├─ 序列化本轮消息（user/assistant/toolResult）   │
│                  ├─ 按 content 配置过滤（默认只 retain text +     │
│                  │  toolCall error，排除 hindsight 自身工具）      │
│                  └─ async 批量送 Hindsight retain API             │
│                     （LLM 事实提取 + 向量化，不阻塞响应）         │
│                                                                  │
│  session_shutdown ─→ shutdown()                                  │
│                      └─ flush 未 retain 的队列，确保不丢          │
└──────────────────────────────────────────────────────────────────┘
```

四个钩子的职责（源码 `extensions/index.ts` + `extensions/lifecycle/` 核实）：

| 钩子 | 时机 | Extension 行为 |
|---|---|---|
| `session_start` | pi 会话启动 | `lifecycle.initialize()`：读配置、连 Hindsight、auto-create bank |
| `context` | 模型调用前构建 context | `lifecycle.recall()`：派生 query、调 recall API、封装注入 context、过滤旧 recall 消息 |
| `agent_end` | 每轮 agent 处理完成 | `lifecycle.retain()`：序列化消息、过滤、async 批量 retain |
| `session_shutdown` | 会话关闭 | `lifecycle.shutdown()`：flush 队列 |

### 3.3 端到端工作流程

天问用户一次对话的完整记忆流程：

```
用户发消息 "帮我看下建行信用卡数据的 card_no 字段为什么总是报错"
    │
    ▼
tianwen-ai 接入层：解析 ssoid → userId=1001
    │
    ▼
构造 pi 会话：注入 HINDSIGHT_BANK_ID=tianwen_user_1001
    │
    ▼
session_start 钩子：
    Extension 连 Hindsight service（http://hindsight-svc:8888）
    bank tianwen_user_1001 存在？否 → auto-create
    │
    ▼
context 钩子（agent turn 前）：
    Extension 从 "card_no 字段报错" 派生 recall query
    POST /v1/default/banks/tianwen_user_1001/memories/recall
        ├─ semantic: 向量相似度找"字段报错"相关记忆
        ├─ keyword: BM25 精确匹配 "card_no"
        ├─ graph: 图谱遍历 card_no → 建行 → 上次任务
        └─ temporal: 时序找近期相关
    RRF fusion + cross-encoder 重排 → token budget 截断
    结果封装为 <hindsight_memories> 注入 context（ephemeral）
    同时 recall global bank tianwen_global 合并平台共性知识
    │
    ▼
Agent Loop 执行：
    模型看到注入的记忆 + 用户问题
    调用数据域工具查询建行 card_no 字段
    发现是 SHA256 哈希格式，Agent 之前误判为异常
    │
    ▼
agent_end 钩子：
    Extension 序列化本轮消息（用户问题 + Agent 分析 + 工具结果）
    async 送 Hindsight retain API：
        ├─ LLM 事实提取："建行 card_no 是 SHA256 哈希，非异常"
        ├─ entity 识别：INSTITUTION(建行)、DATASET(信用卡)、FIELD(card_no)
        ├─ 分类 world fact（客观事实）
        └─ 写入 bank tianwen_user_1001
    后台 consolidate：归纳成 observation"建行 card_no 字段为 SHA256 哈希值"
    │
    ▼
（若用户明确纠正"不对，是 MD5"）
    Agent 调 hindsight_retain 工具显式写入纠正
    走 L1 HITL 确认后落库，refine 已有 observation
    │
    ▼
session_shutdown（会话结束）：
    flush 队列，确保本轮 retain 全部落库
```

### 3.4 Agent 可调用的记忆工具

Extension 注册了多个 LLM 工具，Agent 可主动调用（源码 `extensions/operations/` 核实）：

| 工具 | 功能 | 关键参数 |
|---|---|---|
| `hindsight_recall` | 原始 recall，返回记忆片段列表 | `query`, `budget?` |
| `hindsight_reflect` | reflect 模式，agentic 推理返回语境化答案 | `query`, `context?` |
| `hindsight_retain` | 显式写入用户级 bank（用户纠正/重要决策）| `content`, `context?` |
| `hindsight_retain_global` | 写入平台级 global bank | `content`, `context?` |
| `hindsight_delete_document` | 删除指定 document | `document_id` |
| `hindsight_route_memory` | 路由记忆到指定 bank | `content`, `bank` |
| `hindsight_retain_receipts` | 查看 retain 记录 | - |

**写入触发点与 HITL 对齐**（5.3 节）：`hindsight_retain` 主动写入是 L1 操作（影响后续会话行为），需用户知情同意——Agent 生成记忆草稿展示给用户确认后落库。会话过程内容的自动 retain（`agent_end` 钩子）由 Extension 后台异步执行，不需用户逐条确认。

### 3.5 配置项清单（extension 侧）

`@luxusai/pi-hindsight` 的配置（源码 `extensions/config/config-defaults.ts` 核实，`DEFAULT_CONFIG`）。天问通过环境变量 + pi settings 注入，关键项：

| 配置项 | 默认值 | 天问设定 | 说明 |
|---|---|---|---|
| `hindsight.baseUrl` | `http://localhost:8888` | `http://hindsight-svc:8888` | Hindsight service 地址（经 LB 指向 hindsight-app 集群）|
| `hindsight.timeoutMs` | `30000` | `30000` | HTTP 请求超时 |
| `enabled` | `true` | `true` | extension 总开关 |
| `scope.mode` | `domain-tagged` | `domain-tagged` | bank 路由模式 |
| `recall.enabled` | `true` | `true` | 是否自动 recall |
| `recall.budget` | `mid` | `mid` | 检索深度（low/mid/high）|
| `recall.maxTokens` | `800` | `1500` | 注入 context 的记忆 token 预算 |
| `recall.types` | `["observation"]` | `["observation","experience"]` | 召回记忆类型 |
| `recall.topK` | `8` | `8` | 每轮召回上限 |
| `recall.injectionMode` | `context` | `context` | 注入方式（context/system）|
| `recall.cacheTtlMs` | `60000` | `60000` | recall 结果缓存 TTL |
| `retain.enabled` | `true` | `true` | 是否自动 retain |
| `retain.async` | `true` | `true` | 异步 retain，不阻塞响应 |
| `retain.delivery` | `immediate` | `immediate` | 投递模式（immediate/coalesced）|
| `retain.updateMode` | `append` | `append` | document 更新模式（append/replace）|
| `retain.content.user` | `["text"]` | `["text"]` | retain 用户消息的哪些部分 |
| `retain.content.assistant` | `["text","toolCall"]` | `["text","toolCall"]` | retain assistant 消息部分 |
| `retain.content.toolResult` | `["error"]` | `["error"]` | retain 工具结果（默认只 retain 错误）|
| `banks.project.enabled` | `true` | `true` | 项目级 bank |
| `banks.global.enabled` | `false` | `true` | 平台级 bank（天问启用 tianwen_global）|
| `banks.user.enabled` | `false` | `true` | 用户级 bank（天问启用 tianwen_user_{userId}）|

**`retain.content.toolResult: ["error"]`** 的意义：默认只 retain 工具调用的错误结果（不 retain 正常结果），避免正常工具输出灌满记忆库。天问保留此默认——错误结果含排查价值，正常结果由 Langfuse trace 承接。

**`retain.toolFilter`**：排除 hindsight 自身工具（`hindsight_retain`/`hindsight_recall` 等）的调用被 retain，防止记忆自引用污染。

### 3.6 bank 路由与多租户落地

`@luxusai/pi-hindsight` 的 bank 路由（源码 `extensions/banks/bank-selection.ts`）按 `scope.mode` 决定用哪个 bank。天问的落地：

```
┌──────────────────────────────────────────────────────────────┐
│              bank 路由落地（天问多租户）                       │
│                                                              │
│  tianwen-ai 启动 pi 会话时：                                  │
│    HINDSIGHT_BANK_ID=tianwen_user_{userId}  ← 按用户动态注入  │
│                                                              │
│  Extension bank-selection 逻辑：                             │
│    recall/retain 时同时操作两个 bank：                        │
│    ├─ tianwen_user_{userId}（用户级，个性化记忆）             │
│    └─ tianwen_global（平台级，共性知识）                      │
│                                                              │
│  recall：合并两个 bank 结果                                   │
│  retain：                                                    │
│    ├─ 自动 retain（agent_end）→ 用户级 bank                  │
│    ├─ hindsight_retain 工具 → 用户级 bank                    │
│    └─ hindsight_retain_global 工具 → 平台级 bank             │
│                                                              │
│  物理隔离：每个 bank 独立，用户间完全不互见                    │
│  auto-create：首次新用户自动创建 tianwen_user_{userId} bank   │
└──────────────────────────────────────────────────────────────┘
```

---

## 四、企业级建设要点与风险处置

### 4.1 安全边界与注入防护

Hindsight 的 recall 结果以 `<hindsight_memories>` 注入 context，存在记忆内容污染 system prompt 指令的潜在风险（与 mem0 amaster 封装的 `[UNTRUSTED]` + `[BLOCKED]` 机制相比是差距）。天问的防护层次：

| 防护层 | 机制 | 来源 |
|---|---|---|
| recall 注入隔离 | 结果作为 ephemeral context 注入，**不写 session history**，过滤旧 `hindsight-recall` 消息防污染 | `@luxusai/pi-hindsight` 内建 |
| 凭证脱敏 | 工具参数含机构名/SQL/凭证，retain 前需脱敏 | 天问自研：在 `agent_end` retain 前加一层 content filter extension，或依赖 Hindsight server 侧配置 |
| trace 侧脱敏 | Langfuse `TELEMETRY_INCLUDE_PAYLOADS=false` 关 payload，工具参数不上传 | 5.8 节 pi-telemetry |
| HITL 把关 | 主动 `hindsight_retain` 是 L1 操作，需用户确认后落库 | 5.3 节 |

**若后续评估需更强记忆侧防注入**：在 `@luxusai/pi-hindsight` 之上叠加一层 tianwen 自研的 recall 内容过滤 Extension，对注入 context 前的 recall 结果做 prompt-injection 模式检测与 `[BLOCKED]` 替换（参考 amaster 封装做法）。

### 4.2 降级策略

Hindsight service 是增强能力，故障时静默降级，不阻塞 Agent 主链路（与详细设计十四章一致）：

| 故障场景 | 降级行为 | 用户感知 |
|---|---|---|
| recall 失败（Hindsight 宕机/网络异常/超时）| 本次无跨会话记忆注入，Agent 按无记忆正常处理 | 无感知（记忆降级）|
| retain 失败 | 本轮内容不记忆，下轮 recall 无新记忆 | 无感知 |
| consolidate 失败 | observations 不更新，recall 退化为只查原始 facts | 无感知（质量略降）|
| LLM 网关故障（retain 事实提取失败）| retain 跳过本轮，不阻塞响应 | 无感知 |

Extension 的 `recall.timeoutMs`/`hindsight.timeoutMs` 配置确保超时不拖垮 Agent 响应。

### 4.3 可观测性

| 指标 | 来源 | 用途 |
|---|---|---|
| Hindsight service 健康 | hindsight-app :8888 health endpoint | 监控服务存活 |
| recall 延迟/成功率 | Extension 日志 + Hindsight server metrics | 发现检索性能问题 |
| retain 队列积压 | Extension `hindsight_retain_receipts` 工具 | 发现写入瓶颈 |
| bank 记忆量 | Hindsight UI :9999 / admin CLI | 容量监控 |
| LLM 调用量（事实提取/consolidation）| Hindsight server + 内部 LLM 网关计量 | 成本监控 |
| token 消耗（recall 注入）| Extension 日志 | 控制注入预算 |

Hindsight 自带 admin CLI 与 monitoring 文档（`hindsight-docs/docs/developer/monitoring.md`），可接入公司既有监控。

### 4.4 容量与性能

| 维度 | 考量 | 措施 |
|---|---|---|
| PG 规模 | 记忆随用户/交互线性增长，向量索引膨胀影响 recall 延迟 | pgvector HNSW 索引调参；按 bank 分表/分区；定期 consolidate 已压缩 |
| hindsight-app 并发 | 多用户并发 recall/retain | 无状态 app 多副本 + LB；PG 连接池 |
| consolidate 并发 | 多副本对同一 bank 重复 consolidate | 幂等设计（refine 不覆盖）；大规模下 PG advisory lock 串行化 |
| LLM 调用成本 | 每条 retain 触发事实提取 LLM 调用 | `retain.content.toolResult: ["error"]` 只 retain 错误减少量；async 批量；consolidation 频率可调 |
| recall 延迟 | 四维并行 + cross-encoder 重排有延迟 | `recall.budget` 调深度；`recall.cacheTtlMs` 缓存；`maxTokens` 控预算 |

### 4.5 性能参数调优配置

本节汇总 Hindsight server 端与 `@luxusai/pi-hindsight` 客户端两侧的性能调优参数，基于官方 `performance.md`、`configuration.md` 与源码核实。Hindsight 的设计哲学是**优化读性能优先于写性能**（memory 写一次读多次），recall 默认 sub-second，retain 重计算放在写入路径。

#### 4.5.1 性能基线（官方 performance.md）

| 操作 | 典型延迟 | 主要瓶颈 | 优化策略 |
|---|---|---|---|
| **Recall**（检索）| 100-600ms | cross-encoder reranker（CPU）| GPU 重排，或降低 budget |
| **Reflect**（推理）| 800-3000ms | LLM 生成 | 用更快的 LLM |
| **Retain**（写入）| 500-2000ms/批 | LLM 事实提取 | 高吞吐 LLM provider + async |

读路径（recall/reflect）始终快，因为重计算（embedding、事实提取、关系解析）都在写入时完成。

#### 4.5.2 Hindsight server 端调优参数

**数据库连接池**（高并发关键，每个并发 recall/reflect 用 2-4 连接）：

| 参数 | 默认 | 天问建议 | 说明 |
|---|---|---|---|
| `HINDSIGHT_API_DB_POOL_MIN_SIZE` | 5 | 10 | 主库连接池最小连接 |
| `HINDSIGHT_API_DB_POOL_MAX_SIZE` | 100 | 按副本数×并发调 | 主库连接池最大连接；高并发需调大 |
| `HINDSIGHT_API_READ_DATABASE_URL` | unset | **设为只读副本** | recall 查询（semantic/BM25/graph/temporal）走只读副本连接池，卸载主库 |
| `HINDSIGHT_API_READ_DB_POOL_MAX_SIZE` | 同主库 | 独立配置 | 只读副本连接池上限 |
| `HINDSIGHT_API_DB_COMMAND_TIMEOUT` | 60s | 60 | asyncpg 客户端命令超时 |
| `HINDSIGHT_API_DB_STATEMENT_TIMEOUT` | 600s | 300 | PG `statement_timeout`，防 runaway 查询 |
| `HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER` | unset | 后台 worker 设 0 | 后台 consolidation 查询不抢延迟敏感流量的 CPU |

**LLM 并发与超时**（retain 事实提取是写入瓶颈）：

| 参数 | 默认 | 天问建议 | 说明 |
|---|---|---|---|
| `HINDSIGHT_API_LLM_MAX_CONCURRENT` | 32 | **8-16**（共享网关）| 最大并发 LLM 请求；共享内部 LLM 网关时调低，预留 slot 给主 agent |
| `HINDSIGHT_API_LLM_TIMEOUT` | 120s | 120 | LLM 请求超时 |
| `HINDSIGHT_API_LLM_MAX_RETRIES` | 3 | 2-3 | 重试次数；本地/内部网关重试意义不大可调低 |
| `HINDSIGHT_API_LLM_INITIAL_BACKOFF` | 1.0s | 1.0 | 指数退避初始 |
| `HINDSIGHT_API_LLM_MAX_BACKOFF` | 60.0s | 30 | 退避上限 |
| `HINDSIGHT_API_LLM_REASONING_EFFORT` | low | low | 推理预算（retain/consolidation 不需高推理）|

**按操作拆分 LLM 并发**（后台不挤占实时读）——组合在全局上限之上：

```bash
# 全局 8，retain/consolidation 各限 2，给 reflect/recall 预留 headroom
export HINDSIGHT_API_LLM_MAX_CONCURRENT=8
export HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT=2
export HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT=2
```

**按操作独立 LLM 配置**（retain 用结构化输出强的模型，reflect 可用更快小模型）：

| 参数 | 说明 |
|---|---|
| `HINDSIGHT_API_RETAIN_LLM_MODEL` | retain 专用模型（默认继承全局）；retain 是结构化任务，小快模型即可（官方推荐 `gpt-oss-20b`）|
| `HINDSIGHT_API_REFLECT_LLM_MODEL` | reflect 专用模型；可用更快小模型 |
| `HINDSIGHT_API_CONSOLIDATION_LLM_MODEL` | consolidation 专用模型 |
| `HINDSIGHT_API_LLM_TEMPERATURE_RETAIN` | 0.1（事实提取低温）|
| `HINDSIGHT_API_LLM_TEMPERATURE_REFLECT` | 0.9（推理高温）|
| `HINDSIGHT_API_LLM_TEMPERATURE_CONSOLIDATION` | 0.0（归纳零温）|
| `HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE` | 默认 8；小模型/小 context window 时调低（如 2）避免 prompt 过大 |

**Reflect 专属调优**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `DEFAULT_MAX_ITERATIONS`（源码常量）| 10 | reflect agentic loop 最大迭代轮数；硬上限防止无限循环 |
| `HINDSIGHT_API_REFLECT_MAX_COMPLETION_TOKENS` | unset（不限）| reflect 最终合成调用的 `max_completion_tokens` 硬上限；设整数做成本封顶 |
| `HINDSIGHT_API_REFLECT_PROMPT_CACHE_ENABLED` | true | reflect 的 step-by-step context cache 前滚，每轮复用前序对话（system+tools+tool results）走 cached-input 费率；per-reflect 缓存临时，reflect 结束删除 |
| `HINDSIGHT_API_LLM_PROMPT_CACHE_ENABLED` | true | 全局 prompt cache（固定 system prefix）；reflect cache 依赖它 |

**Recall reranker（CPU 瓶颈）调优**——无 GPU 机器的关键：

| 参数 | 说明 |
|---|---|
| `HINDSIGHT_API_RERANKER_LOCAL_FP16` | Apple Silicon/支持 FP16 的 GPU 设 true，快 27-36%，质量不变 |
| `HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING` | 按 length 排序后 batch，快 36-54%，质量不变 |

**向量索引调优**（`HINDSIGHT_API_VECTOR_EXTENSION`）：

| 选项 | 适用 |
|---|---|
| `pgvector`（默认 HNSW）| 通用，调 `ef_construction`/`ef_search` 平衡索引质量与速度 |
| `vchord` | VectorChord，BM25 用 llmlingua2 多语言分词 |
| `pgvectorscale` | 大规模 |
| `scann` | Google ScaNN |

**BM25 中文分词**（`HINDSIGHT_API_TEXT_SEARCH_EXTENSION`）：

| 后端 | 中文支持 |
|---|---|
| `native`（默认）| `HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE=zhparser` 或 `simple`；中文支持弱 |
| `pg_search` | `HINDSIGHT_API_TEXT_SEARCH_EXTENSION_PG_SEARCH_TOKENIZER=jieba` 或 `chinese_compatible`，Citus 兼容，**天问优先** |
| `pgroonga` | TokenBigram 多语言，CJK 开箱即用 |
| `HINDSIGHT_API_BM25_MAX_QUERY_TERMS` | 默认 0（不限）；大 bank 长 query 匹配过多时设正数限 tsquery 词数 |

**实体解析调优**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `HINDSIGHT_API_ENTITY_TRGM_SIMILARITY_THRESHOLD` | 0.15 | trigram 匹配阈值，低则多匹配高 CPU，高则严格省 CPU |
| `HINDSIGHT_API_ENTITY_INTRABATCH_MERGE_SIMILARITY` | 0.5 | 同批 retain 内实体合并阈值，比 recall 阈值严 |

#### 4.5.3 `@luxusai/pi-hindsight` 客户端调优参数

客户端侧调优控制 recall/retain 的触发、预算、缓存与过滤（源码 `config-defaults.ts` 核实）：

**Recall 调优**（读路径，影响每轮 agent 延迟）：

| 配置项 | 默认 | 天问建议 | 说明 |
|---|---|---|---|
| `recall.budget` | mid | mid | 检索深度（low 快可能漏间接关联 / mid 平衡 / high 深但慢）|
| `recall.maxTokens` | 800 | 1500 | 注入 context 的记忆 token 预算（控制注入量与延迟）|
| `recall.topK` | 8 | 8 | 每轮召回上限 |
| `recall.timeoutMs` | 40000 | 30000 | recall 超时；调低避免拖垮 agent 响应 |
| `recall.cacheTtlMs` | 60000 | 60000 | recall 结果缓存 TTL，相同 query 不重复检索 |
| `recall.types` | ["observation"] | ["observation","experience"] | 召回记忆类型；observation 已去重最精炼 |
| `recall.injectionMode` | context | context | 注入方式（context/system）|
| `recall.maxQueryChars` | 800 | 800 | recall query 最大字符，防超长 query |
| `recall.includeSourceFacts` | false | false | 是否含原始 facts；true 增 token 但保留 nuance |
| `recall.maxSourceFactsTokens` | 4096 | 4096 | 原始 facts 的 token 预算 |

**Retain 调优**（写路径，影响 LLM 成本与记忆质量）：

| 配置项 | 默认 | 天问建议 | 说明 |
|---|---|---|---|
| `retain.async` | true | true | 异步 retain 不阻塞响应（必须开）|
| `retain.delivery` | immediate | immediate | 投递模式（immediate/coalesced 合并兼容 delta）|
| `retain.updateMode` | append | append | document 更新模式（append 追加 / replace 覆盖）|
| `retain.content.user` | ["text"] | ["text"] | retain 用户消息哪些部分 |
| `retain.content.assistant` | ["text","toolCall"] | ["text","toolCall"] | retain assistant 哪些部分 |
| `retain.content.toolResult` | ["error"] | **["error"]** | **只 retain 工具错误结果**，避免正常输出灌满记忆库（关键成本控制）|
| `retain.toolFilter.toolCall.exclude` | hindsight 自身工具 | 保持默认 | 排除 hindsight_* 工具调用被 retain，防自引用污染 |
| `retain.shutdownFlushMaxJobs` | 10 | 10 | 会话关闭时 flush 的最大 job 数 |
| `retain.shutdownFlushTimeoutMs` | 2000 | 2000 | shutdown flush 超时 |
| `postRetainReflect` | **false** | **false** | retain 后自动 reflect；默认关，reflect 成本高按需调 |

**Hindsight 连接调优**：

| 配置项 | 默认 | 天问建议 | 说明 |
|---|---|---|---|
| `hindsight.baseUrl` | http://localhost:8888 | http://hindsight-svc:8888（经 LB）| 指向 hindsight-app 集群 |
| `hindsight.timeoutMs` | 30000 | 30000 | HTTP 请求超时 |
| `hindsight.apiKey` | unset | mem0 server 签发 key | Bearer auth（若开启 server auth）|

#### 4.5.4 天问调优基线建议

综合上述，天问生产环境的性能调优基线：

**server 侧**：
```bash
# DB 连接池 + 读写分离
export HINDSIGHT_API_DB_POOL_MAX_SIZE=80
export HINDSIGHT_API_READ_DATABASE_URL=postgresql://readonly-host/tianwen_hindsight
export HINDSIGHT_API_DB_STATEMENT_TIMEOUT=300

# LLM 并发拆分（共享内部网关，预留 headroom）
export HINDSIGHT_API_LLM_MAX_CONCURRENT=8
export HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT=2
export HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT=2
export HINDSIGHT_API_LLM_TIMEOUT=120

# 中文 BM25
export HINDSIGHT_API_TEXT_SEARCH_EXTENSION=pg_search
export HINDSIGHT_API_TEXT_SEARCH_EXTENSION_PG_SEARCH_TOKENIZER=jieba

# reranker（无 GPU 机器）
export HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING=true

# 后台 worker 不抢延迟敏感流量 CPU
export HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER=0

# reflect 成本封顶
export HINDSIGHT_API_REFLECT_MAX_COMPLETION_TOKENS=4000
```

**客户端侧**（`@luxusai/pi-hindsight` 配置）：
```json
{
  "recall": {
    "budget": "mid",
    "maxTokens": 1500,
    "timeoutMs": 30000,
    "cacheTtlMs": 60000,
    "types": ["observation", "experience"]
  },
  "retain": {
    "async": true,
    "content": {
      "toolResult": ["error"]
    }
  },
  "postRetainReflect": false,
  "hindsight": {
    "baseUrl": "http://hindsight-svc:8888",
    "timeoutMs": 30000
  }
}
```

**关键取舍**：① `retain.content.toolResult: ["error"]` 只 retain 错误结果是 LLM 成本控制的核心；② `recall.cacheTtlMs` + `recall.timeoutMs` 控制读路径不拖垮 agent；③ server 侧 LLM 并发拆分让后台 retain/consolidation 不挤占实时 recall；④ reflect 默认关 + `MAX_COMPLETION_TOKENS` 封顶控制 agentic loop 成本。

### 4.6 已知限制与演进方向

| 限制 | 现状 | 演进 |
|---|---|---|
| Hindsight 官方无 pi 集成 | 由 `@luxusai/pi-hindsight` 社区封装承接（三社区版中最活跃）| 关注 luxus 维护持续性；必要时 fork 自维护 |
| 无 amaster 的 prompt-injection `[BLOCKED]` 机制 | 依赖 ephemeral 注入 + 旧消息过滤 | 评估叠加自研 recall 过滤 extension |
| 多副本 consolidate 重复 | 幂等但不经济 | 规模上来后加 PG advisory lock |
| BM25 中文分词 | `native` tsvector 中文支持弱 | 用 `pg_search`+jieba 或 `pgroonga` TokenBigram |
| reflect agentic loop 成本 | 多轮 LLM 调用 | 仅对需要推理的复杂问题启用，简单 recall 不走 reflect |

---

## 附录：与概要设计/详细设计的对应关系

| 本文档章节 | 对应概要设计 | 对应详细设计 |
|---|---|---|
| 一、Hindsight 核心机制 | 5.5.2a（选型依据②记忆效果）| 第四章（Hindsight 内部设计展开）|
| 二、Self-hosted 服务构建 | 5.5.2a（部署模式、bank 隔离）| 第四章（部署架构、记忆隔离）|
| 三、pi 集成机制 | 5.1b（extension 载入）、5.5.2a | 第四章（pi Extension 接入点、配置项）|
| 四、企业级建设要点 | 5.8（可观测性）、5.3（HITL）| 第十四章（降级策略）|

本文档是 L5 记忆层的专项详细设计，与《tianwen-ai-detailed-design.md》第四章互补：第四章保留选型决策与候选对比，本文档展开底层机制、部署构建与集成机制的完整实现细节。
