---
created: 2026-08-20
status: approved-by-current-request
scope: rag-knowledge-get
---

# RAG knowledge_get 切片计划

## 目标

补齐 Agent Pi 的 `knowledge_get(citation_id)`，但不把 LightRAG 原生存储暴露给 Agent。Manager 重新授权 citation 后，从 Manager-owned authoritative document storage 读取受限文本。

## 语义

- citation 采用现有稳定格式 `citation:{knowledge_space_id}:{document_id}`；不接受 workspace、storage_key、file_path 或任意 document ID。
- 每次 get 重新执行当前 member/employee/snapshot/binding/ready/tenant 校验；撤权、禁用、过期或 stale binding 立即拒绝。
- 内容来源是 Manager intake 的安全 storage root，沿用 root/path-fence 和已有 parser；LightRAG `/query/data` 只负责 search，不伪造 exact-get。
- 返回 bounded citation JSON，正文最多 4,000 字符，不泄漏绝对路径、workspace、PG 表、key 或跨 tenant 错误细节。

## 实施文件

- Manager `server/manager_service/rag_mcp.py`：RagAccessService.get、MCP tool registration；app wiring 注入 storage root。
- Agent `server/agent_service/src/pi/rag-mcp.ts`：受控双工具 inventory、get call、snapshot tool allowlist。
- Manager/Agent focused tests：malformed/foreign/revoked/not-ready/missing/path escape/bounded get，以及双工具 inventory/allowlist。

## 不做

- 不直连 LightRAG PG；
- 不暴露 LightRAG workspace/path；
- 不恢复 Agent 本地企业知识索引；
- 不实现 chunk 精确定位（当前 citation ID 是 document 级）；
- 不修改 Hindsight/Provider/Skill。

## 验收

- Manager MCP `tools/list` 包含 search/get；
- snapshot 只允许 search 时 Agent 只注册 search，允许 get 时才注册 get；
- taiyi 真实 search → citation → get 返回相同授权文档内容；
- 删除/撤权/跨 tenant/path escape 均 fail-closed；
- Agent/Manager 测试和 TypeScript 检查通过。
