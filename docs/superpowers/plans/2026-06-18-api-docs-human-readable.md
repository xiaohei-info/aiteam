# API Docs Human Readable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/api/docs` 准确展示当前前端真实接入的后端接口，并以可直接复制调用的方式展示入参、出参和错误信息。

**Architecture:** 保留 `app/api/api_docs.py` 作为 OpenAPI 手写注册表来源，先修正文档定义与真实 handler 的偏差，再把 `/api/docs` 从原始 OpenAPI JSON dump 改成面向调用者的文档视图。`/api/openapi.json` 继续输出标准 OpenAPI 3.0.3 机器可读文档。

**Tech Stack:** Python, hand-written OpenAPI registry, self-contained HTML/CSS, pytest

---

### Task 1: 锁定准确性与可读性回归

**Files:**
- Modify: `app/tests/base/test_api_docs_openapi.py`
- Verify: `pytest app/tests/base/test_api_docs_openapi.py -q`

- [ ] 把 `/api/auth/login` 的文档断言改成真实口径：只要求 `password`，且不再出现 `email`
- [ ] 为 `/api/docs` HTML 增加可读性断言：页面必须出现“请求 JSON 示例”“响应 JSON 示例”“字段说明”等面向调用者的展示
- [ ] 为登录接口页面断言加入可复制 JSON 示例，确保示例是 `{"password": ...}` 口径

### Task 2: 修正文档数据源

**Files:**
- Modify: `app/api/api_docs.py`
- Verify: `pytest app/tests/base/test_api_docs_openapi.py::TestOpenApiSpec::test_documents_auth_login_and_wechat_flow -q`

- [ ] 修正 `/api/auth/login` 注册表定义，使请求体、说明文案、错误说明与真实 handler 一致
- [ ] 审查并补充文档元数据辅助函数，给人类可读页面生成字段说明、必填标记、示例 JSON、响应摘要提供统一数据来源

### Task 3: 重写 `/api/docs` 展示层

**Files:**
- Modify: `app/api/api_docs.py`
- Verify: `pytest app/tests/base/test_api_docs_openapi.py::TestSwaggerUiHtml -q`

- [ ] 把每个接口渲染为标准文档块：方法、路径、用途、请求头、参数表、请求体字段表、请求 JSON 示例、响应字段表、响应 JSON 示例、错误响应
- [ ] 保留 `OpenAPI JSON` 入口，但正文不再直接输出 requestBody/responses 的原始 JSON 结构
- [ ] 保证移动端与桌面端都能正常阅读，示例代码块可直接复制

### Task 4: 全量验证

**Files:**
- Verify only

- [ ] 运行 `pytest app/tests/base/test_api_docs_openapi.py -q`
- [ ] 如有必要，补充一次 `pytest app/tests/base/test_sprint19.py -q`
- [ ] 确认 `/api/openapi.json` 仍然是合法 OpenAPI 结构，`/api/docs` 仍然由 `handle_get` 正常对外提供
