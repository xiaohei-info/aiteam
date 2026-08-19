---
created: 2026-08-18
status: handoff-active
canonical: false
scope: pi-agent-completion
---

# AI Team Pi Agent 重构剩余任务交接 TODO

> 本文用于把剩余工作交给其他开发者/Agent。不要重复重写已完成的 Pi Agent 基础切换；先阅读本文件、`AGENTS.md`、Pi 架构设计和当前 HEAD，再按优先级领取任务。
>
> 当前仓库遵守：Agent 是 Node.js/TypeScript + 进程内 `@earendil-works/pi-coding-agent`；禁止恢复旧 Python Agent/Gateway、多 runtime、Executor/Driver、Run/Task/Loop/Timeline 执行模型；禁止修改 `app/` 和 `./.hermes/hermes-agent/`。

## 0. 当前基线

当前 HEAD 已包含以下主要提交：

```text
959bee2f  feat: add local attachment lifecycle
f410e32e  fix: keep agent knowledge retrieval local-only
a5702d62  fix: enforce provider credential visibility
caf29a40  feat: add signed skill distribution
73827ad4  feat: add local knowledge bundle retrieval
152e24f0  fix: harden knowledge deployment boundaries
```

本地验证基线：

- Python 全量非 integration 测试最近一次：`1651 passed, 131 skipped`；
- Agent 直接 `tsc` 检查通过；
- Agent Node 测试全量通过（当前波次 59 项）；
- Compose 配置、`bash -n scripts/ctl.sh`、`git diff --check` 已通过；
- pnpm wrapper 在本环境会被 ignored-build approval 阻断，使用仓库已有 `tsc/tsx` 直接二进制验证；不要借此修改 lockfile 或安装新运行时依赖。

## 0.1 本轮范围确认（用户确认，2026-08-18）

- 本次目标是 **taiyi 测试环境部署与验证**，不是生产上线验收；生产域名、TLS、备份等不作为本轮阻塞项。
- taiyi 是 Linux x86_64（Ubuntu kernel 6.8），且已安装 `/usr/bin/bwrap`；本轮直接在 taiyi 验证 Linux sandbox，不再要求额外 Linux 主机。
- 本轮不迁移旧库数据；知识数据通过重新 intake 进入新知识空间。
- **最新路线修订**：长期 memory 直接使用受控注入的 `@luxusai/pi-hindsight` Extension 访问 Manager 部署的 Hindsight。RAG/MCP 路线本轮暂缓，不进入当前实现和测试验收；Agent 不建立企业知识本地索引。
- 详细修订见 `docs/superpowers/specs/2026-08-18-pi-agent-manager-rag与provider路线修订.md`；该修订覆盖本文件早先的 local knowledge bundle 段落。
- macOS/Windows 原生 sandbox 验证、生产运维和正式 key rotation 延后到后续 hardening。

## 1. 已完成内容（不要重复实现）

### 1.1 Pi Agent 核心

- 旧 Python Agent/Gateway、多 runtime、RunSpec、Driver、Executor、Run/Task/Loop/Timeline 执行链已清理。
- Node Agent 使用 Pi `SessionManager`、`AgentSession`、`prompt`、`abort`、Pi entries 和 SSE。
- SQLite 只保存 Conversation/Session 索引、授权投影、snapshot、幂等收据、附件/artifact 元数据、usage outbox 和本地知识 artifact。
- Manager snapshot/grant ownership、JWT/JWKS、生产 faux/dev-auth 防护已完成。

### 1.2 Agent 本地附件/Artifact

- 本地 `/attachments`、`/artifacts` 生命周期 API。
- tenant/member/conversation ownership、0700/0600、原子写入、MIME/magic 校验、5 MiB 单文件、20 MiB prompt、数量/总容量限制。
- prompt `attachment_ids`、unknown receipt 重试、过期/孤儿清理、OpenAPI 和 Agent 前端上传。
- 不向 Manager/Operator 上传附件字节。

### 1.3 Hindsight

- Manager 已部署独立 Hindsight；taiyi 已完成真实 retain → operation completed → recall。
- 运行时已接入 `@luxusai/pi-hindsight@0.12.0`，Agent 通过受控 inline Extension 直连 Hindsight。
- 已完成 Agent-owned 配置/queue、bank 隔离、shutdown flush、删除清理、sandbox credential scrub 和 ambient config 禁用。
- 已用 Pi SDK `0.84.2` 实测 Extension 加载、真实 recall、显式 retain 和后续 recall。
- 生产级 Manager bank-scoped token provisioning 仍是后续安全增强；当前 taiyi 使用测试 Hindsight endpoint。

### 1.4 签名 Skill

- Manager 专用 Ed25519 PKCS8 私钥签名；Agent 专用 SPKI 公钥验证。
- signed envelope 绑定 tenant/member/key_id，禁止 JWT key reuse/HMAC。
- Agent 缓存按 tenant/member 隔离，持久 manifest provenance、精确版本指针、递归 symlink/traversal/hash 校验和 snapshot `skill_refs` allowlist。
- catalog-only 更新、authoritative empty/revoke、旧版本清理已覆盖。
- Compose/ctl 密钥隔离：private 仅 Manager，public 仅 Agent，Operation 不接收。
- taiyi 已实测 signed package sync、本地 manifest 和 Skill session 启动。

### 1.5 Manager RAG / Memory 路线（当前 local bundle 实现需回退）

最新目标主链：

```text
Pi knowledge_search / knowledge_get custom tool
  → Agent HttpManagerClient
  → Manager authenticated RAG facade
  → ManagerRagService
  → LightRAG(derived tenant workspace)
  → citation/result
```

Memory 采用成熟 Extension 路线：

```text
Pi Session
  → @luxusai/pi-hindsight
  → Manager 部署的 Hindsight
```

当前已完成：

- Manager Hindsight 部署/facade 和管理面基础；
- Manager knowledge intake、knowledge space、employee binding 和 durable source 基础；
- tenant/member/snapshot authorization 基础；
- Hindsight Extension 与当前 Pi SDK 的最小加载 spike。

仍需完成：Manager 下发 bank-scoped Hindsight 配置、受控 ResourceLoader 注入、工具 allowlist，以及删除自定义 Agent memory tools。

需要回退/替换：

- `pullKnowledgeArtifacts` bundle 主链；
- Agent `knowledge_artifact` 企业知识真相；
- `SqliteKnowledgeIndex`；
- “Agent offline 本地企业知识检索”语义；
- Manager 旧 query/search/get 被删除的部分。

目标约束：

- Agent custom tools 不接受 `workspace` 或可扩大权限的 `knowledge_refs`；
- Manager 从 token + employee snapshot + knowledge binding 推导 LightRAG workspace；
- Manager 返回最小 citation/result；
- Manager/LighRAG 不可用时 Agent tool 明确降级，不偷偷改用本地企业知识索引；
- 普通会话/Pi JSONL/raw runtime event 仍不上 Manager，知识和 memory tool 调用是明确授权的窄通道。

## 2. P0：必须继续完成

### HOLD：Manager RAG query/search/get（本轮暂缓）

**当前状态**：LightRAG/MCP 路线尚未最终裁决。本轮明确暂停，不修改 RAG 路由、MCP 接入、bundle/index 代码，也不把 RAG 纳入 taiyi 当前验收。

**主要文件**：

- `server/manager_service/knowledge_intake_service.py`
- `server/manager_service/knowledge_space_service.py`
- `server/manager_service/rag.py`
- `server/manager_service/routes_knowledge_artifacts.py`
- `server/agent_service/src/manager-client.ts`
- `server/agent_service/src/tools/knowledge.ts`
- `server/agent_service/src/pi/session-host.ts`

**实施要求**：

- 在 Manager 增加受认证 `knowledge_search` / `knowledge_get` facade，真实调用 `ManagerRagService → LightRAG`。
- Agent `HttpManagerClient` 增加 query/get 方法；Pi custom tools 只传 query/limit/citation_id，employee/snapshot/caller 在闭包中绑定。
- Manager 从 TenantContext、member grant、employee snapshot 和 knowledge binding 推导 workspace；HTTP 不接受 workspace 或任意 knowledge_refs。
- 删除 `pullKnowledgeArtifacts`、Agent `knowledge_artifact` 主链和 `SqliteKnowledgeIndex`；不保留本地企业知识索引 fallback。
- 返回最小、可展示的 citation；不泄漏内部 workspace、storage path 或跨 tenant 数据。
- Manager/Lightrag 不可用时 tool 明确返回 unavailable；不宣称离线 RAG 可用。
- 测试：
  - 两个 tenant 使用相同 knowledge_space_id 时 workspace/storage 不相同；
  - binding/document/space/tenant 不一致时 fail-closed；
  - Agent query 必须到 Manager，不能读取本地企业索引；
  - citation get 必须验证当前 employee 授权；
  - revoke/disable 后 query/get 立即拒绝或不返回结果。

**完成标准**：taiyi 真实上传知识文档 → LightRAG 索引 → Agent Pi 调用 knowledge tool → Manager query → 返回真实 citation；全程不在 Agent 保存企业知识索引。

### P0-2：Provider runtime config 下发与真实 Pi 请求（已完成测试环境主链）

**最终裁决**：删除 `mode=relay|direct`。未来自建中转站对 AI Team 仍只是 `base_url + api_key + api_protocol`；保留 `api_protocol`，因为中转站支持多种 Pi API 协议。

**当前状态**：

- Manager 已有 Fernet 加密 CRUD、成员可见性、supported models 和 `provider_ref/model` snapshot；
- Agent 仍只读取本地 `auth.json/models.json` 或 `AITEAM_PI_FAKE=true`；
- Manager→Agent 的可执行 provider credential 下发未实现；没有 API key 时 Agent 不能发起真实 LLM 请求。

**主要文件**：

- `server/manager_service/schemas_provider.py`
- `server/manager_service/provider_credential_service.py`
- `server/manager_service/provider_credential_repository.py`
- `server/manager_service/routes_provider.py`
- `server/shared/contracts/crosstier.py`
- `server/agent_service/src/manager-client.ts`
- `server/agent_service/src/pi/model-runtime.ts`
- `server/agent_service/src/pi/session-host.ts`
- `server/agent_service/src/main.ts`
- `web/manager/src/features/providers/*`

**实施要求**：

1. 从 Pydantic/API/repository/DB/UI/tests 删除 provider `mode`，保留 `base_url`、`api_protocol`、加密 `api_key`、models、visibility、version；
2. 增加专用 authenticated runtime-config pull（具体路径需冻结）：Agent 只提交 `employee_id`，Manager 从 fresh snapshot 解析 provider_ref/model，不能让 Agent指定 credential_id；
3. Manager 验证 tenant/member grant 后解密 api_key，通过 TLS 返回 `base_url/api_protocol/api_key/model/version`；普通 authorized-config/snapshot 继续不含 secret；
4. Agent 使用 `ModelRuntime`/native provider registration + `setRuntimeApiKey` 进程内装配，不写 `auth.json`、SQLite、Session 或全局环境变量；
5. 若一个 Agent 进程允许多个 member，provider ID/credential store/ModelRuntime 必须按 tenant/member 隔离；
6. rotation/revoke 后更新或移除 runtime key；日志/SSE/error/usage/crash 全面脱敏。

**测试环境完成标准**：taiyi 已关闭 `AITEAM_PI_FAKE`，Manager 配置 NewAPI 测试 key，Agent 拉取 runtime config 后使用 `minimax-m3` 完成真实 Pi prompt/stream；日志、SQLite、Session JSONL、SSE 未发现 API key。真实测试返回 `BLUEBIRD`。

### P0-3：Pi Hindsight Extension 直连（已完成测试环境主链）

**当前状态**：Manager/Hindsight HTTP facade 和 Agent 自定义 memory tools 已可运行，但不是最终 Pi 原生路线；`@luxusai/pi-hindsight@0.12.0` 与 Pi SDK `0.84.2` 的受控 inline 加载 spike 已通过。

**实施要求**：

1. 固定依赖版本并通过受控 ResourceLoader `extensionFactories` 注入，继续禁止 ambient extension discovery；
2. Manager 为当前 tenant/member/employee provisioning Hindsight bank、policy、URL 和 bank-scoped credential；不得下发全局 service token；
3. 每个 Session 绑定正确的 bank/scope，模型不能通过工具参数改到任意 bank；
4. 只激活产品允许的 recall/retain/reflect 工具；保留 Extension 的自动 recall、agent_end retain、queue 和 shutdown flush；
5. 删除 Agent 自定义 `src/tools/memory.ts` 和 runtime `ManagerClient.memoryRecall/memoryRetain` 主链，避免两套 retain/recall；
6. Manager 管理面 list/delete/disable/retention 可继续调用 Hindsight，不与 Extension runtime 重复写入。

**完成标准**：taiyi 新 Session 已触发 Hindsight recall，显式 retain operation 完成且后续 recall 返回 marker；Extension shutdown/queue/隔离测试通过。Manager bank-scoped token provisioning 和完整自动 retain 仍需后续 live hardening。

### P0-4：taiyi 测试环境最终联调（Provider/Memory 已完成，E2E 待执行）

在 P0-2/P0-3 之后，串行使用共享 taiyi 环境；本轮结果不表述为生产验收：

1. health/readiness/auth/JWKS；
2. Agent grants/snapshot/signed skill sync；
3. [暂缓] knowledge intake → ManagerRagService → LightRAG → Agent knowledge tool query；
4. Manager provider runtime-config → Pi ModelRuntime → real Pi prompt（已完成）；
5. Hindsight Extension direct recall/retain（已完成）；
6. attachment upload/prompt/delete；
7. revoke/rotation/offline/restart recovery。

当前 taiyi 资源：

```text
repo:       /root/app/aiteam
operation:  8781
manager:    8782
agent:      8783
postgres:   5434 / database aiteam_pi_test
hindsight:  9290 (loopback)
lightrag:   9621 (loopback)
```

不要在共享环境并行重启服务或并发修改同一 tenant/knowledge workspace。

### P0-5：完整 Playwright / 三端 E2E

当前只完成了服务 smoke 和局部脚本验证；仍需执行：

- `web/e2e` 三端登录、授权同步、私聊、群聊委托、Provider、Memory、技能、附件、Office；知识/RAG 场景本轮暂缓；
- 真实 Agent auth/binding，不允许测试绕过 Agent 登录或只断言 `202`；
- 检查最终 Pi entries/assistant output、SSE、citation、错误和浏览器 console；
- 跨 tenant、跨 member、撤权、删除、Manager offline、重启恢复。

完成后记录测试命令、环境变量、通过/失败清单和截图/日志路径。

## 3. P1：随后完成

### P1-1：Skill signing key rotation

当前 Agent 只支持一个 public key/key_id。后续实现：

- Manager public-key/JWKS 发布；
- 双 key overlap、key_id rotation、撤销和过期；
- Agent 缓存重验证、旧 key 处理和离线策略；
- 不复用 JWT signing key。

### P1-2：Manager RAG 查询性能与 citation 生命周期

Manager RAG query 是目标路线，不建设 Agent 本地企业知识 bundle。后续：

- LightRAG query 超时、取消、限流和结果大小上限；
- citation/version/re-index/delete 生命周期；
- query/get 的 tenant/member/employee negative tests；
- Manager 离线时明确 unavailable，不返回过期本地企业索引；
- 大结果分页或受控摘要，避免把完整文档正文写入 Pi tool result。

### P1-3：附件/Artifact 完整产品化

当前附件本地生命周期已完成，但仍可增强：

- 页面 reload 后恢复 pending unknown prompt；
- 定时而非仅 Agent 启动时清理 stale files；
- 图片完整解码/内容检测；
- artifact 的前端浏览/预览和非图片处理策略；
- 端到端截图上传/预览/删除验证。

### P1-4：Sandbox 多平台真实验证（本轮只做 taiyi Linux）

代码已有 Linux bwrap/Landlock、macOS Seatbelt、Windows restricted-token/ACL 选择和 fail-closed 测试。本轮直接在 taiyi Linux 验证：

- bwrap/Landlock 正向执行；
- 网络关闭、workspace 越界拒绝；
- 凭据剥离、资源限制、取消和超时。

macOS/Windows 原生验证延后，不阻塞本轮测试环境交付。

### P1-5：运营/前端真实投影

- Marketplace 真实非空数据投影；
- Knowledge 页面显示本地 artifact/citation 状态；
- Office/feed/usage outbox 不再只返回 schema 空数据；
- Skills UI 仅展示 Manager 授权、版本、签名状态，不直接发现用户全局 Skill。

## 4. P2：后续生产运维与清理（不阻塞本轮测试环境）

- `scripts/ctl.sh` 当前已能传递 root/volume，但 Agent 旧子进程可能导致重启时 `EADDRINUSE`；改为 process-group 管理并增加 stale PID 清理。
- 为 Hindsight、LightRAG、Manager data volume 做备份/恢复/容量监控。
- 生产环境的 `AITEAM_ENV=production`、JWT/JWKS、Skill key、Provider secret、sandbox readiness 做启动前检查。
- 完整 deployment smoke、rollback 和 upgrade/runbook。
- 本轮不迁移旧知识/旧库；若未来需要升级旧数据，提供一次性 re-intake/migration 工具，不能静默继续使用旧 namespace。

## 5. 全局验收红线

以下任何一项失败都不能宣称完成：

- Agent 将普通 prompt、Session JSONL、附件字节、raw runtime event 发给 Manager/Operator；knowledge/memory custom tool 的明确授权请求除外；
- Agent 接受 unsigned Skill、错误 tenant/member 的 Skill、symlink/traversal Skill 或未授权 snapshot ref；
- Provider plaintext/ciphertext 进入 Snapshot/AuthorizedConfig/SQLite/log/SSE；
- LightRAG workspace 由客户端传入或跨 tenant 共用；
- Manager/Agent 以 Run/Task/Loop/DAG 恢复第二执行状态机；
- 生产模式仍启用 faux provider/dev auth；
- 测试只断言 HTTP `202/200` 而没有验证真实 entries/citation/授权结果。

## 6. 交接者最短路径

如果只剩一轮实施，按此顺序：

1. RAG/MCP 任务本轮暂缓，不修改相关代码；
2. 完成 P0-2 provider runtime-config pull/injection；
3. 完成 P0-3 Pi Hindsight Extension 直连；
4. 串行跑 P0-4 taiyi 测试环境验收（不含 RAG）；
5. 最后跑 P0-5 Playwright 三端全量（不含 RAG）；
5. P1/P2 作为后续 hardening，不得用其未完成掩盖 P0 未通过。
