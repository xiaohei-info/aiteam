---
created: 2026-08-22
status: active
scope: frontend-backend-production-ready-wave
---

# AI Team 前后端功能完成与 Production Ready Wave

## 用户目标

先完成所有已定义的前后端产品功能，再进入正式 production-ready gate；不得用页面 shell、空数组、skip 或 fake 数据宣称完成。

## 功能完成标准

- 每个 Demo/v1 功能都有真实 API、真实页面、loading/error/empty/unauthorized/offline 状态和自动化验证；
- Agent 继续 Pi-native，不恢复 Run/Task/Loop/Timeline 或 Agent-local enterprise knowledge；
- Manager 是企业配置、RAG、Hindsight 授权和治理真相源；
- RAG citation/search/get/delete/reindex/version、workspace routing 前后端契约一致；
- 群聊/delegation、Provider、Memory、Skill、Attachment、Office、Marketplace、Org、Usage 全链路可执行或明确 unavailable；
- 任何不可实现的外部依赖必须有 fail-closed 状态和生产阻塞记录，不能伪造成功。

## Wave 工作线

### Backend-A：RAG 完整生命周期

- exact chunk/version citation；
- Manager document delete/reindex API 与 LightRAG 同步；
- workspace instance registry health/route/drift；
- citation get/delete/revoke negative tests；
- PostgreSQL/pgvector migration/restart/backup contract。

### Backend-B：产品执行/投影闭环

- group delegation/coordinator API 与 event attribution；
- Office/task/feed/usage真实投影；
- Marketplace/Org/solution/provider authorization consistency；
- attachment/artifact/knowledge/memory lifecycle；
- 空/错误/离线状态契约。

### Frontend-A：Manager/Operation 完整页面

- Knowledge citation/delete/reindex/version；
- Provider/Skill/Memory/Grant/Expert/Marketplace/Org/Governance；
- 实际数据、权限、确认、错误、空态和 a11y；
- 绝不直连 LightRAG/Hindsight 或跨端。

### Frontend-B：Agent 完整工作台

- private/group chat/delegation、Pi events、tool/approval/error；
- provider/model/thinking/skills/attachments/@；
- Office/Org/Marketplace/Usage/Sync；
- RAG 只经 Pi MCP；删除 legacy local knowledge endpoint；
- 真实授权和成员/员工绑定。

### Gate：Production ready

- 三端全量 typecheck/test/build；
- cross-tier 55 + 三端 UI smoke；
- clean PostgreSQL/pgvector/LightRAG/Hindsight install；
- Linux/macOS/Windows sandbox evidence；
- TLS/JWT/JWKS/Provider/Hindsight/Skill rotation；
- backup/restore/upgrade/rollback/RTO/RPO/monitoring；
- no secret in source/image/Agent env/SQLite/Session/SSE/log；
- release artifact、runbook、rollback receipt。

## 当前明确残余

- exact chunk/version citation；
- RAG delete/reindex UI/API；
- multi-instance health/hot reload；
- production native Hindsight scoped token（upstream capability absent，当前为 Manager lease）；
- macOS/Windows native sandbox；
- production TLS/secret-store/observability rehearsal；
- GitHub origin must contain the final code before release.
