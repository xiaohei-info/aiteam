---
created: 2026-08-20
status: completed-historical-snapshot
scope: taiyi-test-rag-model-switch
---

# taiyi RAG Embedding/Reranker 切换计划（历史快照）

> 本文记录 2026-08-20 的 taiyi 测试实验；不代表当前 pinned LightRAG 1.5.6 行为、生产配置或 release 证据。当前 RAG endpoint/workspace 以 Stage B 代码与最新部署验证为准。

## 目标

将 taiyi 测试环境 LightRAG 切换为：

- embedding: `BAAI/bge-m3`（1024 维）
- reranker: `BAAI/bge-reranker-v2-m3`
- SiliconFlow OpenAI/Cohere-compatible endpoints

## 关键约束

- 只修改 taiyi 测试环境，不动生产、不动 `app/`、`.hermes`、Provider/Hindsight 代码。
- 旧 Qwen 4096 维索引不能与 BGE-M3 混用；切换前保留带时间戳的数据备份，切换后重新导入测试知识文档。
- 先用当前配置 key 做最小 embedding/rerank 请求；如果仍为 402，不能删除现有索引，先停在凭据/余额阻塞处。
- LightRAG API key、LLM key、embedding/rerank key 仅留在 Manager/LightRAG 环境，不下发 Agent。

## 步骤

1. 备份 taiyi `/root/app/lightrag-data` 和 `/root/app/lightrag.env`。
2. 验证 SiliconFlow key 对 `BAAI/bge-m3` `/v1/embeddings` 和 `BAAI/bge-reranker-v2-m3` `/v1/rerank` 的最小调用。
3. 成功后更新 LightRAG env：`EMBEDDING_MODEL=BAAI/bge-m3`、`EMBEDDING_DIM=1024`、`RERANK_BINDING=cohere`、`RERANK_BINDING_HOST=https://api.siliconflow.cn/v1/rerank`、`RERANK_MODEL=BAAI/bge-reranker-v2-m3`。
4. 清理/重建测试 workspace 索引并重启 LightRAG；确认 health、embedding、rerank 能力。
5. 重新 intake 一个 smoke 文档，等待 per-document `PROCESSED`，经 Manager → Agent MCP 查询 citation。
6. 记录真实请求、结果和剩余风险；不把 key 写入仓库。

## 完成结果

- LightRAG 已切换为 `BAAI/bge-m3`、1024 维、8192 token 上限。
- `BAAI/bge-reranker-v2-m3` 已通过 Cohere-compatible SiliconFlow endpoint 启用。
- 旧 Qwen 索引已备份至 taiyi `/root/app/backups/lightrag-qwen-before-bge-20260820144755`。
- smoke-space 三个 ready 文档已按 BGE-M3 重新索引。
- LightRAG 日志确认 `Successfully reranked`；Agent MCP 与真实 Pi 查询均成功。
- BGE embedding/rerank 最小 API 请求均返回 200。
- Git 仓库没有写入任何 key；远程测试环境仍为测试数据。

## 剩余注意

- 当前 LightRAG 仍使用 JSON/NanoVectorDB/NetworkX 测试存储，PG/PGVector 迁移仍未做。
- 旧索引保留在备份目录，未删除；后续确认新索引稳定后再清理。
