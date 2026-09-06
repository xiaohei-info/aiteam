# v1 全局完整性整改计划

## 1. 目标、基线与执行权限

### 1.1 目标与裁决

用户授权完成[全局审查原编号30项](../../评审记录/2026-09-06-v1全局完整性审查.md)，继续分阶段测试、独立审查、CI和 taiyi TEST 交付。基线 `5483218edecc35eb3e199d3985c4b0b4dda587a0`（PR56）；初始分支 `feat/v1-completion-wave1`。本文把已有审查变成执行合同，**不是重新审计，也不代表30项已实现**。

当前裁决以 v1 概要设计00、08-25 Pi-native 06/07、08-26 一企业一 Manager 为准：

- Pi `0.84.2` 是唯一执行内核；不升级SDK，不恢复 Gateway/Executor/Driver/Run/Task/Loop/DAG，不复制 Pi JSONL 正文到第二套 Message/Timeline/执行库。
- Operator 持跨企业目录、模型/价格、企业部署注册及平台账号；每套 Manager 只持一个企业的认证、配置授权、RAG/员工记忆及治理；Agent 持本地执行、附件与脱敏 outbox。
- 企业 RAG 单空间与 employee-private Hindsight bank 分离；Manager facade 的明确能力调用是内容边界例外，不允许借此上传普通会话、工具IO或原始日志。
- macOS 复合客户端按模块/正确身份访问相应端；三个普通 Web SPA 仍只调本端，不能让 Manager Web 直调 Agent/Jira，不能把三端代码塞进 Agent 包。
- 不访问冻结 `app/`、真实凭据/企业数据，不动外部 Hermes、开发者钥匙串/ACL/防火墙，不做旧库迁移、跨库直写、向用户机器入站。

### 1.2 单写者与完成口径

1. 每个 S 阶段编码前在本节执行记录确认当时 HEAD、实际改动路径、具体 schema/API、迁移编号、兼容消费者与失败回归；本计划所列 `新增` 路径是预定落点，不是已有功能。发现合同缺口先改计划并请求主控决定。
2. 主控安排单一 writer；本轮规划只编辑本文，保留已有未跟踪审查记录。实施后按实际累计 diff（含未跟踪文件）独立只读审查，不能只审报告。
3. **worker/reviewer/release-checkpoint 均不得 stage/commit/push/建发布PR/merge/deploy**。release-checkpoint 只整理证据并请求主控执行。主控保留全部发布操作权限；禁止 force push、admin bypass、削弱覆盖率/安全/平台门。
4. 完成单位是一个可验证的生产者→消费者闭环。关闭按钮、模拟上游200、打包成功、skip、health200或本文勾选都不能替代实现/原生/部署证据。未验证硬项保持待完成，不从30项删除。

## 2. 已完成的规划验证与未完成的协议前置

### 2.1 本次只读证据

审查证据沿用受控 `global-review/{operator,manager-control,capabilities,agent,governance-release}.md`，不复制其全部发现。当前源码再次定位以下有决策价值的接缝：

- `server/manager_service/{rag_mcp,employee_bindings_services,employee_bindings_repositories,knowledge_intake_repository,snapshot_service}.py`：whole-space 绑定与 document intake 绑定是两种对象；document `stale` 不能等同管理员永久deny；whole-space DELETE 当前物理删除。
- `server/agent_service/src/pi/resources.ts` 和 pinned `@luxusai/pi-hindsight@0.12.0/extensions/{lifecycle/memory-lifecycle,banks/bank-operations,client/client}.ts`；transitive `@vectorize-io/hindsight-client@0.9.1/{src/index,generated/types.gen}.ts`。临时 fake-fetch 探针运行真实 `ensureProjectBank`：初次 GET `/v1/default/banks/{bank}/profile` → 404 → PUT `/v1/default/banks/{bank}`；已存在只GET。PUT携带 `name/reflect_mission/retain_mission/observations_mission/retain_extraction_mode/enable_observations`，**不是可以给只读lease任意透传的“初始化”**。真实 recall 是 POST `.../memories/recall`，retain 是 POST `.../memories`（`items/async/operation_id`）。探针从未联网或写真实bank。
- Pi pinned `dist/core/{agent-session,extensions/runner}.js`：`beforeToolCall` await `emitToolCall`，handler可等待决定，`{block:true}`阻断，异常也阻断。真实 faux Pi Session 临时探针验证等待时副作用0、拒绝后0、批准后1，均继续同一次prompt；不需要实现新执行内核。
- Hindsight pinned类型支持 `PATCH .../memories/{id}` 的 `state=invalidated`，文档语义为排除 recall/consolidation并裁剪派生observations；没有据此证明部署中服务的版本/行为，更没有原生TTL保证。**保留期实施前须取得部署方提供的非秘密 server version/OpenAPI摘要，在隔离fixture验证**；不把 extension版本当server版本。
- Windows pinned `@deepseek-ai/dsh-sandbox-local@0.0.1-rc.1/lib/index.js` 确有 win32 ACL runner（README旧“no runner”落后于源码）。transitive `@deepseek-ai/dsh-sandbox-windows-acl@0.0.1-rc.1/lib/runner.js`/README明确：WRITE_RESTRICTED约束写、并不限制读/网络，Job Object负责子进程退出，workspace ACE standing、private temp可撤销，存在FAT/NULL-DACL/pipe/ConstrainedLanguage限制。不能把 `enforcement=full` 的**文件效果**声明当成 Agent网络/隐私隔离证明；本机只做read-only/no-session的argv组装探针：provider选择windows-acl且报告file enforcement=full，Agent network wrapper仍拒绝；没有spawn、没有Windows原生执行、ACL变更0。
- Jira Cloud官方 Basic auth、REST v3 myself/issues文档已做无认证只读获取；支持 email+API token、`GET /rest/api/3/myself` 和 `GET /rest/api/3/issue/{issueIdOrKey}`。完整 issues HTML超过4MB探针上限，改为有界摘取接口定义，不声称完整文档已抓取。
- NewAPI已部署默认镜像 pin 为 `v1.0.0-rc.25@sha256:54a0b10924aa75fa5b5947208b820ced66b6ef4b445b35f122b31d80676aba2b`；同tag公开 `router/api-router.go`、`controller/token.go`只读核对有 `PUT /api/token/`、`DELETE /api/token/:id`、UserAuth及 `success` envelope。未调用实际NewAPI；S07仍须验证所部署digest与协议对应及模拟失败语义。

本轮探针/公开文档摘录、原计划副本放在受控输出目录 `v1-closure/tmp/`；探针是规划证据，不冒充仓内新增回归或已完成产品。

### 2.2 前置分类（不挡住安全独立阶段）

- **已获主控批准的产品/安全方向**：§3.1–§3.7，2026-09-06 live coordination确认。
- **实施前技术证明**：S04 Hindsight保留/派生数据、S07 NewAPI错误/幂等、S12审批abort、S14 Jira协议/撤销、S19 Windows原生边界。先读pin再小探针，不猜API。
- **发布前运维授权**：既有 taiyi enterprise→Manager注册、公钥信任清单、服务密钥provisioning、历史记忆首次失效清单、旧Relay回收清单。主控/部署方确认；writer不读真实secret、不自猜映射。
- Wave1可独立的身份/RAG/lease安全修复不等Windows、Jira凭据或Wave2注册资料。某个后续子阶段受阻时保留问题状态与已通过证据，不把整个30项宣布完成。

## 3. 已批准的跨阶段合同

### 3.1 RAG：默认、能力deny、文档deny与tombstone

1. 一个Manager只有固定企业workspace，外部输入不得选择其它企业/任意workspace。统一新增 `server/manager_service/knowledge_access_policy.py` 为有效策略解析点，由 snapshot、授权投影和每次 Manager MCP `search/get` 共用；不能只在Agent工具列表检查。
2. whole-capability 三态：`inherit`（无显式设置，保留企业默认）、`allow`、`deny`。现有 `employee_knowledge_binding.enabled=false` 解析为whole-capability deny；DELETE同样留下带actor/revision/time的deny tombstone，返回原204但不把撤销擦掉。重新创建/启用是明确allow且提升revision；不新增“删除即回到默认”语义。旧客户端拿到空refs仍不能绕过Manager enforcement。
3. 文档deny以 `(tenant_id, employee_id, document_id)` 为键；明确管理员禁用/删除对应文档绑定只拒绝该文档，whole deny优先；索引 `pending/stale/failed` 只表示就绪状态，不能永久吞掉重索引后的合法文档。现有文档删除/撤销保留记录；backfill/reindex不得复活管理员deny。新增tombstone只存配置/撤销元数据，不复制知识正文。
4. 请求判定顺序：部署企业→active member→员工生命周期/成员grant→whole policy→**当前tools中对应 `knowledge_search`/`knowledge_get`许可**→当前ready文档/版本与document deny。能力拒绝403；隐藏/失效citation按既有不泄露存在性的错误处理。每次操作重判；search中在外部等待后返回前核对policy revision，撤销竞态不得交付旧结果。
5. search只输出能够唯一关联到当前许可文档的有界citation片段；拒绝未知/冲突alias、混合来源graph摘要，不仅过滤document ID列表。get重新校验document版本及边界；请求任意旧citation/直接调MCP不能绕过。
6. 迁移现存disabled/revoked证据，保留原记录与来源。**物理删除且无审计证据的旧状态不可恢复**：预检列unknown范围，主控确认后才启用依赖该推断的迁移；不得全库改deny、全库改allow或凭空补授权。不复活多知识库产品。

### 3.2 Hindsight有效策略、lease操作和保留期

1. `employee_memory_setting` 为唯一effective source；`employee.memory_policy`保留历史来源/旧API兼容投影，不再独立写出第二份执行真相。新增 `memory_policy_service.py` 接住两个既有写入口，按字段presence更新、同一事务提升employee版本/策略revision；snapshot、runtime-config、facade、管理memory API均读取它。policy catalog是模板，只有显式应用才改员工策略。
2. 迁移只补缺项，保留原JSON和source provenance：双方冲突 `enabled`取更严格、显式operation集合取交集、有限retention取较短者；缺字段≠显式 `[]`（空操作集deny-all）。未知/隐式旧默认不能伪装为明确auto-retain授权。新策略记录 `source/revision/explicit_auto_retain`；无明确授权时可保留有权recall，但不自动发送会话提炼。seed_memories原样保留，不因迁移自动导入真实bank。
3. lease持久保存可执行 `allowed_operations`、policy revision/fingerprint、member/employee/snapshot/bank、issue/expiry；token仍opaque且仅hash落库。旧lease无操作证据时迁移为失效，重新领取，不给allow-all。每个facade调用重新检查active member、employee、grant与当前effective policy，权限为**lease与当前策略的交集**，放宽必须新lease；收紧不等待下一次runtime-config才生效。
4. 运行lease allowlist：`recall`仅POST `.../memories/recall`；`retain`仅POST `.../memories`；初始化仅GET `.../profile` 的最小兼容响应。deny PUT/PATCH/DELETE、bank/config/template/reflect/mental-model/list管理路径、双重编码/路径跳转、未知query/body字段和超限body。async retain的 `operation_id`/document来源由可信层绑定作用域，防止调用者用 `update_mode/strategy/document_id`覆盖别人的memory；没有读写两项之外的“通用HTTP代理”。
5. **bank初始化移到Manager可信代码**：在有权领取lease时确保employee bank存在，只在确认不存在时创建，不把每次PUT当幂等无副作用地重写existing bank。facade提供只含SDK所需的sanitized profile，令pinned extension的GET成功，运行lease不需要PUT权限。未知bank状态/并发创建走有界重试/明确错误，不放宽bank管理权限。正常首次recall/retain与旧bank配置不被破坏；管理API仍只给owner/enterprise_admin适当操作权限。
6. 保留期保证是**到期不参与recall + 原生失效**，不是物理硬擦除。有限retention以Manager可信接受时刻计算，不能信任模型传入历史/未来timestamp续期。服务侧覆盖保留命名空间metadata，重试不刷新首次接受时间。保留治理可存bank/id/accepted_at/expiry/cursor/attempt元数据，Hindsight是唯一长期memory正文库。
7. 实施保留前用精确server schema+隔离fixture验证：分页list/metadata、`state=invalidated`确实排除召回并裁剪派生观察，异步retain完成后可关联接受记录。recall经过有界过滤，剔除过期/无可信来源facts及关联chunks/entities/source_facts；不得只删top-level结果而留下派生泄露。无法证明某派生项的有效来源时不返回；无法取得时间/清理状态时fail-closed该记忆能力，不假装TTL已支持。不得擅自引入新bank池/本地memory store/升级SDK来绕过。
8. durable cleanup按enterprise/employee分批claim、幂等原生invalidate、失败有重试/告警；新数据在明确启用策略下自动执行。**历史首次清理必须dry-run（数量、ID/hash、时间/来源、冲突/unknown、不含正文）并获主控/用户批准**；策略删除不得隐式恢复默认写权限，保留deny/provenance。不得静默物理删除、重建bank或把invalidated宣传成硬擦除。

### 3.3 企业部署注册、签名服务principal与信任切换

1. 新增typed `ServicePrincipal`，不要把用户 `TokenClaims`/可伪造 `X-Service-Identity` label作为服务身份。复用现有RSA/PyJWT、持久key机制，但**服务key purpose与用户JWT分离**，不扩大用户JWT issuer/audience接受集合。服务请求用 `Authorization: Bearer <service assertion>`，拒绝用户token/HMAC/共享SERVICE_TOKEN。
2. assertion固定RS256/受信kid，必须校验 `iss/sub/aud/iat/nbf/exp/jti`、`purpose=service`、deployment identity、`enterprise_id/tenant_id`、route所需scope；最长60秒、最多30秒时钟容差。kid仅索引本地已登记公钥，不能从token的jku/x5u或body URL抓key。每次请求新assertion；幂等写用稳定operation key/指纹并与请求path/body摘要绑定，接收端拒绝冲突重放。trace/request label不是身份。
3. Operator维护 `manager_deployment` 注册：deployment ID、Manager内/外地址、enterprise/tenant唯一绑定、service issuer/subject、公钥集合/fingerprint、status/revision。Manager持单行本部署 binding + 受信Operator公钥。一个deployment不能承载两企业，同一企业不能同时激活两Manager；endpoint变更/身份重绑须显式受限管理动作，不能从业务body自动学习。
4. 最小scope集合按route映射：Manager→Operator `catalog:read`、`relay:resolve`、`rollup:write`、`enterprise-policy:read`，只能本企业；Operator→Manager `enterprise:provision`、`owner:bootstrap`、`catalog:notify`、`enterprise-policy:write`、`notification:write`。rollup、provider、skill/catalog所有服务路由消费principal，body的tenant/enterprise只校验一致，不选择权限范围。每个Manager只信Operator相应target audience和本部署企业。
5. 初次登记不走TOFU：部署方先生成/持有本端服务私钥，经受控安装渠道交换public registration manifest与双方key fingerprint；平台system_admin登记已部署Manager。验证固定地址的**签名绑定/挑战响应**，响应须匹配预登记公钥/nonce/enterprise/deployment，才置active并执行bootstrap。bootstrap nonce一次性、有截止、hash落库、Idempotency-Key绑定body；不能用任意Manager自报enterprise claim注册自己。全程TLS，生产endpoint无userinfo/query/fragment、无redirect，私网部署地址只接受部署方明确allowlist，不让普通API触发SSRF。
6. Operator provision/reset/notify/catalog fanout按enterprise解析gateway，不再用进程唯一manager_url。响应返回非秘密Manager handoff地址/deployment引用；owner bootstrap仍一次性给负责人，Operator只存hash。Manager provision检查本部署binding，第二tenant直接拒绝而非写入registry；不新增容器编排。
7. 首次TEST升级采用**协调cutover而非接受旧共享token的在线兼容后门**：见§6.2。添加性schema可提前建，未登记状态阻止相应控制调用；未批准的真实映射不猜测。CI使用两套独立合成Manager身份/端口/企业/临时RSA key，并非taiyi迁移清单。密钥轮换经已认证管理渠道预装next public key，验证后切signing kid、短重叠后撤旧；缺key/revoked/unknown kid一律fail-closed。

### 3.4 不可变发布、solution manifest与企业覆盖

1. Operator现有catalog row作为authoring/head；新增不可变 `(catalog_type, template_id, version)` release，保存规范化payload、content hash、published_at/provenance。version沿用正整数的字符串wire，按模板单调发布；已发布内容PATCH进入下一draft，不改旧release。纯可见性/下架是独立distribution policy revision，不改release bytes。
2. solution release以**一个**有序 `expert_bindings` manifest为准，逐项钉死expert template/version/hash，包含coordinator引用/说明；UI `expert_template_ids`只作编辑投影，提交时统一规范化且验证coordinator在roster中。禁止“版本固定但包读取当前专家内容”。list/detail/内嵌专家包对principal同样做hidden/enterprise可见性校验，禁止套solution取不可见expert。
3. release GET（含旧version）受当前distribution policy：hidden/deny/withdraw不允许新的pull/recruit；已安装的企业配置/历史会话不删除。通知是hint，Manager持久release projection并周期/触发pull比较，丢通知/重启后仍能发现升级/撤回，不自动覆盖已安装实例。
4. Manager招募/apply保存安装version/hash和**模板基线**。升级API先preview、再confirm：基于安装baseline、当前enterprise配置、目标release三方diff；未覆盖字段可更新，企业显式覆盖/skills/knowledge/memory/grants/model偏好保留，冲突逐字段确认。dry-run无写；确认带base employee revision、目标release hash、preview指纹/Idempotency-Key；并发改变409重新preview。既有会话固定roster/在途prompt snapshot不重写；新的群聊才使用升级后的roster。
5. 旧发布记录只固化**当前可观察**payload为 `legacy_observed` baseline，不伪造历史版本；若已安装实例无法证明旧原始内容，显示baseline unknown且禁止自动三方合并。迁移不覆写实例、不抓当前catalog充当旧baseline；管理员可以明确选择字段更新。历史release本身不因回退被删除。

### 3.5 有界内存执行材料与scheduler身份

1. 新增 `execution-authorization.ts`（验证过的本地user session注册/解析）和 `runtime-lease-cache.ts`（受控材料缓存），供HTTP prompt、scheduler、usage flush共用；它们是DI对象，不是全局STREAMS/凭据库。scheduler metadata只含owner、规则、prompt及安全阻塞状态，不存password/service token/runtime secret。
2. user JWT需由现有本地verifier验签、enterprise/member/issuer与当前Manager origin一致；登录或正常带token的本端请求可注册**同进程**身份，signOut/身份切换/expiry清除。schedule在reservePrompt和关闭one-shot**之前**解析身份/预检授权，缺失返回可恢复 `authentication_required` 状态，不能消耗唯一一次执行。错过occurrence仍遵循现有misfire=skip；一次性计划显式重新安排，不暗中重放。
3. runtime材料key至少含manager origin、tenant/member、employee、snapshot hash/version、provider/model/version、credential/policy revision；不能按employee全局复用，更不能把A用户token送给B群成员。cache最大128条、单条大小受schema限制，过期清除/LRU驱逐；并发相同key装载single-flight，signOut/撤权竞态回来的旧响应不能重新填充（generation check）。
4. Provider runtime-config additive返回 `issued_at/expires_at/snapshot_version/policy_revision`，上游access expiry必须往下传。可用截止为 `min(JWT.exp, upstream expires_at, loaded_at+300s)`，按独立单调elapsed再限制，绝不refresh-on-cache-hit延长；缺任何可信expiry只允许当前在线装载使用，**不进入离线cache**。Hindsight沿既有短lease截止，Jira见§3.7另行在线验证。
5. 新prompt优先有界在线刷新；仅连接失败/timeout/明确可降级5xx可复用**已装载且未过期、匹配同一快照模型**的材料；401/403、404撤回、禁用/deny、非法签名/畸形响应、scope/version冲突全部失效且不可fallback。Manager把上游不可达与真实授权否决分成typed错误，不能一律NotFound掩盖。
6. Manager/RAG/Hindsight暂时不可达与本地Pi能否运行分开：已合法provider材料可继续同一授权prompt；云能力工具返回安全 unavailable，不伪造召回或把要求的写吞成成功。没有cloud memory lease时不启用发送，现有queue只由明确允许retain的有效身份/lease补投；不得切换bank/model。策略明确deny则清对应能力/租约而非当普通网络故障。
7. restart不恢复runtime秘密，必须重新登录/呈交有效JWT并在线装载，Docs/UI如实说明5分钟上限、重启/expiry边界，不能承诺永久离线或关机后无人值守调度。通过内存传给Pi ModelRuntime，销毁/驱逐时移除runtime key，不能进projection/schedule/approval/日志/错误/SSE。
8. Manager HTTP seam统一deadline（默认10s，控制端已有30s外层预算内），涵盖headers和response body，abort透传；只读有限重试，写须既有幂等key与明确语义，401/403不重试。Agent无每次执行强制联网quota lease。

### 3.6 ApprovalRecord、副作用与恢复

1. 接入唯一受控Pi `tool_call` extension。可信产品分类中，read/knowledge_get/search/recall、只读Jira及本地纯索引读取可按grant执行；**全部bash、write/edit、外部mutation与未知工具逐次审批**，不猜shell命令安全性，不信远端MCP `readOnlyHint`，`full-access`也不豁免。read-only会话本已禁止的write先拒绝，审批不能提升sandbox权限。
2. `todo_update`等已批准的纯本地展示元数据工具、固定roster `mention_employee`不是任意OS/SaaS mutation：沿其已有授权/预算/父abort；peer自己的实际副作用仍要审批。Hindsight自动retain只在effective Manager策略明确预授权时运行，不每轮弹窗；手工retain同样受scope/policy，不获得bank管理权。
3. 新增SQLite `approval_record`只存owner/conversation/participant、Pi tool_call id、prompt receipt引用、snapshot+permission revision、规范化参数hash、有界安全预览、expiry/decision/CAS版本/消费标志。完整参数留当前Pi执行内存/已有JSONL，**不复制第二份tool正文**、不上传控制面。参数preview脱敏，安全根路径可展示相对路径，token/绝对私密路径/content正文不进审计汇总。
4. `GET /api/agent/conversations/{id}/approvals`列当前/近期记录，`POST .../approvals/{approval_id}/decision`接收approve/deny和expected revision、Idempotency-Key；仅本会话owner/合法本地身份能决定。审批10分钟超时并受授权/lease有效期更短截止约束；批准前后重查参数hash、snapshot、permission、调用仍存活。第一次CAS决定有效，同意重复幂等、冲突决定409；审批只consume一次。
5. handler等待当前Promise后继续同一个Pi tool call，不通过再次 `prompt()`“继续”。deny/expiry/abort/signOut/revoke唤醒并block，绝不让挂起gate使abort永不返回；pinned `ctx.signal`与host cancellation联动。race测试涵盖approve与abort/expiry同时发生。
6. crash后pending/已批准未证明消费完成的记录标不可恢复/unknown；不自动执行、补偿或重放未知副作用。下游支持幂等才透传稳定tool operation key；不支持时明确至多一次发起/结果未知，不承诺exactly-once。approval_required SSE仅安全metadata，刷新通过approval读取API恢复，无需新Timeline状态机。

### 3.7 首个真实连接器与Windows范围

1. **Jira Cloud单一类型**：现有 `jira` api_key preset，HTTPS `https://<site>.atlassian.net`、Atlassian email+API token；不声称支持Jira Server/DC/PAT/OAuth或全部preset。只读 `GET /rest/api/3/myself`真实认证探测、`GET /rest/api/3/issue/{key}`指定issue读取；fields固定白名单、无comments/changelog/任意expand/JQL/任意URL。参数只允许有界issue key及产品配置的project allowlist；返回summary/status等有界安全数据，正文仅用户本地。
2. Manager存定义/加密凭据/employee+member grant及revision，复用 `shared/crypto`，不把provider表当connector万能仓库。写凭据只在受限管理/授权入口、不返回secret/ciphertext；runtime-config是授权窄通道、no-store。Agent只在受控适配器内内存持最小凭据，真实探测/调用从Agent发出；Manager Web只能显示configuration-valid / not-probed或读取经认证Agent上报的无正文探测摘要，不能跨端呼叫Agent或把本地schema验证写成connected。
3. 每次connector调用先在线校验当前member/employee/binding/credential revision；禁用、撤销、expiry、401/403或Manager不可达时**零Jira请求**，清理失效材料且不fallback。明确三层：Manager撤权停止后续凭据发放；受控Agent逐次授权检查/短暂内存消费；Jira原生token自身权限/撤销由凭据持有者负责，不是Manager可mint的downscoped令牌。5分钟Manager lease绝不宣称原始token也过期/被撤；raw email/token仅适配器当前受控进程内最短时间使用，不返回WebView/模型/日志。只接受专用最小权限账号/项目，优先Jira原生只读scope配置，不能把管理员token配置成功宣传为只读隔离；setup要求操作者确认上游最小权限来源，probe分开显示身份认证、项目访问结果和本机adapter只读范围，不声称已穷尽验证token全部权限。不新增Manager SaaS正文proxy/OAuth框架；更强的原生token即时撤销保证须另审批。
4. 禁止redirect（尤其带auth跨origin）、loopback/link-local/private SSRF、userinfo/非TLS/用户URL；fixture transport仅通过测试DI启用，生产没有“allow localhost”开关。readiness区分配置校验、授权、真实认证探测时间/expiry和可执行能力；其它preset不伪装connected。
5. Windows仍是#30硬项。S19先在secret-free原生 `windows-2022` CI临时工作区评估既有dependency + 非管理员隔离候选；只读源码/argv探针不能证明OS边界。现有ACL runner不够，不能把availability改true、关network isolation、默认为full-access、换到WSL冒充Windows或以包产物计通过。
6. 新生产runner/backend/权限模型须提交小规模实证和方案再请求主控批准。可丢弃探针可评估非管理员AppContainer/受限进程等，但不能擅自修改全局防火墙/开发者ACL、上游dependency源码或新增执行内核。S19仍标待实现/待验证；得到实际不可行证据后记录阻塞条件，不删项。

## 4. 四批可执行阶段

每个阶段按“失败回归 → 最小实现 → 真实调用方 → 独立验证/审查 → 主控release-checkpoint”串行。下面相对路径均在仓库；花括号列举的是同目录具体文件。后续新分支只能由主控在上一批已达到交付点后创建，不覆盖上一批改动。

### Wave1：Manager身份、策略和能力（S01–S05）

#### S01 身份状态、管理权限与现有登录（审查1、2、19）

- 改动：`server/manager_service/{repository,auth_service,auth_password_policy,member_service,passkey_service,passkey_ceremony,passkey_store,oauth_service,routes_auth,routes_mfa,routes_settings,settings_service,routes_employee,employee_config_service,snapshot_service,authorized_config_service,provider_credential_service}.py`；新增 `active_principal.py`。对应 `web/manager/src/{AppProviders,App}.tsx`、`pages/LoginPage.tsx`、`features/settings/{SettingsPage.tsx,useSettingsApi.ts}`、`features/members/{MembersPage.tsx,useMembersApi.ts}`；必要因子管理组件新增在 `features/settings/AccountSecurityPanel.tsx`。
- 合同：密码/Passkey/OAuth正式identity映射共同检查active；修5列/第6项映射、真实配置RP ID与allowed origins、密码创建/重置timestamp。可信RP/origin必须贯穿 `routes_mfa.py` → `passkey_service.py` → `passkey_ceremony.py` 的options/challenge/finish校验，不能只修options展示，不能从调用者body/未受信Host接受origin。owner/enterprise_admin可写企业设置/员工配置；finance_admin仅财务职责、member仅本人和已获授权资源。公开完整员工配置读与内部已授权snapshot配置读取分开，防“一律加管理员”误伤执行。嵌套 `routes_employee_bindings.py` 必须把path employee_id与binding资源owner一起校验，不能只以tenant内binding_id通过访问别的员工；修改相应 `employee_bindings_services.py`/`schemas_employee_bindings.py`，同类memory/connector读写复用资源授权。
- 兼容/迁移：保留既有密码/首登重置/登录路由，不加refresh/新SSO；缺可信RP配置时明确not-configured而非用tenant UUID。旧密码时间戳unknown不得批量强制重置，创建/真实重置后新时间可信。已有JWT本地expiry不变，在线签发/资源操作统一拒disabled。Manager `LoginPage.tsx` 仅对明确的reset-required/密码过期typed错误进入重置流程，disabled或其它403不能被误当首登重置；重置入口同样不能给disabled成员签发token，正常首登/过期重置后登录仍成功。
- 回归：`server/tests/manager/{test_auth_service,test_auth_e2e,test_auth_password_policy,test_repo_repository,test_passkey_service,test_oauth_service,test_routes_auth,test_routes_mfa,test_authorized_config,test_snapshot,test_member_grant_authz}.py`，新增 `test_active_principal.py`、`test_passkey_ceremony.py`；真实registered-route测member设置写403、未授权config403/404、授权snapshot200、管理读取200、disabled三类登录及重置拒绝、signOut和已配置因子管理浏览器路径。无真实passkey/OAuth凭据，合成WebAuthn走真实ceremony验证可信origin/rpIdHash/challenge绑定与重放，错误origin或RP、缺可信配置均拒绝。`web/manager/src/pages/LoginPage.test.tsx` 增加disabled/普通403不进reset、明确reset-required/过期可重置、重置后可登录的consumer回归，不用仅有status=403的mock替代真实problem code。
- 开工预检：编码前在§8登记当时HEAD、实际完整路径、精确problem code/RP配置来源与注入路径、schema/迁移编号（无迁移则明确记无）、旧Agent/macOS与Manager Web消费者以及上述新增失败测试名和基线失败输出。此预检及隔离失败回归无需等待S04/S06/S07/S19的后续协议、部署或原生条件；本次规划不冒充已完成S01预检/回归。后续每个阶段重复同样的contract/migration/consumer预检。

#### S02 有效版本与方案复用授权（13、14）

- 改动：Manager `{employee_config_repository,employee_config_service,authorized_config_service,snapshot_service,recruit_service,recruit_repository,repository_member}.py`，迁移新增 `migrations/0035_identity_and_employee_revision.sql`；`server/shared/contracts/snapshot.py`及两端projection消费者仅在需要字段时改。
- 合同：采用现有 `employee.version` 作为effective revision，生命周期/有效memory/knowledge/tools等变化同事务提升；避免引入两个不可比较“version”，既有known_versions仍比较字符串且snapshot请求version一致。grant撤销走现有revoked_ids；投影变更不会改写在途prompt对象。
- 方案复用grant取原授权与本次授权并集；显式grant管理才可减权。员工、solution、member/department关系在同一tenant事务内发布；旧分步写需用repo事务收口，外部package读取在事务前，失败不得删除/替换预存在关系。幂等apply重复不增长重复记录。
- 回归：`test_authorized_config.py`、`test_snapshot.py`、`test_recruit_solution.py`、`test_recruit_order_repository.py`、`test_member_grant_isolation.py`；active→paused→active/archived增量、same known_versions无重复、A/B复用保留A、各写步骤注入异常PG回滚、并发apply唯一键/幂等；Agent缓存状态更新与旧在途snapshot稳定。

#### S03 RAG显式deny（3）

- 按§3.1实施，改 `rag_mcp.py`、`snapshot_service.py`、`authorized_config_service.py`、`employee_bindings_{services,repositories}.py`、`schemas_employee_bindings.py`、`routes_employee_bindings.py`、`knowledge_intake_{repository,service}.py`；新增 `knowledge_access_policy.py`、`migrations/0036_knowledge_policy_tombstones.sql`；Agent `src/{manager-client,pi/rag-mcp}.ts`、Manager员工配置/知识页面同步真实状态。
- 迁移/API：现有knowledge绑定PATCH/DELETE语义按§3.1，新增显式policy字段由typed schema接受并生成OpenAPI；RLS/复合owner键、非物理删除tombstone，历史unknown预检不可跳过。当前tools缺省与显式限制兼容解析统一，不把 `tools=['read']`变默认知识许可。
- 回归：`test_rag_mcp.py`、`test_rag_enterprise.py`、`test_knowledge_intake_unit.py`、新增 `test_knowledge_access_policy.py` 与PG隔离case；default正常、whole deny、only-search/only-get、doc A deny而B可读、reindex不复活撤销、引用旧version、并发撤权、两个member/tenant、直接MCP请求、删除后重启tombstone仍有效。

#### S04 Hindsight操作最小化与实际保留（4、16）

- 先完成§2.2精确server-schema/保留小探针；允许先独立交付lease安全修复，**不能因此勾完16**。改Manager `{hindsight_credentials,hindsight_lease_repository,hindsight_facade,hindsight_client,routes_hindsight,schemas_hindsight,memory_service,employee_bindings_services,employee_bindings_repositories,employee_config_service,snapshot_service,authorized_config_service}.py`；新增 `memory_policy_service.py`、`memory_retention_service.py`、`memory_retention_repository.py`，`migrations/{0037_memory_policy_lease_scopes,0038_memory_retention_jobs}.sql`；Agent `src/{pi/resources,manager-client}.ts`及Manager记忆设置UI。
- 严守§3.2初始化/lease/body allowlist。单事务policy来源迁移、旧lease全部失效、metadata-only cleanup/outbox；legacy config与新的effective source兼容由同一service处理，不能留双写。非删除字段省略时保留，不把PATCH变PUT清空。
- 回归：`test_hindsight_{credentials,lease_repository,facade,client}.py`、`test_memory_items.py`、新增 `test_memory_policy_service.py`、`test_memory_retention_service.py`、Agent `pi/resources.test.ts`。读lease拒retain/PUT/PATCH/DELETE、正常readonly首次init、retain-only不能recall、policy-disable后旧lease立即拒、跨bank/编码路径、管理操作角色、显式[]、迁移冲突清单、TTL到期/异步结算/cleanup重启/derived泄露/历史dry-run、不把内存正文复制到DB/日志。

#### S05 自定义Skill完整性与知识job恢复（17、18）

- 改Manager `{schemas,capability_catalog_service,capability_catalog_repository,authorized_config_service,knowledge_intake_service,knowledge_intake_repository,routes_knowledge_intake,app}.py`；新增 `knowledge_intake_recovery.py`、`migrations/0039_knowledge_job_recovery.sql`；Agent `src/{skills,http/server}.ts`，Web `features/capability/CapabilityPage.tsx`、知识DocumentsPanel。
- metadata-only skill更新保留files/hash；显式包更新验证SKILL.md/hash/version后才替换，Operator immutable skill仍禁改。创建fileless明确draft/non-executable；readiness按实际选择的签名缓存列missing/invalid，不忽略必须skill。
- upload先durable job；claim_owner/lease_until/heartbeat/attempt/cursor可重启恢复，外部track ID优先查询/对账，未知接受结果不盲目重复上传。超期失联可恢复或有理由failed允许retry/delete，真正活跃job继续409；多个进程claim互斥，不新增消息总线。
- 回归：`test_platform_skill_service.py`、`test_skill_signing.py`、capability现有service/routes测试、`test_knowledge_intake_unit.py`、新增 `test_knowledge_intake_recovery.py`、Agent `skills.test.ts`/HTTP readiness；保存后未调BackgroundTask、parsing/indexing kill、租约未到/到期、远端已done/结果unknown、幂等retry、重启签名缓存缺包。真实PG证明claim/事务，fixture LightRAG证明不重复提交。

### Wave2：Operator可信企业与发布（S06–S10）

#### S06 Signed service identity与Manager登记（5、7）

- 改 `server/shared/{service_token,service_client,config}.py`；新增 `shared/service_identity.py`、`shared/contracts/service_identity.py`，复用 `shared/auth` RSA primitives而不改变用户claims语义。Operator `{dependencies,service,repository,schemas,manager_gateway,catalog_dependencies,routes_enterprise,routes_rollup,rollup_service,routes_catalog,routes_skill_market,routes_platform_provider}.py`；Manager `{operator_catalog,routes_tenant,routes_bootstrap,routes_catalog_notify,routes_in_app_notification,rollup_reporter,app}.py`所有真实服务接缝纳入；新增两端 `service_identity_repository.py`、Operator `routes_manager_deployment.py`。
- 新路由意图：平台system_admin `POST/GET /api/operation/manager-deployments`、`POST /api/operation/manager-deployments/{id}/verify`；Manager `GET /api/manager/service-binding` 只签名返回绑定/挑战证据、非公开自动注册入口。字段/operation_id按§3.3在编码前落typed schema并同步三端OpenAPI与消费者；不再增加同义旧路径alias。
- 新增Operator `migrations/0012_manager_service_trust.sql`、Manager `0040_service_trust_binding.sql`；service key只端内受保护存储，本地trust含public keys。配置模板/`deploy/docker/{docker-compose.yml,SERVICE_TOKEN.md}`、`deploy/ci/{run.sh,README.md}`、`.github/workflows/deploy-main.yml`按§6协调更新，不在secret文件写明文fixture。
- 回归：`server/tests/shared/{test_service_token,test_service_client}.py`、新增 `test_service_identity.py`，Operator `test_service.py`/`test_catalog_gateway_service_token.py`/rollup测试；新增跨端双Manager集成fixture。A签名替换body为B403，用户JWT冒充服务401，scope/issuer/audience/kid/purpose/时间窗/重放/path-body mismatch，Operator目标错Manager拒、第二tenant拒、bootstrap nonce重用拒、origin redirect/SSRF拒；正常开通/reset/catalog/relay/usage链均成功。

#### S07 NewAPI撤销与续期（6）

- 改Operator `{platform_provider_service,platform_provider_repository,newapi_client,service,routes_platform_provider}.py`，新增 `relay_token_lifecycle.py`、`migrations/0013_relay_token_lifecycle.sql`；Manager `{provider_credential_service,schemas_provider,operator_catalog}.py`为S11传可信access expiry/revision。
- 每个旧token ID持久生命周期记录，不能覆写丢失；模型收紧/deny-all先落revocation obligation与policy revision，阻止旧projection再签发，调用实际NewAPI停用/删除并确认success envelope；失败retry/告警。新token只在允许模型集内发放，过期/临近到期续期，旧token清理不能遗失；没有原子上游操作时承认短暂不可用优于留宽权限。
- 迁移现有已知ID，无证据的早期孤儿token仅dry-run可核验清单，不用名称猜测批量删别的token。HTTP200 `success=false`是失败；网络结果未知先GET reconciliation，不能重复创建无限token。更新quota不得把上游实际余额/使用量覆盖成初始化值。
- 回归：`test_newapi_client.py`、`test_enterprise_model_access.py`、`test_platform_provider_routes.py`、新增 `test_relay_token_lifecycle.py`；deny-all/shrink/expiry/near-expiry/重复轮换/timeout后恢复/旧ID保存/删除不存在语义/无body泄密。合成或隔离NewAPI验证远端旧token真正拒绝，不用mock count冒充taiyi已撤销。

#### S08 企业动作/下载与持久平台账号（8、12）

- 前端改 `web/operation/src/features/accounts/{EnterpriseActions,LifecycleDialogs,AccountsPage}.tsx`、`useAccountsApi.ts`：quota/lifecycle调已有正确路由，recharge按现有真实schema，不新增支付服务；export消费返回rows生成CSV/下载，转义公式前缀与特殊字符。
- Operator改 `{system_repository,auth_service,routes_auth,app}.py`，新增 `system_account_service.py`、`routes_system_accounts.py`、`migrations/0014_system_account.sql`；Web新增 `web/operation/src/features/system-accounts/{SystemAccountsPage.tsx,useSystemAccountsApi.ts}`，在 `web/operation/src/App.tsx` 显式路由注册。
- `GET/POST /api/operation/system-accounts`、`PATCH .../{id}`、`POST .../{id}/credential-reset`仅system_admin；持久身份/active状态/角色，禁止禁用或降级最后active system_admin，凭据hash/一次性reset不回显旧密码。环境种子仅空库首次bootstrap，重启不覆写已有账号，既有部署导入由主控安全初始化，不读取secret进报告。
- 回归：accounts真实browser→registered route无四种422、导出可下载/CSV injection；平台repo重启/双角色/禁用新登录/last-admin并发、system_operator无账号管理权。主要测试 `server/tests/operation/{test_system_auth,test_lifecycle_quota_audit}.py`，新增 `test_system_account_service.py` 与 `web/operation`对应source-named测试。

#### S09 Immutable releases/visibility/企业升级（10、11）

- 按§3.4，改Operator `{catalog_service,catalog_repository,routes_catalog}.py`、`server/shared/contracts/crosstier.py`；新增 `catalog_release_repository.py`、`migrations/0015_catalog_releases.sql`。Manager `{operator_catalog,routes_catalog_notify,recruit_service,recruit_repository,authorized_config_service}.py`，新增 `catalog_release_projection.py`、`template_upgrade_service.py`、`routes_template_upgrade.py`、`migrations/0041_catalog_release_projection.sql`；两端catalog/detail/recruit真实UI。
- 现有template发布接口产新不可变version，历史GET带version保持稳定；新增Manager `POST /api/manager/employees/{employee_id}/template-upgrade/preview|confirm` 及solution实例对应preview/confirm资源路径，编码前schema精确列出字段/冲突/权限/幂等，统一employee更新service；不自动覆盖shared employee被多个solution复用的企业配置，preview列受影响solution供确认。
- 回归：Operator `test_catalog_service.py`/`test_catalog_pull.py`、Manager `test_recruit_solution.py`，新增 `test_catalog_releases.py`、`test_template_upgrade.py`；同version/hash永不变化、2 Manager public/allowlist/hidden/deny/nested专家、团队编辑coordinator正确、丢notify仍发现、企业覆盖/空值覆盖保留、unknown旧baseline无自动合并、并发preview409、失败事务回滚、旧群固定roster与在途snapshot稳定。

#### S10 企业治理策略producer与投影（9的前半）

- 改Operator `{admin_service,admin_repository,manager_gateway,service}.py`、Manager `{operator_catalog,routes_tenant,app}.py`；新增Operator `enterprise_policy_outbox.py`、Manager `enterprise_policy_service.py`/`routes_enterprise_policy.py`；迁移Operator `0016_enterprise_policy_outbox.sql`、Manager `0042_enterprise_policy_projection.sql`。
- quota/lifecycle同事务持久policy revision+outbox；按S06绑定向Manager传递，Manager可主动GET `/api/operation/enterprise-policy`补拉，签名服务target限定当前企业。Manager `PUT /api/manager/enterprise-policy`只接受Operator本企业的单调revision，同revision内容不一致409，旧revision不覆盖新值；ack/applied revision可观测。
- policy包含现有enterprise status、允许模型、soft quota scope/target/window/threshold/action，不改成实时付费硬租约。不臆造套餐/汇率/付款；UI区分已保存/待同步/已应用。S16才关掉9的整项状态。
- 回归：版本乱序/重投/丢通知/双Manager/重启outbox、同事务失败不发布、策略暂不可达不拖垮readyz；已有治理路由request契约、两端Web真状态。

### Wave3：Agent执行、审批与连接器（S11–S14）

#### S11 运行租约、定时身份与deadline（21、22；26前置）

- 按§3.5；新增 `server/agent_service/src/{execution-authorization,runtime-lease-cache}.ts`；改 `src/{http/auth,http/server,pi/session-host,pi/model-runtime,pi/resources,manager-client,schedule,main,usage-flush}.ts`；Manager S07 runtime-config/schema typed错误/expiry往下贯穿。
- local store只增加schedule last-block reason/next用户动作和必要索引，不持token；缓存独立于projection。保留现有收据/overlap/misfire语义、每participant单写者；同一prompt固定snapshot，下一prompt可选新快照，历史不反向从最新snapshot重写。
- 回归：新增 `execution-authorization.test.ts`、`runtime-lease-cache.test.ts`，更新 `services/schedule-usage.test.ts`、`pi/session-host.test.ts`、`manager-client.test.ts`；真实Authorization header、one-shot缺token未消耗、expiry/restart/signOut/两member同employee/快照换版、300s clock边界/LRU/generation race、timeout包括body、401/403/404不fallback、短网断模型可运行而RAG unavailable、缓存从不落库/日志。

#### S12 本地人工审批（20）

- 按§3.6；新增 `src/{approval-service,pi/approval-extension}.ts`，修改 `storage/sqlite.ts` schema/迁移、`pi/{resources,session-host,event-sse}.ts`、`http/server.ts`及新增 `http/approval-schemas.ts`，Web `features/chat/TimelineView.tsx`及新增 `ApprovalCard.tsx`/已有API hook；schema/export维护真实registered routes。
- 回归：新增 `approval-service.test.ts`、`pi/approval-extension.test.ts`、HTTP owner越权测试/浏览器审批；实际faux Pi在审批前副作用0、approve1/deny0、同call幂等、参数或permission变化拒、full-access仍审批、任意bash都gate、abort/expiry同时决定、restart未知不执行、group全部child取消、远端readonly hint不能免审。等待/返回均为同prompt，不通过第二prompt模拟continuation。

#### S13 已接受失败、SSE/群终态与文档附件（23、24）

- 改Agent `src/{http/server,pi/session-host,pi/event-sse,storage/sqlite}.ts`，新增 `src/pi/attachment-tool.ts`；Web `web/agent/src/features/chat/{TimelineView.tsx,useChatApi.ts}`及附件组件。现有entries/metadata/idempotency receipt用于对账，不新增正文事件库。
- 202前能预检的错误直接problem+json；202后初始化失败写安全receipt失败原因并发出既有终态/受控失败字段，disconnect后通过receipt+entries恢复，不造旧Run enum。群root直到全部target settled才清busy；一个participant结束不能清其它busy；事件含实际source。
- **SSE无缺口恢复围栏（首次连接、刷新和每次重连均适用）**：当前 `SessionHost.subscribe` 仅校验 `after/Last-Event-ID`，不回放订阅前事件。先建立本会话owner-checked SSE，确认服务端listener已注册、客户端成功打开流并开始有界内存缓冲，再读取/重新读取同一owner的分页entries、receipt及聚合runtime state；先前预读只能作显示缓存，不能作为恢复完成的依据。`subscribePiEvents()` 返回close句柄并不等于流已建立；当前 `http/server.ts` 是先 `host.subscribe` 再返回SSE响应，实施时保留该先后关系，客户端等待实际连接成功而非仅调用订阅函数。
- 围栏内按稳定entry/participant source identity合并持久entries与缓冲事件，仅同一logical human message做多目标去重，不吞其它participant的assistant/tool结果；结算事件触发receipt/runtime state与末尾entries补查，保证异步旧读取不覆盖更新终态，也不把未结算peer判空闲。对账结束后连续消费同一订阅；对账期间断流、restart、cursor丢失/无效或缓冲溢出必须重建围栏并重读，不能仅凭旧cursor宣告恢复。transient delta允许丢失，最终正文仍从Pi JSONL/entries恢复，内存缓冲不是第二套正文事件库；receipt未知只展示unknown/明确用户动作，绝不自动重放prompt或副作用。
- 兼容/预检：沿现有events/entries与owner-checked receipt/runtime metadata读取接缝收口，receipt可读字段、终态关联及必要additive schema在S13编码前精确登记并同步OpenAPI/真实消费者；不把当前尚未暴露的receipt读能力写成已有API。恢复围栏不要求持久SSE replay log、新执行内核或新正文存储，不改变既有cursor校验与未知工作不重放约束。
- 附件owner检查后有界本地读取/materialize，只向当前已绑定conversation/participant snapshot授予文件ID，不给任意绝对路径。明确支持UTF-8 txt/Markdown/CSV/JSON等纯文本、文本型PDF、DOCX正文输入，已有图片保持；`src/local-files.ts` 的旧Office/未知binary/octet-stream上传可保留安全存储/下载但标 `storage-only`，不可仍标已被模型消费。带不支持附件的prompt在接受前返回可操作错误或由用户明确选择text-only，不静默忽略。扫描PDF/OCR、旧Office转换不在本轮支持承诺。现有dsh-attachment是image-only；PDF/DOCX可按主控批准引入维护正常、固定版本的小型本地parser，先临时验证再更新 `package.json/pnpm-lock.yaml` 与plan，不升级Pi、不引入Python执行内核/云解析、不上传企业RAG。增加 `src/pi/document-extractor.ts`，限制byte/解压规模/页数/字符/CPU/timeout/并发、禁外部资源/宏/脚本，MIME与实际签名匹配、symlink、删除/撤销同时读取要测；UI/Docs/typed响应一致显示实际输入能力。
- 回归：`http/server.test.ts`/`http/conversation-reads.test.ts`、`pi/event-sse.test.ts`、`pi/session-host.test.ts`、新增 `pi/attachment-tool.test.ts`，以及 `web/agent/src/features/chat/{chat.test.ts,TimelineView.test.tsx}` 和真实registered-route浏览器恢复测试。用可控barrier而非sleep确定性覆盖两处结算窗口：①预读完成后、实际SSE listener注册前结算；②SSE已建立后、entries/receipt/runtime state读取与缓冲对账完成前结算（含返回乱序）；均须最终显示持久回复/安全失败、清除已终结root的accepted/busy，不依赖后续恰好再来一个事件。增加对账中再次断流、Agent restart、cursor丢失/无效、缓冲溢出、分页尾部刷新、unknown不重放；不同速度群在快peer结束/断流时慢peer仍busy，全部settled后才清root，双方结果与source完整且human不重复。保留浏览器202后init错误/abort/刷新测试；临时txt/md/pdf/docx让faux tool真实读出合成关键文本，跨owner与超限拒绝，输出不进Manager。

#### S14 Jira Cloud代表连接器闭环（15）

- 按§3.7；Manager改 `{routes_connector_ops,routes_connector_schemas,connector_probe,connector_ops_service,connector_ops_repository,employee_bindings_services,snapshot_service}.py`，新增 `connector_credential_{service,repository}.py`、`routes_connector_credentials.py`、`migrations/0043_connector_credentials.sql`；Agent新增 `src/{connectors/jira-client,pi/jira-tool}.ts`，改 `manager-client.ts`/`pi/{resources,session-host}.ts`/readiness；Web Manager连接器配置与状态、Agent真实probe入口。
- 预定API：Manager现有connector管理资源下受限credential写、`POST /api/manager/connectors/{id}/runtime-config`（member+employee当前grant、no-store）、`POST .../{id}/probe-results`只接合成状态码/latency/revision不接响应正文；Agent `POST /api/agent/connectors/{id}/probe`由本地用户主动执行。typed envelope和fields在本阶段落OpenAPI；真实issue调用为Pi工具而非新增任意URL HTTP proxy。
- 回归：新增 `server/tests/manager/test_connector_credentials.py`、更新 `test_service_connector_ops.py`；Agent `connectors/jira-client.test.ts`、`pi/jira-tool.test.ts`；控制HTTPfixture真实Basic auth/myself/get issue、缺token401而不是connected、撤权或无Manager在线复核后零上游请求、cross-member/grant/employee/错误项目/issue key限制、AAD防密文替换、过期/redirect/任意URL/SSRF/body size/timeout/error脱敏、unsupported presets不connected，以及Manager lease过期与native token撤销能力分离的Docs/schema测试。生产Jira凭据不参与测试；真实tenant验证如需另列用户授权验收，不伪称已做。

### Wave4：治理、Web、可观测与平台交付（S15–S20）

#### S15 Usage可靠补投与认证member维度（26、27）

- 改Agent `src/{usage,usage-flush,manager-client,main,storage/sqlite}.ts`；Manager `{usage_audit_quota_service,routes_usage_audit_quota,billing_repository,rollup_reporter,app}.py`、Operator rollup相应schema/repo，`server/shared/contracts/{summary,crosstier}.py`；新增Manager `rollup_outbox.py`、`migrations/0044_usage_member_rollup_outbox.sql`。
- Agent启动/网络恢复（周期有界探测）/登录装载后自动排空pending与失联sending；指数退避+jitter/上限/单writer，不阻塞prompt。用S11身份resolver，不把长期token写outbox。Manager同事务持久usage与Operator outbox再ack Agent，接收成功/上游暂失败不丢投递；跨端at-least-once，累计summary以source+id+revision/hash幂等/单调取delta，金额Decimal/unknown保持。
- member_id以认证JWT导出并核对上传值，不信body代填；历史NULL/无来源为unknown，不按员工/最近用户推算。只传允许summary维度，按tenant/member/employee/time统计并支撑quota；摘要schema加版本、旧报文如可认证补member，否则明确unknown。
- 回归：`services/schedule-usage.test.ts`、Agent manager-client/usage测试，Manager `test_usage_audit_quota.py`/`test_repo_usage_audit_quota.py`/`test_usage_audit_quota_isolation.py`、Operator rollup测试；Agent断网+restart、Manager ack后上游断网+restart、重复/乱序/同ID冲突、不重计、missing member历史unknown、成员伪造拒绝、429/401不tight-loop、两enterprise隔离及usage/log无正文secret。

#### S16 自动soft治理、通知与审计投影/回流（9、28）

- S10+S15前置。Manager改 `{usage_audit_quota_service,routes_usage_audit_quota,login_audit,audit_repository,snapshot_service,recruit_service,rollup_reporter,in_app_notification_repository}.py`；新增 `quota_evaluation_service.py`、`audit_projection_service.py`、`migrations/0045_governance_evaluation_audit.sql`；Operator rollup/admin审计统计接入；Agent `manager-client.ts`/approval/auth拒绝点生成允许的安全事件摘要。
- policy按现有scope `tenant|employee|member`、target_ref、window计算；通知dedup绑定policy revision/窗口/目标，企业quota/lifecycle由S10同步。在预算超阈值/企业停用时按明确policy阻止新recruit/new snapshot issuance并返回typed原因，历史本地prompt不远程终止；没有每次联网quota lease。解除/时间窗变动自动重评估并可观察applied revision。统计unknown不能按0误判余额安全。
- 真实login/拒绝授权/审批安全元数据→统一审计查询投影，保留原表单写者与event ID，幂等cursor读取/逐级汇总；Manager/Operator只见允许聚合，不含IP原值、email、prompt、工具参数、路径/stack/凭据。不能只把Agent audits=[]换成捏造事件。
- 回归：新增 `test_quota_evaluation_service.py`、`test_audit_projection_service.py`；现有login/审计/治理route测试和两端Web读取；同tenant两member不同预算、employee目标、窗口边界、重复通知不倍增、新招募/快照被真实消费者拒绝、恢复后可用、已冻结离线prompt继续、真实登录/403能查询且Operator有脱敏计数、补投不重算。

#### S17 Agent Web消费已有读取（25）

- 改 `web/agent/src/features/chat/{useChatApi.ts,TimelineView.tsx}`、`features/group/GroupPage.tsx`、`features/workspace/{useWorkspaceApi.ts,WorkspacePage.tsx}`、`features/office/{OfficePage.tsx,ScheduledJobs.tsx,useOfficeApi.ts,types.ts}`；具体新增展示组件按源命名，尽量不新建后端接口。
- 先逐条对照现有 `server/agent_service/src/http/server.ts` 的search/participants/preview/unread/works/stats读取schema：列表preview+未读写回、真实固定roster而非当前授权估算、搜索定位entries/分页、工作记录增量/统计。unknown与employee执行次数语义不变；不拿群消息数量当执行次数，不引入mock KPI/视觉重设计。
- 回归：对应hooks与页面vitest、`web/e2e`现有Agent场景扩充；reload/unread写回、搜索跨页定位、roster授权更新仍固定、SSE恢复重复去重、office增量和统计空/unknown、private/group owner越权。

#### S18 本端DB就绪与安全可观测（29）

- 改 `server/shared/{app_factory,observability,service_client,config}.py`、两端 `app.py`，Agent `src/{http/server,manager-client,main}.ts`；按实际依赖新增最小OTel/Prometheus库至 `server/requirements.txt`/Agent package+lock，**不升级Pi**；OpenAPI health与部署检查同步。
- 控制面readyz有界本端DB真实query（Manager走正确business角色/绑定，Operator本端DB），DB失败503而healthz仍存活；不以Operator/Hindsight/Manager上游离线判本端not-ready。无DB dev状态需明确未配置，不用production fallback内存假ready。Agent既有DB/sandbox检查保留。
- `/metrics`真实注册，request/service/result/status类低基数labels；tenant/member/conversation IDs不作metric label。结构日志带request/trace/tenant/service上下文但不记录body/credential/header/exception raw；W3C trace/context覆盖入口→service→DB/受控出站、Agent→Pi/custom tool，并限制传入trace/header长度/格式。安全失败日志只允许错误code。health/metrics不返回DSN或全量配置。
- 回归：新增 `server/tests/shared/test_readiness.py`/`test_observability.py`，Node HTTP测试；真实PG断连/恢复、上游断网不改ready、/metrics非404且低基数、并发context无串扰、跨端trace透传、合成secret/token/prompt标记不得出现于日志/错误/metrics。

#### S19 Windows原生能力与包验收（30）

- 先仅新增secret-free可行性CI（建议 `.github/workflows/agent-native-validation.yml`）、`scripts/probe-agent-windows.mjs` 和 `src/pi/sandbox-platform.test.ts`受控探针；不得复用会注入企业配置secret的package环境做探针。工作目录/HOME/TMP/DATA_DIR全为runner临时fixture，采集before/after允许范围的ACL摘要与进程列表。
- 现有dependency基线证明：runner真实启动/正确workspace-write与read-only文件效果；读出workspace外**合成canary**、network请求到受控loopback监听器、FAT/NULL-DACL/reparse-point边界（不支持则明确拒绝）与grandchild取消，评估不足。网络测试先验证对照进程能连，以免“网络本来不通”假阳性。不触碰真实profile/凭据。
- 执行候选非管理员network/read隔离验证后形成实证packet。若现有依赖无法满足，报明确阻塞并请求主控批准最小生产wrapper/OS前提/ACL清理设计；未批准前不改production `sandbox.ts`为可用。不能永久以skip或排除win32处理。
- 获批准且实证可行后，窄改 `src/pi/sandbox.ts`、`src/main.ts`/launch guards、`scripts/build-agent-package.mjs`、`deploy/agent`启动说明、`.github/workflows/agent-package.yml`；Windows命令不能硬编码 `true`/假定bash存在，验证包自带/明确要求的shell及argv/路径含空格、Unicode。若需要新增shell分发/license/OS最低版本，先审批再更新plan。
- 完成门：**解包后的真正Windows产物**使用synthetic config与动态端口启动→ready→本地authenticated prompt/faux SDK→允许操作→文件/网络/跨workspace拒绝→abort/timeout杀全child tree→正常退出/崩溃后恢复→无ambient secret/ACL泄漏。macOS arm64、受支持Intel包与Linux安全回归同样保留，不能把Windows通过换成其它平台退化。原生任务不能continue-on-error或skip计通过。

#### S20 全量证据与交付收口（全部30）

- 在主控确认实际30项证据后更新本计划§7、原审查逐项整改链接、三端真实OpenAPI（`scripts/check-openapi.sh`）、`docs/客户端接入/2026-09-05-macOS三端接口接入说明.md`、`docs/部署运维/{Hindsight-Manager-facade-lease,Agent-Sandbox-生产发布Runbook}.md`、部署/Agent包接入文档与README过时交付描述。中文客户端接入用编号步骤解释认证/版本/恢复，不手抄字段大全或把三个SPA混为复合客户端。
- 每项至少提供生产代码/测试路径、精确HEAD、测试输出、独立review、相关CI与TEST/native结果；unknown/外部待授权明确列出。不把“全文替换未实现文案”为完成。

## 5. 迁移与消费者兼容矩阵

### 5.1 迁移执行规则

1. 上述SQL文件名是基于Manager最高0034、Operator最高0011的预留顺序；一个writer串行提交。每阶段开工核准编号未被占用，若变更先更新本文，不改已应用migration。local SQLite沿 `storage/sqlite.ts` 版本化升级，不建第二套执行库。
2. Manager新租户表均ENABLE/FORCE RLS、app_rw最小grant、TenantContext访问、正确复合唯一键/owner约束；部署binding/service私钥是端内控制表，普通成员/业务role不得读私钥。Operator仅oper表，不从Manager直读数据。
3. 每个迁移：空库→新schema、基线fixture→新schema、重复执行、并发启动、失败中途重跑、row count/hash/provenance不丢、RLS双企业fixture、支持回退binary能否读取添加列分别验证。默认添加性迁移，破坏性column drop/大批删数据要另行批准。
4. dry-run清单只含ID/hash/revision/数量/未知原因，不输出password/token/正文/真实配置值。memory合并/retention、binding tombstone、template baseline、Manager注册、Relay孤儿各自有清单与操作者批准，不能用一份“成功”覆盖全部。

### 5.2 跨版本组合

- Wave1 Manager→旧Agent：Manager final enforcement先修，旧Agent仍可拉安全snapshot；明确deny旧客户端可能显示滞后，但执行必须拒绝。旧memory lease失效可重领，新readonly初始化兼容不授PUT。需旧client识别新字段时保持additive；显式空operation不被legacy归一为默认allow。
- Wave2 Operator↔Manager：签名identity协议不能与旧shared-token端混跑cutover。先准备添加性schema/公钥/绑定验证和包，再协调停控制写/服务替换；旧配置字段可留作迁移证据但**不作认证fallback**。Agent不接受服务私钥也不直接拉Operator秘密。
- 新Manager→旧Agent runtime-config：expiry等additive，旧Agent仍在线每次拉但不得获得扩大授权；新Agent→旧Manager缺可信expiry时在线可用、不做offline cache。新审批API缺失时Web明确not-supported，不偷偷对危险tool放行；一旦升级S12 backend即强制gate，旧UI可通过新版客户端决定或安全拒绝。
- Release旧/新：旧固定version读取实际release，旧PATCH不得改已发布bytes；未知历史baseline不伪造。升级需要新版Manager消费者/明确确认；旧Agent既有群roster/session历史不重建。
- Usage旧/新：versioned additive member与revision校验，身份可信可导出member，其余legacy unknown；累计summary重试不翻倍。S10 producer可以先上线“待应用”状态，S16 consumer未通过前不宣称quota已生效。
- Agent SQLite：审批/schedule/receipt安全索引是添加性。重启cache空、pending side-effect unknown不重放。回退旧Agent绕过审批/隔离是不安全回退，须停执行而非直接安装旧包继续。

## 6. 分阶段验证、release-checkpoint与taiyi TEST回退

### 6.1 每个Wave的必需证据

1. 单元/route/service：先跑本阶段列出的source-named回归；依赖PG的用真实一次性PG16/独立fixture，不连接真实企业库。Python标准命令：`env -i PATH=<venv/bin:/usr/bin:/bin> PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 <venv>/bin/python -m pytest -q -p no:cacheprovider -m 'not integration' <本段测试>`；需async plugin按现有配置显式加载，不把缺plugin skip当通过。
2. Node：`pnpm --dir server/agent_service check`、`pnpm --dir server/agent_service test`（隔离HOME/TMPDIR、synthetic环境），新测试必须在脚本glob覆盖；依赖pin保持frozen install。前端：`pnpm --dir web --filter @aiteam/shared run build`、`pnpm --dir web -r typecheck`、`pnpm --dir web -r test`、`pnpm --dir web -r build`，对应Playwright真实registered-route联调。
3. 三端OpenAPI：`scripts/check-openapi.sh <managed-output>`，schema变更与实际路由/消费者同批审查；部署静态：`bash scripts/check-deploy.sh`、`bash scripts/check-agent-sandbox.sh --dry-run`、相关脚本`bash -n`。本轮规划未运行上述全套，不提前记录绿灯。
4. CI保留 `.github/workflows/{ci,web-ci,deploy-ops}.yml` 现有unit/integration(RLS)/coverage-ratchet/OpenAPI/Node/Web/E2E和分端构建门，S19加原生required evidence。secret-free双Manager/newapi/Jira/Hindsight fixtures只在隔离测试运行；不能以mock service token放开真实安全代码。
5. 独立review必须看真实 `git diff`+untracked、调用方/迁移/拒绝路径，逐一修复有效blocker。review后修改要重新相关验证。每批最新**精确head/base** CI全绿才可由主控发布；先前SHA成功不能代替当前。
6. release-checkpoint输出只读packet：branch/HEAD/base、changed+untracked files、每项证据、review unresolved=0、CI job链接/sha、迁移/配置预检、backout、TEST smoke脚本和请求主控动作。writer不stage/commit/push/PR/merge/deploy。审批记录不等于真实执行证据。

### 6.2 当前taiyi TEST从5483218e升级的专用步骤

1. 任务给定的已部署基线是`5483218e`（PR56）；当前工作树是分支`feat/v1-completion-wave1`上的未提交`e5a29890`，二者不可混写为同一已部署版本。**本次未读取taiyi运行状态或credentials**。首次发布由主控通过既有授权只读预检取得实际checkout SHA、组件版本/schema、DB备份可用性、服务状态及**非秘密**enterprise/tenant↔Manager deployment/endpoint/public key fingerprint清单。若当前DB实际上有多tenant，不把它们合并/迁移到一个Manager：暂停S06发布、提交拆分/新部署决定，无授权不得碰真实数据。
2. Wave1按已有流程逐批delivery，先列schema add、旧lease失效/显式memory授权UI影响和回退门；首次历史retention清理默认不开启，先dry-run批准。安全修复不等Windowsnative或Wave2映射资料。
3. Wave2发布前主控确认每个真实enterprise→独立Manager注册与双方public trust根、oper/Manager服务key安全生成持有、TLS地址allowlist、公开handoff URL和受支持客户端组合。TEST当前一个Manager只有证据对应的一企业可绑定；不能把其他enterprise都填相同URL“让测试过”。
4. `deploy-main.yml`合并main会自动触发self-hosted部署且 `run.sh`拉**当时branch最新tip**，不是固定PR head；所以主控在涉及签名/注册cutover的merge**之前**完成预检/备份/审批，串行发布窗口禁止混入第二次merge，部署结束核对actual checkout与批准SHA。不先merge再祈望secret配好，不直接SSH手工部署/改GitHub secrets绕过流程。
5. 现有workflow每次从GitHub secret重写 `.env.test`，fallback key列表是有限的。服务identity私钥/注册trust不得只临时加本机env后下次部署丢失；计划使用受保护持久端内key与public注册表，部署方负责配置引用，脚本只验证“存在/公钥指纹正确”，不打印值。任何必须新增secret由主控向部署方申请，writer不读取/更新secret或复制环境备份内容。
6. 协调cutover：暂停新增企业/重置/目录发布/治理策略写（本地已有工作可继续），备份oper/Manager schema+数据、组件配置与相关上游生命周期清单；由主控执行已批准migration/register；部署两端签名版、验证双方scope与bound enterprise，再恢复控制写/outbox。任一方未就绪保持控制通道fail-closed和outbox pending，不开放shared-token兼容。
7. taiyi TEST 首次升级采用简化的**完整维护停机**，不声称零停机或 cgroup cutover：主控先停止旧应用栈/写入者并确认旧进程不再写库，保持 PostgreSQL/NewAPI 等迁移依赖可用；随后核对卷和备份可用性、切换到批准 checkout、执行 0039 及其它已批准迁移，完成后启动应用栈并检查 health/ready/OpenAPI。若依赖曾被停止，必须在备份/DDL 前显式启动并确认可用；任何迁移失败保持停机并按 backout 合同处理，不跳过 DDL 或在线兼容旧 token。
8. 通过既有taiyi TEST流水线交付，核准SHA、health/ready/OpenAPI，新增真实场景smoke至少包括active/disabled登录、member越权拒、RAG关闭后直接MCP拒、readonly memory lease不写、对应Manager handoff、同version稳定/企业覆盖保留、旧Relay拒绝、Agent调度/5分钟offline/审批/群恢复、补投幂等/成员统计/实际审计可见。使用经主控授权的**独立synthetic TEST账号/对象**，不改真实企业内容/配置；若不能分离则申请替代环境，不能强行对真实数据测删除。
9. 用户端分平台包在对应native CI验证。taiyi Linux运行成功不是Windows证据；TEST样例包不带控制面代码/秘密。完成的Windows能力必须有包SHA、runner OS、真实启动/拒绝/取消日志，不用模板打包artifact替代。

### 6.3 Backout合同

- 每波保留上一安全版本SHA、DB/配置/上游状态备份位置的引用与校验hash，不在报告存secret。先停止产生新控制写/cleanup/lease issuance，flush状态只保留pending不删除，不恢复未知副作用。
- Wave1策略/tombstone/lease：**不得回滚为旧allow-all facade或把deny记录删掉**。回退应用需保留安全guard，必要时停对应能力；旧lease不可复活。retention原生invalidate是可逆性依赖upstream，未经批准不自动revalidate历史事实。
- Wave2trust：不能回退到shared-token接收；保留登记/公钥/拒绝门，可回滚业务release但维持签名边界；不能配对旧Manager错写企业。已有NewAPI撤销无法靠DB恢复原token，回退只可在当前允许策略下安全重新签发，不复活已收紧的宽授权。
- Catalog：保留不可变release和安装记录；可切最新release指针但不能改旧bytes或覆盖企业实例。platform账号回退不能丢新账号/恢复disabled旧密码。
- Agent：停止新prompt/scheduler，abort挂起approval/子进程，preserve JSONL/SQLite/DATA_DIR；新审批、secret隔离或Windows sandbox回退不允许用旧不安全binary继续执行，必要时该平台保持不可用。绝不回放unknown tool operation。
- Governance：保留summary dedup和outbox游标，新旧累计账单先对账再恢复投递；quota回退不解禁企业deny；unknown归属仍unknown。ready/metrics修复可独立回退，但不能把DB假ready作为应急常态。
- 必须在隔离fixture至少演练一次“迁移后回退binary/前滚恢复+pending outbox不丢”。真实数据恢复、历史清理反转、重新绑定部署、上游token处理都须主控批准；backup成功不等于restore已证明。

## 7. 原编号30项→阶段→关闭证据

全表初始均 `待实施`。关闭时写明实现HEAD、source-named测试、独立review/CI以及所需TEST/native证据；不能只改checkbox。

| 原编号 | 审查目标 | 阶段 | 最小关闭证据/发布约束 | 状态 |
|---|---|---|---|---|
| 1 | disabled成员新登录/配置 | S01 | 三类登录及配置/lease实际拒绝；active仍成功 | Wave1A已实施/本地验证；待独审、CI、TEST |
| 2 | 管理角色/资源授权 | S01 | member设置写/未授权config拒绝、授权snapshot正常 | Wave1A已实施/本地验证；待独审、CI、TEST |
| 3 | RAG显式deny | S03 | whole/doc/工具权限、tombstone重启、旧citation与直接MCP拒绝 | S03已实施/本地验证；待独审、CI、TEST历史预检 |
| 4 | Hindsight操作scope | S04 | readonly正常init+recall；写/删/收紧旧lease拒绝 | S04已实施；真实route/PG/SDK/native本地验证；待独审、CI、TEST |
| 5 | 服务企业scope | S06 | 双独立Manager签名跨企业/用途/受众负例；TEST信任登记确认 | 待实施 |
| 6 | Relay撤销/续期 | S07 | 上游旧token真实拒绝、expiry续期、失败记录重启可重试 | 待实施 |
| 7 | 企业Manager绑定 | S06 | 独立地址开通/reset/notify与handoff；禁止第二tenant | 待实施 |
| 8 | 运营动作/导出 | S08 | 浏览器四种实际路由无422、CSV文件可用/安全 | 待实施 |
| 9 | soft quota/企业治理 | S10+S15+S16 | version传递、按scope自动评估通知、新招募/快照消费者拒绝和恢复 | 待实施 |
| 10 | 目录可见范围 | S09（S06前置） | list/detail/nested package按enterprise过滤，不靠UI隐藏 | 待实施 |
| 11 | 版本/团队/升级 | S09 | 不可变hash、真实manifest、丢notify发现、preview保留覆盖 | 待实施 |
| 12 | 持久平台账号 | S08 | restart、多角色/禁用/last-admin；bootstrap不覆写 | 待实施 |
| 13 | 生命周期增量 | S02 | 同known_versions生命周期变化能sync、在途snapshot不变 | Wave1A已实施/本地验证；待独审、CI、TEST |
| 14 | 方案复用授权 | S02 | A/B并集、并发幂等、真实PG失败回滚预存在关系 | Wave1A已实施/本地验证；待独审、CI、TEST |
| 15 | 真实连接器 | S14（S01/S11/S12前置） | Jira Cloud凭据→grant→真实probe→Pi issue工具→撤销；其余不伪connected | 待实施 |
| 16 | 记忆策略/保留 | S04 | effective source/presence、TTL排除及native失效、历史清理批准 | S04已实施；Manager→PG ledger→精确native集成本地验证；待独审、CI、TEST/历史清理批准 |
| 17 | 自定义Skill/readiness | S05 | 元数据编辑不丢包、签名校验、缺包真实not-ready | S05已实施/本地聚焦验证；待独审、最终全量CI、TEST |
| 18 | 知识导入恢复 | S05 | 失联claim/track重启对账、活跃409、安全retry不重复 | S05已实施/原子receipt+job与PG聚焦验证；待独审、CI、协调切换/TEST预检 |
| 19 | 扩展登录/退出 | S01 | identity映射/RP可信配置、因子管理/signOut浏览器回归 | Wave1A已实施/本地验证；待独审、CI、TEST与DNS验收 |
| 20 | 人工审批 | S12 | 真Pi gate批准一次/拒绝零、abort/expiry/crash未知不执行 | 待实施 |
| 21 | 调度身份 | S11 | 真Authorization、缺身份不消耗one-shot、restart恢复说明 | 待实施 |
| 22 | 有界离线执行 | S11 | TTL≤300秒/有效期最小、短断网复用、401/403清除无fallback | 待实施 |
| 23 | 失败/SSE/群恢复 | S13 | 202后失败可见、全部target终态、SSE先建立再entries/receipt/state对账；两处结算竞态/restart/cursor丢失恢复且不重放 | 待实施 |
| 24 | 普通文档附件 | S13 | txt/md/csv/pdf/docx正文受控读取，跨owner/超限/压缩攻击拒绝 | 待实施 |
| 25 | Web已有读取消费 | S17 | preview/unread/participants/search/works/stats真实API浏览器验证 | 待实施 |
| 26 | 可靠用量補传 | S11+S15 | Agent恢复自动排空+Manager持久outbox、deadline、累计幂等 | 待实施 |
| 27 | 成员维度统计 | S15 | 身份导出member、两成员统计不同、旧unknown不推算 | 待实施 |
| 28 | 审计查询/汇总 | S16 | 真登录/拒绝→页面→脱敏平台计数，无内容/秘密 | 待实施 |
| 29 | DB ready/可观测 | S18 | 本DB断连503、上游离线ready不变、metrics/trace/日志隐私 | 待实施 |
| 30 | Windows原生交付 | S19 | 现有依赖可行性→批准安全方案→真正包启动/拒绝/取消/native日志 | 待实施/待原生验证 |

## 8. 执行记录与下一步

- 2026-09-06 初始：审查与本计划为已有未跟踪文档；HEAD `5483218edecc35eb3e199d3985c4b0b4dda587a0`、分支 `feat/v1-completion-wave1`；没有stage/commit/push/部署。
- 本轮规划：保留全部原30项，拆成S01–S20；主控批准§3七组安全/兼容方向，要求不阻塞可独立Wave1、不提前排除Windows、不对未知旧配置/真实映射做推断。再次获得主控批准§3.7 Jira三层权限/撤销边界和S13纯文本+PDF/DOCX输入、其余storage-only边界。已做§2只读源码/公开协议、两项临时SDK探针及一个不spawn的Windows argv探针；没有业务代码、仓内测试、真实配置或数据变更。
- 本轮复审修订：纠正S13“先读后订阅”的恢复窗口；对照实际 `SessionHost.subscribe/publish`、HTTP events的listener/响应顺序和Web订阅异步句柄，明确先建立live SSE并缓冲，再owner-checked entries/receipt/runtime state对账，加入两处结算窗口、重启/cursor丢失及不同速度群的确定性回归要求。S01补齐 `passkey_ceremony.py`/`routes_mfa.py` 可信origin执行路径与disabled登录/密码重置UI区分及开工失败回归门；仍只有本文变更，没有业务代码/测试实现或阶段关闭。修订后计划SHA-256写入受控复审报告，须由独立reviewer重读实际未跟踪文件并复算hash后才可无条件批准，不能沿用修订前批准。
- 开工顺序：主控独立审查修订计划/精确hash → 单writer按S01开工预检核准实际文件路径、合同/迁移/消费者并执行失败回归 → S02–S05小段串行；安全隔离的S01预检/失败回归不等待后续部署/native决定，各Wave按§6证据由主控发布。S04 retention协议、S06真实TEST注册清单、S19原生可行性在各自门之前收口，不能把待取得的证据写成已通过。

### Wave1A 开工预检（S01/S02，2026-09-06）

- 实际基线仍为 `5483218edecc35eb3e199d3985c4b0b4dda587a0` / `feat/v1-completion-wave1`；只保留父会话 plan/audit 未跟踪文件，无暂存。仅实施原编号1/2/13/14/19，其余保持待实施。
- S01精确落点：`server/manager_service/{active_principal,repository,auth_service,auth_password_policy,app,settings_service,routes_settings,routes_employee,routes_employee_bindings,employee_bindings_services,authorized_config_service,snapshot_service,passkey_service,passkey_ceremony,routes_mfa,oauth,oauth_service}.py`；新增 `auth_origin.py`。线上Manager在shared无状态验签之后用本端app_user核验active并重新读取roles；不修改shared验签/Agent离线JWT expiry。service级snapshot/pull同样在管理员grant豁免之前检查active。公开完整employee/绑定配置仅owner/enterprise_admin；内部snapshot/RAG配置读取不加管理角色门。绑定单资源读改删显式核对URL employee_id与实际row.employee_id。
- 密码SQL：两种identity查询同为7列（id/user/secret/must_reset/password_changed_at/roles/status），find_user优先密码身份但role/status来自app_user；创建/真实secret变更写now()。无密码时间戳迁移，旧unknown不强制过期。403 typed code新增 `principal_inactive`、`password_reset_required`、`password_expired`，普通`forbidden`不触发Web重置流程。
- RP配置：唯一可信 `MANAGER_PUBLIC_ORIGIN`，RP ID严格取该origin.hostname（不取tenant UUID/body/Host），origin精确匹配；HTTPS，HTTP仅显式dev/test的localhost/loopback配置，缺配置503 `auth_origin_unconfigured`。注册challenge绑定tenant+当前user、登录challenge绑定tenant+可选account/credential allowlist；finish核验origin、RP、challenge类型/作用域、UP/UV、签名/计数和重放，CeremonyError转换为422。无新factor DB迁移。
- 主控2026-09-06额外批准OAuth既有接口安全修复：authorize additive `intent=login|link`，link须active JWT，state随机/10分钟/原子一次性且绑定provider/tenant/intent/user/精确redirect。redirect仅可信origin的 `/auth/oauth/callback`。link新增必填state，旧无state请求422；Web sessionStorage核验本浏览器预期state/provider/intent，callback不自动接受外来事务。unlink事务删除该provider的connection及精确auth_identity，保留其它provider，禁止移除最后可用登录方式。既有OAuth/passkey账号不增SSO/refresh；macOS须按新state协议升级并走受信Manager callback，不开放任意native scheme。
- Web落点：`web/manager/src/{App,AppProviders}.tsx`、`shell/AppShell.tsx`、`pages/{LoginPage,OAuthCallbackPage}.tsx`、`auth/{factors,passkey}.ts`、`features/settings/{SettingsPage,AccountSecurityPanel}.tsx`；同端API真实passkey创建/认证、OAuth跳转回调/解绑、退出。普通成员仍可管理自己的factor，但不能写企业设置。更新 `.env.example`、`server/manager_service/README.md`（新增身份契约说明）及路由schema/description，不手写OpenAPI副本。
- S01失败回归先运行：新增 `test_active_principal.py`（密码/reset/issuer disabled、role freshness、registered routes）、`test_passkey_ceremony.py`（合成ES256/CBOR真实验证）、扩展 `test_repo_repository.py` 的真实SQL形状断言和PG `test_auth_e2e.py`；之后同步OAuth state/unlink PG、Web LoginPage/AccountSecurity/Callback与浏览器虚拟authenticator测试。基线结果/命令在本节后续记录，不把跳过PG当通过。
- S02待S01通过后登记精确事务实现再编码；既定migration `0035_identity_and_employee_revision.sql` 只扩展现有employee版本trigger的status比较，保留wire version/known_versions。在途snapshot不动，复用grant只并集、显式grant仍替换；外部package/model/skill预检在本地原子发布之前。
- S01失败基线：`test_active_principal.py` 4/4失败（7列SQL缺字段、disabled login错误code、reset和issuer未拒绝）。先修正测试mock签发返回字符串以排除测试自身Pydantic错误，再确认上述真实失败。实施后扩大到Manager非integration：1136 passed / 29 failed / 17 skipped，失败集中在原测试不创建admin principal、旧6列fake、原允许member绑定配置读取的预期；更新具体fixture身份/可信origin及安全契约预期，未放宽guard。新增legacy `routes_employee_prompt.py` 同类完整配置读门（URL与普通employee相同）。
- S01本地PG验证使用新建独立Docker fixture `aiteam-wave1a-fixture` / loopback55483 / `manager_fixture`，合成账号与临时密码，不访问已有DB。初次拉postgres:16被Docker凭据helper拒绝（未解锁/改keychain）；改用本机已存在 `postgres:16-alpine --pull=never`，不再调用凭据helper。
- 因子移除补充相同安全约束：`passkey_store.py` 删除也在app_user行锁内验证其它真实登录方式（password/passkey/OAuth）；不得通过并发unlink+delete移除最后方式。OAuth连接查找补provider匹配，upsert不允许冲突时改写原user归属。无额外表或迁移。
- 同类公开管理面核对：`routes_connector_ops.py`/`connector_ops_service.py` 的status/test/grants属于管理配置读取/写入，补owner/admin门（preset公开元数据仍可读）；`memory_service.py` management=true的list/update/delete要求owner/admin，runtime recall/retain仍走active+employee grant，不误伤RAG/snapshot内部读。对应源命名测试新增负例，连接器真实执行/probe状态语义仍留S14，不在Wave1A伪称完成#15。

### S02 原子发布预检（Wave1A）

- 主控批准将0035改为 `server/manager_service/migrations/0035_identity_and_employee_revision.sql`：现有0034 trigger完整保留并增加status变化；仅增加app_rw对两张因子表DELETE，RLS/FORCE/表owner不变。无数据回填/unknown猜测。0036–0039留后续波次。
- 精确事务落点：新增 `server/manager_service/recruit_transaction.py`，由 `build_recruit_service` 注入Manager本地UnitOfWork；在一个 `PgTenantRouter.session(ctx)` 中绑定employee/grant/recruit/order四个既有repository，不改shared/db、不引入全局可变router。事务获取本tenant招募advisory xact锁，publication重新核对solution/source-template，失败整笔回滚，删除旧best-effort部分补偿。外部package/model/skill预检在事务前；员工、部门配置、授权、solution、订单与审计发布在事务内。
- `repository_member.py` 新增明确 `extend` 并集操作，ON CONFLICT按SQL去重合并部门/成员，不使用读后替换；既有显式upsert保持替换语义。solution apply同solution/version重试仍409（既有契约），无重复实例/授权记录；并发两个不同solution复用同employee均不减权。缺UnitOfWork的手工service装配只允许只读/单招募，apply fail-closed；测试显式注入回滚fixture，不在production加“fake success”分支。
- 验证：新增 `server/tests/manager/test_recruit_transaction.py` PG真实app_rw逐步骤故障（employee/transition/order/grant/solution/event/apply_record）回滚，包括预存在A grant；并发apply/同版本幂等冲突；`test_employee_effective_revision.py` PG所有生命周期revision/no-op＋真实pull与snapshot请求，Agent现有projection consumer回归追加在 `server/agent_service/src/manager-client.test.ts`（或实际消费者源命名test）。既有在途snapshot为独立对象，不反向改写；非active仍可取只读snapshot，不阻断delta状态更新，新runtime发行仍拒绝。
- Browser验证追加实际路径 `web/e2e/manager/account-security.spec.ts`（无mock request，pinned Playwright CDP虚拟WebAuthn authenticator），现有 `web/playwright.config.ts` Manager进程显式test trusted UI origin；`web/e2e/support/globalSetup.ts`仅将本次合成seed的slug/account/password通过内存env传给该场景（不读取现存用户session或真实secret文件）。本地用隔离PG+独立Manager/Vite端口与受控临时Playwright config运行同一spec，不需要启动/修改其它真实tier。测试需密码登录→登记→列表→退出清token→Passkey登录→删除→取消/disabled typed错误；OAuth provider无真实凭据，仅真实route/service+合成provider与浏览器事务测试，不声称实测Google/GitHub账号。
- 实际Chromium小探针（pinned Playwright1.61.1 CDP options已读源码类型）发现loopback IP不是合法WebAuthn RP ID：registration-options200但浏览器 `This is an invalid domain`、未发送注册POST。修复明确区分OAuth可信origin与WebAuthn合法DNS RP：Passkey拒绝IP RP配置503，dev/test只支持 `http://localhost[:port]`；不猜“RP ID可以IP”。`web/playwright.config.ts`/`web/e2e/support/auth.ts` Manager默认UI origin统一改localhost，HTTP/API端口/其它tier不变。本地临时origin同样localhost；不关浏览器安全flag、不模拟注册成功。
- 主控补充裁决（S01/#1）：`hindsight_facade.py` opaque lease入口不经过用户JWT，必须同样检查已验证lease的tenant/member active；`routes_hindsight.py`实际组装注入TenantAuthRepository(PgTenantRouter)。缺依赖/账号不存在/disabled/DB异常均零上游调用；仅复用active_principal helper，operation/policy/lease结构留S04。新增原lease active→disabled/deleted、其它active成员/跨tenant、真实组装/PG回归。
- 发布兼容：taiyi目前IP TEST入口不满足Passkey合法DNS RP配置，**只有Passkey不可用并明确503提示**，不得阻止Manager启动、health、password或OAuth。WebAuthn localhost实际浏览器通过不等于taiyi DNS+HTTPS交付验收；S01发布检查点必须先登记受信公网DNS+HTTPS `MANAGER_PUBLIC_ORIGIN`，否则Passkey保留未配置，密码仍可用。新增IP配置下密码/OAuth可用的回归，未升级SDK或关闭origin验证。
- 全Manager真PG运行发现既有两份resolver测试以 `TenantAuthRepository()` 无router装配且未标integration（此前无PG时全skip），修正 `test_resolve_tenant.py` / `test_resolve_tenant_by_account.py` 使用真实PgTenantRouter并标integration，不改生产resolver语义。更新 `test_employee_{config,bindings,role_title}_e2e.py` 原member完整配置读200/无principal管理员/生命周期不涨版旧预期；补真实管理员行与最终0035重放，保留所有RLS/版本/配置字段断言。
- 全server非integration回归：2006 passed / 11 skipped / 174 deselected。全server integration首次扩跑发现Loop A旧断言只接受`forbidden`（`tests/integration/loops/loop_a_open_enterprise/test_owner_login.py`），按已批准typed reset code同步；其它失败根因是该既有integration harness中途把独立fixture app_rw密码设为其固定合成`apprwpass`，本地命令使用不同合成fixture密码后续连接失效。重新以CI同款合成app_rw配置跑隔离容器，不改变真实secret或既有安全门。
- S02消费者追加已获主控批准：实际旧`member_id=''`兼容projection会与新的scoped状态并存，原始Node测试已暴露旧active回退；不以清空fixture掩盖。改 `server/agent_service/src/storage/sqlite.ts` 的既有projection事务：仅认证sync提供owner且新employee明确同tenant/member时，删除同tenant+employee的旧无member projection/snapshot；显式revoked_ids同样清旧unscoped记录。保留其它tenant、其它member scoped记录与所有会话/正文/在途对象；owner缺失或空增量不清无关记录，tenant未知不推断。去掉 `src/http/platform.test.ts` 手工清理，新增 `src/storage/sqlite.test.ts` 的保留/空增量/撤销/事务失败回滚用例。无schema/新store/执行内核；旧只有无成员缓存的用户需重新sync，兼容说明明确这一安全收口。

### Wave1A 本地验收记录（待独立审查/CI/发布，非30项完成）

- 完成范围：原编号1/2/13/14/19的代码与真实消费者。新增经主控批准的OAuth state/link/unlink安全兼容、0035因子DELETE最小权限、Hindsight已签lease active-only检查、Agent已知tenant旧无member投影安全替换；#3/#4的whole/doc deny/operation allowlist和#16记忆策略仍由后续S03/S04实施，不因active guard提前关闭。
- 最终Manager（含真PG/RLS）覆盖执行：`pytest server/tests/manager --cov=server/manager_service --cov-branch` **1287 passed / 9 skipped**；skip为既有废弃Manager-provider用例。此前扩大到全server非integration **2006 passed / 11 skipped / 174 deselected**（随后增加的clientData JSON类型回归另在Manager最终套件通过）；全server integration使用CI同款合成app_rw密码后 **159 passed / 15 skipped / 2017 deselected**。15skip为未配置独立Operator测试DB，不把它称为全Operator PG完成。
- Node Agent全测试 **158 passed / 1 skipped**（159 total）；唯一skip为仅taiyi gate启用的Linux native bwrap/Landlock矩阵。`pnpm check`通过。实际HttpManagerClient→Agent sync→SQLite/readiness覆盖所有生命周期、相同known_versions无重复snapshot拉取，以及原未清空legacy fixture；SQLite回滚/其它member/其它tenant/unknown tenant/空增量/撤销均通过。
- Manager Web Vitest **275 passed (40 files)**；typecheck与production build通过（现有大chunk提示未放宽阈值）。新增OAuth浏览器事务/回调/错误和Passkey二进制DTO/取消、AccountSecurity界面测试；原LoginPage验证两个typed reset code成功、disabled/普通403不切reset。
- 真浏览器：pinned Chromium虚拟authenticator通过**实际生产Manager app + 独立PG + Vite**，密码登录→登记/列表→退出清token→Passkey认证→删除，**1 passed**。在localhost合法RP上，未mock WebAuthn服务/HTTP成功。IP RP失败先被真实浏览器发现再修配置约束；PG另外证明IP RP配置只使Passkey503，password/health/OAuth仍可用。Google/GitHub真实账号及taiyi DNS+HTTPS尚未验收。
- 真实三端OpenAPI导出/质量检查均OK；不手写契约副本。包含未跟踪源码的完整working-tree diff用于本地coverage gate（未stage）：Python改动行覆盖约94%、Web98%，`diff-cover --fail-under=90`均通过；全仓base/head覆盖棘轮与CI仍归主控发布前确认，未改任何门。
- 所有运行在明确合成环境/新建fixture容器，未读取真实secret/env、修改keychain/ACL或真实企业数据，未接触冻结app/与外部Hermes，未升级Pi/引入正文副本或新执行内核。证据日志/coverage/OpenAPI/临时browser config保存在本轮受控 `v1-closure/tmp/`。开发分支及HEAD保持开工值，无stage/commit/push/merge/deploy。
- 主控下一步：对累计实际Git diff（含所有未跟踪文件）独立审查，再按既有流程执行CI与发布checkpoint。taiyi仍IP入口时Passkey必须明确保持未配置，不能把localhost测试当DNS部署验收；OAuth无state旧link客户端须升级；legacy无member缓存用户可能需要重新sync。当前30项表只标本阶段本地实施，不宣称Wave1其它任务或全v1已交付。

### S03 开工合同与迁移预检（2026-09-06，仅原编号3）

- HEAD/branch仍为 `5483218edecc35eb3e199d3985c4b0b4dda587a0` / `feat/v1-completion-wave1`；已有S01/S02未暂存实现完整保留。仅RAG策略，不实施Hindsight、技能包、导入恢复；不读真实凭据/企业库，不stage/commit/发布。
- 主控批准精确新增北向路径：`GET /api/manager/employees/{employee_id}/knowledge-document-bindings`，`PUT/DELETE .../{document_id}`。同 `routes_employee_bindings.py` 组装，当前active owner/enterprise_admin专用；PUT严格 `{enabled:boolean}`，DELETE幂等204且只留该员工/文档deny，不删除源文档或索引。服务端推导workspace、actor/time/revision/source，双方必须存在于ctx企业。existing whole `knowledge-bindings` DELETE留deny tombstone，POST相同已撤销ref明确恢复allow；PATCH省略字段保持原值，不能隐式enabled=true或清config。
- `migrations/0036_knowledge_policy_tombstones.sql`：existing whole表增加 `policy_revision bigint default 0`、`policy_source text`、`policy_actor uuid NULL`、`policy_updated_at timestamptz NULL`、`revoked_at timestamptz NULL`；document索引表增加相同元数据与 `enabled boolean NULL`（NULL=inherit，绝非显式allow）。新增复合employee `(tenant_id,id)`唯一键，whole/document binding的tenant+employee FK，document binding的 `(tenant_id,knowledge_space_id,document_id)` FK；保留RLS/FORCE/owner和现有唯一键。不猜测/删除不满足新FK的历史关系：约束校验失败即阻止升级。
- 迁移来源裁决修正：观察到的whole enabled=false保持deny，但actor/time未知仍NULL；document `revoked/stale/pending/failed`是资源/索引状态，**不迁为永久管理员deny**。新列source标legacy_resource或inherit，enabled仍NULL。只读 `knowledge_policy_preflight.sql` 供受控迁移预检输出metadata-only unknown与复合FK不一致范围；无whole行不能判断从未设置还是历史物理删除，保留inherit，不能全库补allow/deny。真实TEST预检/未知历史映射仍待主控授权，不阻止不推断数据的添加性迁移/安全代码。
- 管理写才改policy元数据；索引upsert/backfill/publish仅改索引列，不能碰enabled/tombstone/revision。policy实质变化在同事务trigger提升原 `employee.version`，no-op PUT/重复DELETE不涨版；doc索引ready/stale不等于管理修订。删除/禁用后reindex/restart仍deny，显式doc allow不能越过whole deny、tools限制、非ready/deleted文档。
- 解析点新增 `knowledge_access_policy.py`；同一个有效策略解析供 `snapshot_service.py`、`authorized_config_service.py` 和 `rag_mcp.py`。沿旧empty config.tools=默认集合；显式非空列表只许可列出的knowledge操作，search/get相互独立。additive typed `KnowledgePolicySnapshot(state=inherit|allow|deny, allowed_operations=[knowledge_search|knowledge_get], revision=employee.version)` 在 `shared/contracts/snapshot.py` 的snapshot和授权投影传递；Agent `manager-client.ts`保留该策略，`pi/rag-mcp.ts`按精确操作创建工具（支持get-only/显式[]），不因空refs/tool数组恢复已deny。
- 每次Manager search/get先重判active_principal、员工生命周期/成员grant、whole/tool策略；search跨外部await后重读policy fingerprint/版本/文档状态再做citation映射，撤销竞态零结果交付。get重新校验源版本与policy，隐藏/失效citation沿既有安全unavailable；whole/tool拒绝403（MCP调用为协议错误，HTTP直接tools/call同样校验）。禁止未知/冲突alias、未验证混合graph正文；只输出当前允许源文档中可验证的有界内容，无原文时不信上游任意text。
- 实际代码落点：`server/manager_service/{knowledge_access_policy,rag_mcp,snapshot_service,authorized_config_service,employee_bindings_repositories,employee_bindings_services,schemas_employee_bindings,routes_employee_bindings,knowledge_intake_repository,routes_grants,app}.py`、上述migration/SQL、`server/shared/contracts/snapshot.py`；必要 `knowledge_intake_service.py`仅保持索引与policy列分离，不改调度。Web新增 `features/experts/KnowledgePolicyPanel.tsx`（及source-named测试），使用当前单企业knowledge list与真实管理路由，嵌入 `EmployeeConfigDrawer.tsx`；`features/knowledge/KnowledgePage.tsx`说明document删除与员工deny不同；无普通SPA跨端访问。更新Manager README/OpenAPI由真实typed router导出，不手写副本。
- 验证先失败回归/同步测试：新增 `test_knowledge_access_policy.py`（whole/tool/doc/race/直接MCP）及 `test_knowledge_policy_pg.py`（真实route/service/PG、两member/tenant、disabled/admin、FK/RLS、migration重放、known_versions、whole/doc DELETE幂等、reindex/restart/旧citation）；扩充 `test_rag_mcp.py` 来源过滤、`test_knowledge_intake_unit.py`的索引保持策略、现有绑定suite；Agent `manager-client.test.ts`/`pi/rag-mcp.test.ts` get-only/deny消费者，Webpanel真实API形状/状态测试。隔离Docker合成PG、MockTransport LightRAG，不调用真实知识服务。最终focused Python/PG、Node、Webtypecheck/test、OpenAPI质量检查与无暂存证据入受控报告；独审/CI/TEST由主控后续执行。
- S03阶段中间验证：新增resolver测试已通过；初始RagAccessService尚无policy注入seam，12例setup报预期TypeError（不冒称已验证行为失败）。接通实现后164例focused回归通过。原4个RAG成功测试仅信上游text、无可信源，已改成临时真实源文件而非放宽新provenance检查；原跨tenant混入绑定的结果从过滤改为整体Forbidden。接下来真实PG/route/SDK负例、migration/restart与Web/Agent消费者独立验收。
- S03扩展回归发现两份旧PG fixture把actor填 `owner-a/owner-backfill` 而不是app_user UUID，新增服务端policy_actor UUID保存因此拒绝；仅将 `test_employee_bindings_e2e.py` 和 `test_knowledge_intake_e2e.py` 相应合成actor改UUID，不改生产schema/权限。Web旧 `ExpertsPage.test.tsx` 两条错误断言假定页面只能有一个alert，新独立知识策略加载失败也需提示；改为定位对应错误文本的alert，保留失败/不保存断言，不隐藏真实策略错误。上述测试路径补入实际S03回归落点。
- S03全Node验证首次159通过/1失败/1原生Linux skip：失败为既有macOS sandbox测试将“outside”放在本次合成 `HOME=/tmp/...`，pinned dsh `writableRoots` 的workspace-write明确包含系统temp，因此不是本次RAG回归或应削弱的门。已只读核对pinned `dsh-sandbox-local/lib/index.js` Seatbelt builder与`dsh-sandbox` writableRoots；改验证环境为受控artifact内独立home（非系统temp），不改sandbox代码/OS权限/测试断言，不读取真实HOME或keychain。全Manager含PG最终1313 passed/9既有skip；全Web首次277 passed/1旧alert选择器失败，保持对应错误断言并修为精确文本定位。

### S03 本地验收记录（原编号3，待独审/CI/TEST）

- 仅RAG显式whole deny/document策略tombstone/current tools/enforcement与真实消费者完成；S01/S02原改动保留。新增文档管理路径、服务器生成policy metadata、nullable inherit、同事务employee.version trigger、复合FK/RLS均按主控裁决实现。索引传播SQL没有新增policy列的写入，PG证明backfill/single-upsert/bulk-upsert/publish不复活deny。没有实施Hindsight retention、技能或导入恢复。
- 最终真实Manager+shared测试（含新独立 `aiteam-s03-fixture` Docker PG、app_rw/RLS、服务与registered routes/官方MCP client）**1438 passed / 11 existing skipped**；最终Node全套 **160 passed / 1 existing Linux-native-only skipped**；Manager Web **278 passed / 41 files**。两端TS检查与Manager Web生产build通过；保留原大chunk提示，不调阈值。新增PG并发相同DELETE只增revision一次、policy/employee版本回滚原子性、pre-0036合成表真实初迁移+重放等证据。
- RAG负例包含继承成功、whole禁用/删除、search-only/get-only/read-only、doc A拒而B成功、状态非ready/deleted、旧citation、旧auth对象、upstream-await间whole/doc/tools/member/version撤销、未知/冲突alias和混合graph正文、管理员降级/禁用、两成员与跨企业拒绝。重启证据为对同一真实PG重建repository/service（无内存许可缓存）；未声称真实LightRAG或taiyi进程kill/检索质量验收。
- 真实两控制端OpenAPI导出和质量检查OK，新3条operation由typed FastAPI schema生成；Agent未新增北向路由。本阶段相关production working diff（含未跟踪文件及共享文件上已有S01相关行）Python changed-line coverage **96% / 278 lines**，Web **100% / 78 lines**，`diff-cover --fail-under=90`通过；Web LCOV仅在受控副本把 `SF:src/`规范化为仓库路径，没有改hit计数。一次原始LCOV路径不匹配返回无行，不计为覆盖率证据。全分支覆盖棘轮/CI仍由主控执行。
- 全验证使用明确合成环境：无真实env/secret/enterprise读取，未访问冻结app/、修改外部Hermes、SDK/lockfile、keychain/ACL/防火墙。pnpm入口在空HOME下误选未缓存工具版本失败，最终用已安装的本地tsc/vitest与pinned Node直接运行；没有升级依赖。生产build显式envDir指向受控空fixture目录。日志/coverage/生成OpenAPI/working diff位于本run受控 `v1-closure/tmp/s03/`。
- 发布剩余门：独立reviewer读实际累计Git diff及未跟踪文件；主控CI与taiyi TEST前执行/确认metadata-only历史预检，未知物理删除意图不恢复/不推断，FK不一致不自动修复。旧严格客户端须兼容additive knowledge_policy，原DELETE现在保留GET/list可见tombstone；Manager对旧client直接MCP仍强制当前拒绝。未stage/commit/push/merge/deploy，不宣称整批Wave1或全部30项完成。

### S04 开工预检（2026-09-06，仅原编号4/16）

- HEAD `5483218edecc35eb3e199d3985c4b0b4dda587a0` / `feat/v1-completion-wave1`；S01–S03累计未暂存改动完整保留，无发布操作。已读pinned `pi-hindsight@0.12.0` bank/lifecycle/retain/recall和transitive `hindsight-client@0.9.1`真实序列化源码；依赖版本不变。
- 主控本阶段裁决：外置Hindsight在仓内无server pin，不用extension版本冒充服务版本。主控安排只读非秘密version/digest/OpenAPI预检，后续另批准合成fixture原生探针。当前可独立实施lease/有效策略安全闭环；**有限retention持久原值但所有记忆内容能力503 `memory_retention_unverified`、不降为无限，不执行历史cleanup；#16仍open，Wave1发布仍有此门**。需要验证的原生接口：profile/create存在性、async retain operation→facts/document/metadata关联、分页list/state/metadata、PATCH invalidated召回排除及observations/source_facts/chunks/entities裁剪。模拟HTTP200不算这项证明。
- 精确代码落点：Manager `memory_policy_service.py`（新增，唯一normalization/presence/读取入口）、`employee_config_repository.py`（同一tenant session收口旧config写入口）、`employee_config_service.py`（旧API字段presence）、`employee_bindings_{repositories,services}.py`、`schemas_employee_bindings.py`、`routes_employee_bindings.py`、`snapshot_service.py`（不再合成默认retain）；`hindsight_{credentials,lease_repository,facade,client}.py`、`schemas_hindsight.py`、`routes_hindsight.py`、`memory_service.py`、`routes_memory_items.py`。按实际需要新增 `hindsight_operation_policy.py` 负责精确有界SDK DTO与可信来源重写，避免泛HTTP代理。消费者仅Agent `src/pi/resources.ts`及必要`manager-client.ts`、Manager `features/experts/MemoryPolicyPanel.tsx`（新增）/`EmployeeConfigDrawer.tsx`，无connector/runtime kernel改动。
- migration `0037_memory_policy_lease_scopes.sql`：employee_memory_setting增加source/revision/explicit_auto_retain/provenance；保留原employee JSON及setting JSON/retention/seed来源，不导入seed。迁移只补缺项、enabled取restrictive、显式operations取交集（`[]`为deny-all）、finite retention取短；未知implicit default只有recall，不授权auto-retain。新政策显式`explicit_auto_retain=true`且retain获准才允许自动提炼；仅retain operation许可为手工许可。source/provenance为server-owned不可调用者覆盖。employee.memory_policy成为兼容投影，两个写入口均同事务更新setting及投影（沿employee.version trigger）；部分字段缺失保留，DELETE写deny tombstone。既有template/recruit repository写也经同一个policy transaction helper，不留隐藏旧写入口。policy catalog仍不自动应用。
- 同migration lease增加allowed_operations与policy_revision；旧无操作证据lease一律revoked，不补allow-all。每次facade用S01 active-principal并读取当前roles，再复用snapshot grant/lifecycle/current policy；scope为lease与当前策略交集，放宽需新lease，响应前重判撤权/expiry。finite策略失败即零上游操作。
- Facade仅GET精确`v1/default/banks/{bank}/profile`（本地最小SDK兼容profile）、POST精确`.../memories/recall`或`.../memories`；禁止全部query、未知字段、PUT/PATCH/DELETE及其它路径，raw/decoded路径非canonical（%编码、反斜线、dot-segment）拒绝。stream读取上限256KiB，JSON strict/duplicate-key拒绝，有界array/depth/string。retain的operation/document标识由tenant/member/employee+canonical request digest派生；调用者document/update_mode/strategy不能覆盖其它已接受记忆，metadata去掉本机cwd/session路径与保留命名空间。保留content只存在请求内存/唯一Hindsight，绝不写正文数据库/日志。
- Manager可信bank provisioning：GETprofile仅明确404才PUT最小固定bank配置，existing bank不PUT改写；生产用tenant-scoped PG advisory事务锁串行Manager创建，冲突再GET确认、有界失败503。runtime-config在授权后provision成功再发lease；facade profile不能触发任意bank配置写。管理memory API同样取消每次PUT，owner/admin管理权限保留，有限retention未验证时不暴露正文。
- 兼容：北向路径不变，runtime-config additive operation/revision字段；不升级pinned SDK。旧Agent不再有bank PUT权，但受控profile GET初始化成功；新Agent自动retain与manual retain分开，未知旧policy默认不自动上传，readonly不flush旧队列。MemorySetting PUT/PATCH保留省略字段，DELETE仍204但可GET到deny/provenance。scope只执行employee，旧非employee字符串仅保留历史来源，不扩大bank共享。
- 验证先失败/同步：新增 `test_memory_policy_service.py`（presence/冲突/显式[]/source）、`test_memory_policy_pg.py`（真实迁移重放/初次冲突/backfill/RLS/事务/两个入口/restart/known_versions）、`test_hindsight_operation_policy.py`（DTO/未知/编码/超限/来源）；扩展四份`test_hindsight_*`、`test_memory_items.py`、binding/config/snapshot suite，Agent `pi/resources.test.ts`真实pinned fetch fixture成功init+recall/retain、禁止auto/readonly queue/revoke/expiry。原生retention/restart cleanup/derived proof须另补，不以unverified gate测试充作完成。所有测试使用独立临时合成PG/受控artifact空HOME，无真实secret或企业数据。
- S04协议补充：主控取得部署server `0.9.0`，source revision `b12646f49ec512136b9f709e608524ffed969668`，真实OpenAPI SHA256 `41db1920c45292df48fd95b222be4949699c5caf2d22afeb4560ae9baf741f57`（受控preflight目录）；已核对RecallRequest/RetainRequest/MemoryItem/BankProfile/CreateBank字段。`3aed33...`经主控澄清为部署image ID，并非可registry pull的RepoDigest；两个registry精准pull均manifest unknown，不使用本机同tag的`6364...`替代。主控批准提供docker image save的内容寻址archive，校验archive hash+config image ID/layers后`--pull=never`本机隔离运行；不export运行容器/卷/运行env。新增受控可重复probe落点 `scripts/verification/s04_hindsight_native_probe.py` 和 `scripts/verification/s04_hindsight_native_probe.sh`，只挂独立脚本，不挂repo/home/secret，用image自带临时PG或独立fixture PG、无外网；embedding/LLM可double，curation/recall SQL/派生prune不mock。
- S04受控Agent补充：pinned `retain.enabled`同时控制手工写和queue flush，因此不能只把它改成auto-consent。保留manual operation enable，但`agent_end` hook只有explicit_auto_retain=true时注册；工具按recall/retain分别注册。继续使用原pinned JSONL队列，queue文件名派生tenant/member/employee/bank/auto-consent scope；旧无scope queue不自动补投，readonly不flush。没有新队列实现/正文库；只隔离现有队列消费者，避免切成员/取消auto-consent时冲刷其它来源内容。
- S04原生前置已通过：主控archive核验确认OCI manifest `3aed33...` → config image `8d1952becd2119115e995accbdc7cdb88d9bc147df08653e0b47455ee08a0df0`及21层一一匹配；最终probe直接pin config ID，无tag fallback。真实HTTP/PG recall、PATCH invalidated+重复、observation prune、entity关联移除、分页document/metadata、fresh与其它bank保留通过；真实async retain→GEToperation(include_payload=false) completed→doc/metadata关联→同operation重复亦通过。原始共源chunk仍存在，非物理擦除。
- 主控批准finite=fact-only精确模式：runtime-config additive `retention_mode=unlimited|fact_only`，Agent受控pinned配置有限模式types固定world/experience、preferObservations=false、不请求derived；caller显式observation/derived options拒绝typed `memory_retention_option_unsupported`，不能假空。Manager强制上游同样请求且只交付可信ledger证明的id/text/type；context/tags/metadata/chunks/entities/source_facts等不外送；返回前依当前时间、当前policy再校验。无限模式不无故缩水。
- retention具体落点 `memory_retention_{repository,service}.py`（新增）、`migrations/0038_memory_retention_jobs.sql`：metadata-only `memory_acceptance`按tenant+employee+bank+immutable document generation键，保存member、operation_id、policy_revision、accepted_at、expires_at、operation_state/terminal_at、claim_owner/until、attempt/next_attempt、cleanup_state/last_error_code；不存内容或raw result。接受记录先写，重试同operation/document保留首次时间；不同正文派生不同immutable document，不再提供upsert覆盖。expired同请求重试拒绝，不刷新TTL。有限模式匹配ledger scope/document+operation+接受revision metadata，不单信上游metadata；当前更短策略与初始deadline取min。
- durable maintenance在Manager已有lifespan链内启动有界5秒tick，thread offload同步HTTP/PG；基础设施只读枚举本表有作业tenant，claim与全部写入仍PgTenantRouter/TenantContext+RLS。每轮至多16docs/每doc100facts，claim有60秒截止、CAS owner、失败指数退避/安全metadata日志。提前poll持久化async completed/failed/cancelled终态，不请求payload；非终态/404 unknown不伪成功、expiry后继续对账。failed/cancelled可能部分写入：保持非可召回，确认终态后同样原生invalidate其可信doc；pending尚在写不能宣告cleanup完成。终态且expired按document_id+state=valid+offset0分批，每项确认native invalidated，列表空只在终态后作为完成；失败/无进展重试，重启claim过期从0恢复，旧claim不得删除新generation。管理text/revert不允许复活已过期ledger事实。
- 部署schema能力校验按已证明0.9.0路径/字段指纹受限read（非真实token/bank内容日志）；未配置/不匹配保持finite503，不引入可任意绕过的enable开关。原始historical unknown来源只允许content-free预检（新增 `memory_retention_preflight.py` 帮助函数/命令，默认无写），真实首次cleanup仍待主控批准且本阶段不执行；不重建bank、不DELETEdocument、不claim硬擦除。
- 扩充验证：`test_memory_retention_service.py`/`test_memory_policy_pg.py` claim/CAS/TTL/可信时间/retry/异步终态/部分写入/restart/新generation；原生fixture新增shared-chunk派生路径与异步metadata真实证据。Agent `resources.test.ts`测试实际pinnedprofile/recall/retain以及finite配置、manual/auto/readonly queue隔离；Web新增MemoryPolicyPanel源命名测试，`experts/types.ts`及drawer serializer省略独立即时memory策略（避免旧drawer保存反向覆盖），明确finite模式能力与non-erasure说明。全部仅本仓代码/fixture改动。
- S04 schema回归fixture新增 `server/tests/manager/fixtures/hindsight_retention_contract.json`：从已验SHA的真实0.9.0 OpenAPI只摘录本阶段recall/retain/list/PATCH/operation/profile路径及相关typed schema，纯公开协议metadata、不含服务secret/企业内容。运行时比较此相同subset的规范化SHA256常量（包含version），60秒内存正缓存；不信任配置提供任意hash作为绕过。
- S04新增主控裁决（native共源chunk反证导致的必要放宽边界）：finite已承诺deadline不能被延长/取消/重试/DELETE再创建复活。新增0038内 `memory_bank_guard` 持久单向guard（tenant/employee/bank；不按member/lease），只有实际employee finite生效/可信接受证据触发，catalog模板不触发。policy写事务先guard已知/可信派生bank再发布finite；首个bank建立前同样持久guard，所有旧/新lease都读当前guard。未来策略可以更长或unlimited，只决定新acceptance期限；已guarded bank始终ledger-proven fact-only（新unlimited facts无expiry仍可读）。不加解除guard/新bank/删chunk入口，未来rich恢复另需治理证明批准。readonly `retention_guarded`由effective source投影/runtime mode传给UI/Agent，调用者不可解除。补finite→longer→unlimited、cleanup未完先放宽、多member旧unlimitedlease、DELETE/recreate/restart、fresh unlimited可读回归。

### S04 同协议恢复：consent/lease兼容子阶段（不关闭全部S04）

- 恢复基线：HEAD仍`5483218edecc35eb3e199d3985c4b0b4dda587a0`，`feat/v1-completion-wave1`；保留主控捕获的129份累计文件，无暂存/发布。只执行主控 `recovery-s04/auto-consent-decision.md`：effective policy/lease/automatic-consent与受控消费者；已存在retention ledger/cleanup/guarded-bank代码保持，不重做镜像探针，不扩写其清理引擎，后续worker负责其完整收口。
- 精确北向合同：既有`POST /api/manager/hindsight/runtime-config` additive请求`client_protocol`，本轮支持常量`aiteam-memory-v1`；这是受控客户端兼容协商，不是客户端身份认证/人类意图证明。missing/unknown只签发当前recall交集的只读lease；retain-only且无可读操作返回409 `hindsight_client_upgrade_required`。响应包含服务器确认的`client_protocol`及当前`explicit_auto_retain`，仅支持协议且当前retain+明确auto授权才为true；旧严格客户端须协调升级，绝不以重发旧无协议写请求降级兼容。
- lease添加性schema沿尚未发布0037增加`client_protocol text NULL`：不把旧行伪造为已支持；旧已scoped lease可继续recall交集，但没有协议证据或positive policy revision一律不能retain。所有memory policy revision变化后旧retain lease403，即使manual操作仍允许；新领取方重新使用当前policy，缺省/非法runtime consent绝不回退snapshot旧true。两份store的issue/reuse/rotate/resolve持久语义对齐。
- 线性化口径：Manager最后一次当前policy revision/active/grant/lease复核（body读取及metadata acceptance准备之后、发起native HTTP之前）为本次write授权围栏。policy commit先于该检查则零native发送；已越过围栏的在途请求可能已被native异步接受，后来撤销或响应403不等于回滚。无自动刷新lease后重放；原operation/document派生与首次accepted_at/expiry不改。
- pinned源码证明：`memory-lifecycle.ts`初始化只GETprofile并启动periodic flush，shutdown也消费`retainQueuePath`；`queue.ts`所有enqueue/coalesce/retry/dead-letter都以configured path为根；`retain.ts`手工写遇既存pending queue会排队而不是仅发送本次。失败不区分401/403，保持原job.id和正文到active/dead queue，SDK不会自己获取新lease。因此仅auto boolean分路径不够：新版使用`consent-v1`命名空间+tenant/member/employee/bank+policy revision+lease ID/version+auto交集派生queue path；换lease（含同revision因expiry/revoke轮换）绝不重新挂旧queue，保留原文件/operation IDs，不改label或默删manual内容。同一有效lease内普通网络失败仍可用SDK原幂等retry。
- 原固定configDir也必须按lease隔离：pinned manual tools会reloadConfig；旧loader读取后来新lease的config会换queue，故`resources.ts`中的生成config和env引用以lease隔离，旧loader shutdown/reload只持自己文件/原token；销毁只删自己生成配置。沿pinned公开配置/原队列实现，不升级SDK/改外部源码/新增kernel或正文store。旧及unknown queue保持暂停；本轮不新增恢复/重放旧队列入口。
- 实际改动路径：`server/manager_service/{schemas_hindsight,routes_hindsight,hindsight_credentials,hindsight_lease_repository,hindsight_facade}.py`、`migrations/0037_memory_policy_lease_scopes.sql`；Agent `src/{manager-client.ts,pi/resources.ts}`；`server/manager_service/README.md`与`server/agent_service/README.md`的协商/撤销/队列兼容说明。必要纯source规范的effective-policy fixture不改retention engine。
- 验证：新增`server/tests/manager/test_hindsight_consent.py`（实际route/schema、legacy/new client、revision/prepare围栏/已发出竞态）；新增`test_hindsight_consent_pg.py`（真实PG两个policy写入口、opaque lease重启/旧列、active/当前grant、无正文持久化）；更新已有`test_hindsight_{credentials,lease_repository,operation_policy}.py`及必要runtime-config route fixture，增加实际OpenAPI字段断言。Agent更新`src/{manager-client.test.ts,pi/resources.test.ts}`、新增`pi/hindsight-consent.test.ts`运行真实pinned extension初始化/manual/auto/context/shutdown与队列retry：snapshot=true/runtime=false、missing/invalid runtime consent、unsupported旧client、pending旧automatic/manual队列、401/403后的new lease、同lease幂等job ID、readonly、fresh manual允许、reload旧loader不借新token/config。仅复用已证明自有`aiteam-s04-fixture`/127.0.0.1:55485及受控空HOME临时文件；不访问其它DB/secret。不将focused通过称作finite cleanup或S04全项验收。

#### S04 consent恢复本地检查点（不是全部S04完成）

- 实现了服务器确认的`aiteam-memory-v1`、当前runtime `explicit_auto_retain`、旧/缺协议证据与stale revision写lease拒绝；readonly与当前新manual lease成功。银行准备等待中若policy/snapshot变化，runtime-config明确拒绝，不返回旧consent。新协议响应必须有positive policy revision+显式operation集合，字段缺失/非法不能恢复写权限或auto true。
- 初始新增consent失败回归9/9失败（原实现缺请求/响应protocol与consent、旧client可得write scope）；实施后focused Manager **86 passed / 0 skipped**，涵盖新consent registered-route 10例、真实PG 4例、原lease/facade/operation/parser/policy单测与S01真实auth-factor/active-member集成。SDK/Agent focused **50 passed / 0 skipped**，包含9个实际pinned生命周期/队列用例、resources/manager-client和session-host受控消费者；Node TypeScript检查通过。没有改测试或安全门为skip/宽松阈值。
- pinned源码及实测确认该queue path控制覆盖startup periodic、manual pending、shutdown、同lease retry；无需新机制。409/422/401/403 runtime协商不自动重发无协议请求。旧auto queue与手工pending完整保留，403后new manual-only lease只发新explicit内容；旧loader reload/shutdown仍用旧token/自身config，不借新key。401/403后即使同policy revision重新得到auto许可也不挂旧queue；同有效lease普通503重试的实际SDK operation_id/body保持不变。无lease loader关闭不清其它lease配置。
- 本次独立库存校验：原超时捕获129文件中115份字节不变，14份属于本恢复明确改动（含plan/README）；另外修改原干净`pi/resources.test.ts`并新增4个文件（Agent README与3份consent测试）。未删除任何捕获文件，`memory_retention_service.py`、`memory_retention_repository.py`、0038及原生probe均保持原hash。`git diff --check`通过；HEAD/branch未变，无暂存/提交/推送/部署。仅复用自有PG `aiteam-s04-fixture` /127.0.0.1:55485，保留给后续验证；无真实数据/凭据/钥匙串/ACL访问。
- 对保留代码做一次不改写的交接验证：`test_memory_policy_pg.py` + `test_memory_retention_service.py` **25 passed / 2 failed**。失败为`test_durable_lease_restart_and_immediate_policy_grant_revoke`仍用无protocol旧请求却期待retain scope；`test_guarded_bank_real_routes_ttl_retry_future_time_and_restart_cleanup`同样无protocol且期待policy更改后旧write lease成功。后续retention测试应明确协商新协议，并在每次策略变化后给新的retain领取current lease，同时保留旧lease的recall/guard验证；**不能放宽当前stale/legacy写拒绝来适配旧断言**。本恢复不修改这些retention用例或其cleanup实现。
- 下一收口范围保持主控裁决：retention ledger/guarded-bank/deadline/async终态/partial cleanup/restart/CAS/management读写/历史unknown预检的完整端到端验证；补未完成Web记忆面板消费者测试与全Manager/Agent/Web回归、OpenAPI完整导出/覆盖棘轮/独审/CI。已独立通过的native0.9.0原语不重跑替代Manager实现验收。历史第一次真实清理仍未批准/未执行；不宣称TTL硬擦除或全部30项完成。恢复证据在本run受控`v1-closure/tmp/{consent-before,python-final,node-final,retention-handoff}.log`及`recovery-delta.json`。

### S04 finite-retention集成收口预检（2026-09-06，仅原编号4/16）

- 基线/branch不变，现有S01–S03及consent恢复实现完整保留，开工字节清单保存于本run受控`tmp/retention-close/before.json`。不stage/commit/push/部署，不重做image身份/原语调查，不升级SDK、不引入正文store；仅复用自有PG `aiteam-s04-fixture` loopback55485及合成HTTP/native证据。
- 具体修复接缝：`server/manager_service/memory_retention_{repository,service}.py` 的async终态持久化必须同job claim owner/截止CAS（不跨doc无条件改写）；failed/cancelled部分结果在终态立即清理（包括新unlimited acceptance），pending/unknown不得清理或猜测完成。终态证明先落库，native错误不丢证明；分页offset0、重启回收claim、部分PATCH/无进展/过期claim/退避均以真实PG回归。`memory_policy_service.py`与尚未发布`migrations/0038_memory_retention_jobs.sql`只补可信finite acceptance的sticky guard证据，不触碰unknown legacy正文；旧deadline只缩不延长，已cleaned不复活。无新迁移编号/北向路径，RLS/表所有权不变。
- `memory_service.py`及`hindsight_facade.py`：management recall/list/update和runtime facade均在外部等待后以当前policy/时间重新围栏，不能在最初unlimited分支后漏出后来finite的数据；guarded响应只有已证明有效fact字段，guarded analytics不返回native全库统计/派生metadata，retain只回传安全confirmed acknowledgment。guarded管理edit/revert使用可信native UUID/ledger和当前deadline，未知/过期不复活。`hindsight_client.py`的maintenance transport落实实际有界stream响应；不得仅读取无限body后检查长度。typed unsupported derived反馈保持既有`memory_retention_option_unsupported`，无新可绕过开关。
- 验证落点：补`test_memory_retention_service.py`、`test_memory_policy_pg.py`并新增`test_memory_retention_pg.py`（复用真实registered-route/PG fixture）、`test_memory_items.py`、`test_hindsight_client.py`；旧retention场景补明确client_protocol并在policy变更后重新领取write lease，仍用旧readonly lease验证sticky guard，绝不放宽consent安全。新增`web/manager/src/features/experts/MemoryPolicyPanel.test.tsx`覆盖立即保存/DELETE后重读/空操作/天数校验/失败无假成功；按真实pinned config/parser补`server/agent_service/src/pi/hindsight-consent.test.ts`的fact-only工具与context消费者/unsupported响应。必要UI错误只修实测失败；更新Manager/Agent README有限能力、历史授权和部署门。
- 顺序：先运行现有focused失败基线；新增故障回归并最小修复→真实PG/registered routes/SDK与UI→全Manager+shared、全Agent、全Web测试/类型/生产build、三端OpenAPI和deploy静态检查。独审/CI/taiyi与真实历史dry-run批准仍属主控后续门；本地假上游与既有native primitive证据分开列，不把它们冒充Manager到taiyi完整部署成功。
- 新的集成证据（不重做image或原语调查）：新增`scripts/verification/s04_hindsight_manager_fixture.py`复用已证明的native初始化/模型double，精确config image `8d1952...`、`--pull=never --network none`启动独立native+pg0，只挂该脚本及受控临时Unix socket目录，不挂repo/home/secret、不开TCP端口。新增`server/tests/manager/test_memory_retention_native.py`通过显式fixture container env及测试专用docker-exec/容器内Unix socket HTTP transport将真实Manager route+独立PG acceptance/claim与native HTTP相连，验证async完成、schema、可信事实、管理edit/list/expiry排除及原生invalidate、放宽后的fresh unlimited。无fixture container时作为显式native gate不执行，专用命令必须实际通过才计本地native集成；CI/部署负责人需复现，不当成taiyi真实bank验收。小探针实证：macOS artifact长路径超过AF_UNIX长度；改短受控tmp后Docker Linux socket仍不能跨宿主kernel连接。故保留`--network none`，不开放TCP/放宽网络，测试transport通过docker exec stdin传输当前fixture请求并在容器内发真实HTTP，响应只在内存，不写body文件。
- 原生集成发现并定位确定合同错误：已pin的`OperationResponse`和实际HTTP200使用`operation_id`（不是`id`）；原retention fake与service同错导致所有真实acceptance永远pending。本收口修`memory_retention_service.py`的严格匹配及两份retention测试fixture，不兼容猜测两种拼写；native gate先失败后必须重新通过。
- 主控额外批准Agent context缓存收口：pinned lifecycle有60秒bank/message-count缓存，positiveInt不接受0，不能靠1ms猜测TTL。`server/agent_service/src/pi/resources.ts`每次context调用新建pinned正式导出的`createRecallTurnPolicy`，复用原lifecycle deps与`{snapshotRuntime,setMemoryStatus,notify}`/setup helper；不改外部包/私有cache，不复制解析渲染。所有controlled lease包括原unlimited均重新向Manager复核。仅WeakSet记录本loader已注入的消息object identity，后续context先排除自身旧注入（不以用户文本/tag猜测删除原消息），失败返回清理后的原context，不回退旧facts/叠加blocks。明确禁用原本lease禁止的mentalModels注入，手工/auto retain及queue不变。新增实际SDK同bank同message-count立即重复、可控到期/403/503/unsupported、fresh成功与保留用户内容回归；合成请求在受控输出中交给Manager实际严格DTO/parser再次验证，不把fake宽松接收当兼容证明。
- 全Manager回归发现的确定整合问题：0037重放无条件去掉新的`retention_guarded`兼容投影，造成S02/S03 no-op migration测试真实版本多涨1；修0037仅比较有效source/revision/policy字段并保留server-owned guard投影（不忽略真实策略变化），新增guarded→unlimited重放前后版本/guard断言。另`test_employee_config_e2e.py`/`test_snapshot_e2e.py`两处旧精确JSON断言同步完整additive policy source/revision/auto/retention字段；`test_repo_employee_config.py`的顺序SQL fake补新的guard SELECT游标，不改repository语义。保留S02/S03原no-op断言作为回归门，不把5个失败一律改成宽松预期。

### S04 finite-retention本地验收记录（仅4/16，待独审/CI/TEST）

- 完成了本阶段retention整合，不再只是原语probe：真实Manager registered routes、独立app_rw/RLS ledger、精确`8d1952...` native HTTP/PG/async retain/curation/recall联通，可信accepted_at不采信2099时间、重试不续期、source-proven fact-only、管理list/edit/过期revert拒绝、原生invalidate及放宽后新unlimited事实成功。新native gate实测先发现并修复`operation_id`错读，修复后独立运行**1 passed**且纳入最终全Manager执行；仅模型/embedding/ranking是double，不是fake native SQL或fakeManager响应。未重做archive/image身份调查或既有原语验证。
- 真实PG+fake-native注入pending/processing/unknown/404、错误operation ID、failed/cancelled部分成功、102条分页中第二PATCH失败、无进展、unknown来源、过期claim、旧owner CAS、跨tenant、重启repository/service、policy在外部等待中变更、短deadline被旧worker覆盖的竞态。terminal proof先持久化且每doc CAS；新failed/cancelled即使unlimited也不永久搁置。source未知永不自动adopt/clean；历史dry-run只输出metadata，未执行真实历史清理。
- Agent额外主控批准的cache修复已通过真实pinned SDK：同bank/同message-count立即重复必发第二次Manager检查；403/503/到期/旧unlimited后来guarded不注入旧标记，保留原用户对象/字面tag文本、新fresh事实只注入一次。manual retain使用Manager精简ack（无items_count且服务operation ID不同于caller ID）仍成功；auto/manual queue、revision/lease isolation及同lease幂等测试保持通过。实际SDK输出的3种合法recall请求和1种derived请求交给真实Manager strict DTO+fact-only parser：**3 accepted + 1 typed unsupported**，不靠fake宽容猜契约。
- 最终全Manager+shared及OpenAPI/deploy静态pytest（包括上述真正native gate）**1571 passed / 11 existing skipped**；11skip为既有deprecated provider/shared条件项，native test未skip。Node Agent全suite **176 passed / 1 existing Linux-native-only skipped**，TypeScript通过。全Web **shared42 + operation182 + agent159 + manager283**通过；四workspace TS均通过，Manager生产build通过，原500kB大chunkwarning保留、不调门。记忆Panel新增5例，严格nullable API response在初次typecheck暴露后改为fail-closed加载错误；无效未保存天数不能阻止DELETE撤销。UI即时保存与drawer不echo旧policy保持。
- 真实三端OpenAPI导出/质量检查均OK；所有实际存在的`deploy/**/*.sh`及verification shell静态语法检查通过。不存在的旧`deploy/ctl.sh`一次验证命令127已记录并纠正为实际文件枚举，未编造成功。Manager上次全suite5失败的根因区分为0037真实重放版本bug、additive DTO旧断言和fake缺cursor；保持S02/S03原no-op/RLS/授权断言，通过最终重跑证明没有为绿灯弱化门。
- 验证运行使用受控空HOME、明确synthetic fixture环境、原自有PG容器（仅将其postgres测试角色设置为新的已知fixture密码，不读取原密码/真实secret），native fixture`--network none`且无host repo/home/secret挂载。macOS UDS长度/kernel差异与空HOME缺Docker context的失败只修fixture transport/明确daemon endpoint，未改OS ACL/keychain/网络隔离或开外网。没有freeze app/externalHermes/SDK/lockfile变更、没有stage/commit/push/merge/deploy。
- 本地累计working diff（含untracked）的changed-line coverage：Manager Python **92%（1427行，110未覆盖）**、Manager Web **99%（307行，3未覆盖）**，两次`diff-cover --fail-under=90`均通过；Web仅在受控LCOV副本规范化SF路径，未改hit。全项目baseline/branch棘轮仍须CI。开工134份已有文件中114份字节保持，20份是明确S04改动，另新增4份测试/fixture文件，没有删除任何prior文件。新的native容器及其socket目录已移除，原自有S04合成PG保留供独审，未触碰其它容器。
- 本地proof日志、coverage、源代码字节清单、真实OpenAPI、synthetic SDK wire请求与累计working diff在本run `v1-closure/tmp/retention-close/`。独立reviewer须读实际累计diff及untracked；全branch CI/覆盖棘轮和taiyi发布归主控。历史第一次真实清理、真实部署schema/worker恢复/失败告警和回退前滚演练仍是release门，不以本地fixture或原生invalidated当物理擦除/全部v1交付。S05及其它30项阶段不在本收口宣称完成。

### S05 开工合同（2026-09-06，仅原编号17/18）

- HEAD/branch仍为`5483218edecc35eb3e199d3985c4b0b4dda587a0`/`feat/v1-completion-wave1`；S01–S04累计未暂存实现按受控`tmp/s05/before.json`保留。不stage/commit/发布，不访问真实数据/凭据或冻结目录。
- Skill精确路径：Manager `schemas.py`、`capability_catalog_{service,repository}.py`、新增`custom_skill_package.py`（复用shared SkillPackage/hash/path校验，有限文本包）、`authorized_config_service.py`；Agent `src/skills.ts`、`src/http/server.ts`以及必要`src/pi/resources.ts`必需技能缺失阻断；Web `features/capability/{CapabilityPage.tsx,types.ts}`。既有POST/PUT路径不变：PUT按字段presence保留metadata及version/files/hash；显式files必须非空含SKILL.md、canonical安全路径、有限size/数量、server-computed hash，提供hash时必须相等；空files只允许创建draft，不能清空可执行包。readonly `package_status=draft|ready|invalid`按实际包派生，旧非法/缺hash行不签发，不把invalid当允许保存危险上传。Operator source与platform-ID仍不可改。
- 主控批准：可分发包同version不同bytes409，同bytes/version重投幂等；新版本也不得复用已知旧version偷偷换包。`0039_knowledge_job_recovery.sql`内追加metadata-only `skill_package_revision(tenant_id,skill_id,version,content_hash)`，RLS/FORCE、同事务序列化catalog更新+revision记录，旧历史只固化可观察的有效hash，不假造丢失历史版本。Agent按当前已选snapshot refs、tenant/member/cache/keyTTL/签名/文件hash及真实pinned Pi loader检查ready/missing/invalid，缺必需技能不再available=true或执行时悄悄省略。
- Job精确路径：`knowledge_intake_{repository,service}.py`、新增`knowledge_intake_recovery.py`、`rag_ingestion.py`（既有1.5.6 text/track/paginated adapter拆出submit与单步reconcile）、`routes_knowledge_intake.py`、`app.py`、上述0039。新上传document+job同一事务，源文件在事务前落盘；job持`claim_owner/lease_until/heartbeat_at/attempts/next_attempt_at/submission_state/file_source/track_id/upstream_document_id/text_chars`，不新增正文store。每次job唯一server-generated file_source，正确workspace内精确匹配；legacy在途无提交证据保守unknown，uploaded/parsing未提交证据才可恢复parse。claim取当前document最新job，SKIP LOCKED/CAS owner+deadline防多进程抢占；每步有界，POST前持久化fence，response后立即持久化track，异步poll不占一个长HTTP请求。ready发布与claim/job/document/bindings同事务，沿S03策略列不复活deny。
- 主控批准未知提交安全例外：POST前fence后crash、POST已发response未落库、旧indexing不推断为未提交。优先track状态；丢track只用unique file_source+完整有界pagination+processed证明对账。pending/processing保护409，已确认terminal失败/parse失败可retry/delete；结果unknown达到有界attempt后document.failed `SUBMISSION_UNKNOWN`但继续退避自动对账，**retry/delete均409且typed output `can_retry/can_delete=false`**，UI显示“需对账”及只读指引，不把列表无行当取消证明，不加force reset/删除后门。不知道上游接受结果时绝不再次POST；重试复用已知安全结果/新durable job与既有operation idempotency。
- 原有BackgroundTask仅低延迟hint，生产lifespan立即恢复并每5秒bounded扫描；admin仅枚举有工作tenant，所有claim/业务写仍TenantContext/RLS。reindex/URL复用同durable处理，真正活跃任务始终409；metadata-onlyjob输出attempt/next-check/error供诊断，不输出凭据或上游正文。Web `features/knowledge/{DocumentsPanel.tsx,types.ts}`消费真实能力字段并继续轮询unknown。
- 先失败/同步测试：新增`test_custom_skill_package.py`、`test_custom_skill_pg.py`和`test_knowledge_intake_recovery.py`/`test_knowledge_intake_recovery_pg.py`；更新现有capability/platform/signing/authorized_config/intake/rag_ingestion suites。真实registered route/service/PG验证事务回滚、并发claims/lease前后/旧ownerCAS、两个tenant、未送BackgroundTask、parse重启、POST前后fence、丢track、metadata延迟/分页/冲突、远端pending→processed、failed/unknown、重复retry零重复索引。fake upstream只mockHTTP边界，先读公开pin源码并小probe；不声称真实taiyi LightRAG验收。Agent `skills.test.ts`/HTTP readiness+resources，Websource-namedtests；最终focused Python/PG/Node/Web/TS/OpenAPI、无暂存证据与剩余门写受控报告。独审/CI/TEST归主控。
- S05协议实证：已只读取公开`HKUDS/LightRAG v1.5.6 document_routes.py`，text路由仅生成server track_id、启动managed indexing后响应；不支持caller提供幂等track id，因此上述submission fence/unknown保护不能省略。pinned Pi0.84.2 `core/skills.js`实际只在非空description时加载SKILL.md。主控批准新增`server/requirements.txt`固定`PyYAML==6.0.3`（无Pi升级）校验custom frontmatter；限制frontmatter8KiB、深度6/节点128、拒绝anchor/alias/merge，description必须string且trim非空，兼容普通/引号/多行/CRLF，Python/Pi有歧义的类型语法拒绝。错误不回显正文。旧不合格包只标invalid，不改字节；使用真实pinned Pi loader对照测试。首次focused检查因缺PyYAML在collection明确失败，未当成功或用自写YAML绕过。
- S05真实回归与根因：原28失败实际为27次old fake在atomic-create新参数处TypeError、1次skill fake把presence的None覆盖成非法枚举；先以新增真实PG10/10证明生产atomic/claim/route路径，再给fake加锁/owner+lease CAS/rollback而非默认成功。同步后7个旧断言差异逐一确认：dispatch外异常不应把未知工作变普通failed；已POST/已processed但publication失败保持受保护对账；删除resolver新增每job唯一source别名。新Node真实HTTP readiness测试另发现**生产SkillCache.reconcile原有versioned refs分支只add到临时Set而未写Map**，因此`review@1`缓存被当未授权清掉。S05范围内修该一行实际cache消费者，保留非versioned/revoked/签名门，新增versioned HTTP+重启回归；不修改fixture来掩盖。Manager全套首次1482pass/2fail/10existing skip，两失败是旧PG HTTP fake上游只实现ingest_text，当前production只调用validate/submit/reconcile，按真实HTTP协议替换该test double，不提供production fallback。
- S05迁移补充完整性：沿S03已有document复合唯一键，在0039加job `(tenant_id,knowledge_space_id,document_id)`→document复合FK（旧不一致数据fail migration，不推断归属/删除），submission_state限定not_submitted/submitted/terminal。旧分步事务可能留下无active job的uploaded/parsing/reindex_requested，0039只补可观察queued行；legacy indexing/INDEX_FAILED可能已提交则保守source=document ID对账，重试多generation相同旧alias不自动认领。已知SUBMISSION_UNKNOWN的failed始终保护并继续claim；重放不清新track/source/fingerprint。
- S05切换按**测试环境维护窗口**执行，不做不停机切换：先停止新的知识导入/控制面写入，完整停止旧 Manager/Operation/Agent 及其测试依赖，确认进程和服务已退出后再替换代码、执行0039、安装依赖并启动新版本。允许短暂停机，现有进行中的上游任务不承诺无缝保活；新版本启动后按持久 fence/track/job 证据对账，未知状态不盲目重POST、不force-delete。生产或需要无停机的环境另行设计，不由本轮测试发布方案承担。
- 新增`server/manager_service/knowledge_intake_preflight.sql`提供pre/post0039兼容的**只读metadata**作业/claim/fence/correlation/版本指纹和unknown计数；不输出文件名、正文、error_message或凭据，不执行修复。`test_knowledge_intake_recovery_pg.py`在本阶段独立合成PG验证只读执行/字段排除/计数，真实清单仍由主控部署授权取得。本阶段代码完成不代表发布门已解除。
- S05 UI复核补充：`DocumentsPanel.tsx`原通用failed citation提示“请重试”、所有409提示“可重试”，会与新unknown保护冲突。按已批准合同对`SUBMISSION_UNKNOWN`/`knowledge_reconciliation_required`给专用需对账提示；并发状态变化导致旧按钮请求409时立即重读文档能力，隐藏重试/删除并继续轮询。补现有`KnowledgePage.test.tsx`源消费者的stale-ready→409→unknown用例；不改变普通busy/503的既有重试语义。

### S05 最后生产者事务恢复合同（同协议恢复，仅atomic reindex）

- 恢复基线仍`5483218edecc35eb3e199d3985c4b0b4dda587a0` / `feat/v1-completion-wave1`，已读主控`recovery-s05/reindex-transaction-decision.md`。原164份累计文件在本run受控`tmp/recovery-before.json`取hash；不重做S01–S04或SDK/native调查，不stage/发布/改部署脚本。
- 仅改`server/manager_service/knowledge_intake_repository.py`的`KnowledgeIngestionJobRepository.prepare_reindex`：一个`PgTenantRouter.session(ctx)`内INSERT幂等operation（现有tenant+operation+key唯一键）、document CAS/stale索引标记、INSERT明确`operation_id`关联job；失败包括CAS失败整笔回滚，不能留下failed/pending孤儿receipt。返回typed preparation（operation/exact linked job/newly_created）。相同key的INSERT竞争在现有唯一键等待后重读同receipt/job；相同key不同fingerprint/document/space拒409。解析、HTTP、claimed delivery在commit之后。
- `knowledge_intake_service.py::_run_reindex`消费此原子结果，去掉先单独commit receipt的窗口。相同key重投不重新执行；已completed receipt即便document后来改变仍保持完成。pending legacy receipt只按精确operation_id找job，缺/冲突关联返回既有409 `knowledge_reconciliation_required`，不按document_id猜代次、不盲重POST。新请求继续执行当前document状态/unknown保护；没有新北向路由、wire字段或迁移（复用0039 operation_id）。已有claim/fence/recovery和S03 deny保持原样。
- 测试落点：新增`server/tests/manager/test_knowledge_reindex_transaction_pg.py`（复用已有受控fixture与真实route/service/PG），覆盖commit前各步骤故障全回滚、commit后丢响应/重启同job恢复、同key并发、不同key CAS败者零孤儿receipt、fingerprint冲突、completed重投遇后来doc改变、legacy pending不误认其它代job、RLS；`test_knowledge_intake_unit.py`的test fake同步原子receipt/job与rollback语义，不加production fallback。必要更新`manager_service/README.md`及只读preflight对无精确关联legacy receipt的说明/诊断。
- 先跑实际旧服务的故障注入失败基线，再最小实现，最后focused真实PG+原intake/e2e/policy回归。前run广测1611+12skip/Node178+1skip/Web286是在最后source edits之前，保留为历史证据而非本次最终验收；本恢复跑受影响checks并精确记录时间/文件hash，独审与最终全量CI归主控。当前简化TEST维护路径已在`deploy/ci/run.sh`落实stop-before-live-code/DDL顺序：先停应用 writers，依赖恢复并确认可用后备份、执行现有迁移，再启动新栈；不接入可选systemd probe。本阶段仍保留已批准发布/回退约束。
- 恢复失败基线已实测：真实service在document CAS后注入Crash，document/job回滚但PG仍有1条pending receipt（`atomic-before.log`），不是mock缺接口。最后响应也改为重读**同key/fingerprint的确切receipt**，不再根据当前document（可能已是另一代）的状态覆盖旧receipt。既有`knowledge_reconciliation_required`错误类在repository定义、service原导入名保留，用于事务内当前unknown/CAS判定；无新错误code。fake同步同一receipt字典与job终结/rollback，证明用真实PG为准。
- 恢复第一次扩大focused：151pass/1fail（新producer 12例通过）；失败是旧startup fixture断言5秒内轮到自身，但同一PG此前多轮测试留下其它fixture的未知作业，8-claim全局预算先消耗旧任务，且各fixture的HTTP double不共享track字典。不是放宽claim/超时的理由：只在`test_knowledge_intake_recovery_pg.py` teardown移除当前自动生成tenant下、已关闭fake上游的测试knowledge rows（TenantContext/RLS），不碰其它fixture/真实资源；最终使用同一自有55486容器中新建`manager_atomic_fixture`独立空库。生产预算/恢复/lease不变，保留5秒event断言。Node focused27、Web focused26与两端TS本次均通过。

### S05 本地聚焦验收与最后事务收口（待独审/最终CI/TEST）

- 最后恢复仅原子reindex生产者/确切receipt响应与相应tests/docs；没有改SDK、S01–S04业务、native调查或部署脚本。新`test_knowledge_reindex_transaction_pg.py` **14个真PG case**证明4处commit前故障全回滚、commit后丢响应同job恢复、同key并发唯一job、不同key在两个receipt均已INSERT后竞争CAS且败者零孤儿、fingerprint/RLS、completed遇后来document变化不重执行、pending/accepted legacy缺失/冲突关联拒绝、same-key未知提交保护后原job恢复。所有外部调用只在commit后，并沿原claim/fence。
- 最终源聚焦Python：2026-09-06 **11:44:03–11:44:40 UTC**，`test_knowledge_reindex_transaction_pg`+intake recovery PG/unit+intake e2e+S03 policy PG+rag_ingestion，**154 passed / 0 skipped**。当前Skill package/catalog/signing/authorized-config聚焦 **80 passed / 0 skipped**；Node skills/resources/HTTP platform **27 passed / 0 skipped**；Manager Web capability/knowledge **26 passed / 0 skipped**，两端TypeScript检查通过。当前三端registered OpenAPI导出/质量检查均OK。没有移除/放宽任何门。
- 本恢复生产diff（只比较主控capture的两份Python文件，archive bytes已核SHA，不混S01–S04/S05之前行）**45个可执行变更行，93%覆盖**，`diff-cover --fail-under=90`通过；第一次纯unified artifact缺git source header导致parser失败，补artifact header后重跑，未改coverage hit数。最终源码仍有既有warning（Starlette TestClient弃用/MCP Pydantic forward ref）；无新skip。旧全Manager/shared **1611+12skip**、Node **178+1skip**、Web **286**均早于最后修改，仅作历史checkpoint，**不冒充最终全量CI**。
- 首次扩大focused的startup失败已通过测试隔离纠正，不修改生产预算：旧自有fixture库有20个其它fixture未知作业，后续单个HTTP double无法拥有它们；在同一自有`aiteam-s05-fixture`（55486）中新建`manager_atomic_fixture`，teardown只用RLS移除各测试生成tenant的knowledge元数据，未触碰原库、55485或真实服务/数据。该fixture库上扩大focused连续通过153、154例，5秒startup event断言保留。
- 更新原编号17/18为已实施/本地聚焦验证；不是30项完成，不是部署验收。独立累计diff review、最终树全量CI，以及后续单独阶段的stop-before-live-code/DDL顺序验证、metadata-only预检、具体TEST停机/恢复批准仍为发布门。未知记录不force-reset；不以旧代码/仅DB回退越过fence。报告：本run受控`v1-closure/recovered-s05-atomic-reindex.md`，详细日志/coverage/OpenAPI与source hash清单位于同目录`tmp/`。无stage/commit/push/merge/deploy。
- 最终树复核（2026-09-06 13:18 UTC之后）：先在复用的非隔离 `manager_fixture` 上运行单个原子PG故障用例，因该环境已有残留receipt状态出现1条非空断言红；该结果不作为证据，也未通过放宽生产语义处理。随后在新建、仅含合成数据的 `manager_atomic_fixture`（本机55487、自有PostgreSQL容器）上用当前源码重跑同一真实Manager/RLS fixture，原子reindex/恢复/intake/policy/rag套件为 **154 passed / 0 skipped**；Agent技能/资源/HTTP为 **27 passed / 0 skipped**；Manager capability/knowledge Web为 **26 passed**，Agent与Manager Web `tsc --noEmit`均通过。结果确认producer bytes仍为已核验的 `knowledge_intake_repository.py`/`knowledge_intake_service.py`，未新增source fallback/default success；非隔离环境红例属于测试环境状态污染，不能替代隔离PG证据。

### Wave1 repair pass validation record（2026-09-06）

- 修复后 Manager 非 integration 套件（排除仓内已有 async-mark 且环境无 async plugin 的单个 `test_lifespan_runs_threaded_maintenance_and_stops_without_dropping_claims`）为 **1333 passed / 9 skipped**；完整命令和环境缺口写入 repair findings，不把 integration skip当绿灯。
- 修复后 Agent `pnpm --dir server/agent_service check` 通过；全 Agent `pnpm --dir server/agent_service test` 为 **179 passed / 1 skipped**；Manager Web `typecheck`通过，Vitest **287 passed / 42 files**。
- 受影响真实 PG tests在本环境因 `ADMIN_DB_URL` 未配置而 **4 skipped**（`test_knowledge_policy_pg` compatibility tombstone、legacy duplicate recovery、recruit audience validation、0039 malformed files replay）；生产代码未添加测试绕过。静态 migration guard、fake/service/registered-route regressions已通过。
- 未执行 CI、taiyi、native Windows、真实Hindsight/LightRAG、真实企业数据/secret或发布；无stage/commit/push/deploy。后续发布必须在合成PostgreSQL fixture补跑上述4个PG case，并独立复核当前累计working-tree diff。

### S05 测试环境发布切换方案（简化版）

- 本轮 taiyi 是测试环境，接受维护窗口和短暂停机；不做不停机切换、不做主进程冻结、不做复杂 cgroup 保活。现有旧 Manager、Operation、Agent 和测试依赖统一停止，确认服务退出后再更新代码和执行迁移。
- 发布顺序：停止新知识导入和控制面写入 → 停止 Manager/Operation/Agent 应用进程；测试 PostgreSQL/NewAPI 可先停止旧应用依赖，但执行备份和迁移前必须按受控命令重新启动依赖并保持应用停止 → 确认持久化数据卷仍存在 → checkout/安装当前精确代码 → 运行备份、0039及其它迁移 → 启动新三端 → 对未完成知识任务按 fence/track/job 对账。未知状态进入 needs-reconciliation，不能盲目重POST、force-delete 或假装成功。
- 这是测试环境完整停应用、短暂停机的简单发布，不做不停机切换；依赖服务在备份/DDL阶段必须可用。生产环境或要求零停机时，再单独设计分批/不停机切换，不作为本轮 taiyi 验收内容。
- 已提交的 `deploy/ci/stop_legacy_unit.py`、`scripts/verification/s05_systemd_cutover_probe.py`、`.github/workflows/s05-cutover-probe.yml`、`server/tests/app/test_stop_legacy_unit.py` 仅作为候选安全实验和回归，不接入正式 `deploy-main.yml`，不再作为 taiyi 发布的前置条件。首次 hosted probe 曾安全拒绝空 systemd 属性，后续修复后的原生重跑不是本轮必须等待的测试环境发布门。
- 测试发布仍必须保留数据库/依赖持久化卷、备份、迁移重放和启动后健康/OpenAPI 检查；不能用删除容器或重建空库代替更新。发布失败保持停止状态，按日志和 migration/上游状态人工对账后再决定前滚或回退。

### Wave1 repair pass（2026-09-06，独立审查八项根因修复）

- 主控确认 #1 绑定源：新增 `MANAGER_TENANT_ID`，Settings 严格规范化 UUID；Manager 实际 verifier/auth service 使用该单一绑定。绑定存在时 resolve-tenant、账号解析、login、owner-reset、JWKS、F01/F02 tenant 入口及启动知识空间初始化只接受该 tenant；绑定缺失/不一致 fail-closed（`manager_binding_required` / `manager_binding_mismatch`），不扫描或猜测 tenant_registry。healthz 仍存活，readyz 在缺绑定/未验证时503；密码链不依赖 `MANAGER_PUBLIC_ORIGIN`，Passkey origin错误只影响Passkey能力。
- #2：`SnapshotService.ensure_runnable`成为直接 Manager memory recall/retain 的前置生命周期门；management list/update/delete 仍显式 `owner|enterprise_admin` 门，管理接口不借此放宽 runtime grant/policy。
- #3：兼容 `ExpertKnowledgeBinding` bind/unbind 改走 `EmployeeKnowledgeBindingRepository` 的统一 tombstone/revision/actor/time 语义；显式enable清除旧 revoke，索引 ready/stale/revoked 状态写入不触碰策略列。
- #4：Agent resource loader 改用既有 `skillRefsForSnapshot`，当前 `skills` 优先、legacy `skill_refs` fallback；实际签名缓存/Key TTL/Pi loader缺包继续阻断readiness与execution，不静默省略。
- #5：Recovery 对 `file_source=document_id` 的legacy job在 `not_submitted` 也先检查同文档 generation；generation不唯一时写 `SUBMISSION_UNKNOWN` protected reconciliation state，零POST/零reconcile，继续有界claim供对账。
- #6：RecruitService production builder注入 tenant-scoped MemberDeptRepository，recruit/apply在任何持久化前验证 department/member subjects；solution publication继续单事务保护 reused employee/audience rollback，保留现有 audience union/explicit replacement语义。
- #7：0039 skill revision backfill先判断 `jsonb_typeof(files)='array'` 再调用 `jsonb_array_length`；scalar/object legacy files行原样留存，可由 `package_status=invalid` inspect，不cast、不删。
- #8：direct Manager memory schemas/routes加入 employee/memory/query/offset bounded limits、metadata JSON byte bound和256KiB content-length gate；字段超限为422，body过大为typed 413 `request_too_large`，限制均在Hindsight service调用前，统一错误体不回显请求正文/上游响应。
- 本修复新增/更新回归：bound Manager auth registered-route/service + startup/ready checks；memory inactive/runnable and body/query limit negative tests；compat binding PG tombstone/re-enable/indexing separation；Agent canonical/legacy skills loader/readiness; legacy duplicate-generation not_submitted recovery PG; recruit invalid audience route/service and rollback; malformed `skill_catalog.files` migration replay；direct memory typed 422/413/no-backend-I/O。Focused commands/results写入本轮 repair findings，不把未运行的PG/native/TEST证据标绿。

### Wave1 final independent-review fix pass preflight（2026-09-06，当前工作树）

- 基线与边界：当前 branch `feat/v1-completion-wave1`，HEAD `e5a29890`（基线 `5483218e`）；保留所有 S01–S05 staged-free/unstaged/untracked WIP，不 reset/clean，不 stage/commit/push/deploy。仅收口最终 Wave1 review 的 A–H：Manager 单企业绑定/维护/lease、Agent canonical skills/readiness、legacy JSONB、direct memory receive bound、RAG compatibility binding、recruit audience/skill package transaction、knowledge unknown-job UI、OpenAPI/client/docs；不扩大到 Wave2+。
- 已定位的生产接缝：`routes_in_app_notification.py`、`app.py`/`knowledge_intake_recovery.py`/`memory_retention_service.py`、`hindsight_facade.py`；`skills.ts`/`http/server.ts`/`pi/resources.ts`/`pi/session-host.ts`；`authorized_config_service.py`/`capability_catalog_repository.py`/`migrations/0039_knowledge_job_recovery.sql`；`routes_memory_items.py`/`memory_service.py`；`employee_bindings_{repositories,services}.py`/`rag_mcp.py`；`recruit_service.py`/`recruit_transaction.py`/`platform_skill_service.py`；knowledge UI, shared OpenAPI and Manager memory hook/types.
- Contract anchors: exact deployment tenant is `MANAGER_TENANT_ID` and unbound Manager maintenance is fail-closed; canonical `skills` is presence-aware (`[]` is authoritative; malformed present arrays reject); legacy scalar/object `files` remain inspectable and migration JSONB calls are CASE-safe; direct memory raw receive is bounded before parsing while Pydantic 422/typed 413 and privacy remain; compatibility bind/unbind is typed 404/422 and one enterprise transactionally linearized; audience IDs are UUID + current-tenant subjects before publication, platform skill bytes are validated outside but installed inside the atomic publication, and unknown knowledge submissions remain protected/non-retryable until reconciliation.
- Validation targets: focused Manager/Agent/Web tests plus `scripts/check-openapi.sh`; run four affected PostgreSQL cases when `ADMIN_DB_URL` supports them, otherwise record each explicit skip. Final TEST paragraph must say application writers/Manager/Operation/Agent stop first, PostgreSQL/NewAPI are started before backup/DDL while apps remain stopped, migration then new-stack start; mention baseline `5483218e` versus current uncommitted `e5a29890`. No production fallback or API weakening.

### Wave1 final independent-review fix pass execution record (2026-09-06 17:49 UTC, worker fix3)

- Current execution baseline is branch `feat/v1-completion-wave1`, HEAD `e5a29890`, base `5483218e`; all existing unstaged/untracked S01–S05 and repair-pass changes remain in place. This pass is limited to the seven approved security/data seams in the task: Manager tenant binding on notification/recovery/retention/Hindsight paths; one presence-aware Agent skills helper and signing-key precedence; malformed legacy `skill_catalog.files` preservation plus CASE-safe 0039 replay; pre-parse direct-memory body bounding; atomic compatibility employee knowledge bind/unbind; UUID/tenant-safe recruit publication with no remote fetch under open transaction; and protected unknown knowledge-submission controls.
- Planned source/test consumers are the already located seams in `server/manager_service/{app,routes_in_app_notification,knowledge_intake_recovery,memory_retention_service,hindsight_facade,employee_bindings_{repositories,services},routes_employee_bindings,rag_mcp,recruit_service,recruit_transaction,platform_skill_service,authorized_config_service,capability_catalog_repository,routes_memory_items,memory_service}.py`, `server/manager_service/migrations/0039_knowledge_job_recovery.sql`, `server/shared/contracts/snapshot.py`, Agent `src/{skills,http/server,pi/resources,pi/session-host}.ts`, and the corresponding existing source-named Manager/Agent/Web/PG tests. No new migration/API family is planned; any existing 0039 change remains replay-safe and additive.
- Required failure coverage before implementation review: notification/startup/maintenance/Hindsight unbound and mismatched tenant fail closed while health lives; `skills` present including `[]` suppresses legacy refs and malformed entries reject across normalize/resources/system prompt/group context; scalar/object files survive row/projection and replay; chunked body over-cap yields typed 413 before JSON decode while field overlimits remain 422; bind/unbind/re-enable/indexing race preserves tombstone/revision; bad UUID/foreign-tenant audience and publication-fetch failure leave no rows; `SUBMISSION_UNKNOWN` remains visible and non-retryable/non-deletable. Run focused Python/PG/Node/Web and OpenAPI checks, record environment skips/failures without changing expectations or weakening gates. No stage/commit/push/deploy.

### Wave1 final independent-review fix pass implementation record (2026-09-06 18:10 UTC)

- Implemented production binding checks at the notification service boundary and recovery route/service boundary; recovery lifespan now passes the explicit configured tenant, rejects missing/mismatched service bindings before claim, and remains a caught maintenance failure while `/healthz` stays independent. Hindsight already rejects missing/rebound tenant before opaque lease resolution; retention maintenance remains a bound-tenant no-op on missing/mismatch.
- Centralized existing `skillRefsForSnapshot` use across Manager normalization, resource loading, system/group context and readiness, and fixed sync verification so an explicitly present `skill_signing_keys=[]` overrides env/cache instead of reviving keys. Updated Agent OpenAPI/shared snapshot descriptions/examples and added signing precedence regression. Legacy files now remain raw through repository and authorized projections, `package_status=invalid`; 0039 uses an argument-safe CASE expression and replay assertions remain metadata-only.
- Compatibility knowledge bind/unbind now uses atomic insert-on-conflict plus row-lock transitions, explicit false creates/retains tombstones, explicit true clears revocation, revision/actor/time remain server-owned, and direct retry rejects `SUBMISSION_UNKNOWN` before reindex. Recruit audience validation returns canonical UUID subjects used for publication and transaction writes; prepared platform package bytes are fetched/validated before the transaction and only installed in its rollback scope. Unknown UI/backend controls remain protected and visible.
- Verification at this record: Manager suite `1385 passed / 160 skipped`; Agent suite `180 passed / 1 skipped`, `pnpm --dir server/agent_service check`; Manager Web `286 passed / 42 files`, `pnpm --dir web/manager typecheck`; three-tier OpenAPI `scripts/check-openapi.sh` passed. Focused preflight/negative suites also passed (latest selected Manager `140 passed / 9 skipped`; raw skill/route/recovery selected `181 passed / 9 skipped` before the full Manager run). No `ADMIN_DB_URL`/`DB_URL` was configured, so synthetic PG cases remained skipped; no CI/taiyi/native Windows/real secret/data/Hermes execution. `git diff --check` passed and no files are staged.

### Wave1 final contract/UI/release closeout preflight (2026-09-06, current worker)

- Current source baseline is branch `feat/v1-completion-wave1`, HEAD `e5a29890`, base `5483218e`; all prior S01–S05 and repair-pass unstaged/untracked work remains in place. This pass is limited to final review findings: Manager auth/ready OpenAPI responses; bounded direct-memory contracts and truthful examples; Manager memory Web employee scope/create/ack alignment; Hindsight native list type/fact compatibility and fixture; facade lease runbook/runtime OpenAPI synchronization; simple TEST maintenance ordering and baseline labeling; and S05 unknown-job UI/status wording. No API family, migration, dependency, or deploy-main probe expansion is planned.
- Exact source seams before implementation: Manager route modules under `server/manager_service/routes_*.py`, `server/shared/app_factory.py`/`shared/openapi.py` and OpenAPI quality tests; `routes_memory_items.py`/`memory_service.py` plus `web/manager/src/features/memory-items/{useMemoryApi.ts,types.ts,__tests__/useMemoryApi.test.tsx}`; `memory_retention_service.py`/`hindsight_client.py` and native retention fixture/tests; `docs/部署运维/Hindsight-Manager-facade-lease.md`, `server/manager_service/README.md`, `server/agent_service/README.md`, and runtime contract routes; `docs/superpowers/plans/2026-09-06-v1-completeness-closure.md`, `deploy/ci/README.md`, `deploy/docker/README.md`, and `.github/workflows/deploy-main.yml` only as needed to prove the simple maintenance path remains unhooked from optional probes.
- Required failure-first checks are: each Manager auth operation that can return `principal_inactive`, `password_reset_required`, or `password_expired` declares a 403 example; unbound Manager `/readyz` declares 503; direct memory POST/PATCH rejects over-limit bodies before decoding and exposes 413 plus metadata/body bounds; state examples and nonempty fields validate; knowledge binding examples use bounded nonempty synthetic config and recruit audience examples are UUIDs; scoped Web memory methods require `employee_id` and consume the actual async acknowledgement; native list mapping handles `ListMemoryUnitsResponse.type` and `fact_type` safely; runtime/lease docs and OpenAPI agree on `aiteam-memory-v1`, exact recall/retain allowlist, policy revision, `unlimited|fact_only`, and upgrade/read-only behavior; TEST docs stop app writers before dependency backup/DDL and distinguish base `5483218e` from current uncommitted `e5a29890`; unknown submissions remain non-retryable while ordinary failed jobs retain retry behavior. No tests/gates are weakened and no optional systemd probe is connected to deploy-main.

### Wave1 final contract/UI/release closeout execution record (2026-09-06 19:13 UTC)

- Source timing: this worker read the active plan/current generated OpenAPI before implementation, began from branch `feat/v1-completion-wave1` at HEAD `e5a298905c474dfb8af7e6139ec74c68a98ec538` (base `5483218e`), and finished local verification at `2026-09-06T19:13:16Z`; HEAD/branch stayed unchanged and no files were staged.
- Production/docs changes are limited to shared Manager OpenAPI auth/readiness/error enrichment and truthful memory/Hindsight examples; bounded Manager memory receive/body schemas plus strict async write acknowledgment; native `type`/legacy `fact_type` and bounded text/source projection; Web Manager employee-scoped memory hook/types and S05 unknown-operation wording; Hindsight Manager/Agent/runbook contract synchronization; and simple TEST stop/dependency/backup/DDL/migrate/start ordering. `deploy-main.yml` remains free of the optional systemd probe.
- Latest validation: Manager Python `1391 passed / 160 skipped` (19:11:45–19:12:12 UTC); Agent `pnpm check` plus `181 tests, 180 passed / 1 skipped` (19:12:27–19:12:50 UTC); Manager Web `287 passed / 42 files` plus typecheck (19:10:49–19:10:56 UTC); all Web workspace typechecks (19:11:10–19:11:12 UTC); Manager production build (19:13:04–19:13:06 UTC); OpenAPI export/check for operation, manager and agent all OK (19:11:22–19:11:25 UTC); deployment shell/Compose/static checks OK (19:11:34 UTC); `git diff --check` and no-staged-files check OK (19:13:16 UTC).
- Environment boundaries: no `ADMIN_DB_URL`/`DB_URL` was configured for this worker, so PG/native integration cases remain explicit skips; no CI, taiyi, native Windows, real Hindsight/LightRAG, real credentials/data, frozen `app/`, or external Hermes execution occurred. Existing warnings and the one platform-gated Agent native skip remain unchanged; no test/gate was weakened. Independent cumulative-diff review, CI, TEST maintenance execution, native evidence and historical cleanup approval remain parent/release-owner gates.
