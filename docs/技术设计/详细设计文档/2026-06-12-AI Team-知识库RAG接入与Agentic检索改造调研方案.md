# AI Team — 知识库 RAG 接入与 Agentic 检索改造调研方案

> 状态：**方案已收口（待出实施计划）**
> 日期：2026-06-12
> 范围：知识库文档入库职责、LightRAG 接入方式、对话期 RAG 检索范式
> 关联：`业务解决方案设计 §5.2-A / §7.2`、`CLAUDE.md` 架构边界、`Gateway执行链路实现口径与设计差异备案`

本文档先讲清**现状问题**与**调研事实**，再给出经多轮讨论**收口的设计决策**与**目标架构**，最后列出**实施前仍需细化的点**。结论之前的事实均经过本地代码 / 依赖实测与外部资料核对。

---

## 1. 背景：三个被质疑的现状问题

| # | 现状 | 问题 |
|---|------|------|
| P1 | 文档上传后由 AI Team 后端用 `read_text(utf-8)` 自己读文本，再进程内调 LightRAG 做 chunk+embed（`router_team.py:_read_asset_text` → `lightrag_service.ingest_document`） | 解析职责放错层；无解析器导致**实际只能吃纯文本**，页面文案宣称的 PDF/Word/Excel 不可用；入库时机是"列表刷新时懒触发"，无标准化进度 |
| P2 | LightRAG 的 LLM 凭据从环境变量 `LIGHTRAG_LLM_API_KEY` / `OPENROUTER_API_KEY` 硬读 | 未与企业级 LLM Provider 配置中心打通；知识库页面无法配置 Provider/Model |
| P3 | 每个 run **无条件预检索注入**：用用户原始消息当 query 去检索，结果拼进 prompt 再发给 Hermes（`runtime_executor.py:144`） | 不该查时也查（闲聊污染上下文/浪费 token）；query 未改写（多轮指代检索不准）；无法多跳/多源；不符合业内 Agentic RAG 最佳实践 |

---

## 2. 调研事实（实测 + 资料核对）

### 2.1 LightRAG 自身能力（实测 v1.5.2）

当前安装版本 `lightrag 1.5.2`（`app/.venv`）：

- **`lightrag.parser`** — 原生文档解析，支持 **pdf / docx / doc / html / md / json**（当前实现完全没用到，可 `import` 直接复用）
- **`lightrag.api`（LightRAG Server）** — 完整 REST 服务，入口 `lightrag-server`（默认端口 9621），自带 `/documents/upload`（返回 `track_id`、后台处理）、`/query`（`mode ∈ {local,global,hybrid,naive,mix,bypass}`）
- **嵌入式核心类** `LightRAG(...)` — 进程内直接 `ainsert` / `aquery`，当前 `lightrag_service.py` 走的就是这种

### 2.2 LightRAG 是否暴露 MCP？与 agent 的标准集成方式

**官方包不带 MCP server。** 实测 console_scripts 只有 `lightrag-server`/`lightrag-gunicorn` 等，全包无 MCP 入口。LightRAG 对 agent 的官方接口只有 **REST API** 与 **Python 嵌入式** 两种。

**社区已有成熟的 LightRAG MCP server（第三方），且全部是架在 LightRAG REST 之上的薄包装**：
- `desimpkins/daniel-lightrag-mcp`（22 工具）、`shemhamforash23/lightrag-mcp`（支持 **stdio + streamable-http**）、`mcp-lightrag`(PyPI) 等。

**不直接套用社区 server 的原因**：它们暴露 20+ 工具（含删文档、改图谱），权限面过大，违反 `CLAUDE.md`「工具/Gateway 层不得定义业务对象与权限」；且为单实例、无多租户授权模型。

### 2.3 ⚠️ 关键发现：LightRAG 1.5.2 stock Server 数据面是「单 workspace / 进程」

为评估"一个 server + workspace 隔离服务多 agent"是否可行，实测了 stock server 源码：

- `create_app` 里**只创建一个 `rag` 实例**（`lightrag_server.py:1990`），绑定启动参数 `--workspace`。
- query / document 路由是 `create_query_routes(rag, ...)`、`create_document_routes(rag, ...)`，**接收这唯一一个 rag**（`:2065-2066`），检索一律走 `rag.aquery_llm(...)`、上传写 `rag.workspace`。
- 虽有 `LIGHTRAG-WORKSPACE` 请求头（`get_workspace_from_request`，docstring 写着 "enables multi-workspace"），但它**只被 `get_status` 状态端点用了一次**（`:2235`），`/query` 与 `/documents/upload` 数据面**根本不读这个头**。

**结论**：stock server 的 per-request 换 workspace 是**半成品**（只接了状态上报）。"一个 stock lightrag-server + 请求头切 workspace 服务多 KB" **走不通**——要么一个 workspace 一个进程（违背省资源），要么不用 stock server。

### 2.4 ⚠️ 关键发现：workspace 是「实例级固定」，不是「per-call 可切」

- `aquery` / `ainsert` / `aquery_llm` **均不接受 workspace 参数**，`QueryParam` 无 workspace 字段。
- 实例所有存储在 `initialize_storages()` 时用 `workspace=self.workspace` 焊死（`lightrag.py:1015-1084`）。

**含义**：**一个 LightRAG 实例 = 恰好一个 workspace，运行期不可切**。因此「一个实例 + 按 KB 切 workspace」不存在；哪怕设 `workspace=kb_id`，仍需每 KB 一个实例，**实例数量相同**。workspace 的真正用途是：多实例**共用同一物理后端**（Postgres/Milvus/Redis）时做命名空间前缀隔离；用文件存储（每 KB 一个 `working_dir`）时隔离已由目录实现，workspace 多余。

### 2.5 Hermes / 仓库现有能力（实测）

- Hermes 原生 MCP 客户端：`hermes_cli/mcp_config.py` 管理 `config.yaml` 的 `mcp_servers:`，支持 **stdio（command/args/env）** 与 **url（SSE/HTTP）**；`config.yaml` 已在用（如 `cloudflare_docs`）。
- 仓库已有 `app/mcp_server.py`（stdio）把项目/会话管理暴露成 MCP——"AI Team 出 MCP 注入 Hermes"这条路已走通。
- `mcp` 包支持 **streamable-http + FastMCP**（实测可用）。
- **注意**：AI Team 主服务 `app/server.py` 是 stdlib `BaseHTTPRequestHandler`/`ThreadingHTTPServer`，**非 ASGI**，无法一行 `mount` FastMCP——故 MCP-over-HTTP 以「同进程内独立端口的 ASGI listener」形态运行（见 §4.2）。

### 2.6 业内范式对比：Pre-injection vs Agentic RAG

| 维度 | Pre-retrieval 注入（现状 P3） | Agentic RAG / retriever-as-tool |
|------|------|------|
| 谁决定查不查 | 代码无条件查 | **LLM 自己判断** |
| query | 原始用户消息 | **模型改写/分解后的 query** |
| 多跳/多源 | 不支持 | 支持 |
| 代表实现 | 朴素 RAG | LangChain `create_retriever_tool`、LlamaIndex query-engine-tool、MCP retriever |

> 澄清：单次向量检索本身并不慢（本地 bge，几十毫秒）。现状毛病不是"慢"，而是"不该查时也查 / query 不优化 / 不能多跳"。Agentic RAG 解决的是**按需与质量**。

---

## 3. 收口的设计决策

| 决策 | 结论 |
|------|------|
| **D1 检索范式** | 改 **Agentic（MCP 工具）**，员工 LLM 按需调用、实时返回。**纯 agentic，不保留 pre-injection 兜底**，移除 `runtime_executor.py:144` 的无条件预检索 |
| **D2 LightRAG 接入** | **不起独立 stock server**。维持**嵌入式 Python SDK**（现有 `lightrag_service`），在 **AI Team 同进程内**用 **streamable-http MCP** 暴露检索工具，以 **url** 注册到 Hermes 员工 profile |
| **D3 隔离单元** | **KB = LightRAG 实例 = `working_dir`（`app/.state/lightrag/{kb_id}`）**，沿用现状。embedder 全局共享。MVP 用文件存储，不引入 workspace（详见 §2.4） |
| **D4 工具身份** | 工具对模型只暴露 `knowledge_search(query, top_k?)`。**Agent 身份走连接级凭据（profile 注入的 token），不作为模型参数**，服务端解析授权 |
| **D5 入库职责** | AI Team 只存元数据；用 `lightrag.parser` 做多格式解析；进度复用现有 `KnowledgeIngestionJob` 表；删除 `_read_asset_text` 的 utf-8 自读 |
| **D6 Provider 配置** | LightRAG 的 LLM 凭据改从**企业级 LLM Provider 配置中心**解析；知识库页支持选 Provider/Model |

**为什么 D2 放弃独立 server**：stock server 数据面单 workspace（§2.3），多 KB 要么多进程、要么自己造多 workspace 路由层——而嵌入式核心类**本就支持一进程多实例**（现有 `_instances` 注册表），直接满足多 KB，无需额外常驻服务。净减少一个要部署/鉴权/健康检查的进程。

---

## 4. 目标架构

### 4.1 文档入库链路（落地 D5 + D6）

```
前端上传文件
  → Team Panel：存文档元数据 + KB 绑定 + 建 KnowledgeIngestionJob（status=parsing）
  → 后台异步：lightrag.parser 解析（pdf/docx/...）→ lightrag_service.ingest_document(kb_id, ...)
  → 更新 job/doc 状态（parsing→processing→ready/error）+ chunk_count
前端轮询 Team Panel（北向）→ 读 KnowledgeIngestionJob 状态 → 回显「解析中/已入库/失败」
```

- **删除** `_read_asset_text` 的 utf-8 自读；解析交给 `lightrag.parser`。
- 入库由"列表刷新懒触发"改为**真正的后台异步任务**。
- 进度回显复用 `KnowledgeIngestionJob`（已存在），**不依赖 stock server 的 track_id**。
- LightRAG 实例的 LLM 凭据从 Provider 配置中心解析（替换环境变量硬读）。

### 4.2 对话期检索链路（落地 D1 + D2 + D4）

```
员工 profile 注入：mcp_servers.aiteam-knowledge（url 型）+ 该员工专属 token
用户发消息 → Hermes 执行 → 员工 LLM 判断需要知识时
  → 调 MCP 工具 knowledge_search(query[, top_k])    # 连接头带 token
  → MCP 层：token → employee_id → 查 enabled KB 绑定 → 命中各 KB 实例检索 → 合并
  → 结果 + citations 实时返回给 LLM → LLM 继续生成
Gateway 不再无条件预检索注入（移除 :144）。
```

- MCP 服务形态：**AI Team 同进程内的 FastMCP streamable-http listener（独立端口）**，与 `lightrag_service` 共享模块级全局（`_instances` / `_embedder` / `_loop`）——一个进程、一份 embedder、一套注册表。
- 不走 stdio：stdio 会让 Hermes fork 子进程重载 embedder、自建独立注册表、并与主进程争同一 `working_dir` 文件锁。
- citations 经 Gateway 转成北向 `timeline` 工具事件回流（保持现有 `tool_call` 展示口径）。

### 4.3 授权边界（落地 D4，守 `CLAUDE.md` 红线）

- **模型只填 `query`**；KB ID / Agent ID **都不作为模型参数**。
- **Agent 身份 = 连接级凭据**：每个员工 profile 的 mcp 配置注入专属 token（url query 或 header）。MCP 层用 token 反查 `employee_id`，再 `employee_knowledge_bindings.list_by_employee` 取 enabled KB（该映射 `runtime_executor.py:125` 已在用）。
- 从设计上消除两类越权：模型传任意 `kb_id`（读越权库）、模型冒充他人 `agent_id`（身份冒充）。
- 授权口径归 **Team Panel**；MCP 仅在授权范围内执行检索，不得自定义权限。

### 4.4 KB = 实例 的资源说明（落地 D3）

- 真正占内存的是**数据**（向量/chunks/图），与切片方式无关；embedder 全局共享、event loop 单线程共享，**多实例本身无实质额外开销**。
- 大量 KB 时的资源杠杆是「空闲实例常驻」——未来加 **LRU 淘汰**即可，与 workspace 无关。
- 仅当未来换**共享 DB 后端**（Postgres/Milvus）时，才让每实例带 `workspace=kb_id` 指向共享库——届时 workspace 才登场，现在引入属过度设计。

---

## 5. 实施前仍需细化的点

> 方向已定，以下为实现细节，进入正式实施计划时收口。

1. **token 颁发与校验**：员工专属 MCP token 的生成、存储、注入 profile 的时机；MCP 层校验与 `employee_id` 解析的实现（建议复用现有 auth/profile 同步入口）。
2. **后台入库任务载体**：解析+ingest 的异步执行用什么（线程池 / 现有调度 `scheduled_job_service`），失败重试与并发上限。
3. **多 KB 合并检索语义**：一个员工多 KB 时各取 top_k 后如何合并/排序/去重；citations 如何标注来源 KB。
4. **存量索引**：现有 `app/.state/lightrag/{kb_id}/` 是否需要因 parser/Provider 变更重建。
5. **失败与降级（无兜底前提下）**：检索工具异常返回结构化错误，LLM 用"暂时无法访问知识库"话术，**不静默编造**；LightRAG 异常不拖垮整个 run。
6. **前端两处**：知识库页 Provider/Model 选择；文档列表的解析进度回显（读 job 状态）。

---

## 6. 边界与不做项（防过度设计）

- **不**自建解析器/向量库/检索内核——复用 LightRAG（`CLAUDE.md §3.1`）。
- **不**起独立 stock LightRAG server（§2.3 单 workspace + 多一个常驻进程）。
- **不**为"省资源"引入 workspace（§2.4，解决的不是该问题）。
- **不**在 MCP 工具层暴露写操作（删文档/改图谱）——MVP 只读检索。
- **不**让 Gateway/MCP 定义"谁能访问哪个 KB"——授权归 Team Panel。
- **不**把 Agent/KB 身份做成模型参数——走连接凭据。
- **不**在本轮引入 rerank / 多 KB 智能路由 / LRU 淘汰等增强——先打通 agentic 主链路。

---

## 附：关键代码位置索引

| 关注点 | 位置 |
|--------|------|
| 现状文本自读 / 懒触发入库 | `app/team_panel/api_team/router_team.py` `_read_asset_text`（~1427）、`_advance_pending_knowledge_ingestion`（~1447） |
| 现状嵌入式入库/检索（多实例注册表） | `app/team_panel/integration/lightrag_service.py`（`_instances` / `_get_instance` / `ingest_document` / `query`） |
| 现状预检索注入 | `app/agent_gateway/runtime_executor.py:144`、`_retrieve_knowledge`（~331） |
| 员工→KB 绑定查询 | `runtime_executor.py:125` `employee_knowledge_bindings().list_by_employee` |
| 入库 job 表/repo（进度载体） | `app/team_panel/repositories/knowledge_ingestion_job_repo.py` |
| 现成 MCP server 范式 | `app/mcp_server.py` |
| Hermes MCP 配置 | `hermes-agent/hermes_cli/mcp_config.py`、`hermes-agent/config.yaml` `mcp_servers:` |
| LightRAG stock server 单 workspace 证据 | `lightrag/api/lightrag_server.py:1990/2065-2066/2235`、`routers/query_routes.py` |
| LightRAG workspace 实例级证据 | `lightrag/lightrag.py:189/1015-1084`、`QueryParam` 无 workspace |

## 附：外部资料

- [LightRAG MCP Server (shemhamforash23)](https://github.com/shemhamforash23/lightrag-mcp)
- [Daniel LightRAG MCP Server — 22 工具](https://github.com/desimpkins/daniel-lightrag-mcp)
- [mcp-lightrag (PyPI)](https://pypi.org/project/mcp-lightrag/)
- [LightRAG MCP Server (LobeHub)](https://lobehub.com/mcp/shemhamforash-lightragmcp)
