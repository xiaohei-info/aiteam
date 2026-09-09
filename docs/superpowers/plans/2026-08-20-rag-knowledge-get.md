---
created: 2026-08-20
status: superseded-by-stage-b
scope: rag-knowledge-get
---

# RAG knowledge_get 切片计划（历史）

> Stage B 已覆盖本计划的 knowledge_get、tenant-derived workspace 与 endpoint mapping 语义；本文仅保留早期设计背景，不是当前实施清单。当前以 v1 概要设计 04/06/11 和代码为准。

## 目标

补齐 Agent Pi 的 `knowledge_get(citation_id)`，但不把 LightRAG 原生存储暴露给 Agent。Manager 重新授权 citation 后，从 Manager-owned authoritative document storage 读取受限文本。

## 语义

- 旧 citation `citation:{knowledge_space_id}:{document_id}` 继续兼容；search 对可验证结果返回 versioned `citation:{space}:{document}:{safe-token}`，不接受 workspace、storage_key、file_path 或任意 document ID。
- `citation_version` 使用 Manager 文档 `updated_at`/source digest 的稳定不透明摘要；chunk locator 只暴露安全 token 与可选 `chunk_index`，不回显 LightRAG `chunk_id` 或内部 path。
- 每次 get 重新执行当前 member/employee/snapshot/binding/ready/tenant/version 校验；撤权、禁用、过期、reindex/delete 或 stale binding 立即拒绝。
- 内容来源是 Manager intake 的安全 storage root，沿用 root/path-fence、parser 和确定性 chunk map；LightRAG `/query/data` 只提供检索 provenance，不直连 LightRAG storage 或伪造 chunk API。
- 返回 bounded citation JSON，正文最多 4,000 字符，不泄漏绝对路径、workspace、PG 表、key 或跨 tenant 错误细节。

## 实施文件

- Manager `server/manager_service/rag_mcp.py`：RagAccessService.get、MCP tool registration；app wiring 注入 storage root。
- Agent `server/agent_service/src/pi/rag-mcp.ts`：受控双工具 inventory、get call、snapshot tool allowlist。
- Manager/Agent focused tests：malformed/foreign/revoked/not-ready/missing/path escape/bounded get，以及双工具 inventory/allowlist。

## Exact chunk 约束

- LightRAG 1.5.6 `/query/data` 的公开结构是 `data.references[{reference_id,file_path}]` 与 `data.chunks[{reference_id,file_path,chunk_id,content}]`；实现同时容忍 `full_doc_id`、`chunk_order_index` 等 richer payload，但不假设它们一定存在。
- provenance 缺失、alias 冲突、chunk id/index 重复、跨文档或越界时，只返回明确的 versioned document citation 或丢弃，不猜 chunk；只有唯一 manager-authoritative span/map 才生成 exact citation。
- 不直连 LightRAG PG/storage，不暴露 LightRAG workspace/path/chunk id；不恢复 Agent 本地企业知识索引；不修改 Hindsight/Provider/Skill。

## 验收

- Manager MCP `tools/list` 包含 search/get；
- snapshot 只允许 search 时 Agent 只注册 search，允许 get 时才注册 get；
- taiyi 真实 search → citation → get 返回相同授权文档内容；
- 删除/撤权/跨 tenant/path escape 均 fail-closed；
- Agent/Manager 测试和 TypeScript 检查通过。
