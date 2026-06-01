# AI Team App Host Architecture

本文说明 `app/` 作为 AI Team **Agent Service 宿主层** 的当前代码结构、模块边界与保留理由。

## 1. 定位

`app/` 当前不是一个独立对外维护的通用 WebUI 产品，而是 AI Team 的主应用宿主。

它处在如下链路中：

```text
Browser / Admin UI
  -> app/static + app/api
  -> app/team_panel
  -> app/agent_gateway
  -> hermes-agent
```

其中：

- **Browser / Admin UI**：用户入口与后台入口
- **app/api**：HTTP 宿主、挂接点、保留的基础能力
- **app/team_panel**：业务控制面，维护企业、员工、会话、任务、治理等业务对象
- **app/agent_gateway**：运行时适配层，把业务请求翻译成 Runtime 可执行对象，并统一承接事件回流
- **hermes-agent**：执行真相层，负责 Session / Task / Cron / Skills / Memory 等真实运行机制

## 2. 当前目录边界

### 2.1 `api/`

保留宿主基座能力，并承担少量 AI Team 挂接：

- HTTP 路由入口
- 静态资源与 SSE 输出
- 认证、上传、工作区、终端等通用能力
- 向 `team_panel` / `agent_gateway` 挂接 AI Team API

约束：

- `api/routes.py` 仍是宿主入口，但不应继续承载大块 AI Team 业务逻辑
- 新业务语义优先下沉到 `team_panel` / `agent_gateway`

### 2.2 `team_panel/`

AI Team 业务控制面。

当前已形成的子层包括：

- `api_team/`：北向业务路由
- `application/`：命令服务、查询服务、策略
- `domain/`：领域对象、枚举、值对象
- `repositories/`：持久化访问
- `transactions/`：连接与 UoW
- `integration/`：与 Gateway 的内部接入
- `views/`：聚合视图与 schema
- `migrations/`：控制面数据迁移

### 2.3 `agent_gateway/`

AI Team 运行时适配层。

当前职责包括：

- RuntimeHandle 创建与更新
- 单聊 / 群聊 / 编排 / 定时任务等路径的运行时提交适配
- 事件水合与补拉
- 凭据解析、Profile 供应、对账与恢复

### 2.4 `static/`

浏览器端页面壳与交互脚本。

当前分两部分：

- 原宿主静态能力：通用会话、流式、设置、终端等
- `static/aiteam/`：AI Team 页面壳、页面模块、状态辅助与 timeline 客户端

约束：

- 前端主路径应优先消费 Team Panel 北向接口
- 不把 Runtime 原始对象直接暴露为主产品语义

### 2.5 `tests/`

测试目录当前是混合态：

- 一部分仍在覆盖宿主层保留能力
- 一部分已明确覆盖 AI Team 分层实现（`tests/aiteam/`）

后续治理方向：

- 保留对当前仍被 AI Team 使用的宿主能力的回归覆盖
- 优先增强 `tests/aiteam/` 的分层验证
- 持续移除只服务于旧开源产品叙事、对当前项目无直接价值的文档/发布类测试

## 3. 为什么保留部分原宿主代码

当前不采用“推倒重写”的原因：

1. **启动快**：已有宿主能力可直接支撑 MVP 展示版
2. **边界清晰**：AI Team 的新增业务模块已经可以在 `team_panel/` 和 `agent_gateway/` 内独立演进
3. **风险可控**：只要把产品语义从旧文档与旧治理口径中剥离，就不会被“它看起来像上游产品”继续牵着走

因此当前策略是：

- **代码层选择性复用**
- **文档层去上游产品化**
- **业务层按 AI Team 主项目治理**

## 4. 当前推荐演进路径

### 4.1 直接保留

这些继续保留：

- `server.py` / `bootstrap.py` / 启动脚本
- `Dockerfile` / compose
- `api/` 中仍承担宿主能力的模块
- `static/` 中仍被 AI Team 使用的通用壳能力

### 4.2 持续迁出业务语义

这些继续往 AI Team 口径收口：

- 业务接口 -> `team_panel/api_team`
- 运行时翻译 -> `agent_gateway/`
- 页面级产品语义 -> `static/aiteam/`
- 分层测试 -> `tests/aiteam/`

### 4.3 不再继续维护的上游产品化资产

以下类型不再作为本项目权威资产：

- Hermes WebUI 社区/贡献者导向文档
- 上游产品路线图、主题手册、发布日志
- 以“通用开源 WebUI 产品”视角书写的说明文档
- 仅为 `app/.github` 子目录独立仓运行而存在的 CI 工作流

## 5. 验证标准

判断 `app/` 是否已经从“中间态”向 AI Team 主项目收口，可用以下问题验证：

1. 看到 `app/` 文档时，读者首先理解的是 **AI Team 的宿主层职责**，而不是 Hermes WebUI 产品介绍
2. 看到目录结构时，读者能清楚区分 `team_panel`、`agent_gateway`、`hermes-agent` 的边界
3. 新增的开发说明、部署说明、联调说明是否落在 AI Team 自有文档，而不是继续补在上游产品文档里
4. CI / 测试 / 文档资产中，是否还保留明显只服务于上游开源项目身份的残留

如果以上四点都能满足，说明当前清理方向是正确的。
