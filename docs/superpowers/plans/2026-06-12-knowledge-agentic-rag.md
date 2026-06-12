# 知识库 Agentic RAG 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把知识库从"AI Team 自读纯文本 + Gateway 无条件预检索注入"改造为"LightRAG parser 多格式入库 + 员工 LLM 按需调用 MCP 检索工具"，并让 LightRAG 凭据走企业 Provider 配置中心。

**Architecture:** 维持 LightRAG 嵌入式 SDK（`lightrag_service` 的 `_instances` 多实例，KB=instance）。新增一个 AI Team 同进程内的 FastMCP streamable-http 服务（回环端口），暴露唯一只读工具 `knowledge_search(query, top_k?)`；身份走 `Authorization: Bearer <employee_id>` header（回环绑定，模型不可篡改），服务端按 employee 解析 enabled KB 绑定后检索合并。员工 profile 的 `config.yaml` 注入该 MCP url+token；移除 `runtime_executor` 的预检索注入。

**Tech Stack:** Python, LightRAG 1.5.2 (`lightrag.parser` / 嵌入式), `mcp` FastMCP (streamable-http), Hermes MCP client (url + headers), stdlib http.server (主进程), pytest。

设计依据：`docs/技术设计/详细设计文档/2026-06-12-AI Team-知识库RAG接入与Agentic检索改造调研方案.md`（D1–D6）。

---

## 关键现状（已实测，供执行者参考）

- `app/team_panel/integration/lightrag_service.py`：`_instances:{kb_id→LightRAG}`；`_get_instance(kb_id)`（working_dir=`app/.state/lightrag/{kb_id}`）；`ingest_document(kb_id, rag_document_id, text, file_name)`；`query(kb_id, question, top_k)`；`_build_llm_func()` 当前读环境变量 `LIGHTRAG_LLM_API_KEY`。
- `app/team_panel/api_team/router_team.py`：`_read_asset_text(doc)`（~1427，utf-8 自读）；`_advance_pending_knowledge_ingestion(conn,kb_id=None)`（~1447，懒触发）；`_handle_knowledge_document_post`（~1584）。
- `app/agent_gateway/runtime_executor.py`：预检索在 `:144` `_retrieve_knowledge(kb_ids,message_text)`（~331）；`_compose_prompt`（~181）拼 knowledge_block；`_provision_profile`（~313）；`_profile_home`（~62）。
- `app/agent_gateway/profile_provisioner.py`：`ensure_profile` / `_seed_profile_config`（每次 ensure 用 root 覆盖 profile config.yaml）/ `set_profile_model`（写 model 块，是"seed 后再补"的范式）。
- Provider 中心：`uow.llm_providers().list_by_enterprise(eid)` → `EnterpriseLlmProvider(provider_key,base_url,api_key,transport)`；`uow.llm_models().list_by_enterprise(eid)` → `EnterpriseLlmModel(model_id,is_default,enabled,provider_id,context_length)`。
- 员工→KB：`uow.employee_knowledge_bindings().list_by_employee(employee_id)`（过滤 `enabled`）。
- Hermes url-mcp 配置（`hermes-agent/tools/mcp_tool.py:29`）：`mcp_servers.<name>: {url, headers:{Authorization: "Bearer .."}}`，streamable-http。
- `app/server.py`：`main()` 在 `httpd.serve_forever()`（~494/520）前有启动区，`start_watcher()` 在此启动——MCP listener 线程在同处启动。

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `app/team_panel/integration/lightrag_service.py` | 嵌入式 LightRAG；新增 provider 凭据解析 + parser 文本抽取入口 | Modify |
| `app/team_panel/integration/knowledge_mcp_server.py` | 新增：FastMCP streamable-http，工具 `knowledge_search`，header→employee→KB 检索 | Create |
| `app/agent_gateway/profile_provisioner.py` | 新增 `set_profile_mcp(profile_dir, url, token)` | Modify |
| `app/agent_gateway/runtime_executor.py` | `_provision_profile` 注入 MCP；移除预检索注入 | Modify |
| `app/team_panel/api_team/router_team.py` | `_read_asset_text` 改 parser；入库用 provider 凭据 | Modify |
| `app/server.py` | 启动区拉起 MCP listener 线程 | Modify |
| `static/aiteam/pages/knowledge.js` | accept 对齐真实格式；Provider/Model 选择；进度回显 | Modify |
| `app/tests/aiteam/...` | 新增/回归测试 | Create |

---

## Task 1: lightrag_service 凭据走 Provider 配置中心（D6）

**Files:**
- Modify: `app/team_panel/integration/lightrag_service.py`（`_llm_credentials` / `_build_llm_func`）
- Test: `app/tests/aiteam/layer2_team_panel/test_lightrag_provider_creds.py`

- [ ] **Step 1: 失败测试** — `_llm_credentials_from_provider(provider_dict)` 给定 `{provider_key,base_url,api_key,default_model}` 返回 `(api_key, base_url, model)`；空 api_key 返回 None。
- [ ] **Step 2: 跑测试确认 FAIL**（函数未定义）。
- [ ] **Step 3: 实现** `_llm_credentials_from_provider`，并让 `_build_llm_func(creds=None)` 接受显式 creds，优先于环境变量；`ingest_document` / `query` 增加可选 `llm_provider:dict|None` 形参，向下传。保持无 provider 时退化为纯向量（现有行为不破坏）。
- [ ] **Step 4: 跑测试确认 PASS**：`pytest app/tests/aiteam/layer2_team_panel/test_lightrag_provider_creds.py -v`
- [ ] **Step 5: commit** `feat(knowledge): lightrag 凭据支持从 provider dict 解析`

## Task 2: parser 多格式文本抽取（D5）

**Files:**
- Modify: `app/team_panel/api_team/router_team.py`（`_read_asset_text` → 复用 parser）
- Create: `app/team_panel/integration/document_parser.py`（封装 `lightrag.parser`）
- Test: `app/tests/aiteam/layer2_team_panel/test_document_parser.py`

- [ ] **Step 1: 失败测试** — `extract_text(path)`：`.md`/`.txt` 返回原文；`.pdf`/`.docx` 调 lightrag parser；未知扩展名按 utf-8 文本兜底。用临时 `.md` 与 `.txt` 文件断言原文返回。
- [ ] **Step 2: 跑测试确认 FAIL**。
- [ ] **Step 3: 实现** `document_parser.extract_text(path)`：按扩展名路由；文本类直接读；二进制类 `from lightrag.parser import ...` 解析为纯文本；解析失败抛带文件名的异常。`_read_asset_text` 改为定位文件后调 `extract_text`。
- [ ] **Step 4: 跑测试确认 PASS**。
- [ ] **Step 5: commit** `feat(knowledge): 文档入库改用 lightrag.parser 支持多格式`

## Task 3: MCP knowledge_search 服务（D2/D4 核心）

**Files:**
- Create: `app/team_panel/integration/knowledge_mcp_server.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_knowledge_mcp.py`

- [ ] **Step 1: 失败测试** — `resolve_employee_kb_ids(conn, employee_id)` 返回该员工 enabled KB id 列表；`search_for_employee(conn, employee_id, query, top_k)` 对每个 KB 调 `lightrag_service.query` 合并去重，返回 `{chunks:[{content,doc_id,file_name,kb_id,score}], citations:[...]}`。无绑定返回空。
- [ ] **Step 2: FAIL**。
- [ ] **Step 3: 实现** 这两个纯函数（不依赖 FastMCP，便于测）；再写 `build_mcp_app(conn_factory)`：FastMCP 实例，工具 `knowledge_search(query:str, top_k:int=5)`，从 `request_context` 取 `Authorization: Bearer <employee_id>` → `search_for_employee`；缺/坏 token 返回结构化错误 `{"error":"unauthenticated"}`。`streamable_http_app()` 暴露 ASGI。
- [ ] **Step 4: PASS**：`pytest app/tests/aiteam/layer2_team_panel/test_knowledge_mcp.py -v`
- [ ] **Step 5: commit** `feat(knowledge): 新增 MCP knowledge_search 服务（按员工授权检索）`

## Task 4: profile 注入 MCP（D2/D4）

**Files:**
- Modify: `app/agent_gateway/profile_provisioner.py`（新增 `set_profile_mcp`）
- Modify: `app/agent_gateway/runtime_executor.py`（`_provision_profile` 调用）
- Test: `app/tests/aiteam/layer3_gateway/test_profile_mcp_inject.py`

- [ ] **Step 1: 失败测试** — `set_profile_mcp(profile_dir, url, token)` 写入 `config.yaml` 的 `mcp_servers.aiteam-knowledge = {url, headers:{Authorization:"Bearer "+token}, transport...}`，保留其它字段；token 为空时不写。
- [ ] **Step 2: FAIL**。
- [ ] **Step 3: 实现** `set_profile_mcp`（仿 `set_profile_model` 的 yaml 读改写）；在 `_provision_profile(profile_name, system_prompt, employee_id)` 末尾、seed 之后调用，url 取 `AITEAM_KNOWLEDGE_MCP_URL`（默认 `http://127.0.0.1:{MCP_PORT}/mcp`），token=employee_id。
- [ ] **Step 4: PASS**。
- [ ] **Step 5: commit** `feat(knowledge): profile 注入 knowledge MCP（url+token）`

## Task 5: 移除预检索注入（D1，纯 agentic 无兜底）

**Files:**
- Modify: `app/agent_gateway/runtime_executor.py`（删 `:144-153` 预检索 + `_compose_prompt` 的 knowledge_block 分支；保留 `_retrieve_knowledge` 暂作死代码删除或留作内部?→删除）
- Modify: `app/agent_gateway/orchestration_executor.py`（`:523` 同步移除）
- Test: 回归 `app/tests/aiteam/layer5_flows/test_private_chat_flow.py`

- [ ] **Step 1:** 改 `process_run`：删除 `knowledge_block, citations = _retrieve_knowledge(...)` 与其后的 tool_call 注入；`full_prompt = _compose_prompt(system_prompt, message_text)`（去掉 knowledge 形参）。删 `_retrieve_knowledge` 及 orchestration 调用。
- [ ] **Step 2:** 跑私聊流程回归 `pytest app/tests/aiteam/layer5_flows/test_private_chat_flow.py -v`，按失败修正断言（移除对预检索 citations 的期望）。
- [ ] **Step 3: commit** `refactor(knowledge): 移除 Gateway 预检索注入，改走 agentic MCP`

## Task 6: server.py 启动 MCP listener（同进程独立端口）

**Files:**
- Modify: `app/server.py`（`main()` 启动区）
- Modify: `app/api/config.py`（新增 `KNOWLEDGE_MCP_PORT` 默认 9701，绑 127.0.0.1）
- Test: `app/tests/aiteam/layer3_gateway/test_mcp_listener_boot.py`（import + app 构造冒烟）

- [ ] **Step 1: 冒烟测试** — `knowledge_mcp_server.build_mcp_app` 可构造、`/mcp` ASGI app 非空。
- [ ] **Step 2:** 实现：`start_knowledge_mcp()` 在守护线程里用 uvicorn 跑 `streamable_http_app()` 于 `127.0.0.1:KNOWLEDGE_MCP_PORT`；在 `start_watcher()` 旁 try/except 启动，失败仅告警不阻断主服务。
- [ ] **Step 3:** 跑冒烟测试 PASS。
- [ ] **Step 4: commit** `feat(knowledge): 主进程内拉起 knowledge MCP listener`

## Task 7: 前端 — 格式对齐 + Provider 选择 + 进度回显

**Files:**
- Modify: `static/aiteam/pages/knowledge.js`（`accept`、Provider/Model 选择、文档进度列）
- Modify: `app/team_panel/api_team/router_team.py`（KB create/patch 接收 `llm_provider_key`/`model`）
- Test: `app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py`（断言渲染包含进度/Provider 控件）

- [ ] **Step 1:** `accept` 改为 `.txt,.md,.markdown,.csv,.json,.log,.html,.pdf,.doc,.docx`；文案与真实能力一致。
- [ ] **Step 2:** KB 表单加 Provider/Model 下拉（数据取已配置 provider）；文档列表展示 `status`（解析中/已入库/失败）。
- [ ] **Step 3:** 后端 KB create/patch 持久化 `llm_provider_key`/`model`，入库时透传给 `lightrag_service`。
- [ ] **Step 4:** 跑页面渲染测试 PASS。
- [ ] **Step 5: commit** `feat(knowledge): 前端格式对齐+Provider配置+进度回显`

---

## 验证（任务级，不跑全量回归）

1. **单测**：Task 1–7 各自 pytest 子集全绿。
2. **入库链路**：脚本上传一个 `.md` 文档 → 轮询 job 状态到 `completed` → `chunk_count>0`。
3. **MCP 检索**：起 MCP listener，用 `mcp` 客户端带 `Authorization: Bearer <employee_id>` 调 `knowledge_search`，返回命中 chunk；带错误 token 返回 `unauthenticated`。
4. **端到端（条件具备时）**：一个绑定了 KB 的员工私聊提一个知识相关问题 → 北向 timeline 出现 `knowledge_search` 工具事件 → 回答引用知识。无 Hermes 环境时，至少完成 1–3 并说明 4 的验证方式。

## Self-Review 摘要

- 覆盖 D1（Task5）/D2（Task3,4,6）/D3（沿用现状，无任务）/D4（Task3,4）/D5（Task2）/D6（Task1,7）。
- 风险点：FastMCP header 读取 API 细节（Task3 实现时以 `request_context` 落地）；uvicorn 在守护线程跑 ASGI（Task6）；私聊回归断言可能依赖旧 citations（Task5 已预案）。
