# 自动化 Tab 功能方案

> 文档定位：前端自动化 Tab 的产品与实现方案。
>
> 文档约定：后续自动化功能的设计、实现说明、联调记录和验收文档统一放在 `clients/desktop/docs/` 目录下。

## 一、现状判断

当前代码库存在两套前端状态：

### 1. `AITeam` 前端仍是功能预览

`clients/desktop/src/pages/AutoTasks/index.tsx` 目前：

- 仅展示“每日简报、每周回顾、项目监控”等模板；
- 创建按钮被禁用；
- 页面明确提示调度器、触发条件、执行日志和创建接口尚未接入；
- 没有真实任务列表、详情、编辑、运行历史和接口调用。

相关文档：

- `docs/design/new_design.md`：任务卡片、分类筛选、详情页和创建流程设计；
- `clients/desktop/docs/automation-tasks-api.md`：自动化任务 API 契约；
- `docs/design/design_gaps.md`、`docs/archive/todo.md`：自动化模块此前的建设缺口。

### 2. `FredServer/web/agent` 已有可用实现

后端近期提交：

- `68da68f4 feat(agent): integrate automation tasks with local schedules and Pi sessions`
- `84206a94 fix(agent): preserve selected timezone and verify task lifecycle integration`
- `4cc65157 test(agent): align task regression assertions with testing library types`

已经落地：

- `/tasks` 路由和导航入口；
- 任务列表、搜索、分类、状态筛选；
- 新建和编辑任务；
- 单次、固定间隔、每天、每周、每月五种调度；
- IANA 时区处理；
- 任务启用、暂停、软删除；
- ETag / `If-Match` 并发控制；
- `Idempotency-Key` 创建幂等；
- 执行员工和本地连接器选择；
- 任务详情与运行记录；
- 从任务页跳转到对应聊天会话和审批；
- 与既有聊天调度、Office 调度统一。

因此，自动化 Tab 不应继续按“预览功能”重新设计，而应以 `FredServer` 已实现的任务模型和 API 为实际基线，将 `AITeam` 前端切换为真实任务管理页面。

---

## 二、产品定位

自动化 Tab 的核心定位是：

> 让用户创建一个由指定 AI 员工按照时间规则自动执行的工作安排，并查看任务的执行状态、结果和历史会话。

首期不扩展成完整的通用工作流编排器，也不引入第二套执行引擎。

### 首期支持范围

| 能力 | 支持情况 |
| --- | --- |
| 单次执行 | 支持 |
| 固定间隔 | 支持 |
| 每日执行 | 支持 |
| 每周执行 | 支持 |
| 每月执行 | 支持，不存在的日期跳过 |
| 时区 | 支持 IANA 时区 |
| AI 员工 | 支持选择当前成员可用员工 |
| MCP 连接器 | 支持选择本地已安装且授权的连接器 |
| 暂停 / 启用 | 支持 |
| 删除 | 软删除，保留历史 |
| 执行记录 | 支持 |
| 结果会话 | 支持跳转 |
| Webhook 触发 | 暂不支持 |
| 任意事件触发 | 暂不支持 |
| 可视化多步骤工作流 | 暂不支持 |

设计文档中的事件触发、Webhook、可视化流程步骤放入后续版本，不在当前 Tab 中伪装成已实现能力。

---

## 三、信息架构

### 1. 页面入口

保留主导航入口：

```text
自动化任务
```

建议 URL：

```text
/tasks
```

从已有功能进入指定任务时使用：

```text
/tasks?conversation_id={conversation_id}
```

联动入口包括：

- 员工详情 → 自动化任务；
- 聊天页调度配置 → 自动化任务；
- Office 定时任务 → 自动化任务；
- 运行记录 → 对应聊天会话。

### 2. 页面布局

采用“左侧任务列表 + 右侧详情/编辑区”，比纯卡片网格更适合当前后端能力：

```text
┌──────────────────────────────────────────────────────┐
│ 自动化任务                              [+ 新建任务] │
│ 任务在本机运行，需要 Agent 在线且保持登录             │
├──────────────────────┬───────────────────────────────┤
│ 搜索                 │ 任务详情                       │
│ 分类                 │                               │
│ 状态                 │ 任务名称                       │
│ 员工                 │ 执行指令                       │
│                      │ 执行员工 / 连接器              │
│ 任务卡片列表         │ 调度信息                       │
│                      │ 状态与操作                     │
│                      │ 运行记录                       │
└──────────────────────┴───────────────────────────────┘
```

### 3. 任务卡片字段

每个任务至少展示：

- 任务名称；
- 执行员工；
- 任务分类；
- 当前状态：启用中、已暂停、已完成；
- 调度摘要：每天、每周、每月、固定间隔或单次；
- 下一次执行时间；
- 上次运行结果；
- 阻塞原因。

任务状态和运行状态必须区分：

```text
任务状态：active / paused / completed
运行状态：queued / blocked / running / succeeded / error / aborted / unknown
```

不能把最近一次运行失败直接等同于任务状态 `failed`。

---

## 四、新建任务流程

当前实现可使用单页表单，保留设计文档中的五步信息结构。

### Step 1：基本信息

字段：

- 任务名称，1–120 字符；
- 执行指令，1–20,000 字符；
- 分类：报告、监控、提醒、其他。

列表接口仅返回 `prompt_summary`，详情接口再加载完整 `prompt`。

### Step 2：选择执行员工

只展示当前成员有权限使用、且未撤销的员工。

约束：

- 后端根据 token 推导 tenant/member；
- 前端不得传 tenant_id 或 member_id 覆盖权限；
- 员工切换可能需要建立新的执行会话；
- 原会话和历史执行记录必须保留。

### Step 3：选择连接器

通过以下接口加载：

```http
GET /api/agent/connectors?employee_id={employee_id}&status=enabled
```

只展示当前成员已授权、当前员工可用、本机已安装且状态为 enabled 的连接器。

连接器选择为空是合法情况，表示任务不使用外部连接器。

前端不能接收或展示 API Key、OAuth Refresh Token、MCP 私密配置、任意服务器地址或任意执行命令。

### Step 4：配置调度

#### 每天

```json
{
  "mode": "daily",
  "timezone": "Asia/Shanghai",
  "time": "09:00:00"
}
```

#### 每周

```json
{
  "mode": "weekly",
  "timezone": "Asia/Shanghai",
  "weekday": 1,
  "time": "10:00:00"
}
```

#### 每月

```json
{
  "mode": "monthly",
  "timezone": "Asia/Shanghai",
  "day_of_month": 31,
  "invalid_date_policy": "skip",
  "time": "09:00:00"
}
```

界面需提示：月份不存在所选日期时，本次执行将跳过。

#### 固定间隔

```json
{
  "mode": "interval",
  "timezone": "Asia/Shanghai",
  "interval_seconds": 7200,
  "starts_at": "2026-09-20T09:00:00+08:00"
}
```

新任务间隔最小为 5 分钟。

#### 单次

```json
{
  "mode": "once",
  "timezone": "Asia/Shanghai",
  "run_at": "2026-10-01T16:30:00+08:00"
}
```

单次任务执行后进入 `completed`，不能直接重新启用；需要重新配置新的执行时间。

### Step 5：创建确认

创建前展示任务、员工、连接器、频率和时区摘要。

创建请求必须携带：

```http
Idempotency-Key: {uuid}
```

避免重复点击产生重复任务。

---

## 五、详情页功能

详情页包含四个区域。

### 1. 基本信息

- 名称；
- 执行指令；
- 分类；
- 执行员工；
- 连接器；
- 当前任务状态；
- 阻塞原因。

### 2. 调度信息

显示当前调度规则、时区、上次执行时间和下一次执行时间。

`next_run_at` 应直接使用后端返回值，前端不要自行计算下一次执行时间，避免与调度器不一致。

### 3. 运行历史

每条记录至少展示：

- 运行状态；
- 计划执行时间；
- 实际开始时间；
- 完成时间；
- 错误码；
- 脱敏结果摘要；
- 对应会话入口。

状态文案建议：

| 状态 | 展示 |
| --- | --- |
| `queued` | 等待执行 |
| `blocked` | 执行条件未满足 |
| `running` | 执行中 |
| `succeeded` | 执行成功 |
| `error` | 执行失败 |
| `aborted` | 已中止 |
| `unknown` | 结果待核实，不会自动重放 |
| `skipped` | 本次已跳过 |

### 4. 会话与审批入口

保留“打开会话与审批”入口。自动化执行复用原 Pi Session、现有工作记录和审批链，不在任务详情页复制审批机制。

---

## 六、任务操作规则

### 启用

```http
POST /api/agent/automation-tasks/{task_id}/actions/enable
If-Match: "{etag}"
```

启用前检查有效 schedule、员工授权、Agent 登录状态和连接器状态。

### 暂停

```http
POST /api/agent/automation-tasks/{task_id}/actions/pause
If-Match: "{etag}"
```

暂停只阻止后续触发，不取消当前运行，不删除会话和历史记录。

### 删除

```http
DELETE /api/agent/automation-tasks/{task_id}
If-Match: "{etag}"
```

删除采用软删除：停止后续调度，任务从默认列表消失，但会话和运行历史保留。

确认文案：

```text
删除任务后将停止后续调度，但已有会话和运行记录会保留。是否继续？
```

### 编辑

编辑请求携带 `If-Match`。版本冲突时提示用户刷新，不能覆盖其他操作的更新。

---

## 七、与已有功能的统一规则

### 1. 聊天页调度

普通会话继续支持既有单次/间隔调度。

如果会话已使用日历型自动化任务，聊天页不展示另一套可编辑表单，而显示：

```text
此会话使用自动化任务调度，请前往自动化任务页面管理。
[管理自动化任务]
```

### 2. Office 页面

Office 页面只展示任务摘要，点击后进入：

```text
/tasks?conversation_id=...
```

不要在 Office 页面自行计算下一次执行时间。

### 3. 员工详情

员工详情中的“自动化任务”卡片点击后进入自动化 Tab，并带上 `employee_id` 筛选。

### 4. 任务与会话

后端当前采用：

- `automation_task` 保存任务管理信息；
- `automation_binding` 保存任务与会话关系；
- schedule 继续存储在 `Conversation.schedule`；
- 执行继续复用 `ScheduleService`、`SessionHost`、Pi Session 和工作记录。

前端不应维护第二套本地 schedule 状态。

---

## 八、`AITeam` 前端落地建议

### 推荐方向

优先将 `FredServer/web/agent` 的自动化任务实现迁移或对齐到 `AITeam`，参考目录：

```text
FredServer/web/agent/src/features/automation-tasks/
├── TasksPage.tsx
├── types.ts
├── tasks.css
└── TasksPage.test.tsx
```

需要同步对齐：

- `/tasks` 路由；
- 导航入口；
- Agent API Client；
- 认证和错误处理；
- 任务详情跳转；
- 聊天调度入口；
- Office 任务入口。

### 移除预览实现

从 `clients/desktop/src/pages/AutoTasks/index.tsx` 移除或替换：

- “功能预览”徽标；
- “创建待开放”禁用按钮；
- 禁用的模板按钮；
- “调度与任务接口正在建设中”提示；
- 本地静态模板展示；
- 接口失败时的 demo fallback。

### 建议新增 API 模块

```text
clients/desktop/src/api/agent/automationTasks.ts
```

封装以下接口：

- `listAutomationTasks`
- `getAutomationTask`
- `createAutomationTask`
- `updateAutomationTask`
- `enableAutomationTask`
- `pauseAutomationTask`
- `deleteAutomationTask`
- `listAutomationTaskRuns`
- `listConnectors`

核心类型至少包含：

```ts
type AutomationTask = {
  task_id: string
  name: string
  category: string
  prompt_summary: string
  employee_id: string | null
  connector_ids: string[]
  schedule: TaskSchedule | null
  status: 'active' | 'paused' | 'completed'
  block_reason: string | null
  conversation_id: string | null
  next_run_at: string | null
  last_run: TaskRun | null
  etag: string
}
```

---

## 九、错误和空状态

### Agent 未登录或失效

```text
当前登录已失效，自动化任务暂时无法执行。请重新登录后重试。
```

### 调度器不可用

```text
本机调度服务暂时不可用。任务配置仍然保留，请稍后重试。
```

### 没有任务

```text
暂无自动化任务
创建一个定时工作安排，让 AI 员工按计划执行工作。
[新建任务]
```

### 没有可用连接器

```text
当前员工没有可用的本地连接器。你仍然可以创建不依赖外部连接器的任务。
```

### 任务被阻塞

应显示“已配置，但当前无法执行”，并展示具体原因，不要显示成普通失败任务。

### 运行结果不确定

```text
本次执行结果待核实。系统不会自动重复执行，避免产生重复副作用。
[查看执行会话]
```

---

## 十、迭代拆分

### P0：替换预览页

- `/tasks` 接入真实接口；
- 列表、搜索、分类、状态筛选；
- 新建任务；
- 任务详情；
- 启用、暂停、删除；
- 运行历史；
- 真实错误态；
- 移除 demo fallback。

### P1：完善体验

- 员工筛选；
- 连接器状态和授权提示；
- 员工详情页联动；
- 聊天页、Office 页统一跳转；
- 运行状态刷新；
- 删除任务后的历史查询；
- 并发冲突和表单草稿保护。

### P2：工作流能力

后续再考虑：

- 事件触发；
- Webhook；
- 多步骤 AI 员工流程；
- 步骤级输入输出；
- 手动重试；
- 统计报表；
- 成功率和平均耗时。

手动重试需要设计新的执行 attempt，不能直接重放原 occurrence，避免产生重复外部副作用。

---

## 十一、验收标准

1. 页面不再展示“功能预览”和伪任务；
2. 刷新后任务仍来自真实 API；
3. 创建请求携带 `Idempotency-Key`；
4. 编辑、启停、删除请求携带正确 `If-Match`；
5. 支持五种调度模式；
6. 时区显示与后端 `next_run_at` 一致；
7. 月末无对应日期时展示跳过规则；
8. 暂停不会取消当前运行；
9. 删除任务不会删除原会话和运行历史；
10. `unknown` 不显示成成功，也不会自动重试；
11. 未授权员工和连接器不能提交；
12. 后端异常时不展示本地 demo 任务；
13. 聊天页和 Office 页能定位到对应任务；
14. 运行记录可以跳回实际执行会话；
15. 前后端测试、类型检查、构建和 E2E 流程通过。

## 结论

自动化 Tab 应从“模板预览页”升级为基于真实本地调度器的任务管理中心。实现上以 `FredServer` 近期的 `automation-tasks` 模块为事实基线，`AITeam` 完成页面和 API 能力迁移，不重新设计任务模型、调度状态机或连接器权限体系。事件触发、Webhook 和可视化多步骤流程放入后续版本，首期优先保证“创建 → 调度 → 执行 → 查看结果 → 暂停/删除”闭环稳定。
