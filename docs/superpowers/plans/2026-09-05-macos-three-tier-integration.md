# macOS 三端复合客户端接入补齐实施计划

## 目标与授权

用户已授权：开始开发前一轮接口审查确认的补齐项，完成后通过 CI 流水线部署 taiyi 测试服务器，并提供可直接发给客户端团队的接入说明（不复制 API 参数详情）。基线为 main `0c9ef35bff65888bb8eaee224f9d9a364eaf33b4`，实施分支 `feat/macos-three-tier-integration`。

macOS 是三端客户端复合体：运营模块直接调用 Operator，企业管理模块直接调用 Manager，本机聊天/执行模块调用本地 Agent。各模块使用正确身份/权限；这不改变数据所有权，不要求 Agent 通用代理其它端。Agent 会话/工作明细不上传控制面。

## 本轮范围

1. 修复已复现的 Agent 缺陷：会话列表同 timestamp 分页漏项；群历史 source_role=`member` 与公开 `participant` 不一致；冷启动办公历史 JSONL 换行解析错误；市场技能计数使用已废弃 skill_ids。
2. Agent 会话列表/详情增加真实 last_preview 与 unread_count，复用 last_read_entry_id；增加真实群成员只读查询，不用授权全集冒充成员。
3. Agent 增加本机消息全文搜索及历史分页，Pi JSONL 仍为正文事实源；检索匹配完整的可检索文本，HTTP 输出继续脱敏和限长。保留旧调用方不带分页参数时的 entries 响应兼容，带参数时明确分页元信息。
4. Agent 增加当前成员/员工本机工作记录、用量统计、历史翻页与增量轮询。复用 Pi Session/来源索引和既有 usage 捕获，只建立必要的本地派生查询记录，不恢复 Run/Task 执行内核。
5. Manager 员工配置增加统一可选岗位字段 role_title（非账号权限角色），贯穿数据库、schema/service/repository、组织树与授权投影；Agent office/roster 可展示岗位及真实多部门关联。没有值时明确未设置，不猜测默认岗位。
6. Agent 市场摘要透出已有 description 和固定平台技能引用并修正计数；可直接使用 Manager 市场完整目录的复合客户端在文档中明确说明。
7. 收紧 Agent 专用成功身份 tenant_id 约束，保留 Operator 共享身份可空；完善 sidecar 文件型 JWKS 安装及轮换说明、RAG MCP 配置示例、动态端口接入说明，不引入凭据或自动信任未知 issuer。
8. 一份中文编号接入说明覆盖原 17+3 项：已有能力如何选择端和接口、新能力如何接、明确不可用/后续定义的项；无表格、不重复字段详情，指向三端 API Docs。

## 本轮不做/不伪造

- 不恢复 Agent recruitment/knowledge-bases 写入口；招募、组织编辑、企业知识管理复用 Manager 现有 API，macOS 复合客户端可直连。
- 不伪造模板 usage_stats、price_tier、全平台 recruit_count，不把企业实例 knowledge/connector/memory 绑定塞入公开模板。模板商业定价、跨企业使用统计和招募前能力要求缺少业务定义，本轮接入文档明确未提供。
- 市场小目录继续支持客户端名称/分类筛选；不为“以后可能很大”扩展三端服务端市场索引/搜索协议。消息全文搜索是本轮明确范围，不混淆二者。
- 不读取/改写冻结 app/，不引入旧 runtime/Gateway/Run/Task/Loop 状态机，不改 Pi SDK 依赖，不上传工作正文，不修改外部 Hermes 仓库。
- 不修改真实生产配置、凭据/CI secrets；taiyi 为测试部署，不能宣称生产 JWKS 已交付。

## 必须收口的实现语义

- preview：最新可见 user/assistant 消息的脱敏短摘要，排除 thinking/tool/internal entry；无消息为 null。未读仅统计已读位置之后的可见 assistant 消息，群按真实来源、稳定次序处理；human/employee 输入、工具和 streaming delta 不重复计数。已读更新校验引用属于当前会话，拒绝跨会话/非法引用。
- roster：来自 conversation_participant_session，给出员工身份/展示信息/协调者或成员角色及当前可用性；人数明确为数字员工人数，不计本机人类用户；撤权成员可展示历史身份但不可执行。绝不返回 session_file/workspace/凭据。
- cursor：opaque、有版本、限定 owner/resource/filter，方向明确；排序含稳定 tie-break。非法/异作用域 cursor 拒绝，不依赖客户端过滤实现安全。历史翻页不能丢同 timestamp 记录。
- work records：一条记录对应一个员工的一次实际 prompt 执行；以事件/会话/员工关联展示，不独立决定执行主状态。新增记录及同记录完成/失败/中断/恢复产生可轮询的变更游标；只按 created_at 拉新增不满足要求。结束路径包括异常/abort；重启后未确认结果不能标成功。旧 Pi 历史有界重建或明确标记来源/未知用量，不造每项历史费用。
- statistics：当前认证用户、本机范围，支持员工与时间范围；token 与执行次数复用真实计量且幂等重试不重复。沿用员工执行次数，不把它称用户业务任务数。价格未知显式可见，金额使用一致币种和精度，不能累加逐次四舍五入到 cents 的零值后冒充实际零费用。已上报 sent 项也不能从本机总量消失。
- history/search：没有查询条件时兼容当前 entries 消费；搜索须覆盖截断点以后的匹配，返回安全 snippet 和来源/定位；多 participant entry 标识及同 timestamp 顺序稳定。只读查询不触发模型执行，owner 校验先于读会话文件。
- OpenAPI：所有新接口/字段/参数/错误/nullable/分页/时间范围都有真实 schema、summary、description、examples；接口详细定义以生成的 API Docs 为准。任何不可避免的破坏性语义先更新本计划并联系主控，不自行扩大范围。

## 编码前接口与读取语义收口（2026-09-05，阶段 1 执行契约）

1. `GET /api/agent/conversations?limit=&cursor=` 保持 `{data:[],page}`；排序为 `(updated_at DESC,id DESC)`。新 cursor 为带版本、owner、resource/filter scope 摘要和冻结 tuple 边界的 opaque 编码，不从当前 anchor 行重取时间；它不是授权凭证，每次查询仍独立限定 owner。旧裸 conversation ID 仅在当前 owner 中能找到时接受。未知查询字段、非法/跨 owner/resource cursor 返回 422；本轮不新增会话列表筛选项。
2. `GET /api/agent/conversations/{id}/entries` 不带参数时保持 `{data:{conversation_id,entries}}`，不加 page、不创建 Session；保留现有 `id/parentId`。带 `limit` 或 `cursor` 时启用历史分页，默认 limit=50，范围 1–100；沿历史正序向后读，在顶层增加 `{page:{next_cursor,has_more}}`。可用 `entry_ref` 定位参数从该条目起（包含该条目）读取一页，不能与 cursor 混用。未知字段/非法参数返回 422。
3. 新增稳定 `entry_ref`（conversation、participant、原 Pi entry ID 的版本化不可逆引用）和 `participant_employee_id`（所属 Session，不等于发送者）。历史统一按 `(timestamp ASC,conversation ID ASC,participant employee ID ASC,Session 内 append ordinal ASC,Pi entry ID ASC)` 排序；无合法 timestamp 为 0。同 logical_message_id 的 fan-out user entry 取排序最前的一条，来源类型/ID 一并参与去重；assistant/tool 不按裸 ID 合并。Web key/de-dup 优先 entry_ref。分页边界独立于 entry_ref；SSE after/Last-Event-ID 不变，不承诺 transient delta 持久回放。
4. `PATCH/PUT /api/agent/conversations/{id}` 的 `last_read_entry_id` 推荐传 entry_ref，兼容该会话内唯一可解析的旧 raw ID，重复 fan-out 引用解析到保留的逻辑消息；跨会话、歧义、非法引用 422，非 owner 会话 404；null 清空。写入规范化 entry_ref。last_preview 为最新可见 user/assistant 的安全文本（最多 200 字；图片仅以占位文本表示），无消息为 null；unread_count 只计已读位置后有可见文本/图片的 assistant 消息，不计 thinking/tool/internal、human/employee 输入或 transient delta。旧失效/歧义已读指针按未读处理，不猜测位置。
5. `GET /api/agent/conversations/{id}/participants` 返回 `{data:{conversation_id,participants,employee_count}}`，真实 participant 索引按 coordinator 优先、employee ID 正序。角色公开为 coordinator/participant；人数只计数字员工。展示字段仅 allowlist 的员工 ID、display_name、handle、role、available；available 表示当前本地授权、active 生命周期和版本匹配快照可用（不是模型/网络健康保证）。撤权/缺失投影仍保留实际成员，available=false；空 roster 就返回空，不读授权全集补成员，不泄漏 Session/workspace 路径。
6. `GET /api/agent/messages/search?q=&conversation_id=&employee_id=&limit=&cursor=` 返回 `{data:[{conversation_id,conversation_title,entry_ref,id,participant_employee_id,timestamp,role,source_*,snippet}],page}`。q 为 trim 后 1–200 字、大小写不敏感的字面子串，不是正则；可选 conversation_id 精确限定 owner 会话，employee_id 按实际发送员工来源过滤（不把人类输入归给目标员工）。排序与历史相同但全 tuple 倒序（最新优先），每条逻辑可见消息至多一项；cursor 绑定 owner、全部筛选和排序。limit=50、1–100；snippet 最多 240 字。先对完整 text blocks 拼接结果执行现有凭据/路径脱敏，再匹配与取 snippet，不能先走 4,000 字/32 块 HTTP serializer。只扫当前 owner 全部会话，不复用 office 最近 100 个会话范围；无全文 SQLite/FTS 正文副本。
7. 新建小型纯读取/派生服务，host seam 只读取已存在的 participant JSONL 或旧 conversation.sessionFile fallback（包括有 entry_employee_id 但无 participant 行的旧文件）。owner 校验先于文件读取；空文件/空会话不创建 workspace、Session 或索引，不触发资源/模型初始化。活跃 Session 读取当前已存在 entries，legacy entries 可保留已有有限等待但不创建 Session；preview/search 不等待执行。所有读取共用 source decoration、logical message 去重和排序，删除后自然不可检索，不留第二正文存储。

8. 实施发现并由主控批准的来源索引时机修复：原 promptParticipant 在 settle 后才写 source index，会导致 active fan-out 读取重复/误归属。本阶段仅对已观测的 Pi user message，在 Pi append 提供稳定 entry ID 后，使用该 participant delivery 闭包中的真实 command 来源提前幂等写 `conversation_entry_source`，保留 settle 时补齐。Pi 当前 SDK 在 message_end listener 返回后同步 append，因此在随后 microtask 以同一 message 对象匹配稳定 entry；不修改 SDK、不保存正文、不改变执行生命周期。不在只读查询中写索引，也不将活跃 employee 输入猜为 human。慢速并发 human fan-out、employee→employee、settle/重启一致性为必测项，阶段 2 复用该来源索引。

## 主控已确认的阶段 2 收口（仅写回计划，本阶段不编码）

- 工作历史使用 `GET /api/agent/work-records`；变更轮询单独使用 `GET /api/agent/work-records/changes?after=…`。历史 page cursor 与单调 change_seq 不混用。一条实际 `promptParticipant` 执行对应 opaque execution ID、owner、员工/会话、Pi entry 区间、开始/结束和观测结果；HTTP fan-out 与 coordinator tool 投递共用，不用 HTTP 收据数代替执行数。不保留 prompt/result 正文、不控制执行。Pi abort/error/终态决定观测结果，不能用 Promise resolve 认定成功；初始化失败不可伪造模型用量；结算幂等标记与 usage 累加原子提交，重启未确认结果为未知/中断，不重放；旧历史 backfill 不重新计量。
- `GET /api/agent/usage/statistics` 复用全部本机小时摘要（pending/sending/sent/failed 均包括），按**执行开始时间所属 UTC 小时桶**归属。可选范围为 `[window_start,window_end)`，必须两端整点对齐且 start < end，否则 422，不静默舍入；不传范围读取全部。工作历史仍按执行精确时间筛选，API Docs/接入说明解释精度差异，不新增细粒度账本，不把小时费用分摊到旧工作记录。累计高精度 cost_total，最终展示再舍入；未知定价/缺失数据明确标识，不宣称为零。
- DELETE 会话清除可定位工作记录及搜索/预览派生内容；changes 返回删除标记，tombstone 仅保留 opaque record ID、owner/filter 范围和变更序号，不留正文/标题/路径或可回溯 conversation/entry 的引用。无会话/entry 引用的既有用量汇总保留，累计统计不能缩水或触发重新计量。验证删除后不可查询、after 可取删除、跨 owner 隔离和重启一致性。

## 文件落点与实施顺序

### 阶段 1：Agent 会话/历史读取
- `server/agent_service/src/http/server.ts`、`storage/sqlite.ts`、`pi/session-host.ts`、`pi/event-sse.ts`、`manager-client.ts`；新增小型读服务/分页 helper 仅在复用需要时采用，不继续向巨型 server 类塞全部业务。
- 先以现有 fixture 补四个缺陷回归，再实现 preview/unread/roster、entries 分页和消息搜索。
- 测试缺少消息/同时间戳/长消息/群来源/撤权/跨成员/非法 cursor/重启/旧客户端响应。

阶段 1 当前状态（2026-09-05）：代码与回归已完成，等待主控独立审查；本阶段没有开始阶段 2/3。Agent check 通过；Agent 全量 130 passed / 1 existing taiyi-only Linux matrix skipped；最后一轮定向回归 63 passed；Web Agent typecheck 与 chat 目录 95 tests 通过；根 .venv 的三端 runtime OpenAPI 检查均通过。首轮新 OpenAPI 测试仅因参数排列假设失败，已改为验证名称/位置/schema 集合并复测，未削弱门禁。未暂存/提交/发布；完整证据与后续 seam 见受控 worker handoff artifact。

### 阶段 2：Agent 工作记录与统计

编码前具体收口（2026-09-05，恢复执行 Stage 2 only）：
1. `GET /api/agent/work-records?employee_id=&window_start=&window_end=&limit=&before=`：当前 owner 全部/指定员工工作历史，按 `(occurred_at DESC,created_seq DESC)`，缺失 Pi 时间的旧记录排最后，不伪造 epoch 时间。`before` 使用上一页 `page.next_cursor`；默认 50、最大 100。范围成对传 UTC ISO 时间，按精确 `occurred_at` 取 `[start,end)`，不整点舍入。live 的 occurred_at 是 promptParticipant 实际开始，旧记录只能用真实首条 Pi entry 时间，`time_basis=pi_entry` 且 started_at/ended_at 为 null，明确不代表 prompt 起止。
2. `GET /api/agent/work-records/changes?employee_id=&after=&limit=`：按单调 change sequence 正序，返回最新记录 upsert 或仅 opaque ID 的 delete；响应 `page.next_cursor` 始终可继续用作 after（空页也返回），has_more 表示尚有待消费项。不传 after 从本机索引起点消费。history 的 `meta.after` 是第一页前的变更水位，后续 before 页保留同一水位，客户端历史加载后从该水位轮询，不能用 created_at 代替更新游标。changes 只允许 owner/employee scope，不接收 conversation、时间、outcome 筛选：否则删除 tombstone 必须残留可回溯内容。时间筛选的 history 客户端在同 owner/employee changes 上应用 upsert/remove；after 与 before 不混用，非法/跨 owner/employee/filter cursor 均 422。keyset 不是冻结内容快照，同 ID 按 upsert 更新。
3. SQLite 新增独立小型 work-record repository：记录实际执行 opaque UUID、owner/employee/conversation、Pi ordinal 区间、可空 entry 引用、观测时间/结果/来源、可空计量；不保存 prompt/result/title/path。独立最小 change index 每 record 仅保留最新 seq，upsert 和删除都分配新自增序号，避免同 timestamp/active→final 丢项；删除后该索引仅留 owner/employee/opaque ID/seq/delete。所有 SQL 查询独立限定 owner，不把 cursor 当授权。
4. 只在 `promptParticipant` 排队/忙校验之后、初始化之前建立 live 观测记录；共用 HTTP fan-out 与 employee mention。Pi agent_settled + 最后 assistant stopReason 判定成功，abort 标志/aborted 终态优先，error 终态或异常为失败，无可确认终态为 unknown。初始化失败 token/cost 为 null。finalize 与既有 hourly outbox 累加同一 SQLite 事务且只允许 active→final 一次；usageRecorder 仅在提交后触发既有 flush，不再重复累加。faux 模式不产生 billable outbox。
5. SQLite 打开时未结算 live 观测转 unknown（process_restart）、ended_at=null，不重放、不从 JSONL 猜测成功/费用，也不补计量。旧 JSONL 查询时按 participant 的 user→下一 user 区间派生历史（无 user 的 assistant 段也可显示），标 provenance=pi_history；只记录引用/真实 Pi 时间/可判定 stopReason，per-record usage/cost=null。按稳定首 entry 引用幂等导入，live ordinal 区间排除，永不调用 usage 累加；使用 Stage 1 的 owner-checked 非初始化文件读 seam 并保留 fan-out 的每个真实 employee Session。
6. `GET /api/agent/usage/statistics?employee_id=&window_start=&window_end=` 直接读取既有 hourly outbox 的全部状态，不建第二用量账本。仅接受两端 UTC 整点或都省略，归属 execution start UTC hour；严格 owner 与 payload 身份校验。新累计在同一 outbox 小时行的 `cost_total_decimal` 字段以十二位定点数精确相加（不是第二账本）；既有跨端 payload.cost_total 保持 numeric alias 兼容，cost_minor 从累计金额最终舍入，不再相加每项 cents。旧行该字段为 null 时只能使用已存 cost_total 的原精度。新只读 API 费用为固定 12 位 USD decimal string。未知定价/缺失计量返回 nullable 总费用和已知费用小计、未知执行数量，不反推旧 per-record 价格，也不恢复旧版本已舍去的小数。
7. 先实现/测试 repository 与 usage 纯逻辑，再接 host lifecycle/backfill/service/API schema；验证成功/异常/resolve-abort/初始化失败、重启未知、同毫秒并发/群/幂等、旧历史不重计、历史精确范围 vs 统计整点、全部 outbox 状态/未知价格/币种/亚 cents 精度、删除轮询与 owner/cursor 隔离。最后 Agent check、定向/全量测试与真实 runtime OpenAPI 检查。无 Manager/岗位/发布文档、SDK 或依赖改动。

- 延续同一 writer cwd，`services/`、`storage/`、`pi/session-host.ts`、`usage.ts`、`main.ts`、HTTP schema/routes 及测试。
- 编码前将实际选定 API 路径、读存储方案、轮询和恢复策略更新到本计划；未知核心语义及时向主控提出。
- 先实现真实生命周期捕获/旧历史策略，再查询+双向 cursor/更新轮询，再统计；验证重复调用/结算、并发、群多员工、重启、时间筛选、未定价。

阶段 2 当前状态（2026-09-05/06 恢复执行）：Stage 2 only 代码与同步回归完成，待主控独立审查。新增 8 个 HTTP 和 6 个 service/repository 用例；覆盖 actual Pi success/resolved-error/resolve-abort/active-delete/初始化失败、群并发与 peer tool/HTTP 幂等、同毫秒更新续页、before anchor 删除、SQLite/host 重启 unknown、旧 JSONL 引用不重计、精确范围与 UTC 整点、全部 outbox 状态、原子回滚、faux 不计费、定点费用与未知/异常币种、删除最小 tombstone/owner 隔离。现有 OpenAPI 数量断言由 47 更新为新增三路由后的 50，仍逐项验证 schema/example/error/header；原六位 cost_total 舍入断言改为真实精确值 0.000010245，非削弱门禁。Agent check 通过；最后一轮定向 34 passed，全量 144 passed / 1 existing taiyi-only Linux matrix skipped；三端 runtime OpenAPI 校验通过，SDK schema 未回写。无 Manager、role_title、发布/客户端指南、依赖改动、暂存、提交、push 或部署。初始验证出现的新代码 ES2023 findLast（项目 ES2022）及 fixture 类型错误已改正；首轮新测试的 faux 自算 tokens/DELETE 既有 200 状态假设与全量测试 API 数量假设均定位并纠正。大历史首次及轮询仍需同步 JSONL 扫描以重建/读取摘要，未做生产规模延迟基准；旧摘要已丢精度/崩溃未计量不补造，changes 是最新态 upsert 不是逐事件回放。完整证据与 review gate 见 Stage 2 worker handoff artifact。

### 阶段 3：Manager 岗位、投影、接入文档

编码前具体收口（2026-09-06，恢复执行 Stage 3 only）：
1. 主控确认 `role_title` 为唯一岗位拼写，nullable；设置时 1–100 字符，无默认岗位。复用 employee 配置 POST/PUT（完整替换，省略或 null 清空）、读/列表、组织树、authorized-config；不加 assignment 表或别名、不改账号 roles。新增 0034 migration 加列及约束，延续 0033 全部 version trigger 条件并加入 role_title；不动 RLS/授权。真实 PG 用例验证旧行 null、变更/不变/清空版本、跨 tenant 与成员写拒绝、组织树/增量投影；现有 CI integration job 自动收集，无需修改门禁。
2. Agent expert/office/真实 roster 显式返回 role_title 和 department_ids（全部真实关联，不猜主部门/名称）。缺失投影/旧配置为 null/[]，公开展示字段脱敏；组织树透出同名岗位。市场保留真实 description、allowlist 固定 skill_id/version/content_hash、modern refs 优先计数；无来源 recruit_count 为 null 而非伪造 0，Web 仅对应隐藏未知计数，不扩展页面。
3. Agent 专用 AuthClaims.tenant_id 成功响应必为非空 string；本地 JWT 拒绝空企业身份，认证窄通道拒绝 Manager 返回无企业/异企业的成功身份。Operator/shared nullable claims 不变。
4. sidecar 仅公共配置/说明与可重复配置回归：配置迁移同时复制相对路径 JWKS 文件，准确 issuer/audience、启动加载与受控轮换/重启、Manager RAG MCP URL、动态端口 IPC；不下发秘密、不自动信任未知 issuer，不发布安装包。
5. 中文指南严格使用主控补充的原 1–20 映射：招募、会话摘要、roster、附件、正式JWKS、office接入、office岗位部门、org岗位/ID、org编辑、专家岗位/用量、消息搜索、市场详情、市场筛选、知识库、模板能力边界、端口IPC、tenant身份、工作历史、本机/企业统计、双向历史/changes。每项端/现有或新增接口/客户端变化；无表格/手工完整 spec，指向真实三端 Docs/OpenAPI，测试地址非生产且尚未部署本轮。
6. 先同步 Manager fake/PG 测试，再实现字段全链；随后 Agent 结构化投影/身份/市场及回归，补公共配置和指南。最终根 .venv Manager focused pytest、Agent check/full tests、相关 Web/typecheck、三端 runtime OpenAPI 与 diff/no-staged 检查；CI/taiyi/提交由主控负责。
- `server/manager_service/schemas.py`、`employee_config_*`、`org_service.py`、`routes_org_schemas.py`、`migrations/` 和对应 fake/PG integration 测试；保留 TenantContext/RLS 和配置版本更新。
- Agent office/roster/专家显式 schema 补角色/多部门；补市场真实 description/技能字段；收紧 Agent 专属身份响应。
- `deploy/agent/config/agent.env.example`、`deploy/agent/CLIENT-INTEGRATION.md`、必要的 config 回归；不改用户真实配置。
- `docs/客户端接入/2026-09-05-macOS三端接口接入说明.md`：按 1—20 原编号说明接入端、接口和行为变化，不写接口字段大全，不采用表格。API Docs 链接/测试服务器地址须核实，不能宣称尚未发生的部署。

阶段 3 当前状态（2026-09-06 恢复执行）：Stage 3 only 实现与文档完成，待主控独立审查。role_title nullable/1–100、完整 PUT 省略/null 清空，0034 幂等加列和 trigger 延续全部 0033 条件；组织树/授权增量与 Agent expert/office/真实 roster 提供岗位和全部部门。市场真实 description/固定技能 allowlist、无来源 recruit_count=null；Web 仅隐藏未知招募统计并验证 Manager 完整配置保存不会丢岗位/多部门，无页面重设计。Agent 专属成功 tenant schema/认证拒绝空值及不一致值，Operator/shared claims 不变。公共配置/JWKS复制/启动轮换/RAG/IPC说明与原 1–20 中文无表格指南已写，明确 taiyi baseline 不是本轮部署，本机包需独立升级。

本阶段实际验证：Agent check 通过，最后全量 149 passed / 1 existing taiyi-only Linux skipped（150 total）；Manager focused 51 passed，全 Manager non-integration 1161 passed / 17 existing skips / 55 deselected；OpenAPI quality pytest 6 passed；Web Agent typecheck 和 marketplace/chat/office 111 tests 通过，Web Manager typecheck 和 experts/org 27 tests 通过（含全量 PUT 保留岗位/多部门回归）；根 .venv 三端真实 OpenAPI 检查及五个新增读取路由 descriptions/examples/422、Manager 授权引用/岗位字段脚本检查通过，无 SDK schema 回写；diff/no-staged/分支基线检查通过。

发现并修正的验证问题：新 HTTP fixture 错把 projection JSON revoked=true 当成正式撤权入口，已用已有 revokedIds 参数；Stage 1 roster 精确 allowlist 断言增加本轮两个获批字段，其余严格隐私断言保留；新 Manager 实际 OpenAPI 回归发现 shared.openapi 旧覆盖文案吞掉 route 的完整 PUT/岗位说明并误称已实现并发版本控制，已删除过时 override、保留真实 route 定义，授权描述同步补齐，复测全绿。自检发现 apply_migrations 会重放 SQL（非迁移账本），0034 使用 IF NOT EXISTS 并在真实 PG 用例包含二次重放验证。

真实 PG 边界：新增 test_employee_role_title_e2e.py 由未改动的 ci.yml integration job 自动收集，验证 app_rw/RLS、岗位 null/设置/清空/不变版本、部门组织与授权增量、403/404/422/DB长度、生命周期不涨版本及 migration 重放；本机缺 ADMIN_DB_URL/DB_URL，命令显式 1 skipped。尝试使用隔离测试 PostgreSQL：postgres:16 镜像不存在，docker pull 因非交互 macOS keychain 凭据助手锁定失败；未解锁/读取/改写凭据，未创建容器或执行部署。真实 PG/CI 仍为主控必过门，不能将 skip 视为迁移已验证。无暂存/提交/push/PR/部署/安装包发布，工作树原 Stage 1/2 代码保留。

### 阶段 4：独立审查与验证
- 独立 read-only reviewer 分别检查本地隐私/授权/cursor/计量正确性和三端契约/升级兼容/文档完整性；按证据修复并重新验证。
- Agent `pnpm check`、`pnpm test`；Python 相关及全量非集成测试；新增 Manager migration 的真实 PG/RLS 测试由 CI 必须执行；相关 Web typecheck/test（接口改动不得破坏当前 Web）。
- 使用根 `.venv` Python 执行 `scripts/check-openapi.sh` 生成并检查三端真实 API Docs；不通过删除/弱化测试或门禁解决失败。

阶段 4 审查后有界修复计划（2026-09-06）：只处理两份独立审查确认的五项问题及客户端版本前提表述，不扩展能力或依赖。
1. 先补 legacy→context、legacy→prompt→restart、群旧文件仅归属既有指定员工、同 ordinal 不同 entry/file 的回归；运行与读取共用同一员工限定的 managed legacy Session fallback，工作摘要校验已存区间首末 entry 身份，错位则返回 null 引用/摘要，不绑定另一执行。
2. 工作历史导入改为每 conversation/participant 一次读取已有 anchor/live interval 元数据、一次批量新增；无新增不启动写事务。补 300 段 warm empty changes 的 SQL 查询/物化行/事务次数断言，不以机器耗时为门禁，不复制 Pi 正文；完整 JSONL 增量读取仍后置。
3. 完整脱敏搜索文本与压缩空白的展示摘要分开，字面匹配后才处理 snippet；补重复空格、换行、截断后匹配，保留跨 text block 凭据脱敏回归。
4. 指南第 14 项改为使用唯一企业知识空间的实际 ID，支持详情/展示名更新及文档管理；明确 owner/enterprise_admin 写权限、不支持第二知识库/删除企业知识库。版本前提改为客户端措辞，不宣称尚未核验的发布。
5. 组织树示例 root/department 补 role_title=null，增加递归必有字段断言，不放宽 schema。
6. 修复后重跑 Agent check/定向/全量，根 .venv 全 Python 非集成、相关 Web typecheck/test 和三端真实 OpenAPI；记录真实 PG 环境前提与必过 CI，不把 skip 当通过。所有改动保持未暂存，提交/PR/CI/taiyi 部署仍由主控负责，独立复审 gate 保留。

阶段 4 有界修复与本机验证结果（2026-09-06）：两份审查的五项 finding 均已按最小修复落地，尚待主控独立复审，不代表合并/发布签收。
- legacy managed 文件只继承给原 entry employee（无 entry 时为 coordinator），context/prompt/读取保持同源；群先打开另一个员工时仍保留原员工只读 fallback，随后建完整 participant 索引不重复分配旧文件。非 managed 路径仍拒绝。工作记录校验存储首末 entry 与 ordinal 边界；不匹配时返回 null 引用/摘要，原记录 ID/时间不变。
- 历史导入仅查询每 participant 的 anchor/live interval 元数据，跳过已知段后批量新增；52 项定向回归中的 300 段 warm empty changes 断言为 1 次 SELECT、300 行元数据、0 次写事务；新增 2 段只开 1 次事务，之后空轮询为 1 次 SELECT、302 行、0 次事务。没有增加正文缓存或第二计量账本；全量 JSONL 同步读取优化仍后置。
- 完整脱敏文本保留原空白用于大小写不敏感字面匹配，snippet/preview 才压缩空白；重复空格/换行/4,000 字后匹配及跨 block 凭据脱敏通过。唯一企业知识库说明、写权限及客户端版本前提已纠正；组织树示例递归检查必有 role_title，部门/root 为 null。
- 实际命令与结果：`pnpm --dir server/agent_service check` 通过；`pnpm --dir server/agent_service exec tsx --test --test-concurrency=1 src/http/conversation-reads.test.ts src/http/work-records.test.ts src/services/work-records.test.ts src/storage/sqlite.test.ts src/http/server.test.ts` 为 **52 passed**；`pnpm --dir server/agent_service test` 为 **156 passed / 1 existing taiyi-only Linux sandbox matrix skipped（157 total）**。本次新增 7 个测试并更新组织树 OpenAPI 测试；未削弱原断言/门禁。
- `PYTHONPATH=server .venv/bin/pytest -q -m 'not integration' server --timeout=300` 为 **1965 passed / 19 skipped / 145 deselected / 47 warnings**。`pnpm --dir web/agent typecheck` 与 `pnpm --dir web/agent test src/features/chat src/features/marketplace src/features/office` 为 **111 passed**；`pnpm --dir web/manager typecheck` 与 `pnpm --dir web/manager test src/features/experts src/features/org` 为 **27 passed**。现有 Python deprecation、React Router/list key、jsdom navigation 警告未扩范围修复。
- `PATH="$PWD/.venv/bin:$PATH" bash scripts/check-openapi.sh /tmp/aiteam-final-openapi` 三端全部 **OK**；对生成的 Agent 文档独立断言 3 个递归组织示例节点的必有字段、5 个新增读取路由 descriptions/examples/422 通过，无 SDK schema 回写。
- `PYTHONPATH=server .venv/bin/pytest -q -rs -m integration server/tests/manager/test_employee_role_title_e2e.py` 为 **1 skipped**：`ADMIN_DB_URL` 未设置，不能称真实 PostgreSQL/RLS 迁移验证通过。真实 PG integration、PR 全部门禁、独立复审、taiyi TEST 部署及目标 SHA/公开接口核验仍由主控完成；本机 sidecar 安装包需独立升级。未尝试解锁/使用 Docker 凭据、暂存、提交、push 或部署。

### 阶段 5：CI 与 taiyi 发布（主控负责）
- 复核干净的目标分支/改动/测试证据；提交、push、PR 到 main。
- PR 所有相关 CI（含 Node/Python/真实 PG/OpenAPI/覆盖率及触发的 Web/deploy checks）通过，独立 review 无阻断后合并。
- 使用现有 `.github/workflows/deploy-main.yml`，PR merge 自动触发 taiyi；如需重跑只走相同 CI workflow，不绕过为 SSH 手工部署。
- 确认部署流水线成功，核对部署日志实际 git SHA；读取 taiyi 三端 health/OpenAPI 验证新路由/schema。不要仅凭 workflow 的 headSha 认定远程持久 checkout 的部署版本。
- 交付客户端接入文档（仓库文件及永久链接）、PR/commit/CI/deploy 链接、实测结果和明确的未提供项。安装包版本若未更新要提醒客户端升级 sidecar，不能把 taiyi 服务发布等同已安装本机 sidecar 自动更新。

## 完成标准

确认范围全部实现、有对应自动化验证和真实 OpenAPI；旧客户端基本调用兼容；本地数据不出端、企业写入归 Manager、字段不伪造；独立审查通过；相关 CI 全绿；taiyi CI 部署成功且目标版本/公开接口已核实；编号接入文档可发客户端团队。任何外部阻塞需提供确切失败和现存改动，不得宣称完成。
