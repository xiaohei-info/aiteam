---
created: 2026-08-25
status: active
scope: operator-manager-agent-solution-group-chat
---

# Pi 原生行业解决方案 → 多 Session 群聊实施计划

## 1. 目标与边界

将 Operator 行业方案模板、Manager 方案应用/授权、Agent 方案群聊收敛为一条可运行链路：

- Operator 只定义固定版本的专家团队蓝图：专家模板、协调专家、协作说明、可选方案工作流 Skill；
- 不在 Operator 方案中填写租户知识 ID、普通专家技能、成员/部门授权或 planner/subtask/aggregate Prompt；
- Manager 将方案包展开为 tenant 内员工实例和 `solution_instance`，解析固定 `coordinator_employee_id`，在应用时由企业管理员选择成员/部门授权，并可绑定本租户知识空间；
- Agent 将已授权方案同步为本地只读投影；一个群聊 Conversation 对应一组固定的 participant Pi Session，创建新群聊才创建新的一组 Session；
- 普通群聊语义：不 `@` 路由到 coordinator；`@` 一个或多个成员直接路由到其固定 Session；不通过 coordinator 转发用户的显式 `@`；
- 用户 `prompt` 与 coordinator 的 `mention_employee` 统一进入同一个本地 `GroupMessageDeliveryService`，所有目标均使用固定 participant Session；
- 单聊与群聊共享 Conversation、Pi entry、SSE、历史、abort、幂等和前端 ChatWorkspace 机制。

不在本轮做：跨用户群聊、云端执行、旧 Run/Task/Loop/DAG、临时 child Session、CLI 作为 Agent 协作主入口、完整方案版本升级向导、生产数据迁移。

## 2. 关键契约

### 2.1 Operator SolutionTemplate

保留：

- `solution_id/version/display_name/description/icon/tags`；
- 有序且固定版本的 `expert_template_refs`；
- `coordinator_template_ref`；
- 可选 `coordinator_instructions`、`workflow_skill_ref`、`output_requirements`。

删除运行时无消费者或越权的字段：

- `knowledge_refs`；
- 通用裸 `skill_refs`；
- `planner_prompt/subtask_prompt/aggregate_prompt`；
- `default_grants`；
- 方案内 `enabled/sequence_no` 双源配置（保留最小有序专家数组）。

迁移兼容策略：新 API 不再接受旧字段；旧测试 fixture 迁移到新 payload。当前无正式数据时直接重置测试目录；若后续发现需保留数据，再单独做一次性离线映射。

### 2.2 Manager SolutionInstance

保存方案落地关系，而非重复能力配置：

- source solution/version；
- ordered `expert_employee_ids`；
- `coordinator_employee_id`；
- 可选协作说明/工作流 Skill/output requirements；
- status/config_version/audit。

员工的 persona/model/tools/skills/memory/knowledge 仍只来自各自 employee config/snapshot；知识关系使用现有 tenant-scoped binding；授权使用 member_grant。

### 2.3 Agent participant sessions

新增本地 SQLite 元数据：

- `conversation_participant_session(conversation_id, employee_id, role, session_file, workspace, employee_version, pi_session_id, created_at)`；
- 必要时增加 `conversation_entry_ref` 仅保存多 Session entry 的顺序/归属/逻辑消息 ID，不复制正文。

单聊使用一条 participant；群聊使用 roster 中每个员工一条持久 participant Pi Session。删除临时 `SessionManager.inMemory()` child 作为群聊协作主链。

## 3. 分阶段实施

### Phase 0：契约与 schema

1. 更新 Operator Pydantic/TypeScript schema、catalog service、跨端 `SolutionPackage`；
2. 新增 Manager solution/coordinator 字段和 migration，更新 apply 输出、authorized-config 投影；
3. 增加 Agent projection 类型；
4. 为旧字段建立明确删除测试，确保 docs/API/UI 不再暴露旧 planner/knowledge/default-grants 字段；
5. 更新正式设计文档 F07、Pi-native 群聊章节和本计划引用。

验收：Python schema/service tests、Manager solution apply tests、Agent TypeScript。

### Phase 1：Manager application pipeline

1. Operator 发布/拉取方案时校验所有专家固定版本、协调专家属于 roster、workflow Skill 若有则是已发布固定版本；
2. Manager apply 在单事务/幂等边界内创建员工、source-template→employee 映射、coordinator employee、solution instance 和 grants；
3. 移除方案知识/裸 Skill 拼接到 employee；
4. 预留/实现方案应用时本 tenant 知识绑定入口（首期可要求应用前/应用后通过现有专家知识绑定接口完成）；
5. authorized config 只返回 roster/coordinator/solution metadata，不返回旧 planner/knowledge/skill 方案字段；
6. Manager UI 从“一键 apply”改为展示应用配置（成员/部门授权、协调专家/知识绑定状态），不让用户填写 JSON。

验收：应用方案创建完整员工、授权裁剪、跨 tenant/member/revoke negative tests、重复 apply 不产生半成品。

### Phase 2：Agent fixed participant sessions + unified delivery

1. SQLite 增加 participant session 表与 migration；
2. `SessionHost` 抽出统一 `GroupMessageDeliveryService`/participant session registry；
3. conversation create 对 group solution 根据本地 authorized solution projection 固化 roster/coordinator，并为所有 participant 创建/保存固定 Session；
4. `/prompt` 按 `mentions` 直接选择目标 participant session；无 mention 选择 coordinator；
5. 新增 `mention_employee` custom tool，仅 coordinator 可用，工具闭包绑定当前 conversation/source employee，直接调用同一 delivery service；
6. Agent-to-agent message 保存 source/target/parent logical message metadata；不再创建临时 child Session；
7. 保持每 participant 单写锁、根 prompt 幂等、目标集合完成/unknown 语义、abort 取消全部目标；
8. 注入有界群聊共享上下文，不复制所有正文到其它 Session；
9. 多 participant SSE 聚合并加 source employee metadata；entries/history 合并时去重 logical user message。

验收：无 @、单 @、多 @、协调者工具 @、固定 Session 重开、并发、abort、撤权和重启恢复。

### Phase 3：统一 Agent 前端

1. `ConversationList`/`useChatApi`/`TimelineView`/SSE/entries 继续共用；
2. 提取/复用单聊 `MessageComposer`，群聊不再维护独立 MentionComposer 提交路径；
3. 方案群聊新建只提交 `solution_instance_id`，浏览器不提交 coordinator/roster；
4. 群聊新建另一会话创建全新的 participant Session 集合；
5. 群聊历史按 solution instance 分组、同一 Conversation 可回到统一 timeline；
6. Timeline 展示 source actor，折叠底层 tool call/result，避免重复展示；
7. 补齐附件、abort、schedule、state、unknown receipt、loading/error/empty 与单聊一致性。

验收：Agent web typecheck/unit/build，真实 Playwright 群聊 workflow。

### Phase 4：文档、删除与三端 E2E

1. 更新 canonical v1 F07/D16/D19 与 Pi-native spec/addendum；
2. 删除旧 Operation/Manager/Agent planner/knowledge/skill/default-grants 运行引用、旧 migration 新建路径和无效测试；
3. 保留历史迁移说明但不让新运行时读取旧字段；
4. 三端 E2E：Operator create/publish → Manager apply/authorize/bind → Agent sync → group create → no @/single @/multi @ → Agent coordination mention → history/new conversation/restart/abort/revoke；
5. 验收不上传会话正文/child session 过程到 Manager/Operator，技能签名、RAG 授权、tenant/member 隔离仍 fail-closed。

## 4. 文件范围

### Operator

- `server/operation_service/catalog_schemas.py`
- `server/operation_service/catalog_service.py`
- `server/shared/contracts/crosstier.py`
- `web/operation/src/features/catalog/{types,useCatalogApi,CatalogDetailPage}.ts*`
- `web/operation/src/features/catalog/register/{RegisterForm,SolutionTemplateFields,TeamMemberSelector,validation}.tsx/ts`
- 对应 tests/migrations

### Manager

- `server/manager_service/{schemas,recruit_service,recruit_repository,authorized_config_service,snapshot_service}.py`
- `server/manager_service/routes_recruit.py` 与知识绑定入口
- 新 migration
- `web/manager/src/features/solutions/*`、experts/知识绑定相关页面
- 对应 tests

### Agent

- `server/agent_service/src/storage/sqlite.ts`
- `server/agent_service/src/pi/session-host.ts`
- `server/agent_service/src/tools/{delegate,mention}.ts`
- `server/agent_service/src/http/server.ts`
- `server/agent_service/src/manager-client.ts`
- `server/agent_service/src/pi/event-sse.ts`/group context helper
- `web/agent/src/features/chat/*`、`group/*`
- 对应 tests

### Documentation

- `docs/v1正式版本/技术设计/概要设计/05-通信架构与跨端契约.md`
- `docs/v1正式版本/技术设计/概要设计/06-AgentGateway与运行时接入.md`（Pi-native addendum alignment）
- `docs/superpowers/specs/2026-08-17-pi-coding-agent-sdk-agent架构重构设计.md` 或新增 active addendum
- 本计划

## 5. 约束与非目标

- 单写者：并行子 Agent 只能在隔离 worktree 写不同线；主工作树有未提交的其他 branch 变更时不覆盖；
- 不修改冻结 `app/`；不恢复 Python Agent/Gateway、多 runtime、Run/Task/Loop/DAG；
- 不把 Pi custom tool 当作安全边界；目标 roster、tenant/member/snapshot 每次执行均由宿主校验；
- 不使用 CLI 作为生产协作主路径；CLI 若需要只做后置测试/运维适配；
- 任何跨端正文传输必须符合本地优先/Manager RAG/Hindsight 明确例外；
- 失败必须补回归测试；每个阶段独立运行 Python、Agent、web 和最小 E2E 验证。

## 6. 完成标准

- Operator/Manager/Agent 契约和 UI 不再暴露无效旧方案字段；
- 方案应用产生完整、可授权、可重现的 solution instance；
- 一个群聊 Conversation 对应固定 participant Pi Session 集合；
- 用户 @ 与 coordinator `mention_employee` 走同一 delivery service；
- 无 @、单 @、多 @、历史/新建/重启/abort/revoke 语义稳定；
- 单聊和群聊共享 API、SSE、entries、幂等和 Composer/Timeline；
- 自动化测试和 taiyi 三端 E2E 提供证据；
- 旧执行/配置路径删除或明确成为不可运行的历史迁移内容。
