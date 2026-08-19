---
created: 2026-08-19
status: approved-by-current-request
scope: rag-multispace
---

# RAG 多知识空间 fan-out 切片计划

## 目标

让一个 authorized employee 同时查询多个知识空间，例如：

```text
enterprise_shared + department_finance + employee_private
```

仍然由 Manager 解析授权和 workspace，Agent/MCP 不传 workspace。

## 实施

- `RagAccessService.authorize()` 返回当前 employee 所有 enabled、tenant-valid、active 的知识空间 handle，而不是只接受一个 space。
- `knowledge_search` 对允许的 handles 并行调用 LightRAG `/query/data`；每个请求使用 Manager 派生 workspace 和 Manager-only API key。
- 合并结果时保留 `knowledge_space_id/document_id/citation_id`，按 score 去重并限制总结果/总字节。
- 一个 space 查询失败时不泄漏错误；策略固定为：全部失败 unavailable，部分成功返回成功空间并带 degraded 标记。
- 不改变 Agent 工具 schema；模型仍不能传 space/workspace。
- 继续拒绝 stale/disabled binding、跨 tenant document、未 ready document。

## 不做

- 不复制文档或向量；
- 不迁移 LightRAG storage；
- 不实现 knowledge_get；
- 不改变 Hindsight/Provider；
- 不把 LightRAG key 下发 Agent。

## 验收

- 单 space 行为不回归；
- enterprise + department 两个 space 返回合并 citation；
- 相同 document 在多个 space 出现时按 space/document 去重策略稳定；
- 一个 workspace 超时时另一个 workspace 结果仍返回；
- 全部 workspace 无结果与全部 workspace 失败语义可区分；
- 跨 tenant/member/employee negative tests 通过。
