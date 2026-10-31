# 8783 接口核对表

唯一 HTTP 契约：[8783 OpenAPI](http://121.40.78.201:8783/openapi.json)，本地副本为 [api.json](api.json)，获取日期 2026-09-10；2026-10-13 与后端分支 `feat/local-directory-knowledge` 重新同步（新增受控本地目录 6 接口，automation-tasks 操作从 `{action}` 通配改为枚举 `enable`/`pause`）。

覆盖 74 组请求方法与路径；快照读取继续排除；授权同步已接入登录与会话恢复，其余 73 组均来自该文档。未调用的接口不会为了补齐列表而自动发请求。桌面端接口分流见 [本机 Agent 集成](agent-sidecar.md)。

核对范围：页面、store、API 封装、SSE、附件下载、浏览器代理和原生请求。原生启动仅访问本机 healthz/readyz，并读取 openapi.json 核验包版本；openapi.json 是契约元数据。asset:// 本地文件读取、Tauri 文件和凭证命令不是服务端 HTTP 接口。分发包内部服务间通信不由 WebView 发起；本次已同步 Agent reconciliation v2、运行中消息快照和事实状态能力。

已移除：Manager 封装与类型、任意知识预览 URL 下载、原生 http_request_binary 通道、消息附件 URL 直连、无契约的模拟技能 API、旧 multipart 上传支持。知识文档远程预览不可用，本地文件预览保留。

运行 `pnpm check:api-contract` 核对全量文档方法/路径、全部 request 调用点与旁路传输；更新代码后使用 `pnpm check:api-contract --write-report` 重新生成此表。

| 方法 | 路径 | operationId | 客户端状态 | 调用位置 |
| --- | --- | --- | --- | --- |
| GET | `/api/agent/automation-tasks` |  | 已核对调用 | `src/api/agent/automationTasks.ts:81` |
| POST | `/api/agent/automation-tasks` |  | 已核对调用 | `src/api/agent/automationTasks.ts:96` |
| GET | `/api/agent/automation-tasks/{task_id}` |  | 已核对调用 | `src/api/agent/automationTasks.ts:85` |
| PATCH | `/api/agent/automation-tasks/{task_id}` |  | 已核对调用 | `src/api/agent/automationTasks.ts:107` |
| DELETE | `/api/agent/automation-tasks/{task_id}` |  | 已核对调用 | `src/api/agent/automationTasks.ts:115` |
| POST | `/api/agent/automation-tasks/{task_id}/actions/enable` |  | 已核对调用 | `src/api/agent/automationTasks.ts:111`（enable/pause 枚举路径） |
| POST | `/api/agent/automation-tasks/{task_id}/actions/pause` |  | 已核对调用 | `src/api/agent/automationTasks.ts:111`（enable/pause 枚举路径） |
| GET | `/api/agent/automation-tasks/{task_id}/runs` |  | 已核对调用 | `src/api/agent/automationTasks.ts:119` |
| GET | `/api/agent/connectors` |  | 已核对调用 | `src/api/agent/automationTasks.ts:123` |
| GET | `/healthz` | healthz | 已核对调用 | `src/App.tsx:73`<br>`src-tauri/src/agent.rs:233` |
| GET | `/metrics` | metrics | 文档允许，当前未调用 |  |
| GET | `/readyz` | readyz | 已核对调用 | `src/App.tsx:73`<br>`src-tauri/src/agent.rs:243` |
| GET | `/openapi.json` | openapi | 已核对调用 | `src/api/agent/customGroups.ts:24`<br>`src-tauri/src/agent.rs:248` |
| GET | `/redoc` | redoc | 文档允许，当前未调用 |  |
| GET | `/redoc/redoc.standalone.js` | redocBundle | 文档允许，当前未调用 |  |
| POST | `/api/auth/resolve-tenant-by-account` | resolveTenantByAccount | 已核对调用 | `src/api/agent/auth.ts:23` |
| POST | `/api/agent/login` | login | 已核对调用 | `src/api/agent/auth.ts:38` |
| POST | `/api/agent/reset-password` | resetPassword | 已核对调用 | `src/api/agent/auth.ts:76` |
| POST | `/api/agent/audio/transcriptions` | transcribeAudio | 已核对调用 | `src/api/backend/index.ts:16` |
| GET | `/api/agent/ping` | ping | 文档允许，当前未调用 |  |
| GET | `/api/agent/whoami` | whoami | 已核对调用 | `src/stores/agentAuth.ts:234`<br>`src/stores/agentAuth.ts:335` |
| GET | `/api/agent/conversations` | listConversations | 已核对调用 | `src/api/agent/conversations.ts:57` |
| POST | `/api/agent/conversations` | createConversation | 已核对调用 | `src/api/agent/conversations.ts:89` |
| GET | `/api/agent/conversations/{conversation_id}` | getConversation | 已核对调用 | `src/api/agent/conversations.ts:100`<br>`src/api/agent/customGroups.ts:37` |
| PATCH | `/api/agent/conversations/{conversation_id}` | updateConversation | 已核对调用 | `src/api/agent/conversations.ts:111` |
| PUT | `/api/agent/conversations/{conversation_id}` | replaceConversation | 文档允许，当前未调用 |  |
| DELETE | `/api/agent/conversations/{conversation_id}` | deleteConversation | 已核对调用 | `src/api/agent/conversations.ts:131` |
| GET | `/api/agent/conversations/{conversation_id}/state` | getConversationState | 已核对调用 | `src/api/agent/conversations.ts:143` |
| PUT | `/api/agent/conversations/{conversation_id}/state` | setConversationState | 已核对调用 | `src/api/agent/conversations.ts:154` |
| GET | `/api/agent/conversations/{conversation_id}/context` | getConversationContext | 已核对调用 | `src/api/agent/conversations.ts:165` |
| PATCH | `/api/agent/conversations/{conversation_id}/context` | updateConversationContext | 已核对调用 | `src/api/agent/conversations.ts:177` |
| PUT | `/api/agent/conversations/{conversation_id}/thinking-level` | setConversationThinkingLevel | 文档允许，当前未调用 |  |
| POST | `/api/agent/conversations/{conversation_id}/prompt` | promptConversation | 已核对调用 | `src/api/agent/conversations.ts:194` |
| GET | `/api/agent/conversations/{conversation_id}/events` | subscribeConversationEvents | 已核对调用 | `src/api/agent/events.ts:185` |
| GET | `/api/agent/conversations/{conversation_id}/entries` | listConversationEntries | 已核对调用 | `src/api/agent/conversations.ts:251`<br>`src/api/agent/index.ts:102` |
| GET | `/api/agent/conversations/{conversation_id}/participants` | listConversationParticipants | 已核对调用 | `src/api/agent/customGroups.ts:38`<br>`src/api/agent/customGroups.ts:56`<br>`src/api/agent/observations.ts:7` |
| GET | `/api/agent/messages/search` | searchMessages | 已核对调用 | `src/api/agent/observations.ts:8` |
| POST | `/api/agent/conversations/{conversation_id}/abort` | abortConversation | 已核对调用 | `src/api/agent/conversations.ts:297` |
| GET | `/api/agent/conversations/{conversation_id}/attachments` | listAttachments | 已核对调用 | `src/api/agent/files.ts:30` |
| POST | `/api/agent/conversations/{conversation_id}/attachments` | uploadAttachment | 已核对调用 | `src/api/agent/files.ts:47` |
| GET | `/api/agent/conversations/{conversation_id}/artifacts` | listArtifacts | 已核对调用 | `src/api/agent/files.ts:30` |
| POST | `/api/agent/conversations/{conversation_id}/artifacts` | uploadArtifact | 已核对调用 | `src/api/agent/files.ts:47` |
| GET | `/api/agent/conversations/{conversation_id}/attachments/{attachment_id}` | downloadAttachment | 已核对调用 | `src/api/agent/index.ts:84` |
| DELETE | `/api/agent/conversations/{conversation_id}/attachments/{attachment_id}` | deleteAttachment | 已核对调用 | `src/api/agent/files.ts:61` |
| GET | `/api/agent/conversations/{conversation_id}/artifacts/{artifact_id}` | downloadArtifact | 已核对调用 | `src/api/agent/index.ts:84` |
| DELETE | `/api/agent/conversations/{conversation_id}/artifacts/{artifact_id}` | deleteArtifact | 已核对调用 | `src/api/agent/files.ts:61` |
| GET | `/api/agent/grants/experts` | listAuthorizedExperts | 已核对调用 | `src/api/agent/experts.ts:28` |
| GET | `/api/agent/grants/solutions` | listAuthorizedSolutions | 已核对调用 | `src/api/agent/experts.ts:44` |
| GET | `/api/agent/grants/snapshots` | listFrozenSnapshots | 按用户要求排除 |  |
| GET | `/api/agent/grants/readiness` | grantsReadiness | 已核对调用 | `src/api/agent/auth.ts:63` |
| GET | `/api/agent/grants/experts/{employee_id}/readiness` | expertReadiness | 已核对调用 | `src/api/agent/experts.ts:62` |
| POST | `/api/agent/grants/sync` | syncGrants | 已核对调用 | `src/api/agent/auth.ts:57` |
| POST | `/api/agent/employees/{employee_id}/avatar` | updateEmployeeAvatar | 已核对调用 | `src/api/agent/avatar.ts:17` |
| GET | `/api/agent/employees/{employee_id}/avatar/content` | getEmployeeAvatar | 已核对调用 | `src/api/agent/avatar.ts:29` |
| GET | `/api/agent/work-records` | listWorkRecords | 已核对调用 | `src/api/agent/conversations.ts:272`<br>`src/api/agent/observations.ts:9` |
| GET | `/api/agent/work-records/changes` | listWorkRecordChanges | 已核对调用 | `src/api/agent/observations.ts:10` |
| GET | `/api/agent/usage/statistics` | getUsageStatistics | 已核对调用 | `src/api/agent/observations.ts:11` |
| GET | `/api/agent/usage/outbox` | listUsageOutbox | 文档允许，当前未调用 |  |
| POST | `/api/agent/usage/flush` | flushUsage | 文档允许，当前未调用 |  |
| GET | `/api/agent/marketplace/templates` | listMarketplaceTemplates | 已核对调用 | `src/api/backend/index.ts:22` |
| GET | `/api/agent/marketplace/templates/{template_id}` | getMarketplaceTemplate | 已核对调用 | `src/api/backend/index.ts:25` |
| GET | `/api/agent/knowledge-bases` | listKnowledgeBases | 已核对调用 | `src/api/backend/index.ts:27` |
| GET | `/api/agent/knowledge-bases/{knowledge_base_id}/{kind}` | knowledgeReadModel | 文档允许，当前未调用 |  |
| GET | `/api/agent/knowledge-bases/{knowledge_base_id}/{kind}/{resource_id}` | knowledgeReadModelResource | 文档允许，当前未调用 |  |
| GET | `/api/agent/org/tree` | orgTree | 已核对调用 | `src/api/backend/index.ts:17` |
| POST | `/api/agent/org/departments` | createOrgDepartment | 已核对调用 | `src/api/backend/index.ts` |
| PATCH | `/api/agent/org/assignments/{employee_id}` | assignOrgDepartment | 已核对调用 | `src/api/backend/index.ts` |
| PATCH | `/api/agent/org/departments/{department_id}` | updateOrgDepartment | 已核对调用 | `src/api/backend/index.ts` |
| DELETE | `/api/agent/org/departments/{department_id}` | deleteOrgDepartment | 已核对调用 | `src/api/backend/index.ts` |
| POST | `/api/agent/org/departments/{department_id}/promote` | promoteOrgDepartment | 已核对调用 | `src/api/backend/index.ts` |
| GET | `/api/agent/office/scene` | officeScene | 已核对调用 | `src/api/agent/index.ts:132` |
| GET | `/api/agent/office/feed` | officeFeed | 已核对调用 | `src/api/agent/index.ts:135` |
| POST | `/api/agent/conversations/custom-group` | createCustomGroup | 已核对调用 | `src/api/agent/customGroups.ts:31` |
| GET | `/api/agent/local-directories` | listLocalDirectories | 已核对调用 | `src/api/agent/localDirectories.ts:58`<br>`src/pages/KnowledgeBase/LocalDirectoriesPanel.tsx`<br>`src/pages/TalentMarket/TalentEmployeeWorkspace.tsx` |
| POST | `/api/agent/local-directories` | registerLocalDirectory | 已核对调用 | `src/api/agent/localDirectories.ts:66`（凭一次性票据注册，禁止提交路径）<br>`src/pages/KnowledgeBase/LocalDirectoriesPanel.tsx` |
| POST | `/api/agent/local-directories/challenges` | createLocalDirectoryChallenge | 已核对调用 | `src/api/agent/localDirectories.ts:62`<br>`src/pages/KnowledgeBase/LocalDirectoriesPanel.tsx`（原生选择器前置挑战） |
| PUT | `/api/agent/local-directories/{directory_id}/bindings/{employee_id}` | setLocalDirectoryBinding | 已核对调用 | `src/api/agent/localDirectories.ts:70`（`expected_revision` 乐观并发，409 提示刷新重试）<br>`src/pages/TalentMarket/TalentEmployeeWorkspace.tsx` |
| DELETE | `/api/agent/local-directories/{directory_id}` | revokeLocalDirectory | 已核对调用 | `src/api/agent/localDirectories.ts:80`（两段式确认）<br>`src/pages/KnowledgeBase/LocalDirectoriesPanel.tsx` |
| POST | `/api/agent/local-directory-citations/{citation_id}/verify` | verifyLocalDirectoryCitation | 已核对调用 | `src/api/agent/localDirectories.ts:85`（每次展示原文前实时重验授权）<br>`src/components/Chat/LocalCitationCard.tsx` |
