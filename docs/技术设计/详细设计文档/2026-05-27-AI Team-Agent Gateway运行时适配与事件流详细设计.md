---
created: 2026-05-27
updated: 2026-05-28
status: ready-for-development-review
stage: detailed-design
tags: [project, aiteam, technical-design, detailed-design, agent-gateway, runtime-adapter]
canonical_name: 2026-05-27-AI Team-Agent Gateway运行时适配与事件流详细设计
source_docs:
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-27-AI Team-Team Panel与Agent Gateway详细设计方案.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-26-AI Team-技术概要设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-25-AI Team-业务解决方案设计.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/2026-05-28-AI Team-共享运行口径定稿版.md
  - /var/lib/syncthing/Obsidian/Guantik/Projects/aiteam/技术设计/参考文档/Agent Service项目结构与模块功能参考.md
  - /home/ubuntu/code/aiteam/app
  - /home/ubuntu/code/hermes-webui/README.md
  - /home/ubuntu/code/hermes-webui/api/streaming.py
  - ./.hermes/hermes-agent/gateway/platforms/api_server.py
---

# Agent Gateway 运行时适配与事件流详细设计

## 1. 文档目标

本文是 AI Team 技术详细设计阶段的子文档，聚焦 Agent Gateway 模块的内部实现细节，目标为：

1. 明确 Agent Gateway 的角色边界与职责范围
2. 定义 V1 进程内 Python 运行时适配层的实现策略
3. 说明 Hermes Web UI 代码复用与引用的具体边界
4. 设计运行时句柄、事件流、凭据解析、幂等性等核心机制
5. 提供北向/内部接口契约与示例载荷，并与共享运行口径定稿版保持一致

本文档与《详细设计方案》形成父子关系：父文档定义业务对象与高层流程，本文定义 Gateway 内部运行时适配机制。跨文档共享契约（事件协议、游标、主状态机、北向 API、权限角色）统一以《2026-05-28-AI Team-共享运行口径定稿版》为准。

---

## 2. Agent Gateway 角色与边界

### 2.1 定位声明

Agent Gateway 是 Team Panel 与 Agent Runtime 之间的运行时适配层，承担以下核心职责：

| 职责域 | 说明 |
|--------|------|
| 业务对象翻译 | 将 Team Panel 业务对象（Employee/TeamRun/TeamTask）翻译为 Runtime 可执行对象（Profile/Session/Task/Job） |
| Profile 供应 | 根据 EmployeeInstance 配置，确保对应 Hermes Profile 存在且配置同步 |
| 运行提交 | 将业务请求提交至 Runtime 执行入口（单 Agent Run / Kanban Task / Cron Job） |
| 事件回流 | 接收 Runtime 执行事件，转换为 Team Panel 可消费的业务事件 |
| 凭据解析 | 在运行时前解析 Connector Credential，安全注入执行环境 |
| 状态对账 | 通过 runtime_handle 实现 Team Panel 与 Runtime 状态的一致性校验 |

### 2.2 边界划分

Agent Gateway 位于 Team Panel 业务控制层与 Agent Runtime 执行层之间：

- 上游：Team Panel 业务对象（EmployeeInstance, TeamRun, TeamTask, ScheduledJob）
- 内部：Gateway Adapter Core（Profile Provisioner, Runtime Dispatcher, Event Hydrator, Credential Resolver）
- 下游：Agent Runtime 执行入口（AIAgent.run_conversation, Kanban Task dispatcher, Cron Scheduler）

### 2.3 与周边模块的关系

| 模块 | 关系 | 边界说明 |
|------|------|----------|
| Team Panel | 上游调用方 | Gateway 只接受业务对象，不直接面向前端 |
| Agent Runtime | 下游执行方 | Gateway 调用 Runtime 入口，不干预内部执行循环 |
| Agent Service 代码基座 | 同进程宿主/骨架来源 | 以现有 `server.py + api/* + static/*` 为基座，在项目内提取 Gateway 适配层 |
| External Capability | 并行依赖 | 通过 Runtime 间接调用，Gateway 不直接耦合 |

---

## 3. V1 进程内 Python 运行时适配策略

### 3.1 为何采用进程内适配（V1）

基于技术概要设计的工程约束，V1 采用基于 Agent Python SDK 模块的进程内运行时适配层：

1. 降低部署复杂度：无需独立部署 Hermes API Server，减少 V1 基础设施负担
2. 减少序列化开销：Python 对象直接传递，避免 HTTP/JSON 转换损耗
3. 复用现有能力：直接导入 run_agent.AIAgent、hermes_cli.kanban_db、cron.jobs 等模块
4. 渐进式演进：V2 可平滑迁移至独立 HTTP API 模式，接口契约保持不变

### 3.2 Agent Service 基座复用边界

本项目真正的实施目标不是继续直接修改 upstream `hermes-webui` 仓库，而是把其现有实现迁入并二次开发为：

- 目标仓库：`Agent Service`，其在当前仓库中的代码目录为 `/home/ubuntu/code/aiteam/app`
- 运行形态：同一 `server.py` 进程内同时承载 Team Panel HTTP 宿主壳与 Agent Gateway 进程内适配层
- 技术约束：保持 **Python stdlib `http.server` + 原生 JavaScript** 的极简路线，不额外拆出独立 Gateway 服务

| Agent Gateway 所需能力 | 现有基座模块 | 复用方式 | 校准说明 |
|------|------|------|------|
| HTTP 宿主壳 | `server.py` | 直接复用 | Gateway 与 Team Panel 共享同一进程入口，不新增独立网关进程 |
| 单 Agent 流式执行 | `api/streaming.py` | 80% 复用 | 把 `_run_agent_streaming()` 从“当前 active profile”改成接收 `profile_name` / `run_request` 参数 |
| Provider/模型解析 | `api/config.py` | 100% 复用 | 继续复用目录发现、Provider 解析、全局运行态注册表 |
| Profile 路径解析 | `api/profiles.py` | 核心逻辑复用 | 去掉 Cookie 驱动，改为 `employee_id -> profile_name -> profile_home` |
| 审批/中断协议 | `api/routes.py` + `api/streaming.py` | 直接复用 | 保留 approval / cancel 通道，只给事件补业务标签 |
| Cron 提交与输出读取 | `api/routes.py` 中 cron 相关逻辑 | 复用并提取 | 统一抽成 `create_scheduled_job()` / `sync_job_status()` |
| 会话 JSON 存储模式 | `api/models.py` | 模式复用 | 只作为 Conversation→Session 的宿主兼容层，不替代 Team Panel 控制面数据库 |
| Workspace / 上传基础 | `api/workspace.py` / `api/upload.py` | 并行复用 | 由 Team Panel 资产区桥接运行时临时文件，Gateway 只消费解析结果 |

关键原则：Agent Gateway 是 **Agent Service 内部的进程内适配层**。它复用的是 Agent Service 现有 `api/*` 宿主能力，而不是把浏览器 UI 本身当作 Gateway。

### 3.2.1 对扩展开放、对修改封闭的实现约束

Agent Gateway 在代码落地时，默认采用“**适配器扩展优先、基座文件少改**”的实施原则。

#### A. 优先新增包装层，不优先改巨型基座文件

- 单 Agent 执行优先新增 `adapters/single_agent.py`，由 `start_single_agent_run(run_request)` 包装 `_run_agent_streaming()` 或其抽取后的宿主函数。
- 群聊消息接入/编排优先新增 `adapters/group_conversation.py`，由 `start_group_conversation_run(group_request)` 统一承接“群消息进入后路由到单 Agent session 或 orchestrator root task”的运行时接入逻辑。
- 定时任务优先新增 `adapters/scheduled_job.py`，由 `create_scheduled_job(job_request)` 包装 `cron.jobs`。
- 状态查询/补拉优先新增 `event_hydrator.py`、`reconcile.py`，而不是把业务对账逻辑直接塞进 `api/routes.py`。

#### B. 现有基座文件只允许挂接性改造

- `server.py`：允许增加请求分流/挂接点，但不承载 Gateway 业务逻辑。
- `api/routes.py`：允许保留原始宿主端点与 fallback；不再作为 Gateway 新能力的主要承载文件。
- `api/streaming.py`：允许做**适度抽取**，把可复用的线程调度/SSE/取消逻辑提成内部 helper；不应持续堆积业务语义分支。
- `api/profiles.py` / `api/config.py`：继续提供路径解析、Provider 解析、全局状态注册表，不直接承载 Team Panel 业务判断。

#### C. 允许的“适度抽取”边界

如果某项通用底层能力当前与 API 路由写法混得过深，可以做一次轻量抽取，目标是把“**通用底层能力**”和“**HTTP 接口语义**”分开。典型场景：

- 把 `_run_agent_streaming()` 中可复用的线程启动 / queue / cancel / env 保护逻辑提取成内部 helper
- 把 cron 创建/触发/输出读取中的公共逻辑提取成内部服务函数
- 把 approval / cancel 的宿主协议保留为通道能力，再由 Gateway 统一包装为运行句柄控制接口

这里的抽取目标是**复用同一份底层能力**，不是复制同等逻辑到第二份文件里。

#### D. 明确禁止

- 不复制一整份 `api/streaming.py` 或 `api/routes.py` 再平行维护。
- 不让 Gateway 对外正式契约继续直接暴露为 `/api/chat/start` 之类宿主端点。
- 不在多个文件中各自维护一套 `STREAMS` / `CANCEL_FLAGS` / `SESSION_AGENT_LOCKS` 口径。

### 3.3 运行时入口点

Gateway 内部通过以下 Runtime 入口点执行：

```python
# 单 Agent 执行入口
from run_agent import AIAgent
agent = AIAgent(
    model=..., 
    session_id=...,
    platform="api_server",
    # ... 其他配置
)
result = agent.run_conversation(user_message, conversation_history)

# Kanban 编排入口
from hermes_cli.kanban_db import create_task, dispatch_once
task = create_task(profile_name, goal, context, assignee="orchestrator")
dispatch_once(task.task_id)

# Cron 定时任务入口
from cron.jobs import create_job, run_job
job = create_job(profile_name, schedule, prompt)
run_job(job.job_id)
```

---

## 4. 内部子模块设计

### 4.1 子模块划分

建议按 Agent Service 项目内部模块落点组织：

```text
app/
├── team-panel/
│   └── api_team/                 # Team Panel 北向业务 API，调用 Gateway 能力
├── agent-gateway/
│   ├── __init__.py
│   ├── adapter_core.py           # Gateway Adapter 主入口
│   ├── runtime_dispatcher.py     # 运行提交与分发
│   ├── event_hydrator.py         # 事件回流与补拉
│   ├── reconcile.py              # 状态对账与恢复
│   ├── runtime_handle.py         # 运行时句柄管理
│   ├── models.py                 # Gateway 内部数据模型
│   ├── adapters/
│   │   ├── single_agent.py       # RunRequest -> AIAgent.run_conversation()
│   │   ├── group_conversation.py # GroupConversationRunRequest -> session 或 orchestrator root task
│   │   └── scheduled_job.py      # ScheduledJobRequest -> cron.jobs
│   └── profiles/
│       ├── provisioner.py        # Profile 供应与同步
│       └── credential_resolver.py# 凭据解析与注入
└── api/
    ├── streaming.py              # 复用的 SSE / Agent thread 基座
    ├── config.py                 # 复用的 Provider / 全局状态基座
    └── profiles.py               # 复用的 profile 路径解析基座
```

### 4.2 Profile Provisioner（供应器）

负责将 EmployeeInstance 映射为 Hermes Profile。

```python
class ProfileProvisioner:
    def ensure_profile(self, employee: EmployeeInstance) -> ProfileProvisionResult:
        """确保员工对应的 Profile 存在且配置最新"""
        pass
    
    def sync_employee_to_profile(self, employee: EmployeeInstance) -> ConfigPatch:
        """将员工配置同步到 Profile"""
        pass
```

### 4.3 Runtime Dispatcher（分发器）

负责将业务请求分发到正确的 Runtime 入口。

```python
class RuntimeDispatcher:
    def dispatch_single_agent(self, request: SingleAgentRunRequest) -> RuntimeHandle:
        """分发单 Agent 执行请求"""
        pass
    
    def dispatch_orchestrator(self, request: OrchestrationRequest) -> RuntimeHandle:
        """分发编排任务，创建 orchestrator 根任务"""
        pass
    
    def dispatch_scheduled_job(self, request: ScheduledJobRequest) -> RuntimeHandle:
        """分发定时任务，创建 cron job"""
        pass
```

### 4.4 Event Hydrator（事件水合器）

负责从 Runtime 拉取事件并转换为业务事件。

```python
class EventHydrator:
    def hydrate_events(self, handle: RuntimeHandle, cursor: str) -> List[RunTimelineEvent]:
        """从 Runtime 拉取自 cursor 之后的事件"""
        pass
    
    def subscribe_stream(self, handle: RuntimeHandle, callback: EventCallback) -> StreamSubscription:
        """订阅实时事件流（SSE 模式）"""
        pass
```

---

## 5. 运行时句柄（Runtime Handle）设计

### 5.1 设计目标

Runtime Handle 是 Team Panel 与 Runtime 之间的最小可检索句柄集合，用于：
- 断流后恢复事件订阅
- 状态对账与修复
- 审计追溯

### 5.2 数据结构

```python
@dataclass
class RuntimeHandle:
    """运行时句柄 - Team Panel 与 Runtime 对账的最小标识集合（口径以《2026-05-28-AI Team-共享运行口径定稿版》为准）"""\    
    # 业务标识
    enterprise_id: str
    employee_id: str
    run_id: str
    
    # Runtime 标识（至少填一项）
    profile_name: Optional[str] = None
    session_id: Optional[str] = None      # 单 Agent Run / 私聊
    task_id: Optional[str] = None         # Kanban Task / 编排
    job_id: Optional[str] = None            # Cron Job / Loop
    
    # 句柄类型
    kind: Literal["session", "kanban_task", "cron_job", "composite"] = "session"
    
    # 注：event_cursor 不属于 RuntimeHandle，只属于 stream/events 协议、run_event.cursor_no、runtime_binding 对账字段。
    # Gateway 内部如需维护 runtime_source_cursor（如 {timestamp}-{sequence}），应作为私有字段，不进入北向 DTO。
```

### 5.3 句柄生成规则

| 执行类型 | kind | 必填字段 | 生成时机 |
|----------|------|----------|----------|
| 单 Agent 私聊 | session | profile_name, session_id | Gateway 调用 run_conversation 前 |
| 单 Agent 群聊 | session | profile_name, session_id | Gateway 确定路由后 |
| Orchestrator 编排 | kanban_task | profile_name, task_id | create_task 成功后 |
| Worker 子任务 | kanban_task | profile_name, task_id | orchestrator 拆出任务时 |
| 定时任务 | cron_job | profile_name, job_id | create_job 成功后 |

---

## 6. Profile 供应流程

### 6.1 供应流程

EmployeeInstance 经过以下步骤映射为 Hermes Profile：
1. 检查 Profile 是否存在（~/.hermes/profiles/{profile_name}/）
2. 若不存在，创建 Profile 目录结构（config.yaml, .env, skills/, memories/, sessions/, cron/）
3. 同步配置：prompt -> SOUL.md/AGENT.md；model_ref -> config.yaml；skill_bindings -> skills/；memory_policy -> memories/
4. 生成 CredentialResolutionPlan（暂不写入 .env，运行时注入）

### 6.2 Profile 命名规则

```
{enterprise_id}-{employee_role}-{sequence}

示例：
- ent001-marketing-001
- ent001-finance-003
- ent001-orchestrator-default
```

### 6.3 配置同步策略

| Employee 配置项 | Profile 落点 | 同步方式 |
|-----------------|--------------|----------|
| prompt | SOUL.md / AGENT.md | 文件覆盖 |
| model_ref | config.yaml 的 model | 配置合并 |
| skill_bindings | skills/ 目录 + allowlist | 增量同步 |
| memory_policy | memories/ 配置 | 配置更新 |
| connector_bindings | 运行时注入 | 不持久化到文件 |

---

## 7. 连接器凭据解析路径

### 7.1 凭据管理架构

Team Panel Secret Store（密钥权威口径源）
    |
    | credential_ref (只存引用)
    ▼
EmployeeInstance.connector_bindings
    |
    | CredentialResolutionPlan
    ▼
Gateway CredentialResolver
    |
    ├─ 交互式 Run ──► 进程内 env overlay（secret 不落盘）
    |
    └─ Scheduled Job ──► Profile-scoped 安全 bundle（落盘权限 0600，带 rotation_version）

### 7.2 CredentialResolutionPlan

```python
@dataclass
class CredentialResolutionPlan:
    """凭据解析计划"""
    
    enterprise_id: str
    employee_id: str
    credential_ref: str              # Team Panel 凭据引用 ID
    connector_id: str
    
    injection_mode: Literal["env_overlay", "file_bundle", "mcp_proxy"]
    runtime_target: Literal["single_agent_run", "scheduled_job", "orchestrator_task"]
    alias_env: Dict[str, str]        # 环境变量映射
    rotation_version: int            # 凭据轮换版本号
    scope: Literal["enterprise", "employee"]
```

### 7.3 安全约束

1. 前端不可见：浏览器永不接收 raw secret
2. 日志不回显：任何日志、审计记录只存 credential_ref，不存密文
3. 最小权限：Scheduled Job 落盘时权限 0600，仅 profile 用户可读
4. 版本隔离：凭据轮换后，旧版本 job 继续使用旧凭据，新版本使用新凭据

---

## 8. 执行路径详细设计

### 8.1 单 Agent Run 路径

User Request (Team Panel)
    |
    ▼
POST /api/team/runs
    |
    ▼
Gateway Adapter
    ├─ 1. 验证 employee 状态
    ├─ 2. 调用 ProfileProvisioner.ensure_profile()
    ├─ 3. 调用 CredentialResolver.resolve() 生成 env overlay
    ├─ 4. 创建 RuntimeHandle (kind=session)
    |
    ▼
Runtime Dispatcher
    ├─ 创建 AIAgent 实例
    ├─ 注入环境变量 (env_overlay)
    ├─ 启动后台线程执行 run_conversation()
    |
    ▼
Event Hydrator
    ├─ 捕获 token/tool/reasoning 事件
    ├─ 转换为 RunTimelineEvent
    ├─ 写入 Team Panel Event Store
    |
    ▼
SSE Stream (to Frontend)

### 8.2 群聊消息运行时接入路径（Group Conversation Ingress）

本节只定义 **Agent Gateway 如何承接 Team Panel 已完成持久化与路由判断后的群消息运行请求**，不展开浏览器原生群聊的完整业务流程、UI 合并规则与会话治理语义。完整群聊主流程以《2026-05-27-AI Team-会话群聊编排Loop核心流程详细设计》`8.2 浏览器原生群聊主流程（TeamConversation）` 为准。

Gateway 在群聊场景下的职责不是重新定义“群聊是什么”，而是把 Team Panel 的 `route_decision` 翻译成 **可执行的 Runtime 入口**：

- `single_agent` → 单 Agent session 执行路径
- `orchestration` → orchestrator root task / Kanban 执行路径

```text
Group Message (already persisted by Team Panel)
    |
    ▼
GroupConversationRunRequest
    ├─ conversation_id
    ├─ message_id
    ├─ run_id
    ├─ route_decision(route_mode, target_employee_ids, planner_employee_id?)
    └─ runtime_context
    |
    ▼
Gateway Adapter.start_group_conversation_run()
    ├─ 校验 TeamRun / Conversation / route_decision 已存在
    ├─ 解析 route_mode
    |
    ├─ route_mode = single_agent
    |    ├─ ensure_profile(entry_employee)
    |    ├─ resolve_connectors(runtime_target=session)
    |    ├─ 创建 RuntimeHandle(kind=session)
    |    └─ 转 Runtime Dispatcher.start_single_agent_run()
    |
    └─ route_mode = orchestration
         ├─ ensure_profile(orchestrator or planner employee)
         ├─ resolve_connectors(runtime_target=orchestrator_task)
         ├─ 创建 RuntimeHandle(kind=kanban_task)
         └─ 转 Runtime Dispatcher.submit_orchestrator_root_task()
```

设计口径：

1. `GroupConversationRunRequest` 是 **Gateway 内部适配请求**，不是浏览器北向 API 直接契约。
2. 群聊完整业务流程（成员管理、消息合并、任务树展示、群状态收口）由 Team Panel 控制面定义，Gateway 只承接运行时接入。
3. `route_decision` 的生成权在 Team Panel；Gateway 只消费 `route_mode` 与目标员工集合，不在此层重做业务路由。
4. 群聊场景并不天然等于编排；只有 `route_mode=orchestration` 时，Gateway 才进入 root-task / worker-task 路径。

### 8.3 编排执行路径（Orchestrator / Kanban）

关键设计：AI Team 不自造 worker 协议，复用 Hermes Kanban 机制。

| 概念 | AI Team 层 | Hermes 层 |
|------|-----------|-----------|
| 任务定义 | TeamTask | kanban_db.Task |
| 任务关系 | WorkflowStep.parents[] | task_links |
| 执行者 | assignee_employee_id | Task.assignee (profile_name) |
| 任务状态 | TeamTask.status | Task.status + Event 聚合 |
| 结果回写 | RunTimelineEvent | kanban-worker 技能 |

orchestrator 根任务输入示例：
```json
{
  "goal": "用户原始请求",
  "context": "群聊上下文",
  "candidate_employees": [
    {"employee_id": "emp_001", "profile_name": "ent001-marketing-001", "capabilities": []},
    {"employee_id": "emp_002", "profile_name": "ent001-finance-001", "capabilities": []}
  ],
  "collaboration_template_ref": "tpl_default_marketing_review"
}
```

### 8.4 Scheduled Job 路径

ScheduledJob (Team Panel)
    |
    ▼
Gateway Adapter
    ├─ 验证 employee 状态
    ├─ 生成 cron 表达式
    ├─ 创建 RuntimeHandle (kind=cron_job)
    |
    ▼
Runtime Dispatcher
    ├─ create_job(profile_name, schedule, prompt)
    ├─ RuntimeHandle.job_id = job.job_id
    |
    ▼
Cron Scheduler
    ├─ tick() 触发执行
    ├─ 调用 AIAgent.run_conversation() 或 kanban task
    |
    ▼
Event Hydrator
    ├─ 捕获 job 执行事件
    └─ 更新 ScheduledJobRunRecord

---

## 9. 事件水合与回放游标模型

### 9.1 事件溯源架构

Runtime Events (Source of Truth)
    |
    ├─ Agent 执行事件 (token, tool, reasoning)
    ├─ Kanban 任务事件 (spawned, assigned, started, completed)
    ├─ Cron 调度事件 (triggered, succeeded, failed)
    |
    ▼
Event Hydrator (Gateway 层)
    ├─ 事件标准化 (转换为 RunTimelineEvent)
    ├─ 业务标签注入 (enterprise_id, employee_id, run_id)
    ├─ 持久化到 Team Panel Event Store
    |
    ▼
Team Panel Event Store
    ├─ 支持游标查询 (event_cursor)
    ├─ 支持时间范围查询
    ├─ 支持 run_id 聚合
    |
    ▼
Frontend (SSE / Poll)

### 9.2 Event Cursor 设计

对外正式口径采用 **numeric cursor**：

- `event_cursor: bigint`
- 同一 `run_id` 下单调递增
- 前端建立流、断流补拉、分页回放统一使用 numeric cursor

Gateway 内部若需要保留 Runtime 原始游标（例如 `{timestamp}-{sequence}`），应作为 `runtime_source_cursor` 保存，只用于内部恢复，不作为北向 API 契约。

```python
def allocate_event_cursor(run_id: str, previous_cursor: int | None) -> int:
    if previous_cursor is None:
        return 1
    return previous_cursor + 1
```

### 9.3 断流恢复机制

```python
class EventHydrator:
    def recover_stream(self, handle: RuntimeHandle, last_cursor: int) -> List[RunTimelineEvent]:
        """断流后恢复事件流"""
        # 1. 查询本地 Event Store
        local_events = self.event_store.query_after(handle.run_id, last_cursor)
        
        # 2. 检查是否连续
        if not self._is_continuous(last_cursor, local_events):
            # 从 Runtime 补拉
            runtime_events = self._pull_from_runtime(handle, last_cursor)
            self.event_store.insert_batch(runtime_events)
            local_events = self.event_store.query_after(handle.run_id, last_cursor)
        
        return local_events
```

### 9.4 Event Store 写入策略

V1 采用 内存队列 + PostgreSQL 批量写入 模式，不引入 Redis 等额外中间件。

选型决策：

- V1 并发量：单进程 agent service，预期 < 50 并发 run
- 单 run 事件量：私聊 100-500 条，编排 500-2000 条
- 批量写入：每 1 秒或累积 50 条触发一次批量 INSERT
- 补拉频率：断流是小概率事件，不影响热路径
- 组件复杂度：不引入 Redis，减少 V1 运维成本
- PostgreSQL 吞吐：批量 INSERT 5000+ TPS，V1 场景充裕

为何不引入 Redis：

- V1 并发量不足以消耗 PG 写入吞吐，Redis 的 10万+ TPS 为过度设计
- 引入 Redis 增加部署、监控、故障排查的运维复杂度
- PG 天然满足审计合规、复杂查询（按 employee_id / event_type / 时间范围筛选）、多租户隔离
- V2 若规模增长，可通过 Redis + PG 双轨架构扩展（见 9.5 节）

写入流程：

```python
class EventHydrator:
    def __init__(self):
        self.pending_batch: List[RunTimelineEvent] = []
        self.batch_lock = threading.Lock()
        self.sse_queue = queue.Queue(maxsize=2000)
    
    def push_event(self, event: RunTimelineEvent):
        # 1. SSE 实时推送（不等待 DB）
        try:
            self.sse_queue.put_nowait(event)
        except queue.Full:
            if event.event_type == "heartbeat":
                return
            self.sse_queue.put_nowait(event)
        
        # 2. 累积到批量写入缓冲
        with self.batch_lock:
            self.pending_batch.append(event)
            if len(self.pending_batch) >= 50:
                self._schedule_flush()
    
    def _schedule_flush(self):
        batch = self.pending_batch[:]
        self.pending_batch = []
        threading.Thread(
            target=self._write_batch_to_pg,
            args=(batch,), daemon=True,
        ).start()
```

设计约束：

- SSE 推送不等待 DB：push_event() 先入队再异步写，推送延迟不受 DB 影响
- 批量大小 = 50：兼顾延迟（缓冲最多 50 条）和写入效率
- 队列上限 = 2000：maxsize 防止内存泄漏，满时丢弃 heartbeat
- ON CONFLICT DO NOTHING：cursor_no 唯一约束下避免重复写入
- 异步写入线程：批量写入在独立线程执行，不阻塞 agent 主循环

断流补拉查询路径：

```
GET /api/team/runs/{run_id}/events?cursor=129&limit=100
  -> SELECT * FROM run_event
    WHERE run_id = ? AND cursor_no > 129
    ORDER BY cursor_no ASC
    LIMIT 100
```

查询走唯一键 uk_run_event_run_cursor(run_id, cursor_no)。

### 9.5 V2 演进路径

若 V2 需支撑 100+ 并发 run 或复杂编排，可扩展为双轨架构：

```
Runtime -> Redis Stream -> SSE（毫秒级，MAXLEN=500）
                 ↓ 异步下沉
            PG run_event（审计、归档、复杂查询）
                 ↓ 30天归档
            S3 / 冷备
```

补拉路径升级为：先查 Redis Stream，已清空时查 PG。

V1 设计已预留接口兼容：EventHydrator 的 push_event() 和 recover_stream() 签名不变，仅实现层切换。

---

## 10. 对账与恢复路径

### 10.1 Reconcile 触发时机

1. 定时对账：每 5 分钟扫描 status=running 的 TeamRun
2. 断流恢复：SSE 重连后自动触发
3. 人工触发：后台管理界面提供"刷新状态"按钮
4. 启动对账：Gateway 重启后扫描未闭环 run

### 10.2 Reconcile 流程

```python
class Reconciler:
    def reconcile_run(self, team_run: TeamRun) -> ReconcileResult:
        handle = team_run.runtime_handle
        
        if handle.kind == "session":
            runtime_status = self._query_session_status(handle.session_id)
        elif handle.kind == "kanban_task":
            runtime_status = self._query_task_status(handle.task_id)
        elif handle.kind == "cron_job":
            runtime_status = self._query_job_status(handle.job_id)
        
        # 状态对齐
        if runtime_status.is_terminal and team_run.status not in terminal_statuses:
            self._sync_terminal_state(team_run, runtime_status)
            return ReconcileResult(action="synced", status=runtime_status.status)
        
        elif not runtime_status.is_terminal and team_run.status in terminal_statuses:
            self._handle_divergence(team_run, runtime_status)
            return ReconcileResult(action="divergence_detected", requires_manual_review=True)
        
        return ReconcileResult(action="no_op")
```

### 10.3 补偿机制

| 场景 | 检测方式 | 补偿动作 |
|------|----------|----------|
| Runtime 成功，Team Panel 未更新 | Reconcile 扫描 | 补写 Team Panel 状态，触发回调 |
| Runtime 失败，Team Panel 未更新 | Reconcile 扫描 | 补写失败状态，记录错误日志 |
| Team Panel 取消，Runtime 未停止 | Reconcile 扫描 | 调用 Runtime 取消接口 |
| 事件丢失 | Cursor 连续性检查 | 从 Runtime 补拉事件 |

---

## 11. 北向归属与内部接口设计

### 11.1 北向接口归属说明

本文件不重复定义 Team Panel 北向 REST / SSE 正式契约。相关权威口径归属如下：

- 浏览器可见北向 API（如 `POST /api/team/runs`、`POST /api/team/group-conversations/{conversation_id}/messages`）以《2026-05-27-AI Team-前端页面与接口契约详细设计》为主。
- 跨文档共享的固定请求/响应字段、SSE 事件 envelope、cursor 语义，以《2026-05-28-AI Team-共享运行口径定稿版》为唯一裁决口径。
- 本文只定义 Team Panel 服务层调用 Gateway 时的 **内部适配接口** 与其运行时执行语义。

换言之：

- `前端 -> Team Panel API` 属于业务北向契约；
- `Team Panel Service -> Gateway Adapter` 属于服务内适配契约；
- `Gateway -> Runtime` 属于运行时接入契约。

### 11.2 Gateway 内部适配接口

这些接口为服务内可见，不直接暴露给浏览器：

```python
class GatewayAdapter:
    """Gateway 内部适配接口 - 供 Team Panel 服务层调用"""
    
    async def ensure_profile(self, employee: EmployeeInstance) -> ProfileProvisionResult:
        """确保员工对应的 Profile 存在且配置最新"""
        pass
    
    async def resolve_connectors(
        self, employee_id: str, runtime_target: str
    ) -> List[CredentialResolutionPlan]:
        """解析员工可用的连接器凭据"""
        pass
    
    async def start_single_agent_run(self, request: SingleAgentRunRequest) -> RuntimeHandle:
        """启动单 Agent 执行"""
        pass
    
    async def start_group_conversation_run(
        self, request: GroupConversationRunRequest
    ) -> RuntimeHandle:
        """承接群消息运行请求，并按 route_mode 接入单 Agent 或 orchestrator 路径"""
        pass
    
    async def submit_orchestrator_root_task(
        self, request: OrchestrationRequest
    ) -> RuntimeHandle:
        """提交编排任务，创建 orchestrator 根任务"""
        pass
    
    async def create_scheduled_job(
        self, request: ScheduledJobRequest
    ) -> RuntimeHandle:
        """创建定时任务"""
        pass
    
    async def hydrate_runtime_events(
        self, handle: RuntimeHandle, cursor: Optional[int] = None
    ) -> List[RunTimelineEvent]:
        """从 Runtime 拉取事件，支持断流后补拉"""
        pass
    
    async def reconcile_runtime_state(
        self, handle: RuntimeHandle
    ) -> ReconcileResult:
        """对账 Runtime 状态与 Team Panel 状态"""
        pass
```

---

## 12. 幂等性、错误与超时语义

### 12.1 幂等性设计

所有创建型接口必须接受 idempotency_key：

```python
@dataclass
class IdempotencyContext:
    key: str                    # 调用方提供的幂等键
    fingerprint: str            # 请求指纹（关键字段哈希）
    ttl_seconds: int = 300      # 幂等窗口
```

幂等键作用域：enterprise_id + idempotency_key

### 12.2 错误码定义

| 错误码 | 场景 | HTTP 状态 | 前端处理建议 |
|--------|------|-----------|--------------|
| VALIDATION_FAILED | 请求参数校验失败 | 400 | 提示用户修正输入 |
| PERMISSION_DENIED | 无权访问该员工/资源 | 403 | 跳转权限申请 |
| PROFILE_NOT_READY | Profile 供应中，暂不可执行 | 409 | 显示加载中，轮询重试 |
| CONNECTOR_UNAUTHORIZED | 连接器凭据失效 | 402 | 提示重新授权 |
| RUNTIME_REJECTED | Runtime 拒绝执行（如余额不足） | 503 | 提示充值/联系管理员 |
| RUNTIME_NOT_FOUND | Runtime handle 指向的对象不存在 | 404 | 触发对账流程 |
| USAGE_PENDING | 用量统计尚未完成 | 202 | 异步等待 |
| IDEMPOTENCY_KEY_CONFLICT | 幂等键冲突 | 409 | 使用新 key 重试 |

### 12.3 超时策略

| 阶段 | 超时 | 行为 |
|------|------|------|
| 北向创建接口 | 15s | 必须返回 run_id 或明确错误 |
| Profile 供应 | 30s | 超时返回 PROFILE_NOT_READY，后台继续 |
| SSE 首事件 | 10s | 返回 runtime_handle，前端进入等待态 |
| SSE idle 心跳 | 15s | 发送 keepalive 注释行 |
| 断流补拉 | 60s | 允许从 event_cursor 恢复 |
| 单次 LLM 调用 | 120s | 由 Runtime 控制，Gateway 透传 |

---

## 13. 可观测性与审计

### 13.1 日志分层

| 层级 | 存储位置 | 内容 | 保留策略 |
|------|----------|------|----------|
| Runtime 原始日志 | ~/.hermes/logs/ | agent.log, gateway.log, errors.log | 7 天滚动 |
| Gateway 适配日志 | Team Panel 日志库 | 业务对象翻译、Runtime 调用 | 30 天 |
| 审计事件 | Team Panel 审计库 | 谁、何时、做了什么操作 | 90 天 |
| 业务事件 | Team Panel Event Store | RunTimelineEvent | 30 天 |

### 13.2 关键审计字段

每条审计记录必须包含：

```json
{
  "audit_id": "aud_001",
  "enterprise_id": "ent_001",
  "actor_type": "user|system|employee",
  "actor_id": "usr_001",
  "action": "run_created|employee_recruited|connector_authorized",
  "target_type": "run|employee|connector",
  "target_id": "run_001",
  "payload_ref": "evt_000128",
  "runtime_context": {
    "profile_name": "ent001-marketing-001",
    "session_id": "sess_abc123",
    "task_id": null,
    "job_id": null
  },
  "created_at": "2026-05-27T10:30:00Z",
  "client_ip": "...",
  "user_agent": "..."
}
```

### 13.3 监控指标

| 指标名 | 类型 | 说明 |
|--------|------|------|
| gateway_run_created_total | Counter | 创建的 Run 总数 |
| gateway_run_latency_seconds | Histogram | Run 创建到首事件延迟 |
| gateway_event_hydrated_total | Counter | 水合的事件总数 |
| gateway_reconcile_runs_total | Counter | 对账扫描的 Run 数 |
| gateway_reconcile_mismatches_total | Counter | 发现的差异数 |
| gateway_profile_provision_duration_seconds | Histogram | Profile 供应耗时 |
| gateway_credential_resolution_duration_seconds | Histogram | 凭据解析耗时 |

---

## 14. 安全边界

### 14.1 租户隔离

1. Profile 隔离：每个企业使用独立的 Profile 命名空间
2. 凭据隔离：credential_ref 按 enterprise_id 分区
3. 事件隔离：Event Store 查询必须带 enterprise_id 过滤
4. 运行时隔离：不同企业的 Agent 运行在不同的 Profile 上下文中

### 14.2 数据流安全

关键约束：
- 前端永不直接访问 Runtime
- Gateway 永不向前端返回 raw secret
- 所有 Runtime 调用必须经过鉴权

### 14.3 连接器安全

| 场景 | 安全策略 |
|------|----------|
| OAuth 授权 | 使用 PKCE 流程，token 存储在 Team Panel Secret Store |
| API Key | 仅存储引用，运行时通过 CredentialResolver 注入 |
| MCP 服务 | 通过本地 socket 或受控端口通信，不暴露公网 |

---

## 15. 扩展路径：未来 HTTP/API 模式

### 15.1 演进路径

V1（当前）：进程内 Python 模块调用
Team Panel -> Gateway Adapter -> import AIAgent -> Runtime

V2（未来）：独立 HTTP API 模式
Team Panel -> Gateway Adapter -> HTTP /v1/runs -> Hermes API Server -> Runtime

### 15.2 接口契约兼容性

Gateway 内部接口（internal_api.py）在 V2 保持不变，仅实现层替换：

```python
# V1 实现（进程内）
class InProcessGatewayAdapter(GatewayAdapter):
    def start_single_agent_run(self, request):
        agent = AIAgent(...)
        return agent.run_conversation(...)

# V2 实现（HTTP）
class HTTPGatewayAdapter(GatewayAdapter):
    def start_single_agent_run(self, request):
        resp = httpx.post(f"{HERMES_API}/v1/runs", json=request.to_dict())
        return RuntimeHandle.from_response(resp.json())
```

### 15.3 迁移策略

1. 配置切换：通过环境变量 GATEWAY_MODE=process|http 切换
2. 灰度发布：按企业逐步迁移至 HTTP 模式
3. 回滚能力：保持进程内实现作为 fallback

---

## 16. 术语对照表

| AI Team 术语 | Hermes 术语 | 说明 |
|--------------|-------------|------|
| EmployeeInstance | Profile | 数字员工业务对象 vs 运行时容器 |
| TeamRun | Session / Task | 一次执行实例 |
| TeamTask | Kanban Task | 编排任务节点 |
| ScheduledJob | Cron Job | 定时任务 |
| PrivateConversation | Session | 私聊会话 |
| GroupConversation | Session + 业务层 | 群聊容器 |
| ConnectorBinding | Tool / MCP | 连接器绑定 |
| SkillBinding | Skill / Toolset | 技能绑定 |
| KnowledgeBinding | Knowledge Reference | 知识库绑定 |
| RuntimeHandle | session_id / task_id / job_id | 运行时句柄 |
| Event Cursor | event_id / timestamp | 事件游标 |

---

## 17. 参考文档

1. Team Panel 与 Agent Gateway 详细设计方案
2. AI Team 技术概要设计
3. AI Team 业务解决方案设计
4. Hermes Web UI 源码：/home/ubuntu/code/hermes-webui/
5. Hermes Agent 源码：./.hermes/hermes-agent/

---

## 18. 变更记录

| 版本 | 日期 | 变更内容 | 作者 |
|------|------|----------|------|
| 0.1 | 2026-05-27 | 初始版本 | AI Team |
