---
created: 2026-08-19
status: approved-by-current-request
scope: rag-ingestion-index
---

# RAG 文档 ingestion/index 首个切片计划

## 1. 目标

把 Manager 当前 knowledge intake 的“解析 + 估算 chunk + ready 占位”替换为真实 LightRAG 索引链：

```text
Manager intake
  → Manager derives workspace
  → LightRAG POST /documents/text
  → wait/poll pipeline status
  → Manager document/job ready
  → employee document binding rag_document_id
  → Agent MCP knowledge_search returns citation/chunk
```

## 2. 范围

- Manager LightRAG insert client：API key 只在 Manager；workspace 由 ManagerRagService 推导；file_source 使用 Manager document id。
- intake 只在 LightRAG processing 成功后标记 ready；超时/错误标记 failed，不伪造 ready。
- binding propagation 写入稳定 `rag_document_id`/source alias，供 citation mapping。
- retry 复用同一 intake path；旧绑定先 stale。
- 受限超时、poll interval、响应大小和错误脱敏。
- fake LightRAG transport tests、state transition tests、taiyi live document intake/query smoke。

## 3. 不包含

- 多 workspace fan-out；首期 employee 必须恰好一个 authorized knowledge space。
- PGVector/PGGraph storage 迁移；继续使用 taiyi 当前 LightRAG storage 做测试。
- LightRAG MCP 写工具；Agent 仍只读 `knowledge_search`。
- 旧知识数据迁移；旧文档重新 intake。
- 删除/版本化/大规模后台队列的完整生产实现；先保留当前同步 intake 上限和显式 timeout。

## 4. 验收

- Manager 上传文档后 LightRAG workspace 有 READY 文档/chunk；
- Manager document status/job status 与 LightRAG 结果一致；
- Agent MCP query 返回真实 chunk text 和 Manager citation；
- 未配置 LightRAG、API key、workspace、pipeline timeout 时 fail-closed；
- 解析失败、LightRAG 失败和超时不产生 ready binding；
- 全量 Manager/Agent tests、compose/bash checks 通过。
