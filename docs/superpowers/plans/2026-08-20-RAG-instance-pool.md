---
created: 2026-08-20
status: superseded-by-stage-b
scope: manager-rag-instance-pool
---

# Manager RAG 安全多 workspace 实例池（P0.2 最小切片）

> **已被 Stage B（2026-09-07）取代**：本文件只保留历史背景；当前唯一裁决是 `docs/v1正式版本/技术设计/概要设计/04-数据架构与多租户隔离.md`。Manager 进程按 TenantContext 承载多企业会话，每个企业保留一个逻辑共享 workspace；endpoint pool 只承载 URL/凭据，workspace 与已验证 `instance_id` 由 Manager 持久化映射决定。

Manager 在启动时从 `LIGHTRAG_INSTANCES` 读取一个受边界限制的 JSON 数组。每项固定为：

```json
{"instance_id":"rag-a","url":"http://lightrag-a:9621","api_key":"..."}
```

数组大小、instance ID、URL、凭据均有上限；URL 只允许 `http`/`https`，禁止 URL 凭据、query 和 fragment。解析失败、重复映射和未知 workspace 都 fail-closed。API key 只存在 Manager 进程内存，`repr`、snapshot、SQLite、日志和 SSE 不包含它。

`PgManagerRagService` 派生或读取 tenant workspace 后解析并持久化已验证的 `instance_id`。query 与 ingestion 客户端必须携带该 ID，向对应 endpoint 发送请求级 `LIGHTRAG-WORKSPACE` header；registry 顺序变化不得重路由已有 mapping，未知 instance 或多 endpoint 下无 provenance 的旧 NULL mapping 必须 fail-closed。不存在 Agent/frontend endpoint、key、workspace 覆盖入口。query 保留多空间并行 fan-out、partial degraded 与 all-failed unavailable。

现有单实例配置继续可用：`LIGHTRAG_URL` 与 `LIGHTRAG_API_KEY`；`LIGHTRAG_WORKSPACE` 仅作为被忽略的 legacy hint，不参与路由。`LIGHTRAG_INSTANCES` 未配置时使用该 legacy 单实例 endpoint。

Stage B 已增加 Manager-owned `rag_workspace.instance_id` 审计映射、registry-aware 新空间写入与按租户/RLS 访问；Compose 不设置全局 `POSTGRES_WORKSPACE`，LightRAG workspace 只由 Manager 请求 header 选择。历史 NULL 映射不能在多 endpoint pool 中猜测，需显式运维 reconciliation。
