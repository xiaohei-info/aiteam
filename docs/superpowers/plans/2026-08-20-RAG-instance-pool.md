---
created: 2026-08-20
status: implemented-minimal-static-slice
scope: manager-rag-instance-pool
---

# Manager RAG 安全多 workspace 实例池（P0.2 最小切片）

Manager 在启动时从 `LIGHTRAG_INSTANCES` 读取一个受边界限制的 JSON 数组。每项固定为：

```json
{"instance_id":"rag-a","url":"http://lightrag-a:9621","api_key":"...","workspace":"tenant-space-a"}
```

数组大小、instance ID、URL、凭据、workspace 均有上限；URL 只允许 `http`/`https`，禁止 URL 凭据、query 和 fragment；workspace 与 instance ID 必须唯一。解析失败、重复映射和未知 workspace 都 fail-closed。API key 只存在 Manager 进程内存，`repr`、snapshot、SQLite、日志和 SSE 不包含它。

`PgManagerRagService` 派生 workspace 后解析唯一实例，并把 `instance_id` 放入 Manager 内部 `RagHandle`。query 与 ingestion 客户端均按同一静态 registry 解析 workspace，向 LightRAG 发送该实例固定 workspace；不存在动态热加载或 Agent/frontend endpoint、key、workspace 覆盖入口。query 保留多空间并行 fan-out、partial degraded 与 all-failed unavailable。

现有单实例配置继续可用：`LIGHTRAG_URL`、`LIGHTRAG_API_KEY`、`LIGHTRAG_WORKSPACE`（三者必须同时配置），通用超时配置不变。`LIGHTRAG_INSTANCES` 未配置时使用该 legacy 单实例映射。

本切片刻意不伪造数据库 mapping。未来若需要租户/知识空间到实例的动态业务映射，应增加 Manager-owned migration、受 TenantContext/RLS 保护的映射表和发布/回滚机制；当前仍由静态 workspace-to-instance 配置承担路由。
