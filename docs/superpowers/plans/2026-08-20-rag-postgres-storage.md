---
created: 2026-08-20
status: approved-by-user
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

## 完成标准

- taiyi LightRAG 日志显示四个 PG storage backend；
- `vector` extension 与 `vector(1024)` 表存在；
- 容器重启后文档和 query 仍可用；
- Manager/MCP/Pi 全链路成功；
- 测试与未来生产使用相同 LightRAG + PG 拓扑，只有数据不同。
