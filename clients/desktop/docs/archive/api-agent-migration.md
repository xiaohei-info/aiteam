> 当前接口以 [8783 OpenAPI](api.json) 和 [全量核对表](api-audit.md) 为准。本文为历史迁移记录，不作为新增接口依据。

> 本文保留早期迁移记录。当前服务路由、企业写操作和新版 sidecar 接入以 [macOS 三端接入说明](macos-three-service-integration.md) 为准。

# AITeam 桌面端接口层改造方案（对接 FredServer Agent 端）

> 文档版本：v1.0
> 日期：2026-09-03
> 状态：目标架构已落地；本文保留历史迁移步骤与边界裁决
> 关联仓库：`../FredServer`（服务端 v1 三端架构：Operator / Manager / Agent）

> 说明：AITeam 当前业务运行时已切换到 FredServer Agent `/api/agent/*`、Bearer JWT 与会话级
> Pi SSE。下文的“双栈”“阶段”描述是迁移过程记录；Agent 端事实源仍是
> `server/agent_service/src/http/server.ts`、`/openapi.json` 和对应 schema。

### 当前运行时裁决（2026-09-08）

- Hermes `src/api/hermes.ts`、旧 STT、axios/CSRF client 与预留 WebSocket 接收链路已删除；
  业务请求只通过 `src/api/agent/`。
- 原 `src/lib/hermesSync.ts` 的活跃员工—会话内存映射已更名为
  `src/lib/employeeConversationMap.ts`；它不进行网络请求或数据库持久化。
- `src/lib/message.ts` / `messageSender.ts` 只保留单聊乐观文本构造和聊天附件编码的活跃能力；
  旧文件/图片/卡片发送 stub、SQLite 上下文及注释实现已删除。
- 旧 `stores/auth.ts` 兼容代理和 `lib/session.ts` Cookie/弱加密持久化已删除；登录状态统一由
  `stores/agentAuth.ts` 的 Bearer 会话管理。
- 运行时审计确认无调用后，Tauri SQLite 的 `src/lib/db.ts` 与 Rust commands/schema 已删除；
  会话事实源只保留 Agent SQLite。
- 旧 Intel Hermes/Python/PostgreSQL sidecar 构建脚本与专用 Tauri 配置已删除；
  `tauri:build:mac:intel` 仅编译纯 Tauri `x86_64-apple-darwin` 安装包。

---

## 一、背景

服务端已重建为三端架构。桌面端对应 **Agent 端**：Node Fastify + 本地 SQLite + Bearer JWT，
会话与执行数据留在用户本机，控制面（Operator/Manager）只接收脱敏摘要。

当前前端全部接口指向旧 Hermes 后端（`/api/team/*`，cookie 鉴权，run 驱动消息模型），
两者差异是结构性的，无法通过改 URL 完成，需要一次接口层整体改造。

### 核心差异对照

| 维度 | 旧 Hermes | 新 Agent 端 |
|---|---|---|
| 鉴权 | cookie + CSRF（`X-Hermes-CSRF-Token`） | `Authorization: Bearer <JWT>` |
| 前缀 | `/api/team/*` | `/api/agent/*`（+ `/api/auth/resolve-tenant-by-account`） |
| 响应模型 | 裸 JSON / `{error}` | envelope `{data}` / `{data,page}` + `application/problem+json` |
| 登录 | `POST /api/auth/login {password}` → cookie | 两步：resolve-tenant → `/api/agent/login` → `{token, claims}` |
| 发消息 | `POST /runs` → `{run_id}` | `POST /conversations/:id/prompt` → 202 + `Idempotency-Key`（会话需先建） |
| 流式 | run 级 SSE（`timeline` 事件，`/runs/:id/stream`） | **会话级** SSE（`event: pi`，`/conversations/:id/events`，`after` 断线续读） |
| 历史 | HermesMessage 扁平结构（cursor 分页） | PiEntry（content parts：text/thinking/toolCall/image，`/entries` 全量） |
| 群聊 | group-conversations 独立资源 + members 接口 | `kind=group` 会话 + coordinator + mentions（**无 members 接口**） |
| 附件 | `/uploads` 对话无关，先传后发 | 会话级 `POST /conversations/:id/attachments`（base64 ≤5MiB）→ prompt 引用 `attachment_ids` |
| 员工列表 | `GET /employees`（含 conversation_id 映射） | `GET /grants/experts`（ExpertProjection，**无 conversation_id**） |
| 未读/预览 | workbench 提供 | 当前无（必须在 Chat 迁移前由服务端补齐，见 §5） |
| 已读 | `POST /workbench/state {mark_read}` | `PATCH /conversations/:id {last_read_entry_id}` |
| 停止 | `POST /runs/:id/abort` | `POST /conversations/:id/abort` |
| STT | `POST /stt` `{audio_base64, mime_type, duration_ms}` | `POST /audio/transcriptions` `{filename, mime_type, data}` |
| 知识库 | `/knowledge-bases` CRUD | **410 Gone**（管理归 Manager 端） |
| 招募 | `POST /recruitments` | **410 Gone**（待产品决策） |
| WebSocket | 预留未用 | 无，纯 SSE |

## 二、已确认的决策

1. **渐进式双栈**：`src/api/agent/` 新栈与 `hermes.ts` 旧栈并存，按页面逐步迁移，每步可回退
2. **Tauri 打包内嵌 Node Agent**：Agent 进程只监听 `127.0.0.1:8000`，桌面端始终通过
   `http://127.0.0.1:8000` 访问；Hermes、Manager 等其他服务统一通过 `https://aifred.cn`
   域名访问，不在客户端或 Agent 配置中硬编码外部服务端口
3. **KnowledgeBase 暂缓迁移**：Agent 端无此能力，后续按 Manager 端规划
4. **未读/预览由服务端补齐**（FredServer 侧独立 PR，作为 Chat 迁移前置契约）
5. **消息数据单一事实源**：Agent 内置 SQLite 保存会话、entries、附件和运行状态；前端只在
   Zustand 等内存状态中保存当前展示数据，业务代码不再读写或初始化 Tauri SQLite。运行时
   图审计确认无调用后，原 `lib/db.ts` 及对应 Rust DB commands/schema 已删除。认证会话的
   token 持久化不属于消息数据库，继续独立保留。

## 三、目标架构

### 3.1 目录结构

```
src/api/agent/                  # 新栈（迁移完成后替代 src/api/hermes.ts、src/api/stt.ts）
├── types.ts          # 契约类型镜像（SSOT 在服务端 TypeBox schema，按需镜像）
├── client.ts         # AgentApiClient 传输基类
├── auth.ts           # resolveTenant / login / resetPassword / whoami
├── conversations.ts  # 会话 CRUD / prompt / entries / abort / state / 已读
├── events.ts         # 会话级 SSE 订阅（after 续读 + 指数退避重连）
├── files.ts          # attachments / artifacts
├── experts.ts        # grants/experts / readiness / sync
├── office.ts         # office/scene / office/feed
├── org.ts            # org/tree
├── marketplace.ts    # marketplace/templates
├── stt.ts            # audio/transcriptions
└── index.ts          # 汇出 + 惰性单例装配

src/lib/piConverters.ts   # PiEntry→Message、PiEvent→流式回调（纯函数，可单测）
src/stores/agentAuth.ts   # Bearer token + claims（localStorage 持久化 + 401 登出）
```

### 3.2 传输层设计（client.ts）

- **fetch-based，不用 axios**：
  1. SSE 与普通请求复用同一传输与鉴权注入（旧栈为此维护 axios adapter + EventSource +
     tauriFetch 三套）
  2. envelope 解包 / problem 解码在 fetch 层一次实现
  3. 单测直接注入 mock fetchImpl
- **双模式 fetch 注入**（关键约束：Agent 服务**无 CORS 头**，Tauri 生产模式 webview
  直连会被浏览器拦截）：
  - DEV：`globalThis.fetch` + vite proxy（相对路径）
  - PROD（Tauri）：`@tauri-apps/plugin-http` 的 fetch（CORS 豁免，项目已有依赖）
  - 按 `window.__TAURI_INTERNALS__` 探测选择，构造参数 `fetchImpl` 可覆盖（测试 mock）
  - 注意：`src-tauri/capabilities/default.json` 的 `http:default` allow 列表当前仅放行
    8787；Tauri 生产模式需明确放行 `http://127.0.0.1:8000/**` 和外部服务域名
    `https://aifred.cn/**`
- **双 base URL**：Hermes 和 Agent 必须使用不同的 client 与配置，不复用当前单一
  `BASE_URL`：
  - `VITE_HERMES_BASE_URL=https://aifred.cn`：双栈期间旧 Hermes 地址，仅供 `/api/team/*`
    和旧登录使用
  - `VITE_AGENT_BASE_URL=http://127.0.0.1:8000`：Agent 本地地址；开发环境的相对路径请求
    仍通过 Vite proxy 转发到该地址
  - Agent 的 `AITEAM_MANAGER_URL=https://aifred.cn`：Agent 访问 Manager 等外部服务时使用
    统一域名，由服务端网关按路径路由
  - Tauri production 中 Hermes/Manager 使用 `https://aifred.cn`，Agent 使用本机
    `http://127.0.0.1:8000`；两者不能共用 base URL
- **鉴权链路**：`getToken` 回调从 agentAuth store 取 token 注入 Bearer；
  401 → `onUnauthorized` → 登出。**新栈不依赖 Rust cookie jar**；旧 `get_cookies` / `set_cookie`
  命令与 Cookie 持久化已随 Hermes 传输层删除。
- **路径白名单**：只允许 `/api/agent/*` 与 `/api/auth/resolve-tenant-by-account`，
  防止误调旧端点（对齐 FredServer `web/shared` 的 `assertOwnTierPath` 设计）
- **幂等**：`prompt` 等写方法强制 `idempotencyKey` 参数 → `Idempotency-Key` header

### 3.3 vite proxy 细分（双栈并存期）

```ts
const hermesUrl = 'https://aifred.cn'
const agentUrl = 'http://127.0.0.1:8000'

const proxy = {
'/api/team': { target: hermesUrl },                          // 旧栈（https://aifred.cn）
'/api/auth/login': { target: hermesUrl },                    // 旧栈登录
'/api/agent': { target: agentUrl },                          // 新栈本地 Agent（127.0.0.1:8000）
'/api/auth/resolve-tenant-by-account': { target: agentUrl }, // 新栈租户解析
}
```

启动检查也必须使用 Agent 独立 client：先请求 `GET /healthz` 确认进程存活，再请求
`GET /readyz` 确认 SQLite、工作目录和 sandbox 可用。旧 Hermes 的 `/health` 不能作为
Agent 的兼容别名。

### 3.4 数据流改造（run 驱动 → 会话驱动）

```
登录     resolve-tenant-by-account → /api/agent/login → {token, claims}
员工列表 GET /grants/experts（ExpertProjection[]）
         ↓ employee→conversation 映射改由前端从会话列表（entry_employee_id）反向推导
会话列表 GET /conversations（kind='chat' 私聊 / 'group' 群聊）
发消息   无会话 → POST /conversations {kind:'chat', entry_employee_id}
         → POST /conversations/:id/prompt（202）→ SSE events
流式渲染 message_update.assistantMessageEvent：
         text_delta → onDelta；thinking_delta → onThinkingDelta
         tool_execution_start/end → onToolCall；agent_end/agent_settled → 终态
终态     GET /entries 刷新一次（SSE 只保证增量）
已读     PATCH /conversations/:id {last_read_entry_id}
停止     POST /conversations/:id/abort
恢复流   先 GET /entries，再按每个 conversation 保存的 lastEventId 通过 SSE
         ?after=<lastEventId> 补事件；服务端规定 after 优先于 Last-Event-ID
```

事件订阅必须保证每个 conversation 最多一个活动订阅，并对 event id 做去重。页面刷新、切换
会话或网络断开时使用指数退避重连。终态判定分场景：单聊中 `agent_end` 和 `agent_settled`
都视为可结束当前 prompt 的终态事件；**群聊中服务端对多个 @提及目标 fan-out，每个目标专家
的 Pi session 各自产生 `agent_end`/`agent_settled`**，必须按 `source_employee_id` 分流
跟踪，全部目标 settled 后才 finalize 占位消息（或统一以终态后 `GET /entries` 刷新为准），
否则第一个专家 settled 就会提前结束、丢失其余专家的输出。非活动会话的未读变化继续通过
会话列表轮询（当前前端为 30 秒一次）获取，不能假设单会话 SSE 能提供全局未读通知。

- **群聊**：建群 `POST /conversations {kind:'group', coordinator_employee_id}`；
  发消息带 `mentions`（@handle）。成员无接口，roster 从专家投影 / solution roster 推导，
  不得默认推导为企业全员；`CreateGroupDialog` 需按"选协调人 + 授权 roster"重设计交互
- **附件**：先确保会话存在 → attachments 上传（base64）→ prompt 引用 `attachment_ids`

### 3.5 chat store 重构策略（`src/stores/chat.ts`，1308 行，最大风险点）

保留 store 对外接口形状（conversations/groups/activeConvMessages/appendMessage/
startAssistantStream...），内部替换实现，UI 组件层改动最小化：

| 移除的概念 | 替代 |
|---|---|
| `sendRun` / `runId` / `ACTIVE_RUN_STATUSES` / `fetchRunEvents` | 会话驱动 + SSE `after` |
| 占位消息 id `pending_<runId>` | `pending_<conversationId>` |
| `streamRun(runId, ...)` 回调签名 | 保留签名（首参改为 conversationId），内部由 piConverters 分发 PiEvent |
| `abortRun(runId)` | `abortPrompt(conversationId)` |
| `markConvRead` → workbench/state | `markConversationRead` → PATCH last_read_entry_id |

**piConverters.ts**（纯转换层）：
- `toMessages(PiEntry[])` → 现有 `Message`：content parts 拆分为 content（text 拼接）/
  thinking / toolCalls / thinkingSteps；`source_employee_display_name` → `senderName`
- `dispatchPiEvent(PiEvent, callbacks)` → 流式回调分发（assistantMessageEvent 分流、
  tool_execution_* → ToolCall、agent_end/agent_settled → done、auto_retry/compaction 的
  errorMessage → 错误注入）

转换层必须镜像 FredServer 的 `PiEntry`、`PiSseEventData` 和脱敏规则，不能根据旧 Hermes
事件的宽松字段猜测。至少要覆盖 text/thinking/toolCall/image content parts、工具参数与结果、
`approval_required`、自动重试、上下文压缩、终态和错误事件，并为每一类事件补单测。

### 3.6 前端内存状态与持久化边界

- Agent SQLite 是会话、entries、附件、产物和运行状态的唯一事实源；前端不在新栈中读写
  本地消息数据库。
- `chat store` 只维护当前已加载的 conversations、entries、流式占位和 UI 状态；切换或刷新
  时通过 `/conversations`、`/entries` 重新装载。
- **本地 Tauri SQLite 已删除**：移除 `stores/auth.ts` 的 `dbInit`、`Panel.tsx` 的本地消息
  搜索/会话写入、欢迎消息写入，以及旧 WebSocket 接收链路中的 DB 持久化和 `dbReady` 依赖；
  运行时图与 Tauri command 注册审计确认无调用后，删除 `lib/db.ts` 和 Rust DB 历史文件。
- 迁移初期侧边栏搜索只搜索已加载的内存数据；如果产品要求跨全部历史 entries 的全文搜索，
  应新增 Agent 搜索接口或明确按需加载策略，不启用本地 SQLite FTS 作为新栈数据源。

## 四、分阶段实施路线

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **Phase 0**（契约与打包 spike） | FredServer 补 `ConversationMetadata.last_preview`（最近 entry text 截断）+ `unread_count`（`id > last_read_entry_id` 计数）；AITeam 验证 Node 22.19+ runtime、私有 npm 依赖离线打包、arm64/x64 bundle、Agent `127.0.0.1:8000` 连通、外部服务 `https://aifred.cn` 连通、`/healthz`/`/readyz` 和 Tauri capability | 服务端契约 PR + Agent bundle smoke test |
| **Phase 1**（新栈地基，不改页面行为） | `src/api/agent/` 全套 + 独立 Hermes/Agent client + `agentAuth` store + `piConverters` + vite proxy 细分 + Agent health/ready client + 登录双入口 + 引入 vitest；确定 dev auth 与生产 JWT/JWKS 配置 | PR-1 |
| **Phase 2**（主链路迁移） | `stores/chat.ts` 内部切新栈；`pages/Chat`（prompt+附件）、`pages/GroupChat`（coordinator+mentions）、`CreateGroupDialog` 适配；SSE 重构（含群聊按 `source_employee_id` 分流的终态跟踪）；`GroupDetailPanel` 使用授权 roster；新栈改为 Agent entries + 内存状态；移除所有业务侧 Tauri SQLite 初始化、读写和 `dbReady` 依赖 | PR-2 |
| **Phase 3**（周边页面） | `OfficeStatus` → `/office/scene`；`OrgChart` → `/org/tree`（读取）+ `/org/departments`（添加、重命名、移动、`/promote` 下级升级）、`/org/assignments/{id}`（owner/enterprise_admin 添加部门、调整层级、为员工追加部门，经 Agent 网关转发 Manager）；`TalentMarket` → `/marketplace/templates`（模板浏览保留，处理 Manager 不可用时的 503；招募按钮禁用，recruitments 已 410）；STT → `/audio/transcriptions` | PR-3 |
| **Phase 4**（收尾与正式打包） | 删除旧栈（`hermes.ts`/`stt.ts`/`socket.ts`/`messageReceiver.ts`/`hermesSync.ts`）；新增 `scripts/build-agent-backend.sh` 打包 Node 22+ 运行时与 agent_service 依赖为 resources bundle（对齐 `build-mac-intel-backend.sh` 结构）；`lib.rs` start/stop_backend 适配 node 进程 + 环境变量（AITEAM_ENV/AITEAM_MANAGER_URL/PORT/JWT/JWKS/AITEAM_AGENT_DATA_DIR）；前端使用 `/healthz` + `/readyz` 启动就绪门；删除已断开且无调用的本地 Tauri SQLite 历史实现 | PR-4 |

**历史范围说明**：KnowledgeBase、SkillCenter/AutoTasks/AgentConfig/McpConfig 与 `src/scene`
办公室渲染层在迁移阶段不改业务契约；后续 todo 审计已分别清理不可达 mock。认证 token 的独立
会话存储不受本地消息 SQLite 删除影响。

## 五、数据缺口与风险

| # | 风险/缺口 | 说明 | 建议 |
|---|---|---|---|
| 1 | **内嵌打包可行性**（最大不确定项） | agent_service 依赖 `@deepseek-ai/*`、`@earendil-works/pi-*` 私有包，Node ≥22.19；生产还要求 JWT/JWKS 和 sandbox | Phase 0 先做离线安装、arm64/x64 bundle、启动/ready smoke test；生产环境禁止 dev auth |
| 2 | 群聊 roster 语义 | 无 members 接口；ExpertProjection 不等于企业全员，方案还可能限定 coordinator 和专家列表 | 使用授权的 expert projection / solution roster；CreateGroupDialog 按"选协调人 + 授权 roster"重设计并与产品确认 |
| 3 | SSE 恢复与全局未读 | `after` 只提供会话事件增量，不能覆盖非活动会话未读；重复订阅或重复事件会造成 UI 错乱 | 每会话保存 lastEventId、事件去重、指数退避；保留会话列表轮询；覆盖刷新/断线/重启 Agent 场景 |
| 4 | 服务端补齐排期 | `ConversationMetadata` 当前没有 `last_preview`/`unread_count`，Phase 0 是跨仓库改动 | 将其作为 Chat 迁移前置契约；前端字段可选但要提供明确 fallback 或阻止 Phase 2 合入 |
| 5 | 双栈并存期登录态 | 当前旧登录的 `email` 只用于本地 userId，请求实际只发送 password；新 Agent 需要 account、tenant_id、password | 两个独立 store/session key、明确旧/新入口和退出清理；dev auth 仅注入 `Bearer local-development`，生产使用真实 JWT |
| 6 | 生产模式 SSE 鉴权 | 新栈 Tauri fetch 直接带 Bearer header，需验证流式 response body、断线和过期 token 行为 | 在 Tauri bundle 中实测 Bearer SSE、401 登出、重连退避和 `/readyz` |
| 7 | 前端历史搜索 | 新栈历史事实源是 Agent `/entries`，但没有专门搜索接口 | 按需遍历 Agent 会话与 entries 做客户端筛选；不启用第二份客户端数据库 |

## 六、验证策略

1. **单测**（vitest，Phase 1 引入，同时补 `package.json` script、配置和 lockfile）：envelope/problem 解包、piConverters、SSE 帧解析、断线重连、事件去重、health/ready、双 client 路由
2. **本地联调**（faux model，无需真实 LLM；Agent 受保护接口必须带 Bearer）：
   ```bash
   cd ../FredServer && pnpm --dir server/agent_service install
   AITEAM_ENV=development AITEAM_AGENT_DEV_AUTH=true AITEAM_PI_FAKE=true \
   AITEAM_MANAGER_URL=https://aifred.cn pnpm --dir server/agent_service start
   ```
   dev auth 下前端测试 client 可注入 `Bearer local-development` 跳过登录调主链路；生产禁止该 token。
3. **Tauri smoke test**：Agent 进程启动并监听 `127.0.0.1:8000` → `/healthz` → `/readyz` → Bearer 请求 → SSE response body → 退出清理；验证 `https://aifred.cn` 外部服务连通、capability、数据目录权限、8000 端口冲突和 JWT/JWKS 配置。
4. **手动走查清单**：登录（tenant 解析）→ 员工列表 → 建私聊 → 发消息 → 流式（正文/思考/
   工具调用）→ 停止 → 历史加载 → 群聊（coordinator + 授权 roster + @提及）→ 附件 →
   办公场景 → 断线重连（重启 Agent 后 `after` 续读）→ 非活动会话未读轮询 → 侧边栏内存搜索
5. **构建门**：每 PR `pnpm test`、`pnpm build`（tsc -b + vite build）通过；Phase 4 额外执行
   arm64/x64 bundle 校验

## 七、受影响文档清单及处置建议

接口层改造会使以下文档过时或部分过时，按处置方式分类：

### 7.1 需标注废弃（改造合入后执行）

| 文档 | 说明 | 处置 |
|---|---|---|
| `docs/api-hermes.md` | 旧 Hermes 接口文档全文（cookie/CSRF/run 模型），改造后完全过时 | 顶部加废弃声明指向本文档；保留作历史参考 |
| `docs/api.json` | 已替换为 8783 OpenAPI | 当前唯一接口契约 |
| `docs/AI-MSG-SEND-FIX.md` | Hermes 对接踩坑总结（CSRF 只验存在性、workbench 结构等） | 顶部加"仅适用旧栈"声明；新栈无这些问题 |
| `API_DESIGN.txt`（根目录） | 早期接口设计设想（WebSocket、`/auth/login {email,password}` 等），大量内容从未实现且与新契约冲突 | 归档或删除 |
| `OFFICE_SCENE_UPDATE.md`（根目录） | 引用 `GET /api/team/employees` 作为办公室数据源 | 已删除过时的一次性实现记录 |

### 7.2 需更新内容（与本次决策直接矛盾）

| 文档 | 矛盾点 | 处置 |
|---|---|---|
| `docs/AI-Team-Desktop-Plan.md` | §架构定位明确写"桌面端不含本地服务器，不需要 Node.js sidecar、离线不可用" | 与"Tauri 内嵌 Node Agent"决策**直接矛盾**，需更新该节并引用本文档 |
| `docs/mac-intel-dmg-build.md` | 打包流程围绕 Hermes + PostgreSQL bundle（`runtime/hermes/`） | 已连同 sidecar 脚本删除；Intel 发布改用纯 Tauri `tauri:build:mac:intel` |
| `msg-send-architecture.md`（根目录） | 消息发送链路基于 sendRun/乐观更新 + DB 持久化（已停用） | 已删除，当前链路以 Agent 会话 prompt/SSE 契约为准 |

### 7.3 不受影响

| 文档 | 原因 |
|---|---|
| `docs/description.md` | 需求描述，不含接口细节 |
| `docs/new_design.md`、`docs/设计系统视觉规范.md`、`docs/设计视觉系统参考.html` | 纯视觉/设计规范，无接口引用 |
| `OFFICE_ADJUSTMENT_GUIDE.md`、`OFFICE_ACTIVITY_LOG_IMPLEMENTATION.md`、`COMPUTER_ASSETS_TODO.md`、`cc-haha-*.md` | 当前未发现与本次接口迁移直接冲突的内容 |

`README.md` 需纳入更新：当前仍写着后端 API 尚未就绪、默认地址为 `localhost:8080`，且没有说明
Node sidecar 和离线能力边界，与当前代码及 Agent 内嵌方案均不一致。至少应更新运行架构、开发启动方式、
Agent 数据目录、Agent `127.0.0.1:8000` 端口、`https://aifred.cn` 外部服务域名、JWT/JWKS 配置和
离线能力边界。

### 7.4 文档维护约定（新增）

- 新栈接口以 FredServer `server/agent_service/src/http/server.ts` 的 TypeBox schema 为
  **唯一事实源**，本仓库只做按需镜像，不在文档中手工维护接口清单
- 接口行为疑问优先查 Agent 服务运行时文档：`/docs`（Swagger UI）、`/redoc`、`/openapi.json`
