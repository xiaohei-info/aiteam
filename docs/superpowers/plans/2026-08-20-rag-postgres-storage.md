---
created: 2026-08-20
status: completed-taiyi-test
scope: rag-postgres-storage
---

# RAG PostgreSQL 存储切换计划

## 目标

让 taiyi 测试环境与目标生产架构一致：LightRAG 使用 PostgreSQL + pgvector，而不是 JSON/NanoVectorDB/NetworkX 文件存储；Manager 仍通过 Manager-owned LightRAG facade 访问，Agent 不直连数据库。

## 目标存储后端

```env
LIGHTRAG_KV_STORAGE=PGKVStorage
LIGHTRAG_DOC_STATUS_STORAGE=PGDocStatusStorage
LIGHTRAG_GRAPH_STORAGE=PGTableGraphStorage
LIGHTRAG_VECTOR_STORAGE=PGVectorStorage
```

LightRAG 使用独立 PostgreSQL database/schema/role 命名空间，避免直接写 Manager 业务表；workspace 继续由 Manager 从 tenant + knowledge_space 派生。Graph 使用 `PGTableGraphStorage`，不引入 Apache AGE。

## 实施顺序

1. 备份 taiyi 现有 PostgreSQL cluster、LightRAG JSON 数据和环境配置。
2. 将测试 PostgreSQL 镜像切换为带 pgvector 的 `pgvector/pgvector:pg16`，保留现有卷和端口；创建 `vector` extension。
3. 创建独立 `lightrag` 数据库/角色，最小权限访问；确认 PGVector/PGKV/PGDocStatus/PGTableGraph clean install 能启动并建表。
4. 更新 LightRAG 配置为上述四个 PG storage backend，设置 `POSTGRES_*` 连接参数，并使用 BGE-M3 1024 维。
5. 清空旧 LightRAG 文件 storage，启动 PG-backed LightRAG；检查启动日志、表、vector(1024) 列和 workspace 隔离。
6. 重新 intake 测试知识文档，验证 per-document ready、embedding、rerank、Manager MCP、Agent Pi。
7. 做跨 workspace/tenant 负向查询、重启恢复和数据库持久化验证；保留旧备份，确认后再清理。

## 非目标

- 不把 LightRAG 原生表并入 Manager 业务表；
- 不把 LightRAG key、PG 凭据下发 Agent；
- 不删除 Manager 业务数据；
- 不引入 AGE、Milvus、Qdrant；
- 不把旧 JSON 索引直接迁移，测试文档通过 Manager 重新 intake。

## 阻塞条件

- 当前 PG 镜像必须包含 pgvector；
- LightRAG 当前镜像的 PG 后端必须在 clean install 上通过；
- 若共享 `aiteam-pg` 仍无 pgvector，必须先升级镜像并做 dump/恢复验证。

## 完成结果

- taiyi PostgreSQL 容器已切换为 `pgvector/pgvector:pg16`，保留原业务卷和端口；
- 创建独立 `aiteam_lightrag_test` database 与 `lightrag_test` role，未把 LightRAG 原生表并入 Manager 业务数据库；
- `vector` extension 为 0.8.6，LightRAG 创建 `vector(1024)` HNSW 表；
- LightRAG 日志显示 `PGKVStorage`、`PGDocStatusStorage`、`PGTableGraphStorage`、`PGVectorStorage`；
- 固定 `POSTGRES_WORKSPACE=tcb0f0687d2354eb7b59c75b8cdb889a5__smoke-space`，3 个文档已重新索引到该 PG workspace；
- LightRAG 重启后 Manager MCP query 仍成功，reranker 日志显示 `Successfully reranked`，Agent Pi citation smoke 通过；
- 旧 LightRAG JSON/Qwen 数据与 PostgreSQL cluster 已分别备份；
- `deploy/docker/docker-compose.yml` 已将三端基础 PostgreSQL 镜像切换为 `pgvector/pgvector:pg16`，保持未来部署拓扑一致。

## 剩余注意

- 当前单个 LightRAG 进程的 PG workspace 在启动时固定；多 workspace 需要 Manager endpoint/instance pool 编排，不能依赖请求 header 动态切换同一进程。
- `knowledge_get`、PG workspace instance pool、完整 Playwright 仍未完成。
