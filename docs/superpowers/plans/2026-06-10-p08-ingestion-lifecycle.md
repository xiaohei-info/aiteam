# P08 Knowledge Ingestion Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P08 从“文档登记 + 手工改库状态”推进到“文档入库任务会真实推进到 ready/error，且知识库页能重新看到最新状态”。

**Architecture:** 保持现有 Team Panel 路由不扩展，复用 `knowledge_document` / `knowledge_ingestion_job` 现有模型，在读取知识库列表与检索前用一个最小 ingestion sweep 推进 pending job。前端保持现有页面结构，只在上传/重试成功后重刷知识库列表，让用户能看到状态变化。

**Tech Stack:** Python pytest, Node VM-based frontend tests, vanilla JavaScript, Team Panel repositories/routes

---

### Task 1: 为 ingestion sweep 补 layer2 红灯测试

**Files:**
- Modify: `app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py`

- [ ] **Step 1: 写失败测试**

覆盖：
- `POST /api/team/knowledge-bases/{id}/documents` 后，首次 `GET /api/team/knowledge-bases` 会把 `ingesting` 文档推进到 `ready`
- sweep 完成后，`knowledge_document` 与 `knowledge_ingestion_job` 状态都同步更新

- [ ] **Step 2: 跑测试确认失败**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py::TestKnowledgeDocumentPost::test_knowledge_bases_list_advances_ingesting_document_to_ready -q`

Expected: FAIL，原因是当前没有任何代码消费 pending ingestion job

- [ ] **Step 3: 写最小实现**

实现一个最小 ingestion sweep：
- 默认把 pending/parsing/inserting 的文档推进为 `ready`
- 同步写回 `knowledge_document.status/rag_document_id/chunk_count`
- 同步写回 `knowledge_ingestion_job.status/rag_document_id/chunk_count`

- [ ] **Step 4: 跑测试确认通过**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py::TestKnowledgeDocumentPost::test_knowledge_bases_list_advances_ingesting_document_to_ready -q`

Expected: PASS

### Task 2: 为知识页上传/重试后的状态回刷补 layer4 红灯测试

**Files:**
- Modify: `app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py`

- [ ] **Step 1: 写失败测试**

覆盖：
- 上传成功后会再次调用 `getKnowledgeBases()`，页面能看到新的文档状态
- 重试成功后会再次调用 `getKnowledgeBases()`，页面能看到新的文档状态

- [ ] **Step 2: 跑测试确认失败**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_refreshes_list_after_upload_success app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_refreshes_list_after_retry_success -q`

Expected: FAIL，原因是当前页面只显示 feedback，不会重刷知识库列表

- [ ] **Step 3: 写最小实现**

在 `app/static/aiteam/pages/knowledge.js` 中抽出“加载并渲染知识库”的最小 helper，并在 upload/retry 成功后调用。

- [ ] **Step 4: 跑测试确认通过**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_refreshes_list_after_upload_success app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_refreshes_list_after_retry_success -q`

Expected: PASS

### Task 3: 跑知识库相关回归并提交

**Files:**
- Test: `app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py`
- Test: `app/tests/aiteam/layer5_flows/test_private_chat_flow.py`
- Test: `app/tests/aiteam/layer5_flows/test_group_conversation_flow.py`

- [ ] **Step 1: 跑目标测试**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py::TestKnowledgeDocumentPost::test_knowledge_bases_list_advances_ingesting_document_to_ready app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_refreshes_list_after_upload_success app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_refreshes_list_after_retry_success -q`

- [ ] **Step 2: 跑知识库主回归**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py app/tests/aiteam/layer5_flows/test_private_chat_flow.py app/tests/aiteam/layer5_flows/test_group_conversation_flow.py -q`

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/plans/2026-06-10-p08-ingestion-lifecycle.md app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py app/static/aiteam/pages/knowledge.js app/team_panel/api_team/router_team.py
git commit -m "feat(aiteam): advance knowledge ingestion states"
```
