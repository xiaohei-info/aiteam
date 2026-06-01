# MVP验收和排障

这份文档讲的是：**如何做 MVP 链路验收，如何在每一步记住关键 id，如何看日志排查后台流程。**

## 1. 先说现实边界

当前仓库已经具备：
- AI Team 北向 API namespace
- Team Panel / Gateway / 分层测试
- 企业后台 / 系统后台若干页面模块
- 私聊、群聊、方案应用等流程测试

但当前浏览器页面并不是所有设计稿页面都已完全落地。

### 当前已确认接了真实页面模块的路径
- `/admin/employees`
- `/admin/billing/usage`
- `/system/health`

### 当前仍主要是导航壳/占位区域的路径
- `/app/workbench`
- `/app/chat`
- `/app/group`
- `/app/office`
- `/admin/connectors`
- `/system/accounts`

所以：
- **管理后台类验收**：可以直接走页面 + API
- **私聊 / 群聊 / 编排 / Loop 的 MVP 验收**：当前更适合按“API + 事件 + 日志 + 流程测试”来验，不要假设已经都有完整页面

## 2. 验收前先做的三件事

### 2.1 服务起来

```bash
cd /home/ubuntu/code/aiteam/app
./ctl.sh start
./ctl.sh status
```

### 2.2 基础健康通过

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/api/system-admin/health
```

### 2.3 分层测试至少先过低层

最低建议先跑：

```bash
python -m pytest tests/aiteam/layer0_contracts -v
python -m pytest tests/aiteam/layer2_team_panel -v
python -m pytest tests/aiteam/layer3_gateway -v
```

如果低层契约都没过，不要直接做页面验收。

## 3. 当前页面入口怎么验

## 3.1 系统后台健康页

页面：
- `http://127.0.0.1:8787/system/health`

同时对照 API：

```bash
curl -s http://127.0.0.1:8787/api/system-admin/health
```

验收点：
- 页面能打开
- 页面不是脚本加载失败
- API 返回 200，不是 501
- 页面与 API 的数据来源一致

如果失败，先看：
- `app/static/aiteam/pages/system-health.js`
- `app/team_panel/api_team/router_system_admin.py`

## 3.2 企业后台员工页

页面：
- `http://127.0.0.1:8787/admin/employees`

同时对照 API：

```bash
curl -s http://127.0.0.1:8787/api/enterprise-admin/employees
```

验收点：
- 页面能打开
- 页面能拿到员工列表，或者明确显示空状态
- 如果数据库没准备好，应看到明确的 503/错误信息，而不是页面静默卡死

如果失败，先看：
- `app/static/aiteam/pages/admin-employees.js`
- `app/team_panel/api_team/router_enterprise_admin.py`
- PostgreSQL 是否可连

## 3.3 企业后台费用页

页面：
- `http://127.0.0.1:8787/admin/billing/usage`

同时对照 API：

```bash
curl -s "http://127.0.0.1:8787/api/enterprise-admin/billing/usage"
```

验收点：
- 页面能打开
- 页面能消费 API
- 至少能区分“无数据”和“接口失败”

## 4. 私聊 / 群聊 / 方案应用怎么验

这几类链路当前最可靠的验收方式是：

1. 先用现有 API 发起请求
2. 拿到 `run_id`、`runtime_handle`、`stream_url`、`events_url`
3. 去看 `events` / `stream` / Runtime 日志
4. 再对照流程测试与设计文档判断是否闭环

## 5. 私聊链路验收（建议顺序）

### 5.1 先看现成流程测试

先跑：

```bash
cd /home/ubuntu/code/aiteam/app
python -m pytest tests/aiteam/layer5_flows/test_private_chat_flow.py -v
```

如果这条流程测试不过，不建议先做人工链路验收。

### 5.2 手工验收建议顺序

#### Step 1：看工作台和员工列表

```bash
curl -s http://127.0.0.1:8787/api/team/workbench
curl -s http://127.0.0.1:8787/api/team/employees
```

目的：
- 确认企业、会话、员工基础数据是否存在
- 拿到一个可用的 `employee_id`

#### Step 2：发起 run

```bash
curl -s -X POST http://127.0.0.1:8787/api/team/runs \
  -H 'Content-Type: application/json' \
  -d '{"employee_id":"<employee_id>"}'
```

更完整的请求体，请直接参考：
- `tests/aiteam/layer2_team_panel/test_team_api_contracts.py`
- `tests/aiteam/layer5_flows/test_private_chat_flow.py`

这一步至少要记下：
- `run_id`
- `runtime_handle`
- `stream_url`
- `events_url`
- 如果响应里有 `conversation_id`，也记下

#### Step 3：看事件回放

```bash
curl -s "http://127.0.0.1:8787/api/team/runs/<run_id>/events?cursor=0"
```

验收点：
- 返回 200
- 事件是 northbound `timeline` 口径
- 有递增 cursor
- 能看到 run 的推进过程

#### Step 4：看流式事件

```bash
curl -N "http://127.0.0.1:8787/api/team/runs/<run_id>/stream?cursor=0"
```

验收点：
- SSE 使用 `event: timeline`
- 不是把 Runtime 原始事件名直接暴露给前端

#### Step 5：回查会话

```bash
curl -s http://127.0.0.1:8787/api/team/conversations/<conversation_id>
```

验收点：
- 会话状态可回查
- 对话与 run 能对应上

## 6. 群聊链路验收

先跑：

```bash
cd /home/ubuntu/code/aiteam/app
python -m pytest tests/aiteam/layer5_flows/test_group_conversation_flow.py -v
```

手工验收重点不是页面，而是：
- `POST /api/team/group-conversations/{id}/messages`
- 是否返回可追溯的 `run_id`
- 是否能继续通过 `events_url` / `stream_url` 查看推进过程

建议做法：
- 直接参考 `tests/aiteam/layer5_flows/test_group_conversation_flow.py` 的请求体与断言
- 每发一轮消息，都记录：`conversation_id`、`run_id`、`runtime_handle.kind`

## 7. 方案应用链路验收

先跑：

```bash
cd /home/ubuntu/code/aiteam/app
python -m pytest tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py -v
```

再按测试思路手工补验：
- `POST /api/team/solutions/{solution_id}/apply`
- 然后回查：
  - `GET /api/enterprise-admin/employees`
  - `GET /api/enterprise-admin/billing/usage`
  - `GET /api/system-admin/health`

验收重点：
- 方案应用后，员工侧数据是否真的出现/变化
- 企业后台和系统后台能否读到这轮变化
- 重放同一请求时，幂等行为是否符合预期

## 8. 要记哪些关键 id

做链路验收时，建议每一轮都记这几项：

- `conversation_id`
- `group_conversation_id`
- `employee_id`
- `run_id`
- `runtime_handle.kind`
- `runtime_handle.session_id / task_id / job_id`（如果有）
- `stream_url`
- `events_url`
- 最后一个 `cursor`

这是最小对账集合。

## 9. 日志怎么看

### 9.1 宿主层日志

```bash
cd /home/ubuntu/code/aiteam/app
./ctl.sh logs --follow
```

默认文件：
- `~/.hermes/webui.log`

适合看：
- 服务是否启动
- 页面/接口是否打到宿主层
- 启动期 traceback

### 9.2 Runtime 日志

当前代码对外提供了白名单日志读取接口：

- `GET /api/logs?file=agent&tail=200`
- `GET /api/logs?file=gateway&tail=200`
- `GET /api/logs?file=errors&tail=200`

例如：

```bash
curl -s "http://127.0.0.1:8787/api/logs?file=agent&tail=200"
curl -s "http://127.0.0.1:8787/api/logs?file=gateway&tail=200"
curl -s "http://127.0.0.1:8787/api/logs?file=errors&tail=200"
```

这些文件来自当前 active Hermes profile 的：
- `~/.hermes/logs/agent.log`
- `~/.hermes/logs/gateway.log`
- `~/.hermes/logs/errors.log`

适合看：
- run 有没有真正进 Runtime
- gateway 有没有做事件翻译/回流
- 执行失败的底层原因是什么

### 9.3 什么时候优先看哪层日志

#### 页面打不开 / 首屏报错
先看：
- `./ctl.sh logs --follow`

#### 管理后台页面空白 / 接口 503
先看：
- `./ctl.sh logs --follow`
- PostgreSQL
- `/api/enterprise-admin/*` 响应体

#### run 已创建，但没有事件
先看：
- `GET /api/team/runs/{run_id}/events?cursor=0`
- `GET /api/logs?file=gateway&tail=200`
- `GET /api/logs?file=agent&tail=200`

#### 事件有了，但 UI 不更新
先看：
- SSE `/api/team/runs/{run_id}/stream`
- `static/aiteam/` 页面脚本
- 是否是页面壳还没接真实模块

## 10. 出问题时怎么分层定位

### A. Host seam 问题
表现：
- 路由打不到
- `/api/team/*` 返回异常 404/500
- 页面脚本加载失败

先看：
- `api/routes.py`
- `tests/aiteam/layer0_contracts/test_host_routing.py`

### B. Team Panel 问题
表现：
- 能命中接口，但数据不对
- 企业后台空/错
- run 接受后返回体不对

先看：
- `team_panel/api_team/`
- `tests/aiteam/layer2_team_panel/`

### C. Gateway 问题
表现：
- `run_id` 有了，但 `events` / `stream` 不对
- `runtime_handle` 缺字段
- SSE 事件名不对

先看：
- `agent_gateway/`
- `tests/aiteam/layer3_gateway/`

### D. Runtime 问题
表现：
- Team Panel / Gateway 看着正常，但执行没真正发生
- agent/errors 日志里有底层失败

先看：
- `/api/logs?file=agent&tail=200`
- `/api/logs?file=errors&tail=200`
- `hermes-agent/` 运行环境与配置

## 11. 设计文档在验收时怎么用

如果你已经在做人工验收，不要再从头通读所有设计文档。

按问题回看：
- **验收标准 / 主流程**
  - `../docs/技术设计/详细设计文档/2026-05-27-AI Team-会话群聊编排Loop核心流程详细设计.md`
- **页面/API 契约**
  - `../docs/技术设计/详细设计文档/2026-05-27-AI Team-前端页面与接口契约详细设计.md`
- **事件、cursor、runtime_handle**
  - `../docs/技术设计/详细设计文档/2026-05-27-AI Team-Agent Gateway运行时适配与事件流详细设计.md`
- **共享枚举和统一口径**
  - `../docs/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md`

## 12. 最后记住一句话

**当前 MVP 验收要分成两类做：管理后台类走“页面 + API”，私聊/群聊/方案应用类走“API + 事件 + 日志 + 流程测试”；不要把尚未接真实页面模块的导航壳误当成已完成页面。**
