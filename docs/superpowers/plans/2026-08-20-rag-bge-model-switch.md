---
created: 2026-08-20
status: approved-by-user
scope: taiyi-test-rag-model-switch
---

# taiyi RAG Embedding/Reranker 切换计划

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

## 完成标准

- LightRAG 使用 1024 维 BGE-M3，不再读取 Qwen 4096 配置。
- reranker health/config 显示已启用，查询能正常返回 citation。
- taiyi Agent MCP/真实 Pi 查询通过。
- 旧数据有备份；仓库无敏感值、无未提交意外变更。
