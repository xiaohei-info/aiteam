# AI Team — 知识库 RAG 接入与 Agentic 检索改造调研方案

> 状态：**待 Review（方向已收口，实施计划未出）**
> 日期：2026-06-12
> 范围：知识库文档入库职责、LightRAG 接入方式、对话期 RAG 检索范式
> 关联：`业务解决方案设计 §5.2-A / §7.2`、`CLAUDE.md` 架构边界、`Gateway执行链路实现口径与设计差异备案`

本文档先把**现状问题**与**调研事实**讲清楚，再给出**已确认的两个方向决策**与**目标架构**，最后列出**待 Review / 待定的关键设计点**。结论之前的事实均经过本地代码与依赖实测、以及外部资料核对。

---

## 1. 背景：三个被质疑的现状问题

| # | 现状 | 问题 |
|---|------|------|
| P1 | 文档上传后由 AI Team 后端用 `read_text(utf-8)` 自己读文本，再进程内调 LightRAG 做 chunk+embed（`router_team.py:_read_asset_text` → `lightrag_service.ingest_document`） | 解析职责放错层；无解析器导致**实际只能吃纯文本**，页面文案宣称的 PDF/Word/Excel 不可用；无标准化进度回显 |
| P2 | LightRAG 的 LLM 凭据从环境变量 `LIGHTRAG_LLM_API_KEY` / `OPENROUTER_API_KEY` 硬读 | 未与企业级 LLM Provider 配置中心打通；知识库页面无法配置 Provider/Model |
| P3 | 每个 run **无条件预检索注入**：用用户原始消息当 query 去检索，结果拼进 prompt 再发给 Hermes（`runtime_executor.py:144`） | 不该查时也查（闲聊污染上下文/浪费 token）；query 未改写（多轮指代检索不准）；无法多跳/多源；不符合业内 Agentic RAG 最佳实践 |

---

## 2. 调研事实（实测 + 资料核对）

### 2.1 LightRAG 自身能力（实测 v1.5.2）

当前安装版本 `lightrag 1.5.2`（`app/.venv`）自带以下模块：

- **`lightrag.parser`** — 原生文档解析，支持 **pdf / docx / doc / html / md / json**（当前实现完全没用到它）
- **`lightrag.api`（LightRAG Server）** — 完整 REST 服务，命令行入口 `lightrag-server`（默认端口 9621）、`lightrag-gunicorn`
  - `POST /documents/upload`：**上传即返回 `track_id`，后台异步处理**
  - `GET` 按 `track_id` 查处理状态/进度（`upload→parsing→processing→processed/failed`）
  - `POST /query`、`POST /query/stream`：检索，`mode ∈ {local, global, hybrid, naive, mix, bypass}`，支持 `top_k`、`include_references`、`conversation_history`
- **`lightrag.chunker` / `lightrag.kg`** — 切块与图谱存储

**结论**：当前实现绕过了 LightRAG 自己的解析管线和文档 API，自造了一个能力更弱的纯文本入库——P1 属实。

### 2.2 LightRAG 是否暴露 MCP？与 agent 的标准集成方式

> 这是本轮重点确认项。

**官方包不带 MCP server。** 实测 `lightrag 1.5.2` 的 console_scripts 只有 `lightrag-server` / `lightrag-gunicorn` 等，全包 grep `mcp` 仅命中 swagger 静态资源（误报）。LightRAG 对 agent 暴露的官方接口只有两种：

- **(a) REST API**：`lightrag-server` 进程，OpenAPI/Swagger 文档化（`/query`、`/documents/*` 等）
- **(b) Python 嵌入式**：进程内 `rag.aquery(query, QueryParam(mode=...))`（**当前 `lightrag_service` 走的就是这种**）

**LightRAG + Agent 的三种集成范式：**

| 方式 | 形态 | 谁决定何时检索 |
|------|------|----------------|
| REST 直连 | agent 业务代码调 `/query` | 业务代码（可预检索，也可包成工具） |
| Python 嵌入 | 进程内 `aquery` | 业务代码 |
| **MCP 工具** | 把检索/文档操作包成 MCP server，交给 LLM | **LLM 自主按需调用** |

**社区已有成熟的 LightRAG MCP server（第三方，非官方）**，且**全部是架在 LightRAG REST Server 之上的薄包装**：

- `desimpkins/daniel-lightrag-mcp` — 22 个工具（文档管理 6 + 查询 2 + 知识图谱 6 + 系统 4）
- `shemhamforash23/lightrag-mcp` — 连接 `localhost:9621` 的 REST API，支持 **stdio + streamable-http** 传输，暴露 `query_document` / `upload_document` / `get_pipeline_status` / `create_entities` 等
- `mcp-lightrag`（PyPI）、`enriquecatala/mcp-lightrag`（Obsidian 向）等

**对本方案的含义（关键）**：

1. 我们选定的 **"独立 LightRAG Server + Agentic MCP 工具"** 两个方向**天然契合**——社区做法正是 `MCP → LightRAG REST(:9621)`。技术路径已被验证可行。
2. **但不建议直接套用社区 MCP server**，必须自研最小版，原因见 §4.3：
   - 社区 server 暴露 22 个工具（含删文档、改图谱），**权限面过大**，违反 `CLAUDE.md`「工具/Gateway 层不得定义业务对象与权限」——员工 LLM 绝不应能删库改图谱。
   - 社区 server 面向**单 LightRAG 实例**；我们是「每个 KB 一个 working_dir」+「员工可访问哪些 KB 由 Team Panel 决定」的**多租户授权**模型，社区 server 没有这层。
   - KB→工具绑定、检索 citations 回流北向 `timeline` 事件，都是我们的业务口径。

### 2.3 Hermes 对 MCP / 工具调用的支持（实测）

- Hermes 是完整 function-calling agent（`anthropic_adapter` / `gemini` / `codex` 等多家 adapter）
- **原生 MCP 客户端**：`hermes_cli/mcp_config.py` 管理 `config.yaml` 的 `mcp_servers:` 段；支持 **stdio（command/args/env）** 与 **url（SSE/HTTP）** 两种 transport
- `config.yaml` 现已在用 `mcp_servers:`（如 `cloudflare_docs` 走 url）
- 本仓库**已有 `app/mcp_server.py`**：把 WebUI 项目/会话管理暴露成 MCP 工具——**「自研薄 MCP server 注入 Hermes profile」这条路在本仓库已经走通过**

**结论**：把知识检索做成 MCP 工具、由员工 LLM 按需调用，Hermes 侧零障碍，且有现成范式可循。

### 2.4 业内范式对比：Pre-injection vs Agentic RAG

| 维度 | Pre-retrieval 注入（现状 P3） | Agentic RAG / retriever-as-tool |
|------|------|------|
| 谁决定查不查 | 代码无条件查 | **LLM 自己判断** |
| query | 原始用户消息 | **模型改写/分解后的 query** |
| 多跳/多源 | 不支持 | 支持 |
| 代表实现 | 朴素 RAG | LangChain `create_retriever_tool`+agent、LlamaIndex query-engine-tool、MCP retriever |
| 首 token 延迟 | 稳定一跳 | 多一次工具决策往返 |
| 适用 | 每轮都该查的窄场景 | 通用助手、闲聊+检索混合、多轮追问 |

> 澄清一个常见误解：**单次向量检索本身并不慢**（本地 bge，几十毫秒）。现状的真正毛病不是"慢"，而是"不该查时也查 / query 不优化 / 不能多跳"。Agentic RAG 解决的是**按需与质量**。

---

## 3. 已收口的方向决策

经与负责人确认：

- **D1 — 检索范式：改 Agentic（MCP 工具）。** 检索从「Gateway 无条件预注入」改为「员工 LLM 通过 MCP 工具按需调用、实时返回」。
- **D2 — LightRAG 接入：独立 LightRAG Server。** 起独立 `lightrag-server` 进程走 HTTP API，复用其原生 `track_id` 进度与多格式 parser。

P1（上传职责）、P2（Provider 配置）的方向本身明确，随 D1/D2 一并落地。

---

## 4. 目标架构

### 4.1 文档入库链路（落地 P1 + D2）

```
前端上传文件
  → Team Panel: 存文档元数据 + KB 绑定 + 占位 track_id（不读文本、不解析）
  → Team Panel → LightRAG Server  POST /documents/upload（原始文件）→ 返回 track_id
  → Team Panel 持久化 track_id
前端轮询 Team Panel（北向）→ Team Panel 转查 LightRAG track_id 状态 → 回显「解析中/已入库/失败」
```

- **删除** `_read_asset_text` 的 utf-8 自读逻辑与进程内 `ingest_document`。
- 解析/切块/embed 全部交给 LightRAG Server；AI Team 只持有业务元数据与 `track_id` 映射。
- 多格式（PDF/Word/…）由 LightRAG parser 负责，前端 `accept` 与文案随之对齐到真实能力。

### 4.2 对话期检索链路（落地 P3 + D1）

```
员工 profile 注入：mcp_servers.aiteam-knowledge（stdio 或 url）+ 该员工可访问的 KB 范围
用户发消息 → Hermes 执行 → 员工 LLM 判断需要知识时
  → 调 MCP 工具 knowledge_search(query)
  → MCP server 按注入的 KB 范围转调 LightRAG /query
  → 结果实时返回给 LLM → LLM 继续生成
Gateway 不再无条件预检索注入。
```

- Gateway `runtime_executor.py:144` 的无条件预检索**移除**（或降级为可配置兜底，见 §5）。
- citations：MCP 工具结果经 Gateway 转成北向 `timeline` 的工具事件回流（保持现有 `tool_call` 展示口径）。

### 4.3 自研 MCP server 设计原则（不套用社区版）

- **位置**：新增 `app/agent_gateway/`（或独立模块）下的最小 MCP server，**复用 `app/mcp_server.py` 已验证的 stdio 模式**。
- **最小工具面**：MVP 只暴露 **一个受控工具** `knowledge_search(query, top_k?)`。
  - **KB 范围不由 LLM 选**：由 Team Panel 写入员工 profile 的 MCP 配置（env/args），server 启动时绑定。LLM 只能在「该员工被授权的 KB 集合」内检索。
  - **只读**：MVP 不暴露删文档/改图谱等写操作工具（与社区 22 工具版的本质区别）。
- **授权口径归属 Team Panel**：「员工能访问哪些 KB」是业务对象，必须由 Team Panel 决定并注入；MCP server 只做检索执行，**不得自定义权限**（`CLAUDE.md` 红线）。

### 4.4 Provider 配置（落地 P2）

- KB 表新增 `llm_provider_id` / `model`（embedding 模型可选配，默认本地 bge）。
- 启动 LightRAG Server / 实例时从**企业级 LLM Provider 配置中心**解析凭据，替换环境变量硬读。
- 知识库管理页增加 Provider/Model 选择，直接复用已配置的 provider 列表。

---

## 5. 待 Review / 待定的关键设计点

> 以下需要负责人在 Review 时拍板，再进入正式实施计划（writing-plans）。

1. **MCP transport 选型**：知识 MCP server 用 **stdio**（每 profile 起子进程，隔离强、与现有 `app/mcp_server.py` 一致）还是 **streamable-http/SSE**（常驻一个 server，多 profile 共享，靠参数区分 KB 范围）？倾向 stdio 起步。
2. **LightRAG Server 部署形态**：独立进程如何纳入 `app/ctl.sh` / docker-compose 编排与健康检查？端口、鉴权（LightRAG Server 自带 auth）、与 `HERMES_*` 运行口径如何协调。
3. **是否保留 pre-injection 兜底**：完全移除，还是保留为「员工级开关」（某些强知识依赖岗位默认预注入，通用岗位走 agentic）？影响 D1 的彻底程度。
4. **存量数据迁移**：现有 `app/.state/lightrag/{kb_id}/` 的嵌入式索引，与独立 LightRAG Server 的存储目录/配置如何衔接，是否需要重建索引。
5. **KB 多选检索语义**：一个员工绑定多个 KB 时，`knowledge_search` 是合并检索还是按 KB 分工具暴露；与 LightRAG「每实例一 working_dir」如何映射（单 server 多 workspace vs 多 server）。
6. **失败与降级**：LightRAG Server 不可用 / track_id 处理失败时的状态机与前端回显，以及检索工具异常时 LLM 的兜底话术。

---

## 6. 边界与不做项（防过度设计）

- **不**自建解析器/向量库/检索内核——全部复用 LightRAG（`CLAUDE.md §3.1`）。
- **不**在 MCP 工具层暴露写操作（删文档、改图谱）——MVP 只读检索。
- **不**让 Gateway/MCP 定义「谁能访问哪个 KB」——授权归 Team Panel。
- **不**在本轮引入 rerank / 多 KB 智能路由等增强——先打通 agentic 主链路。

---

## 附：关键代码位置索引

| 关注点 | 位置 |
|--------|------|
| 现状文本自读 | `app/team_panel/api_team/router_team.py` `_read_asset_text`（~1427）、`_advance_pending_knowledge_ingestion`（~1447） |
| 现状嵌入式入库/检索 | `app/team_panel/integration/lightrag_service.py` |
| 现状预检索注入 | `app/agent_gateway/runtime_executor.py:144`、`_retrieve_knowledge`（~331） |
| 编排路径复用 | `app/agent_gateway/orchestration_executor.py:523` |
| 现成 MCP server 范式 | `app/mcp_server.py` |
| Hermes MCP 配置 | `hermes-agent/hermes_cli/mcp_config.py`、`hermes-agent/config.yaml` `mcp_servers:` |
| 文档上传 POST | `router_team.py` `_handle_knowledge_document_post`（~1584） |

## 附：外部资料

- [LightRAG MCP Server (shemhamforash23)](https://github.com/shemhamforash23/lightrag-mcp)
- [Daniel LightRAG MCP Server — 22 工具](https://github.com/desimpkins/daniel-lightrag-mcp)
- [mcp-lightrag (PyPI)](https://pypi.org/project/mcp-lightrag/)
- [LightRAG MCP Server (LobeHub)](https://lobehub.com/mcp/shemhamforash-lightragmcp)
