---
created: 2026-05-27
updated: 2026-05-28
status: ready-for-development-review
stage: detailed-design
tags: [project, aiteam, technical-design, detailed-design, team-panel, domain-model, data-architecture]
canonical_name: 2026-05-27-AI Team-Team Panel领域模型与数据架构详细设计
source_docs:
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-27-AI Team-Team Panel与Agent Gateway详细设计方案.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-26-AI Team-技术概要设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-25-AI Team-业务解决方案设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-28-AI Team-共享运行口径定稿版.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/参考文档/Agent Service项目结构与模块功能参考.md
---

# AI Team Team Panel 领域模型与数据架构详细设计

## 1. 文档范围与边界

### 1.1 文档目标

本文定义 Team Panel 模块在 V1 阶段的：

- 业务控制面领域模型
- 业务口径层数据库结构
- Team Panel 与 Agent Gateway / Hermes Runtime 的映射边界
- 关键状态枚举与执行语义
- 数据一致性、审计、归档、对账、迁移与备份要求

本文是**可指导实现**的模块级详细设计，不是产品概览，也不是运行时内部设计。

### 1.2 范围内

本文覆盖以下 Team Panel 控制面对象：

- 企业与成员上下文：`enterprise`、`membership`
- 模板与招募上下文：`agent_template`、`recruitment_order`
- 员工主数据与能力绑定：`employee`、`employee_binding_*`
- 会话与协作上下文：`conversation`、`conversation_member`、`team_run`、`team_task`
- 周期任务上下文：`scheduled_job`
- 运行句柄与事件：`runtime_binding`、`run_event`
- 记忆/知识/连接器的**绑定与引用口径**
- 审计与对账：`audit_event`

### 1.3 范围外

以下内容明确不在本文内建模为 Team Panel 口径：

- Hermes `state.db`、`sessions/*`、Kanban 内部表、Cron 内部状态机
- LightRAG 文档切块、向量索引与召回算法
- 凭据密文保管系统本身
- 支付充值流水底座
- 外部消息平台原始事件表

### 1.4 设计原则

1. **业务口径与运行口径分离**
   - Team Panel 持有业务/控制面口径。
   - Hermes Runtime 持有执行态口径。
2. **V1 优先简单**
   - 只建开发必需表，不为假想未来预铺过多抽象。
3. **引用优先，复制最少**
   - 对 Runtime 与外部系统只存 join key、摘要、镜像状态，不复制完整内部结构。
4. **状态可解释**
   - 每个枚举都必须有明确执行语义，而非 UI 文案状态。
5. **所有写操作可审计**
   - 关键对象变更必须有审计落点。

---

## 2. 口径分层与上下文归属

## 2.1 三层口径模型

### A. Team Panel 业务/控制面口径

负责：

- 企业空间、成员、权限
- 模板、招募、员工实例
- 员工能力绑定与业务状态
- 会话容器、群协作容器、业务 run/task
- 业务审计、运营筛选、归档口径

### B. Agent Gateway 适配层口径

负责：

- 业务对象到 Hermes Profile / Session / Task / Job 的翻译
- 凭据解析计划
- 运行提交句柄
- 事件回流标签补齐

Gateway 不应持有比 Team Panel 更高层的业务定义，也不应替代 Runtime 成为执行口径。

### C. Hermes Runtime 执行口径

负责：

- profile 目录
- session/message 持久化
- `AIAgent.run_conversation()` 执行结果
- Kanban 任务图及调度
- Cron job 调度与运行状态
- Memory / Skills / Tools 实际加载与执行

## 2.2 限界上下文与归属表

- **Enterprise Context**：归 Team Panel
- **Talent Context**：归 Team Panel
- **Employee Context**：业务主数据归 Team Panel；运行容器归 Hermes
- **Conversation Context**：会话容器归 Team Panel；会话内容与 token 流归 Hermes
- **Execution Context**：业务 run/task 归 Team Panel；真实 task/job/session 执行归 Hermes
- **Capability Context**：绑定/授权归 Team Panel；实际 skill/tool/memory 执行归 Hermes
- **Credential Context**：授权关系与 `credential_ref` 归 Team Panel；密文与解密归凭据系统/Gateway
- **Audit Context**：业务审计归 Team Panel；原始运行日志归 Runtime/日志系统

## 2.3 业务口径 vs 运行口径的显式区分

### 业务口径字段示例

- `employee.status = active`
- `conversation.status = archived`
- `team_run.status = running`
- `scheduled_job.status = paused`

这些字段表达**产品控制面是否允许、如何展示、如何治理**。

### 运行口径字段示例

- `profile_name`
- `session_id`
- `kanban_task_id`
- `cron_job_id`
- `runtime_event_cursor`

这些字段表达**Hermes 中实际执行落点和可回查句柄**。

规则：

- Team Panel 状态不可伪造 Runtime 已完成。
- Runtime 已完成后，Team Panel 通过事件回流更新业务镜像状态。
- 若两者冲突，以 Runtime 执行口径为准，以 Team Panel 控制面规则决定后续 UI/治理动作。

---

## 3. Team Panel 内部主数据流与控制流

## 3.1 员工招募与供应流

```text
模板选择
  -> recruitment_order 创建
  -> employee 创建(draft)
  -> 生成唯一 profile_name
  -> 写入默认模型/Prompt/绑定
  -> runtime_binding 标记 profile_pending
  -> Gateway provision profile
  -> provision 成功后 employee.status=active
```

关键点：

- `employee` 是主对象。
- `profile_name` 由 Team Panel 分配，Hermes 只消费。
- profile 创建失败时，员工保持 `provisioning_failed`，不可接单。

## 3.2 私聊执行流

```text
用户发送消息
  -> Team Panel 查 employee + conversation
  -> 创建 team_run(queued)
  -> 记录 runtime_binding(session pending)
  -> Gateway 提交 single-agent run
  -> Hermes 生成/复用 session 并执行
  -> 事件回流 run_event
  -> Team Panel 聚合 team_run.status
  -> 成功后 team_run=succeeded/failed
```

## 3.3 群聊与协作编排流

```text
群消息进入
  -> conversation 路由判定
  -> 创建 team_run(routing)
  -> 决定 single-agent 或 orchestration
  -> 若编排则创建 team_task(root/planned)
  -> Gateway 映射为 Kanban root task
  -> Runtime 拆子任务并执行
  -> run_event/team_task 状态增量回流
  -> Team Panel 组装任务树时间线
```

## 3.4 周期任务流

```text
配置 scheduled_job(draft)
  -> Gateway 创建 cron job
  -> runtime_binding 写入 cron_job_id
  -> scheduled_job=enabled
  -> 调度触发生成一次 job run 事件流
  -> Team Panel 更新 last_run_* 摘要
  -> 连续失败达到阈值 -> scheduled_job=error
```

## 3.5 绑定变更控制流

```text
编辑员工配置
  -> 更新 employee / binding 表
  -> employee.config_version + 1
  -> runtime_binding.sync_status=dirty
  -> Gateway 重新 provision/patch profile
  -> 成功后 sync_status=synced
```

约束：

- V1 不做细粒度增量 patch 依赖图；统一以员工配置版本驱动重同步。

---

## 4. 规范化领域对象

## 4.1 Enterprise

企业空间，是 Team Panel 多租户边界。

```json
{
  "enterprise_id": "ent_001",
  "name": "Acme AI Lab",
  "slug": "acme-ai-lab",
  "status": "active",
  "owner_user_id": "usr_001",
  "default_workspace_id": "ws_default",
  "created_at": "2026-05-27T10:00:00Z"
}
```

## 4.2 Membership

企业成员关系，不映射到 Hermes Profile。

```json
{
  "membership_id": "mbr_001",
  "enterprise_id": "ent_001",
  "user_id": "usr_002",
  "role": "enterprise_admin",
  "status": "active"
}
```

## 4.3 AgentTemplate

模板口径，用于招募与复制，不是运行容器。

```json
{
  "template_id": "tpl_marketing_v1",
  "name": "营销分析师",
  "role_name": "市场分析",
  "prompt_pack": {
    "system": "你是一名企业营销分析师",
    "style": "结构化、谨慎、可执行"
  },
  "default_model": {"provider": "openai", "model": "gpt-4o"},
  "default_skill_codes": ["web.search", "slides.writer"],
  "status": "published"
}
```

## 4.4 RecruitmentOrder

招募动作流水，用于幂等、失败追踪与审计。

```json
{
  "recruitment_order_id": "ro_001",
  "enterprise_id": "ent_001",
  "template_id": "tpl_marketing_v1",
  "status": "provisioning",
  "created_employee_id": "emp_marketing_001"
}
```

## 4.5 Employee

数字员工的业务主对象。

```json
{
  "employee_id": "emp_marketing_001",
  "enterprise_id": "ent_001",
  "template_id": "tpl_marketing_v1",
  "profile_name": "ent001-marketing-001",
  "display_name": "营销分析师",
  "role_name": "市场分析",
  "status": "active",
  "model_provider": "openai",
  "model_name": "gpt-4o",
  "prompt_version": 3,
  "config_version": 7,
  "created_from": "talent_market"
}
```

## 4.6 EmployeeBindingSet

V1 不建抽象总表，使用 4 张绑定表表达：

- `employee_skill_binding`
- `employee_knowledge_binding`
- `employee_memory_binding`
- `employee_connector_binding`

理由：

- 各绑定语义不同
- 审计与权限规则不同
- V1 可直接开发，不引入过度多态

## 4.7 Conversation

统一私聊/群聊容器。

```json
{
  "conversation_id": "conv_group_001",
  "enterprise_id": "ent_001",
  "type": "group",
  "title": "Q1增长复盘讨论",
  "status": "active",
  "entry_employee_id": null,
  "latest_run_id": "run_001"
}
```

说明：

- 私聊：`type=private`，`entry_employee_id` 必填。
- 群聊：`type=group`，成员通过 `conversation_member` 表维护。

## 4.8 TeamRun

一次业务执行实例，是控制面最重要的运行镜像对象。

```json
{
  "run_id": "run_001",
  "enterprise_id": "ent_001",
  "conversation_id": "conv_group_001",
  "trigger_type": "group_message",
  "execution_mode": "kanban_orchestration",
  "status": "running",
  "entry_employee_id": "emp_marketing_001",
  "planner_employee_id": "emp_marketing_001",
  "root_team_task_id": "tt_root_001",
  "idempotency_key": "grpmsg-20260527-001"
}
```

## 4.9 TeamTask

业务层任务树节点，是 Team Panel 对 Kanban task 的解释层镜像，不是对 Kanban 的完整复制。

```json
{
  "team_task_id": "tt_child_003",
  "run_id": "run_001",
  "parent_team_task_id": "tt_root_001",
  "title": "完成复盘摘要初稿",
  "assignee_employee_id": "emp_writer_001",
  "status": "running",
  "sequence_no": 3,
  "depth": 1,
  "runtime_task_id": "task_child_003"
}
```

## 4.10 ScheduledJob

员工级周期任务的控制面对象。

```json
{
  "scheduled_job_id": "sched_001",
  "enterprise_id": "ent_001",
  "employee_id": "emp_ops_001",
  "name": "服务巡检",
  "goal": "每10分钟检查服务状态并记录异常",
  "schedule_expr": "every 10m",
  "status": "enabled",
  "max_consecutive_failures": 3,
  "runtime_job_id": "job_abc123"
}
```

## 4.11 RuntimeBinding

Team Panel 与 Runtime 的统一 join key 容器。

```json
{
  "binding_id": "rb_001",
  "owner_type": "team_run",
  "owner_id": "run_001",
  "profile_name": "ent001-orchestrator",
  "runtime_kind": "kanban_task",
  "runtime_session_id": null,
  "runtime_task_id": "task_root_001",
  "runtime_job_id": null,
  "sync_status": "synced",
  "event_cursor": 128,
  "runtime_source_cursor": "20260527-103218-000128"
}
```

## 4.12 AuditEvent

业务审计事件，不保存超大原始日志正文。

```json
{
  "audit_event_id": "ae_001",
  "enterprise_id": "ent_001",
  "actor_type": "user",
  "actor_id": "usr_001",
  "event_type": "employee.updated",
  "target_type": "employee",
  "target_id": "emp_marketing_001",
  "payload": {
    "changed_fields": ["model_name", "prompt_version"]
  }
}
```

---

## 5. 核心状态枚举与执行语义

## 5.1 employee.status

- `draft`
  - 业务对象已创建，尚未发起 profile provision。
- `provisioning`
  - 已生成配置并提交 Gateway，同步尚未完成。
- `active`
  - 可发起私聊、可被加入群聊、可被编排分配。
- `paused`
  - 保留全部配置，但不允许新建 run/task/job。
- `provisioning_failed`
  - profile 建立或配置下发失败；允许重试同步，不允许执行。
- `archived`
  - 前台隐藏，只保留历史追溯；不允许新建 run。

## 5.2 recruitment_order.status

- `pending`
- `provisioning`
- `succeeded`
- `failed`
- `cancelled`

语义：`succeeded` 以 employee 可进入 `active/paused` 为完成标准，不是仅创建数据库记录。

## 5.3 conversation.status

持久化主状态统一采用：

- `draft`：已创建但尚未有有效首条消息
- `active`：可发送消息并创建新 run
- `paused`：因权限、员工状态或人工冻结，不允许发起新执行
- `muted`：仅群聊使用；可继续存在但默认不推送办公室动态
- `archived`：只读，不允许新增消息/成员变更

说明：`waiting_reply`、`streaming`、`resolved`、`routing`、`busy` 不再作为 `conversation.status` 主枚举，统一改为 UI / BFF 展示态。

## 5.4 team_run.status

- `queued`
  - Team Panel 已落库，尚未提交 Runtime。
- `routing`
  - 正在做路由/协作决策。
- `submitting`
  - 已交给 Gateway，等待拿到 runtime handle。
- `running`
  - Runtime 已接收，正在执行。
- `waiting_human`
  - 等待人工审批、补充信息或手动确认继续。
- `succeeded`
  - 执行完成且可产出最终结果。
- `failed`
  - 执行失败，无可接受最终结果。
- `cancelled`
  - 被用户或系统取消。

说明：`waiting_children`、`partial_success`、`reconnecting` 不再作为 `team_run.status` 主枚举；编排过程中是否存在未收敛子任务，由 `execution_mode + open_task_count` 作为聚合展示判断。

## 5.5 team_task.status

- `planned`
- `queued`
- `running`
- `waiting_deps`
- `succeeded`
- `failed`
- `cancelled`

语义：

- `planned`：业务层已知道节点，但还未映射/下发或未满足父依赖。
- `queued`：已绑定 runtime task，等待调度。
- `waiting_deps`：依赖未满足，不能开始执行。

## 5.6 scheduled_job.status

- `draft`
- `enabled`
- `paused`
- `error`
- `archived`

语义：

- `enabled` 表示底层 cron 已注册；每次 tick 的运行情况通过 `TeamRun` 与 `run_event` 表达，不再把 `running` 作为 `scheduled_job.status` 长期状态。
- `error` 表示连续失败超过阈值，需要人工干预；不是单次失败。

## 5.7 runtime_binding.sync_status

- `pending`：还没有拿到 Runtime 句柄
- `synced`：句柄已确认，对账可用
- `dirty`：源配置已变化，需要重同步
- `failed`：同步失败，需重试
- `orphaned`：Team Panel 记录存在，但 Runtime 句柄已不可达或丢失

---

## 6. V1 数据库设计

### 6.0 数据库选型依据

V1 选择 PostgreSQL 作为控制面数据库，不选择 MySQL：

| 决策因素 | PostgreSQL | MySQL | 对 AI Team 的影响 |
|----------|------------|-------|------------------|
| jsonb 原生支持 | 二进制存储 + GIN 索引 + 丰富查询语法 | JSON 文本存储，功能有限 | run_event.payload_json、agent_template.default_model_json 等多处依赖 jsonb |
| 声明式分区 | RANGE / LIST / HASH 分区，成熟稳定 | 支持但不够成熟 | run_event 按月分区 + 30天归档策略 |
| 唯一约束 + ON CONFLICT | INSERT ... ON CONFLICT DO NOTHING | INSERT IGNORE / ON DUPLICATE KEY | 批量写入 run_event 时防止 cursor_no 重复 |
| 批量写入性能 | execute_values() 高效 | LOAD DATA INFILE 需文件 | 事件批量 INSERT 每秒数千条 |
| 多租户索引 | 前缀索引 + 分区裁剪 | 类似但分区能力弱 | enterprise_id 前缀覆盖所有业务查询 |
| 技术栈一致性 | 与现有 Hermes 无关，独立选型 | 同 | 新系统选型不受历史约束 |

说明：

- 所有主键使用 /ULID 风格字符串，避免早期跨系统 ID 方案切换。
- JSON 承载局部可变结构，核心关系仍使用关系表。
- 所有主键使用 `text`/ULID 风格字符串，避免早期跨系统 ID 方案切换。
- JSON 承载局部可变结构，核心关系仍使用关系表。
- 所有表默认包含审计字段：`created_at`、`updated_at`、`created_by`、`updated_by`、`deleted_at`。
- Agent Service 现有 `api/models.py` / `~/.hermes/webui` JSON Session 存储**不替代**本控制面数据库；它保留为浏览器工作台宿主兼容层与 Runtime 侧 conversation mirror。
- 因此 V1 采用 **控制面 PostgreSQL + 宿主 JSON 会话索引** 双轨并存口径：业务口径进数据库，运行期会话宿主和 SSE 兼容数据继续沿用现有 JSON 存储模式。

## 6.1 enterprise

用途：企业租户主表。

字段：

- `enterprise_id` PK
- `slug` UNIQUE
- `name`
- `status` enum(`active`,`suspended`,`archived`)
- `owner_user_id`
- `default_workspace_id` nullable
- `archive_reason` nullable
- `created_at`
- `updated_at`
- `created_by`
- `updated_by`
- `deleted_at` nullable

索引：

- `uk_enterprise_slug(slug)`
- `idx_enterprise_owner(owner_user_id)`
- `idx_enterprise_status(status)`

## 6.2 membership

用途：企业成员关系与后台权限过滤。

字段：

- `membership_id` PK
- `enterprise_id` FK -> enterprise
- `user_id`
- `role` enum(`owner`,`enterprise_admin`,`finance_admin`,`member`,`system_admin`,`system_operator`)
- 说明：企业成员表通常只使用 `owner / enterprise_admin / finance_admin / member`；平台角色仅出现在平台级上下文，不应与企业成员关系混用。
- `status` enum(`active`,`invited`,`disabled`,`removed`)
- `permissions_json` jsonb
- `joined_at` nullable
- 审计字段

唯一键：

- `uk_membership_enterprise_user(enterprise_id,user_id)`

索引：

- `idx_membership_enterprise_role(enterprise_id,role)`
- `idx_membership_status(status)`

## 6.3 agent_template

用途：模板市场与行业方案引用基础。

字段：

- `template_id` PK
- `name`
- `category_code`
- `role_name`
- `status` enum(`draft`,`published`,`retired`)
- `prompt_pack_json` jsonb
- `default_model_json` jsonb
- `default_binding_json` jsonb
- `version_no` int
- `source_type` enum(`system`,`enterprise_custom`)
- `owner_enterprise_id` nullable
- 审计字段

唯一键：

- `uk_template_owner_name_version(owner_enterprise_id,name,version_no)`

索引：

- `idx_template_category_status(category_code,status)`
- `idx_template_source(source_type)`

## 6.4 recruitment_order

用途：招募幂等流水与失败重试。

字段：

- `recruitment_order_id` PK
- `enterprise_id` FK
- `template_id` FK
- `status` enum(`pending`,`provisioning`,`succeeded`,`failed`,`cancelled`)
- `requested_by`
- `created_employee_id` nullable
- `error_code` nullable
- `error_message` nullable
- `idempotency_key`
- 审计字段

唯一键：

- `uk_recruitment_enterprise_idempotency(enterprise_id,idempotency_key)`

索引：

- `idx_recruitment_enterprise_status(enterprise_id,status)`
- `idx_recruitment_template(template_id)`

## 6.5 employee

用途：数字员工主数据表。

字段：

- `employee_id` PK
- `enterprise_id` FK
- `template_id` nullable FK
- `profile_name` UNIQUE
- `display_name`
- `role_name`
- `status` enum(`draft`,`provisioning`,`active`,`paused`,`provisioning_failed`,`archived`)
- `created_from` enum(`talent_market`,`manual`,`solution_apply`,`admin_seed`)
- `model_provider`
- `model_name`
- `prompt_version` int default 1
- `config_version` int default 1
- `avatar_url` nullable
- `description` nullable
- `archive_reason` nullable
- `last_provisioned_at` nullable
- 审计字段

唯一键：

- `uk_employee_profile_name(profile_name)`
- `uk_employee_enterprise_name_active(enterprise_id,display_name,deleted_at)` 作为应用层唯一约束口径

索引：

- `idx_employee_enterprise_status(enterprise_id,status)`
- `idx_employee_enterprise_role(enterprise_id,role_name)`
- `idx_employee_template(template_id)`

说明：

- `profile_name` 是映射到 Hermes 的运行 join key，创建后不可修改。
- 员工改名只改 `display_name`，不改 `profile_name`。

## 6.6 employee_prompt

用途：管理可编辑 Prompt 与行为约束版本。

字段：

- `employee_id` PK/FK -> employee
- `system_prompt`
- `behavior_rules_json` jsonb
- `opening_message` nullable
- `version_no` int
- `source_template_version` nullable
- 审计字段

索引：

- `idx_employee_prompt_version(version_no)`

## 6.7 employee_skill_binding

字段：

- `binding_id` PK
- `enterprise_id` FK
- `employee_id` FK
- `skill_code`
- `enabled` bool
- `source_type` enum(`template_default`,`manual`,`solution_apply`,`system_policy`)
- `binding_version` int
- `visibility` enum(`allow`,`deny`)
- 审计字段

唯一键：

- `uk_emp_skill(employee_id,skill_code)`

索引：

- `idx_emp_skill_enterprise(employee_id,enabled)`
- `idx_emp_skill_code(skill_code)`

执行语义：

- `enabled=false` 表示业务上禁用，Gateway 不应下发至 profile。
- `visibility=deny` 优先级高于模板默认授权。

## 6.8 employee_knowledge_binding

字段：

- `binding_id` PK
- `enterprise_id` FK
- `employee_id` FK
- `knowledge_base_id`
- `scope_mode` enum(`read`,`read_write_metadata`)
- `enabled` bool
- `binding_version` int
- 审计字段

唯一键：

- `uk_emp_kb(employee_id,knowledge_base_id)`

索引：

- `idx_emp_kb_employee(employee_id,enabled)`
- `idx_emp_kb_kb(knowledge_base_id)`

## 6.9 employee_memory_binding

字段：

- `binding_id` PK
- `enterprise_id` FK
- `employee_id` FK
- `memory_mode` enum(`builtin`,`external`,`disabled`)
- `provider_code` nullable
- `retention_days` nullable
- `writeback_enabled` bool
- `binding_version` int
- 审计字段

唯一键：

- `uk_emp_memory(employee_id)`

索引：

- `idx_emp_memory_mode(memory_mode)`

## 6.10 enterprise_connector

用途：企业连接器主数据，不保存密文本身。

字段：

- `connector_id` PK
- `enterprise_id` FK
- `name`
- `provider_code`
- `connector_type` enum(`oauth_connector`,`api_key_connector`,`mcp_server`,`webhook_target`)
- `credential_ref`
- `rotation_version` int
- `status` enum(`draft`,`online`,`offline`,`auth_failed`,`archived`)
- `config_json` jsonb
- `last_validated_at` nullable
- 审计字段

唯一键：

- `uk_connector_enterprise_name(enterprise_id,name)`

索引：

- `idx_connector_enterprise_status(enterprise_id,status)`
- `idx_connector_provider(provider_code)`
- `idx_connector_credential_ref(credential_ref)`

边界：

- `credential_ref` 是唯一长期口径。
- 不保存 `client_secret`、`api_key`、refresh token 明文。

## 6.11 employee_connector_binding

字段：

- `binding_id` PK
- `enterprise_id` FK
- `employee_id` FK
- `connector_id` FK -> enterprise_connector
- `enabled` bool
- `access_mode` enum(`invoke`,`invoke_and_writeback`)
- `binding_version` int
- 审计字段

唯一键：

- `uk_emp_connector(employee_id,connector_id)`

索引：

- `idx_emp_connector_employee(employee_id,enabled)`
- `idx_emp_connector_connector(connector_id)`

## 6.12 conversation

用途：私聊/群聊业务容器。

字段：

- `conversation_id` PK
- `enterprise_id` FK
- `type` enum(`private`,`group`)
- `title`
- `status` enum(`active`,`muted`,`archived`)
- `entry_employee_id` nullable FK -> employee
- `latest_run_id` nullable
- `last_message_preview` nullable
- `last_message_at` nullable
- `created_by`
- `archived_at` nullable
- 其余审计字段

约束：

- `type=private` 时 `entry_employee_id` 必填
- `type=group` 时 `entry_employee_id` 必须为空

唯一键：

- `uk_private_conversation(enterprise_id,type,entry_employee_id,created_by,deleted_at)` 用于限制同一用户对同一员工的默认私聊容器

索引：

- `idx_conversation_enterprise_status(enterprise_id,status)`
- `idx_conversation_latest_run(latest_run_id)`
- `idx_conversation_last_message(last_message_at)`

## 6.13 conversation_member

用途：群聊成员与角色。

字段：

- `member_id` PK
- `conversation_id` FK
- `member_type` enum(`employee`,`user`)
- `member_ref_id`
- `role` enum(`owner`,`participant`,`observer`)
- `status` enum(`active`,`removed`)
- `joined_at`
- `removed_at` nullable
- 审计字段

唯一键：

- `uk_conv_member(conversation_id,member_type,member_ref_id)`

索引：

- `idx_conv_member_conversation(conversation_id,status)`
- `idx_conv_member_ref(member_type,member_ref_id)`

## 6.14 team_run

用途：业务执行主表。

字段：

- `run_id` PK
- `enterprise_id` FK
- `conversation_id` nullable FK
- `trigger_type` enum(`private_message`,`group_message`,`manual_run`,`scheduled_job`,`api_call`)
- `execution_mode` enum(`single_agent`,`kanban_orchestration`,`cron_single_agent`)
- `status` enum(`queued`,`routing`,`submitting`,`running`,`waiting_human`,`succeeded`,`failed`,`cancelled`)
- `entry_employee_id` nullable FK
- `planner_employee_id` nullable FK
- `root_team_task_id` nullable
- `scheduled_job_id` nullable FK
- `idempotency_key`
- `input_message_json` jsonb
- `result_summary_json` jsonb nullable
- `started_at` nullable
- `finished_at` nullable
- `error_code` nullable
- `error_message` nullable
- 审计字段

唯一键：

- `uk_run_enterprise_idempotency(enterprise_id,idempotency_key)`

索引：

- `idx_run_enterprise_status(enterprise_id,status)`
- `idx_run_conversation(conversation_id,created_at)`
- `idx_run_employee(entry_employee_id,created_at)`
- `idx_run_job(scheduled_job_id,created_at)`

## 6.15 team_task

用途：任务树镜像。

字段：

- `team_task_id` PK
- `run_id` FK -> team_run
- `parent_team_task_id` nullable FK -> team_task
- `title`
- `description` nullable
- `assignee_employee_id` nullable FK
- `status` enum(`planned`,`queued`,`running`,`waiting_deps`,`succeeded`,`failed`,`cancelled`)
- `sequence_no` int
- `depth` int
- `input_payload_json` jsonb nullable
- `output_summary_json` jsonb nullable
- `runtime_task_id` nullable
- `started_at` nullable
- `finished_at` nullable
- 审计字段

索引：

- `idx_team_task_run(run_id,sequence_no)`
- `idx_team_task_parent(parent_team_task_id)`
- `idx_team_task_assignee(assignee_employee_id,status)`
- `idx_team_task_runtime(runtime_task_id)`

说明：

- V1 使用邻接表模型，不额外建 task_link 表。
- 多父依赖不直接建模到 Team Panel 关系表，放入 `input_payload_json.parents_runtime_ids[]` 作为镜像摘要即可。
- 这样可满足任务树展示与对账，不强行复制 Kanban 全关系图。

## 6.16 scheduled_job

用途：员工级周期任务控制面。`running` 不属于该对象的长期主状态，单次触发执行通过 `TeamRun` 与 `run_event` 表达。

字段：

- `scheduled_job_id` PK
- `enterprise_id` FK
- `employee_id` FK
- `name`
- `goal`
- `schedule_expr`
- `status` enum(`draft`,`enabled`,`paused`,`error`,`archived`)
- `max_consecutive_failures` int
- `consecutive_failures` int default 0
- `last_run_status` enum(`succeeded`,`failed`,`cancelled`) nullable
- `last_run_at` nullable
- `last_success_at` nullable
- `runtime_job_id` nullable
- `notification_policy_json` jsonb nullable
- 审计字段

唯一键：

- `uk_job_employee_name(employee_id,name,deleted_at)`

索引：

- `idx_job_enterprise_status(enterprise_id,status)`
- `idx_job_employee(employee_id,status)`
- `idx_job_runtime(runtime_job_id)`

## 6.17 runtime_binding

用途：统一的运行句柄和同步状态表。

字段：

- `binding_id` PK
- `enterprise_id` FK
- `owner_type` enum(`employee`,`team_run`,`team_task`,`scheduled_job`)
- `owner_id`
- `profile_name`
- `runtime_kind` enum(`profile`,`session`,`kanban_task`,`cron_job`)
- `runtime_session_id` nullable
- `runtime_task_id` nullable
- `runtime_job_id` nullable
- `sync_status` enum(`pending`,`synced`,`dirty`,`failed`,`orphaned`)
- `event_cursor` nullable
- `last_synced_at` nullable
- `last_error` nullable
- 审计字段

唯一键：

- `uk_runtime_binding_owner(owner_type,owner_id)`

索引：

- `idx_runtime_binding_profile(profile_name)`
- `idx_runtime_binding_task(runtime_task_id)`
- `idx_runtime_binding_job(runtime_job_id)`
- `idx_runtime_binding_session(runtime_session_id)`
- `idx_runtime_binding_sync(sync_status)`

## 6.18 run_event

用途：时间线事件流的业务镜像，支持 SSE 断流补拉与后台筛查。

字段：

- `run_event_id` PK
- `enterprise_id` FK
- `run_id` FK -> team_run
- `team_task_id` nullable FK
- `source_type` enum(`session`,`kanban_task`,`cron_job`,`gateway`,`system`)
- `source_id`
- `employee_id` nullable FK
- `event_type` enum(`run_created`,`routing_decided`,`run_started`,`message_delta`,`tool_call`,`task_created`,`task_started`,`task_completed`,`task_failed`,`run_waiting_human`,`result_merged`,`memory_written`,`usage_recorded`,`run_succeeded`,`run_failed`,`run_cancelled`,`heartbeat`,`error`)
- `event_ts`
- `preview_text` nullable
- `payload_json` jsonb
- `cursor_no` bigint
- 审计字段

唯一键：

- `uk_run_event_run_cursor(run_id,cursor_no)`

索引：

- `idx_run_event_run_ts(run_id,event_ts)`
- `idx_run_event_type(event_type)`
- `idx_run_event_source(source_type,source_id)`

说明：

- `cursor_no` 是 Team Panel 对外正式暴露的 numeric cursor。
- Hermes 原始 offset / timestamp-sequence 游标如有保留，必须落在内部字段（如 `runtime_source_cursor`），不直接暴露到北向 API。

## 6.19 audit_event

用途：控制面审计。

字段：

- `audit_event_id` PK
- `enterprise_id` FK
- `actor_type` enum(`user`,`employee`,`system`,`gateway`)
- `actor_id`
- `event_type`
- `target_type`
- `target_id`
- `request_id` nullable
- `payload_json` jsonb
- `created_at`
- `created_by` nullable

索引：

- `idx_audit_enterprise_created(enterprise_id,created_at)`
- `idx_audit_target(target_type,target_id)`
- `idx_audit_event_type(event_type)`

---

## 7. 关系映射到 Hermes Runtime 口径

## 7.1 员工到 Profile

- `employee.profile_name` <-> `~/.hermes/profiles/<profile_name>/`
- `employee_prompt` -> `config.yaml` / prompt 组装输入
- `employee_*_binding` -> skills/memory/connectors/knowledge 的可见性与装配计划
- `runtime_binding(owner_type=employee)` 表示该 profile 是否已供应成功

约束：

- Team Panel 不把 profile 目录内容当业务数据库字段保存。
- 只保存**配置版本**和**运行句柄**。

## 7.2 私聊到 Session

- `conversation(type=private)` 是业务容器
- Hermes `session_id` 是执行容器
- 一个私聊业务会话在生命周期中可关联多个 run
- `runtime_binding(owner_type=team_run).runtime_session_id` 保存本次 run 实际使用/复用的 session

## 7.3 群聊到 Session / Kanban

群聊不是 Hermes 独立实体；V1 规则：

- 浏览器产品中的群聊由 Team Panel 定义为 `conversation(type=group)`
- 若路由到单员工，仍落到某个 profile + session
- 若路由到协作编排，则落到 orchestrator profile + Kanban task 图
- `team_run.execution_mode` 决定下游运行口径类型

## 7.4 TeamTask 到 Kanban Task

- `team_task.runtime_task_id` 对应 Hermes `Task.id`
- `team_task.parent_team_task_id` 仅维护展示树与业务摘要
- Kanban 更复杂的 links / retries / dispatcher 内部状态不回写为 Team Panel 强一致结构

## 7.5 ScheduledJob 到 Cron Job

- `scheduled_job.runtime_job_id` 对应 Hermes job id
- Team Panel 只镜像最后状态、连续失败计数、最近执行摘要
- 详细调度细节与原始输出仍以 Runtime 为准

## 7.6 连接器与凭据边界

- Team Panel：`enterprise_connector.credential_ref`
- Gateway：解析 `credential_ref` -> 临时 env overlay / profile-scoped bundle
- Runtime：只接收已解析的运行注入结果

严禁：

- 在 Team Panel DB 存 raw secret
- 在前端响应中回传 secret
- 在 `run_event` 或 `audit_event` 中写入 secret 值

---

## 8. 归档、软删除、版本化

## 8.1 软删除规则

V1 统一采用 `deleted_at` 软删除，适用于：

- enterprise
- employee
- conversation
- scheduled_job
- 各 binding 表

规则：

- 软删除对象默认不出现在前台列表。
- 历史 run/task/event/audit 不联动删除。
- 软删除后若需要业务归档展示，使用对象自身 `status=archived` 与 `deleted_at` 组合判断。

## 8.2 归档规则

- `employee.status=archived`：员工不可新执行，但历史会话、run、task 仍可查。
- `conversation.status=archived`：会话只读。
- `scheduled_job.status=archived`：job 已停用，不允许恢复。
- `enterprise.status=archived`：租户冻结为只读，后台可查。

## 8.3 版本化规则

V1 只对以下对象做显式版本字段：

- `agent_template.version_no`
- `employee.prompt_version`
- `employee.config_version`
- 各 binding `binding_version`
- `enterprise_connector.rotation_version`

不额外建立通用版本历史表。原因：

- 当前需要的是**可重放 provisioning 与审计**，不是完整时态数据库。
- 版本历史细节由 `audit_event` 记录变更摘要即可。

## 8.4 对运行中对象的版本语义

- 运行中的 `team_run` 固定引用其启动时的员工配置版本。
- 即便之后员工配置更新，历史 run 不回写重算。
- 新 run 使用新的 `config_version` 与 `rotation_version`。

---

## 9. 数据一致性与对账规则

## 9.1 一般一致性原则

- Team Panel 与 Runtime 是**最终一致**，不是分布式事务强一致。
- Team Panel 先落业务记录，再提交 Gateway。
- Gateway 成功拿到 runtime handle 后，回写 `runtime_binding`。
- 若提交后回写失败，系统可通过对账任务修复。

## 9.2 关键写入顺序

### 招募员工

1. 写 `recruitment_order=pending`
2. 写 `employee=draft`
3. 写默认 binding
4. 写 `runtime_binding(owner=employee,pending)`
5. 调 Gateway provision
6. 成功后：`employee=active`、`runtime_binding=synced`
7. 失败后：`employee=provisioning_failed`、`recruitment_order=failed`

### 发起 run

1. 校验员工/会话状态
2. 写 `team_run=queued`
3. 写 `runtime_binding(owner=team_run,pending)`
4. 提交 Gateway
5. 拿到句柄后 `team_run=submitting/running`
6. 事件回流驱动最终状态

## 9.3 对账任务

建议后台定时执行三类 reconciliation job：

### A. profile 对账

检查：

- `employee.status in (active,paused)` 但 profile 不存在
- `runtime_binding(owner=employee).sync_status=failed/orphaned`

处理：

- 标记 `employee.status=provisioning_failed`
- 生成审计事件 `employee.runtime_reconcile_failed`

### B. run 对账

检查：

- `team_run.status in (running,waiting_human,submitting)` 超时未更新
- `runtime_binding` 有 task/session 句柄但 Team Panel 无新事件

处理：

- 按 `event_cursor` 增量补拉
- 若 Runtime 确认结束，修正 `team_run.status`
- 若句柄无效，标记 `runtime_binding=orphaned`

### C. scheduled_job 对账

检查：

- `scheduled_job.enabled` 但 Runtime 无 job
- Runtime 连续失败计数与 Team Panel 不一致

处理：

- 回写 `scheduled_job.status=error` 或 `draft`
- 生成审计事件与运维告警

## 9.4 幂等规则

- 招募：`recruitment_order(enterprise_id,idempotency_key)` 唯一
- 发起 run：`team_run(enterprise_id,idempotency_key)` 唯一
- 事件落库：`run_id + cursor_no` 唯一

## 9.5 冲突处理规则

- Team Panel 配置被更新时，运行中的 run 不中断；仅标记 `runtime_binding(sync_status=dirty)` 用于后续 run。
- 员工被 `paused/archived` 后，已有 run 可继续执行，新的 run 被拒绝。
- connector 认证失败不删除 `credential_ref`，只更新 `enterprise_connector.status=auth_failed`。

---

## 10. 审计字段与可观测性要求

## 10.1 审计字段标准

除 `run_event` 外，所有主业务表至少包含：

- `created_at`
- `updated_at`
- `created_by`
- `updated_by`
- `deleted_at`

说明：

- `created_by/updated_by` 记录 Team Panel 行为责任人，可为 `user:<id>`、`system`、`gateway`。
- `run_event` 使用 `event_ts` 表达原始事件发生时刻，同时保留自身 `created_at` 作为落库时刻。

## 10.2 必须审计的动作

- 企业创建/归档
- 成员角色变更
- 模板发布/退役
- 员工创建、编辑、暂停、归档
- 任意 binding 变更
- connector 创建、换绑、失效、归档
- run 手动取消
- scheduled_job 启停/恢复/归档
- reconciliation 自动修正

## 10.3 原始日志边界

- Team Panel 只保存**摘要、标签、游标、对象关系**。
- 原始 token 流、tool stdout、session message 细节仍在 Hermes / 日志系统中。
- 后台如需跳转深链，应通过 `runtime_binding` 句柄定位，不复制超大日志。

---

## 11. 密钥/凭据引用处理边界

## 11.1 Team Panel 可存内容

- `credential_ref`
- `provider_code`
- `rotation_version`
- 连接器状态
- 授权范围配置

## 11.2 Team Panel 禁止存内容

- API key 明文
- OAuth client secret 明文
- refresh token 明文
- 任何可逆加密后仍由应用直接读取的密文副本

## 11.3 运行注入边界

### 交互式 run

- Gateway 根据 `credential_ref` 解析临时凭据
- 优先进程内 `env overlay`
- 凭据仅在当前 run 生命周期可见

### 无人值守 scheduled_job

- 允许 Gateway 为 profile/job 生成受控 runtime bundle
- 该 bundle 不是 Team Panel 口径
- 其有效性服从 `rotation_version`

## 11.4 审计脱敏规则

- `audit_event.payload_json` 只能记录字段名、provider、版本号、状态码
- `run_event.payload_json` 如包含 tool 参数，必须在 Gateway 侧脱敏

---

## 12. 备份、恢复与迁移说明

## 12.1 备份范围

V1 至少备份：

- Team Panel PostgreSQL 全库
- 审计表与 run_event 表
- 与 Team Panel 关联的 Hermes profile 名单映射快照

不要求 Team Panel 自己备份 Hermes 全部运行目录，但需要可通过 `profile_name` 与 `runtime_*_id` 重新关联。

## 12.2 备份频率建议

- 主库：每日全量 + 小时级 WAL/增量
- `run_event` 可按天分区后冷备
- `audit_event` 至少保留 180 天在线查询，之后冷归档

## 12.3 恢复要求

恢复后必须验证：

- `employee.profile_name` 唯一映射仍成立
- `runtime_binding` 句柄可用于重建跳转关系
- `scheduled_job.runtime_job_id` 与 Runtime 对账后重新校准

## 12.4 迁移策略

### Schema migration

- 使用向前兼容迁移，避免重写历史表
- 所有新增 enum 先通过应用兼容，再执行 DDL
- 迁移脚本必须幂等

### 数据 migration

- 从现有 WebUI session/profile 视图迁移到 Team Panel 时，不直接导入所有 session 为业务会话
- 仅当存在明确 `employee_id/profile_name` 映射时，创建默认私聊 `conversation`

### 大表策略

- `run_event` 建议按月分区或按 `enterprise_id + created_at` 归档
- `audit_event` 可按季度归档

---

## 13. 分阶段实施顺序

## 13.1 Phase 1：租户、模板、员工主数据

目标：先让“招募员工 -> 生成 profile 映射”闭环成立。

范围：

- `enterprise`
- `membership`
- `agent_template`
- `recruitment_order`
- `employee`
- `employee_prompt`
- 4 张 `employee_*_binding`
- `runtime_binding(owner=employee)`

验收：

- 可从模板招募员工
- 可生成唯一 `profile_name`
- provision 成功/失败状态可追踪

## 13.2 Phase 2：私聊容器与单员工 run

范围：

- `conversation`
- `team_run`
- `runtime_binding(owner=team_run)`
- `run_event`
- `audit_event`

验收：

- 每个员工可进入默认私聊
- 发送消息可创建 `team_run`
- 可通过游标补拉事件
- 历史 run 可查

## 13.3 Phase 3：群聊与编排任务树

范围：

- `conversation_member`
- `team_task`
- 群聊路由与编排镜像

验收：

- 群聊可维护成员
- 协作 run 可产生任务树
- Team Panel 能显示 root/child task 时间线

## 13.4 Phase 4：周期任务与 connector 引用

范围：

- `enterprise_connector`
- `employee_connector_binding`
- `scheduled_job`
- 对账任务

验收：

- 员工可绑定连接器引用
- 可创建/暂停/恢复周期任务
- 连续失败转 `error`
- Connector 轮换后新任务使用新版本

## 13.5 Phase 5：归档、后台筛查、数据运维

范围：

- 归档口径完善
- 备份/恢复脚本
- reconciliation jobs
- 审计筛查页

验收：

- 软删除/归档不破坏历史追溯
- 对账能发现 orphaned handle
- 后台可按企业、员工、run、connector 查询

---

## 14. 开发验收检查清单

## 14.1 领域模型验收

- [ ] 员工与 profile 明确分离，前端不把 profile 当业务对象
- [ ] 群聊容器与 run 分离，不把一次消息等同于会话对象
- [ ] TeamTask 仅作业务镜像，不复制 Kanban 全内部图
- [ ] 凭据只以 `credential_ref` 形式进入 Team Panel

## 14.2 数据库验收

- [ ] 所有主表均有主键、必要唯一键、必要索引
- [ ] 所有状态 enum 均有明确执行语义
- [ ] `runtime_binding` 可反查 profile/session/task/job 至少一种句柄
- [ ] `run_event` 支持基于 `cursor_no` 补拉

## 14.3 一致性验收

- [ ] 招募失败可回到 `provisioning_failed`
- [ ] run 提交失败不会产生无状态悬挂记录
- [ ] employee 配置更新可驱动 `sync_status=dirty`
- [ ] scheduled_job 与 Runtime 丢失时可被对账发现

## 14.4 安全与审计验收

- [ ] 数据库中不存在 raw secret 字段
- [ ] 审计事件覆盖关键写操作
- [ ] 事件/日志 payload 已执行脱敏
- [ ] 软删除对象默认不出现在业务列表

## 14.5 运维验收

- [ ] 备份脚本覆盖主库与审计/事件大表
- [ ] 恢复后可通过 `runtime_binding` 重建链接关系
- [ ] run_event / audit_event 有归档策略

---

## 15. 结论

V1 的 Team Panel 数据架构应坚持以下最小闭环：

- 用 `employee` 持有数字员工业务口径
- 用 `conversation + team_run + team_task` 持有交互与协作口径
- 用 `runtime_binding` 持有与 Hermes 的统一 join key
- 用 `run_event + audit_event` 持有回流与治理口径
- 用 `credential_ref` 而不是 secret 持有连接器授权口径

该方案足以启动实现，并能支撑：

- 模板招募
- 员工装配
- 私聊执行
- 群聊编排
- 周期任务
- 审计对账

同时保持 Team Panel 不漂移成第二套 Runtime，Hermes 继续作为唯一执行口径层。