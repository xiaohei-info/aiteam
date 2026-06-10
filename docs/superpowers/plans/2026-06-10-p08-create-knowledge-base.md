# P08 Create Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 P08 补齐“创建知识库”最小闭环，让知识页在空态下可以直接创建知识库，而不是只能显示空提示。

**Architecture:** 保持现有 Team Panel `knowledge_base` 领域模型不扩新表，只在 `router_team.py` 增加 `POST /api/team/knowledge-bases` 最小写入口，并在 `knowledge.js` 空态下渲染创建表单。创建成功后继续复用现有 `GET /api/team/knowledge-bases` 刷新列表。

**Tech Stack:** Python pytest, Node VM-based frontend tests, vanilla JavaScript, Team Panel repositories/routes

---

### Task 1: 为创建知识库补 layer2 红灯测试

**Files:**
- Modify: `app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py`

- [ ] **Step 1: 写失败测试**

覆盖：
- `POST /api/team/knowledge-bases` 成功创建并返回稳定 contract
- 缺失 `name` 时返回 400

- [ ] **Step 2: 跑测试确认失败**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py::TestKnowledgeBasePost::test_post_knowledge_base_creates_new_base app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py::TestKnowledgeBasePost::test_post_knowledge_base_requires_name -q`

Expected: FAIL，原因是当前没有 `POST /api/team/knowledge-bases`

- [ ] **Step 3: 写最小实现**

在 `router_team.py` 中补：
- 读取 `name` / `description`
- 生成 `knowledge_base_id`
- 写入 `knowledge_base`
- 返回最小响应 shape

- [ ] **Step 4: 跑测试确认通过**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py::TestKnowledgeBasePost::test_post_knowledge_base_creates_new_base app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py::TestKnowledgeBasePost::test_post_knowledge_base_requires_name -q`

Expected: PASS

### Task 2: 为知识页空态创建入口补 layer4 红灯测试

**Files:**
- Modify: `app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py`

- [ ] **Step 1: 写失败测试**

覆盖：
- 空知识库时页面渲染“创建知识库”表单
- 提交后调用 `postKnowledgeBase`
- 创建成功后刷新列表并显示新知识库

- [ ] **Step 2: 跑测试确认失败**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_renders_create_form_when_empty app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_creates_kb_and_refreshes_list -q`

Expected: FAIL，原因是当前空态直接 `renderEmpty`，没有创建交互

- [ ] **Step 3: 写最小实现**

在 `api-client.js` 中补 `postKnowledgeBase()`；
在 `knowledge.js` 中为空态渲染创建表单，成功后 `reloadKnowledgeBases(container)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_renders_create_form_when_empty app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_creates_kb_and_refreshes_list -q`

Expected: PASS

### Task 3: 跑知识库相关回归并提交

**Files:**
- Test: `app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py`
- Test: `app/tests/aiteam/layer5_flows/test_private_chat_flow.py`
- Test: `app/tests/aiteam/layer5_flows/test_group_conversation_flow.py`

- [ ] **Step 1: 跑目标测试**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py::TestKnowledgeBasePost::test_post_knowledge_base_creates_new_base app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py::TestKnowledgeBasePost::test_post_knowledge_base_requires_name app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_renders_create_form_when_empty app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py::test_knowledge_module_creates_kb_and_refreshes_list -q`

- [ ] **Step 2: 跑知识库主回归**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py app/tests/aiteam/layer5_flows/test_private_chat_flow.py app/tests/aiteam/layer5_flows/test_group_conversation_flow.py -q`

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/plans/2026-06-10-p08-create-knowledge-base.md app/static/aiteam/api-client.js app/static/aiteam/pages/knowledge.js app/team_panel/api_team/router_team.py app/tests/aiteam/layer2_team_panel/test_knowledge_office_contracts.py app/tests/aiteam/layer4_frontend_bff/test_knowledge_page.py
git commit -m "feat(aiteam): add knowledge base creation"
```
