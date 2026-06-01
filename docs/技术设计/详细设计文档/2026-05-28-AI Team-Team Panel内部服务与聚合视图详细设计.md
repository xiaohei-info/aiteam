---
created: 2026-05-28
updated: 2026-05-28
status: ready-for-development-review
stage: detailed-design
tags: [project, aiteam, technical-design, detailed-design, team-panel, internal-service, aggregate-views]
canonical_name: 2026-05-28-AI Team-Team Panel内部服务与聚合视图详细设计
source_docs:
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-27-AI Team-Team Panel与Agent Gateway详细设计方案.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/详细设计文档/2026-05-27-AI Team-Team Panel领域模型与数据架构详细设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/详细设计文档/2026-05-27-AI Team-Agent Gateway运行时适配与事件流详细设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/详细设计文档/2026-05-27-AI Team-会话群聊编排Loop核心流程详细设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/详细设计文档/2026-05-27-AI Team-前端页面与接口契约详细设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md
  - /home/ubuntu/code/aiteam/app
---

# AI Team Team Panel 内部服务与聚合视图详细设计

## 1. 文档目标

本文补齐 Team Panel 在当前详细设计体系中尚未完全展开的一层：**控制面后端内部如何组织、关键写路径如何落事务、页面读取所需聚合视图如何构建、权限与对账如何落到具体服务模块**。

本文不重复 sibling 文档已经定稿的内容：

- 业务对象、表结构、主状态枚举：以《Team Panel领域模型与数据架构详细设计》为准。
- 浏览器原生群聊 / 编排 / Loop 的完整业务时序：以《会话群聊编排Loop核心流程详细设计》为准。
- 北向 API 路径、页面路由、SSE 消费契约：以《前端页面与接口契约详细设计》为准。
- Group Conversation Ingress、RuntimeHandle、事件水合、补拉与恢复：以《Agent Gateway运行时适配与事件流详细设计》为准。
- 时间线事件、numeric cursor、角色口径、北向契约最小集合：以《共享运行口径定稿版》为准。

本文要回答的实现问题只有五类：

1. Team Panel 后端代码按什么模块边界落地。
2. 关键写路径如何划分事务、幂等与补偿。
3. 关键读路径如何组装为前端真正消费的聚合视图。
4. 权限校验、事件入库、读侧刷新分别落在哪一层。
5. 在 `Agent Service` 当前代码目录 `/home/ubuntu/code/aiteam/app` 中建议如何组织目录与实现顺序。

---

## 2. 边界与职责

### 2.1 Team Panel 在实现层的角色

Team Panel 是 AI Team 的**业务控制面后端**。在实现上它负责：

- 接收浏览器北向请求。
- 校验租户、成员、员工、会话、连接器与页面级权限。
- 维护控制面主对象：`enterprise`、`employee`、`conversation`、`team_run`、`team_task`、`scheduled_job`、`runtime_binding`、`run_event`。
- 把“业务请求”转成 Gateway 可消费的内部适配请求。
- 把事件与规范化表重组为页面可消费的聚合视图。

Team Panel **不负责**：

- 直接执行 Runtime 内部会话循环。
- 直接解释 kanban 内部 schema 作为产品北向对象。
- 直接把浏览器请求下沉为 Hermes 原生 session/chat 私有接口。

### 2.2 三层内部职责分离

Team Panel 在代码上必须分成三类职责，而不是全部堆在 router：

1. **命令侧服务**：处理创建/修改/停用/提交类请求。
2. **查询侧聚合服务**：返回页面所需聚合视图与只读结果。
3. **运行回流服务**：消费 Gateway / Runtime 回流事件，修正控制面镜像状态。

### 2.3 术语约定

本文统一使用以下中文口径：

- **聚合视图**：面向页面/接口消费的组合结果。
- **展示态**：由主状态 + 最新 run + 最新事件计算出来的页面状态。
- **读模型**：若某个页面需要稳定查询结构、缓存或预聚合结果，可在实现层建立的查询侧结果模型。

说明：共享口径文档中的历史相关表述，在本文实现语境下统一改写为“展示态”。本文不再新增这类硬翻译术语。

---

## 3. 推荐项目落点与分层结构

### 3.1 推荐目录结构

```text
app/
├── team-panel/
│   ├── api_team/
│   │   ├── router_team.py                 # /api/team/* 入口聚合挂接
│   │   ├── router_enterprise_admin.py     # /api/enterprise-admin/*
│   │   └── router_system_admin.py         # /api/system-admin/*
│   ├── application/
│   │   ├── commands/
│   │   │   ├── recruitment_service.py
│   │   │   ├── conversation_service.py
│   │   │   ├── run_command_service.py
│   │   │   ├── orchestration_service.py
│   │   │   ├── scheduled_job_service.py
│   │   │   ├── employee_admin_service.py
│   │   │   └── connector_grant_service.py
│   │   ├── queries/
│   │   │   ├── workbench_view_service.py
│   │   │   ├── conversation_view_service.py
│   │   │   ├── office_view_service.py
│   │   │   ├── employee_admin_view_service.py
│   │   │   └── billing_view_service.py
│   │   └── policies/
│   │       ├── permission_service.py
│   │       ├── route_decision_service.py
│   │       └── idempotency_service.py
│   ├── domain/
│   │   ├── entities.py
│   │   ├── enums.py
│   │   ├── value_objects.py
│   │   └── errors.py
│   ├── integration/
│   │   ├── gateway_client.py              # Team Panel -> Agent Gateway 内部调用
│   │   ├── event_ingest_service.py        # Timeline/handle 回流写入控制面
│   │   └── reconcile_scheduler.py
│   ├── repositories/
│   │   ├── enterprise_repo.py
│   │   ├── employee_repo.py
│   │   ├── conversation_repo.py
│   │   ├── run_repo.py
│   │   ├── task_repo.py
│   │   ├── scheduled_job_repo.py
│   │   ├── runtime_binding_repo.py
│   │   ├── run_event_repo.py
│   │   └── audit_repo.py
│   ├── views/
│   │   ├── schemas.py                     # 聚合视图 / 页面返回结构
│   │   ├── assemblers.py                  # 多对象拼装器
│   │   └── cursor_queries.py              # timeline/events 查询辅助
│   └── transactions/
│       ├── uow.py
│       └── db.py
├── agent-gateway/
└── api/
```

### 3.2 分层规则

#### A. router 层
只负责：
- HTTP 参数解析
- 登录态 / 基础身份识别
- 调用 application service
- 返回 JSON / SSE 协议响应

不负责：
- 拼接 SQL
- 直接写多张业务表
- 直接调用 Runtime
- 直接做跨对象聚合

#### B. command service 层
负责：
- 命令前置校验
- 创建主业务记录
- 控制事务边界
- 调用 Gateway 内部适配接口
- 记录审计事件
- 失败补偿与状态收口

#### C. query service 层
负责：
- 读取规范化表
- 聚合多个对象
- 排序、裁剪、权限过滤
- 组装页面级视图结构

#### D. repository 层
只负责：
- 单对象 / 单聚合根的持久化读写
- 唯一键、分页、索引友好的查询
- 不承载页面语义

#### E. integration 层
负责：
- 调用 Gateway
- 接收 Timeline 事件
- 定时对账
- 与 Team Panel DB 的镜像更新协同

---

## 4. Team Panel 内部主数据流

### 4.1 命令侧主链

```text
Browser Request
  -> Team Panel Router
  -> PermissionService / IdempotencyService
  -> Command Service
  -> Repository Transaction
  -> GatewayClient
  -> runtime_binding 回写
  -> AuditEvent
  -> HTTP Response
```

### 4.2 事件回流主链

```text
Gateway Timeline / Reconcile callback
  -> EventIngestService
  -> run_event insert
  -> runtime_binding cursor/status update
  -> team_run / team_task / scheduled_job 镜像修正
  -> optional aggregate refresh marker
```

### 4.3 查询侧主链

```text
Browser Query
  -> Team Panel Router
  -> PermissionService
  -> Query Service
  -> repositories + views/assemblers
  -> 聚合视图 JSON
```

---

## 5. 关键写路径与事务边界

### 5.1 总原则

1. **Team Panel 先落业务记录，再调 Gateway**。
2. **一个命令事务只保证控制面内一致，不跨到 Runtime 做分布式事务**。
3. **任何提交到 Gateway 的对象，都必须先具备业务主键与幂等键**。
4. **拿到 runtime handle 后再推进到 submitting/running 等下一状态**。
5. **若 Gateway 成功而 Team Panel 回写失败，靠 reconciliation 修复，不回滚 Runtime 已接受的执行**。

### 5.2 招募员工写路径

事务内：
- 创建 `recruitment_order`
- 创建 `employee`
- 创建默认 bindings
- 创建 `runtime_binding(owner=employee, pending)`
- 写审计事件 `employee.recruitment_created`

事务外：
- 调 `GatewayClient.ensure_profile()`

回写事务：
- 成功：`employee=active`、`runtime_binding=synced`
- 失败：`employee=provisioning_failed`、`recruitment_order=failed`

### 5.3 单聊 run 提交写路径

#### 输入
- `conversation_id`
- `employee_id`
- `message`
- `idempotency_key`

#### 事务一：业务落库
- 校验 `employee.status`、`conversation.status`
- 追加用户消息记录
- 创建 `team_run(status=queued, execution_mode=single_agent)`
- 创建 `runtime_binding(owner=team_run, pending)`
- 写 `audit_event(run.created)`

#### 事务外：调用 Gateway
- 组装 `SingleAgentRunRequest`
- 调 `GatewayClient.start_single_agent_run()`

#### 事务二：句柄回写
- 更新 `runtime_binding(kind=session, session_id, profile_name)`
- 更新 `team_run=submitting` 或 `running`
- 记录 `last_submitted_at`

#### 失败闭环
- 若事务一失败：整体失败，不调用 Gateway
- 若 Gateway 调用失败：`team_run=failed`，保留用户消息与失败审计
- 若 Gateway 成功但事务二失败：标记 `runtime_binding=writeback_pending`，交给对账修复

### 5.4 群聊消息提交写路径

#### 事务一：群消息入库与 run 创建
- 校验 `conversation.status in (draft, active, muted)`
- 校验用户对该群有成员可见性
- 追加群用户消息
- 创建 `team_run(status=queued)`
- 计算并写入 `route_decision_summary`
- 创建 `runtime_binding(owner=team_run, pending)`
- 写审计事件 `group_message.accepted`

#### 事务外：运行接入
- `route_mode=single_agent`：调 `GatewayClient.start_group_conversation_run()`，内部进入 session 路径
- `route_mode=orchestration`：仍调同一入口，但内部进入 root-task 路径

#### 事务二：句柄回写
- 更新 `runtime_binding.kind=session|kanban_task`
- 更新 `team_run=submitting|running`
- 更新群会话展示态所需摘要字段，例如 `latest_run_id`、`latest_message_id`

说明：
- 群聊与编排的分界发生在 **route_decision**，不是在 router 层硬编码两个不同 API。
- Team Panel 不把群聊直接建模为“kanban 任务容器”；群聊依然是业务会话容器。

### 5.5 编排任务树业务镜像写路径

此路径不是浏览器直接写入，而是**事件回流驱动**：
- 收到 root-task started / child-task spawned / child-task completed / child-task failed
- 插入 `run_event`
- 如果出现新 child task：创建或更新 `team_task`
- 更新 `team_run.open_task_count`
- 必要时刷新 `latest_warning_count` / `latest_failed_task_count`

原则：
- `team_task` 是 Team Panel 可解释的业务镜像，不直接照搬 Hermes 内部所有字段
- Runtime 每新增一个对产品可见的任务节点，Team Panel 必须能映射出对应的 `team_task`

### 5.6 ScheduledJob 配置写路径

#### 事务一
- 校验员工、cron 输入、权限
- 创建 / 更新 `scheduled_job`
- 创建 `runtime_binding(owner=scheduled_job, pending)`
- 写审计事件

#### 事务外
- 调 `GatewayClient.create_scheduled_job()`

#### 事务二
- 回写 `job_id`
- 更新 `scheduled_job=status=enabled|paused`

#### 关闭/删除
- 先更新控制面状态为 `paused` / `archived`
- 再请求 Gateway 停止 Runtime job
- 若 Runtime 停止失败，由对账任务持续重试并标记风险审计

---

## 6. 事件入库与控制面镜像更新

### 6.1 EventIngestService 责任

`EventIngestService` 是 Team Panel 内部实现的关键模块，职责包括：

- 去重写入 `run_event(event_cursor unique)`
- 更新 `runtime_binding.last_event_cursor`
- 推进 `team_run`、`team_task`、`scheduled_job` 的镜像状态
- 维护最小聚合字段，支撑高频页面查询

### 6.2 必须同步更新的最小镜像字段

事件写入后，建议同步维护以下字段，避免高频页面每次全表扫描：

- `team_run.last_event_cursor`
- `team_run.last_event_ts`
- `team_run.latest_preview`
- `team_run.open_task_count`
- `team_run.last_error_code`
- `conversation.latest_run_id`
- `conversation.latest_message_at`
- `scheduled_job.last_run_status`
- `scheduled_job.last_run_at`

### 6.3 不必同步冗余复制的内容

不要在 Team Panel 控制面重复存以下大块内容：
- 原始 token 全量流文本副本
- Runtime 内部 task 原始 payload 全量 JSON
- 连接器原始 secret
- Hermes session 内部 message 文件路径等运行细节

必要时只存：
- preview
- 引用 id
- 句柄 id
- cursor
- 统计摘要

---

## 7. 聚合视图设计

### 7.1 设计原则

1. 聚合视图是**查询结果**，不是新的权威业务对象。
2. 聚合视图可以跨多张表组装，但不得反向写回覆盖主对象口径。
3. BFF 负责页面裁剪，query service 负责业务聚合，二者不混写到 router。
4. 高频页优先使用“最小镜像字段 + 增量事件查询”的方式，避免每次重算完整历史。

### 7.2 WorkbenchView

#### 主要来源
- `employee`
- `conversation`
- `team_run`
- `runtime_binding`
- 可选 `billing snapshot`

#### 目标
返回工作台左侧员工列表、中间会话摘要、右侧快速状态卡所需最小聚合结果。

#### 必备字段
- `pinned_conversations`
- `recent_conversations`
- `employee_sidebar_cards`
- `unread_count`
- `latest_run_preview`
- `quick_actions`
- `empty_state`

#### 查询策略
- 会话摘要按 `conversation.latest_message_at desc`
- 员工卡按业务排序字段 + 在线/忙碌派生态补充
- 仅取每个会话最近一条 run 摘要，不在工作台页加载完整 timeline

### 7.3 PrivateConversationView

#### 主要来源
- `conversation`
- `conversation_member`
- `team_run`
- `run_event`
- `runtime_binding`

#### 目标
支撑单聊页面：
- 历史消息
- 最近 run 状态
- Timeline 增量流
- 工具卡片 / usage / 引用来源 / 记忆提示

#### 组装规则
- 最终消息气泡来自 conversation message + team_run terminal summary
- 中间过程事件来自 `run_event`
- 事件查询遵守 numeric cursor
- `resolved / streaming / waiting_reply` 在此处计算为展示态，不写回主状态枚举

### 7.4 GroupConversationView

#### 主要来源
- `conversation`
- `conversation_member`
- `team_run`
- `team_task`
- `run_event`

#### 目标
支撑群聊页面的三层视图：
1. 消息流
2. 过程流
3. 汇总流

#### 组装规则
- 消息流只展示用户消息与员工最终答复块
- 过程流主要来自 `run_event` 与 `team_task` 摘要
- 汇总流只展示当前 `team_run` 的 terminal summary 或 orchestrator 最终结论
- 若 `route_mode=single_agent`，群聊仍使用 GroupConversationView，只是不渲染任务树
- 若 `route_mode=orchestration`，额外加载 `team_task tree`

### 7.5 OfficeSceneView

#### 主要来源
- `employee`
- `team_run`
- `team_task`
- `conversation`
- `billing mini snapshot`

#### 目标
支撑办公室动态页面：
- 谁在忙
- 正在处理哪类任务
- 是否存在积压或失败
- 点击后跳转哪里

#### 构建方式
- 不读取完整历史消息
- 仅读取每个员工最新 run/task 摘要
- `employee_presence` 由 `latest_run_status + latest_event_ts + manual mute/pause` 派生

### 7.6 EmployeeAdminDetailView

#### 主要来源
- `employee`
- `employee_binding_*`
- `scheduled_job`
- `usage ledger summary`
- `runtime_binding(owner=employee)`

#### 目标
支撑后台 B01 员工详情页签：
- 基础资料
- 模型与 Prompt
- Skill / 知识 / 记忆 / 连接器绑定
- Loop 配置
- 运行摘要

#### 构建规则
- 一个接口返回一个页签容器 ViewModel
- 允许按页签懒加载子块，但统一由 `employee_admin_view_service` 组装
- 不让前端逐块拼十几个基础对象接口

---

## 8. 查询实现策略

### 8.1 V1 默认策略

V1 默认采用：
- **规范化表 + 最小镜像字段 + query service 组装**
- 不额外引入复杂 CQRS 基础设施
- 不新建单独消息总线或外部缓存层作为前提条件

### 8.2 何时需要单独读模型表

只有当以下页面出现明显性能或查询复杂度压力时，再考虑增加只读聚合表：

- 工作台首页（高频列表 + 多维排序）
- 办公室动态页（全员实时概览）
- 费用排行 / 统计页

新增只读聚合表时，遵守：
- 只服务查询，不反向成为业务主对象
- 字段来源必须可追溯到控制面主表或 run_event
- 刷新方式明确写为同步刷新、异步刷新或定时刷新之一

### 8.3 当前不建议的做法

- 前端自己调多个基础接口拼装页面
- 把查询逻辑塞到 router
- 把“聚合视图”直接当成数据库主表口径
- 在未出现性能瓶颈前就引入复杂 event bus / read store 双写体系

---

## 9. 权限校验落点

### 9.1 三层校验模型

#### A. Router 级粗校验
- 是否登录
- enterprise 是否选定
- 基础角色是否允许进入该命名空间

#### B. Service 级业务校验
- 当前成员能否访问该 employee / conversation / scheduled_job
- 当前操作是否符合业务状态
- 当前成员能否发起招募、配置连接器、暂停 job

#### C. Query 级结果过滤
- 列表结果只返回当前成员可见对象
- 敏感字段做裁剪
- 后台页按角色裁掉操作按钮和部分统计字段

### 9.2 必须放在 service 层的校验

以下校验不能只靠前端或 router：
- 是否为群成员
- 是否可访问该员工详情
- 是否可修改某员工绑定
- 是否可触发行业方案 apply
- 是否可查看费用明细

### 9.3 典型对象权限规则

- `conversation`：成员可读；管理员可治理；非成员不可读
- `employee`：前台成员默认只读与其可见范围相关的摘要；后台管理员可配置
- `scheduled_job`：仅管理员与具备授权的员工治理人可编辑
- `billing`：`owner` / `enterprise_admin` / `finance_admin` 按页面粒度控制

---

## 10. 与 Gateway 的内部调用契约

### 10.1 GatewayClient 责任

Team Panel 不直接 import Runtime 内部细节；统一通过 `GatewayClient` 这一层调用：

- `ensure_profile(...)`
- `start_single_agent_run(...)`
- `start_group_conversation_run(...)`
- `submit_orchestrator_root_task(...)`
- `create_scheduled_job(...)`
- `hydrate_runtime_events(...)`
- `reconcile_runtime_state(...)`

### 10.2 Team Panel 传给 Gateway 的最小信息

必须由 Team Panel 先准备好：
- 业务主键：`enterprise_id`、`conversation_id`、`run_id`、`message_id`
- employee / planner / candidate employee 标识
- route_decision
- connector resolution refs
- 当前业务上下文摘要

Team Panel 不应该把以下内容直接暴露给浏览器：
- `profile_name`
- `session_id`
- `task_id`
- `job_id`
- Runtime source cursor

这些都是内部句柄，由 Gateway / runtime_handle 层持有。

---

## 11. 对账、补偿与后台任务

### 11.1 Team Panel 自身需要的后台任务

建议至少有三类后台任务：

1. `run_reconcile_job`
2. `profile_reconcile_job`
3. `scheduled_job_reconcile_job`

### 11.2 Team Panel 内部责任边界

- Reconcile 的“发起与结果落库”在 Team Panel
- Runtime 状态查询能力在 Gateway
- Runtime 真正停止 / 补拉能力也在 Gateway

### 11.3 补偿闭环

#### 场景 A：业务记录成功，Gateway 调用失败
- 更新命令对象到 failed
- 记录审计
- 返回前端明确失败结论

#### 场景 B：Gateway 成功，Team Panel 回写失败
- 保留待修复标记
- 由 reconcile 扫描 handle 修复

#### 场景 C：事件流中断
- 浏览器按 `event_cursor` 补拉
- Team Panel query service 从 `run_event` 提供增量结果
- 如本地不连续，由 Gateway 补拉 Runtime 源事件后再入库

---

## 12. 实施顺序建议

### 12.1 第一阶段：控制面骨架

先落：
- `repositories/*`
- `transactions/uow.py`
- `permission_service.py`
- `idempotency_service.py`
- `gateway_client.py`

### 12.2 第二阶段：最小命令链

先实现：
- 招募员工
- 单聊 run 提交
- 群聊消息提交
- Gateway 句柄回写

### 12.3 第三阶段：最小查询链

先实现：
- `workbench_view_service`
- `conversation_view_service`
- `employee_admin_view_service`

### 12.4 第四阶段：回流与对账

补齐：
- `event_ingest_service`
- `run_event` 增量查询
- `reconcile_scheduler`
- `office_view_service`

### 12.5 第五阶段：扩展页与经营页

最后补：
- 费用页
- 系统后台页
- 复杂排行榜与统计聚合

---

## 13. 可交付验收标准

完成本文后，Team Panel 实现者应能直接回答以下问题：

1. 一个 `/api/team/group-conversations/{id}/messages` 请求先写哪些表，再调哪个内部服务。
2. `route_mode=single_agent` 与 `route_mode=orchestration` 在 Team Panel 里如何分支。
3. `WorkbenchView`、`GroupConversationView`、`OfficeSceneView` 分别从哪些对象组装。
4. 权限校验在哪一层做，哪些不能只放前端。
5. Team Panel 与 Gateway 的边界在哪里，哪些字段不能直接暴露给浏览器。

若这五个问题仍无法由本文直接回答，说明 Team Panel 内部实现设计仍未收口。

---

## 14. 实现结论

1. Team Panel 后端必须按 **router / command service / query service / repository / integration** 分层，而不是把业务逻辑继续堆进 `api/routes.py`。
2. Team Panel 的核心写路径统一遵守“先落控制面记录，再调用 Gateway，再按 handle 回写”的事务模式。
3. 页面消费的核心结果应统一抽象为**聚合视图**，而不是让前端自己拼规范化表。
4. 群聊是业务容器，编排是执行策略；Team Panel 必须在 route_decision 层维护这一区分。
5. Team Panel 是控制面权威来源，Gateway 是运行时接入层，Runtime 是执行事实层；三者边界在实现上必须保持可追踪。
