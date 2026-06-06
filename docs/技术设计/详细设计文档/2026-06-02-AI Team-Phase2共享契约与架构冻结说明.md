---
created: 2026-06-02
updated: 2026-06-02
status: ready-for-development
stage: phase2-freeze
canonical_name: 2026-06-02-AI Team-Phase2共享契约与架构冻结说明
supersedes:
  - docs/复盘/phase2-prd-coverage-matrix.md
  - docs/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md
  - docs/技术设计/详细设计文档/2026-05-27-AI Team-前端页面与接口契约详细设计.md
  - docs/技术设计/2026-05-27-AI Team-技术详细设计.md
source_docs:
  - /home/ubuntu/code/aiteam/AGENTS.md
  - /home/ubuntu/code/aiteam/docs/复盘/phase2-prd-coverage-matrix.md
  - /home/ubuntu/code/aiteam/docs/需求文档/AI-Team-PRD-v2.html
  - /home/ubuntu/code/aiteam/docs/技术设计/2026-05-25-AI Team-业务解决方案设计.md
  - /home/ubuntu/code/aiteam/docs/技术设计/2026-05-26-AI Team-技术概要设计.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-27-AI Team-前端页面与接口契约详细设计.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-27-AI Team-Team Panel领域模型与数据架构详细设计.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-27-AI Team-会话群聊编排Loop核心流程详细设计.md
---

# AI Team Phase 2 共享契约与架构冻结说明

## 1. 文档定位

本文是 Phase 2 开发启动前的最终收口文档，目的只有一个：
在实现 fan-out 之前，把所有跨模块共享契约收成一份可执行口径，避免开发者分别从 PRD、旧详细设计和阶段讨论里各取一套解释。

本文不是替代现有详细设计，而是对 Phase 2 真正会影响实现排期的共享边界做二次冻结，重点覆盖：

1. Phase 2 范围裁剪后的 API / 页面 / 路由口径
2. 数据对象、状态机、角色模型是否有新增或收缩
3. 与外部 provider 的连接边界
4. 哪些旧设计仍有效，哪些在 Phase 2 被明确不采用
5. Phase 2 首批实现必须先失败再补齐的验证面

若现有详细设计与本文冲突，Phase 2 一律以本文为准；后续子文档应按本文回填，不得继续并行保留旧解释。

## 2. 方案调研与复用判断

本轮不是从零重新设计，而是对现有方案做“能否直接采用 / 选择性复用 / 接口层借鉴 / 明确不采用”的收口。

### 2.1 已核对材料

本轮实际核对了以下第一手材料：

- PRD v2 页面范围与登录/人才市场/充值/系统后台需求
- Phase 2 coverage matrix 与 PM 已裁决项
- AGENTS 全局架构边界与唯一共享口径说明
- 业务解决方案设计中的复用判断
- 技术概要设计中的五层结构与边界
- 共享运行口径定稿版中的事件、游标、状态、角色口径
- 前端页面与接口契约详细设计中的路由/API 暴露面
- Team Panel 数据架构详细设计中的对象与状态枚举
- 会话/群聊/编排/Loop 流程设计中的执行链路边界

### 2.2 复用判断结论

1. 直接采用
- 继续直接采用 `前端 -> Team Panel -> Agent Gateway -> Hermes Runtime` 四段主链，不新增中间控制层。
- 继续直接采用 `2026-05-28-AI Team-共享运行口径定稿版.md` 中已冻结的时间线事件、numeric cursor、Conversation/TeamRun/TeamTask/ScheduledJob 主状态机、角色模型。
- 继续直接采用业务解决方案中对 Hermes 能力的复用判断：单次执行、Kanban 协作、Cron 调度、Memory、Skills、MCP 不自建底层。

2. 选择性复用
- 复用 WebUI 的登录壳、SSE 客户端和工作台骨架，但只借壳，不沿用其单密码身份模型或 session 原生对象模型。
- 复用前端详细设计中的 P01/P03/P04/P05/P06/B01/B04/B05/B06/B07/B08/B09 页面分组与大部分 API 分组；仅对 B03、支付 provider、Loop 端侧范围做 Phase 2 收缩。

3. 接口层借鉴
- 认证继续沿用 `POST /api/auth/*`、`POST /api/auth/refresh`、`GET /api/me` 这类统一分组，不把第三方 provider 名称写死进产品主契约。
- 充值继续沿用 `balance / recharge record / callback ack` 这类标准意图-回调式接口分层，但 Phase 2 只允许 mock provider 实现。

4. 明确不采用
- 不采用 B03 独立企业后台页面与 `/admin/templates` 作为 Phase 2 正式交付面。
- 不采用真实法币支付、真实短信发送、真实企业微信等外呼作为 Phase 2 启动前提。
- 不采用移动端作为 Phase 2 范围内交付对象。
- 不采用任何超出现有共享运行口径定稿版的新角色枚举、新主状态枚举或第二套事件协议。

结论：Phase 2 的正确方向不是扩设计，而是删歧义。能复用的保持不动，不能在本阶段落地的能力统一 mock 或延后。

## 3. Freeze 后的总架构口径

### 3.1 主链不变

正式主链仍然是：

`前端页面 -> Team Panel -> Agent Gateway -> Hermes Runtime`

边界仍然是：

- 前端不直接消费 Runtime 原始对象或原始事件名
- Team Panel 继续持有业务对象真相与权限口径
- Gateway 继续只做 runtime 翻译、句柄管理、事件映射、补拉与对账
- Hermes Runtime 继续承接真实执行、技能、记忆、kanban、cron 与模型调用

### 3.2 Phase 2 的范围型收缩

本轮新增的不是架构层改造，而是以下范围冻结：

1. PC-only
- Phase 2 交付范围只覆盖企业前台 PC、企业后台 PC、系统后台 Web。
- 移动端入口、移动端 Loop 展示、移动端会话页均不属于本阶段开发承诺。

2. Mock-first external provider
- 登录、支付、通知等需要第三方 provider 的流程，只冻结业务契约，不以真实外部联调作为启动条件。
- provider 失败/成功/超时语义必须可由 mock 稳定复现。

3. Template governance split
- 模板的“消费入口”属于 P03/P04 招募链路。
- 模板的“系统发布治理”属于 S02。
- 企业后台不再单独交付 B03 模板中心页面。

## 4. Contract delta notes

本节只列与现有详细设计相比，Phase 2 必须明确变化或收缩的共享点。

### 4.1 页面与路由 delta

1. B03 页面取消独立交付
- 旧解释：企业后台存在 `B03 人才市场（后台）`，推荐路由 `/admin/templates`。
- 冻结后：Phase 2 不再交付独立 B03 页面，不保留 `/admin/templates` 为正式开发入口。
- 能力并入：
  - P03 `/app/marketplace`：模板市场浏览、搜索、分类、推荐
  - P04 `/app/marketplace/:templateId`：模板详情与招募确认
  - B01 `/admin/employees/:employeeId/*`：员工实例配置、默认能力调整、解雇与运行治理
  - S02 `/system/templates`：平台模板 CRUD、发布/下架、预览、克隆

2. Phase 2 正式页面面保留
- 企业前台：P01-P09（但移动端页面不在本阶段）
- 企业后台：B01、B02、B04、B05、B06、B07、B08、B09
- 系统后台：S01-S04

3. Loop 入口限制
- Loop/ScheduledJob 入口只出现在 PC 工作台关联页面和 B01 员工详情/Loop 面板。
- 不新增移动端或独立“全端统一 Loop 中心”页面。

### 4.2 API 契约 delta

1. Auth / identity
- 保留统一分组：`/api/auth/*`、`/api/auth/refresh`、`/api/me`、`/api/enterprises/current`
- Phase 2 冻结要求：
  - 登录接口允许接微信扫码与手机号验证码两条业务路径
  - 但 provider 接入层必须可替换为 mock provider
  - 不要求 Phase 2 接通真实微信开放平台或真实短信网关
- **完整 auth / session / device / rate limit / enterprise entrance 契约以 `2026-06-02-AI Team-Auth与登录会话企业入户契约收口.md` 为准**（包括 token lifecycle、refresh token rotation、设备上限、登录频控、邀请码、onboarding redirect 等详细口径）

2. System admin enterprise accounts (S01)
- 保留正式读接口：
  - `GET /api/system-admin/enterprises`
  - `GET /api/system-admin/enterprises/{id}`
  - `GET /api/system-admin/enterprises/export`
  - `GET /api/system-admin/enterprises/{id}/quota`
  - `POST /api/system-admin/enterprises/{id}/quota`
- 保留唯一正式写接口：
  - `POST /api/system-admin/enterprises/{id}/actions`
- `EnterpriseAdminAction` 的 action 枚举、字段语义、legacy alias 兼容/回滚规则，以 `2026-06-03-AI Team-S01系统账号管理契约收口.md` 为准。
- split `/ban|/recharge|/notify` 若在 backend 过渡期继续存在，只能视为兼容别名，不再作为正式 northbound 契约。

3. Talent / recruit / template
- 保留：
  - `GET /api/team/talent-market/templates`
  - `GET /api/team/talent-market/templates/{id}`
  - `POST /api/team/recruitments`
- 移除 Phase 2 正式交付面中的企业后台模板页契约：
  - `/admin/templates`
  - 企业端对应的模板编辑/发布语义
- 保留系统后台模板治理：
  - `GET /api/system-admin/templates`
  - `POST /api/system-admin/templates`
  - `PATCH /api/system-admin/templates/{id}`

3. Employee config
- B03 被并入后，企业对“已招募员工”的二次配置统一走 B01：
  - `GET /api/team/employees`
  - `GET /api/team/employees/{id}`
  - `PATCH /api/team/employees/{id}`
- 不新增“企业模板二次编辑”接口作为 Phase 2 前置依赖。

4. Billing / recharge
- 保留读接口：
  - `GET /api/team/billing/usage/overview`
  - `GET /api/team/billing/usage/records`
  - `GET /api/team/billing/balance`
  - `GET /api/team/billing/recharges`
- Phase 2 允许定义 `RechargeIntent` / `RechargeCallbackAck` 数据结构，但只允许 mock provider 驱动状态流转。
- 若实现需要创建写接口，必须满足：
  - 业务层收到的是 mock intent / mock callback
  - 不对真实支付网关发起请求
  - 余额不足仍按产品契约返回 402/引导充值

5. Run / event / stream
- 继续沿用共享运行口径定稿版：
  - `POST /api/team/runs`
  - `GET /api/team/runs/{run_id}/stream?cursor=`
  - `GET /api/team/runs/{run_id}/events?cursor=&limit=`
- SSE 仍只允许：
  - `event: timeline`
  - `data: RunTimelineEvent`
- 不得为 Phase 2 新增第二套对外事件名或字符串游标。

### 4.3 数据对象与状态机 delta

1. 不新增新的共享主状态枚举
- Conversation 仍固定：`draft | active | paused | muted | archived`
- TeamRun 仍固定：`queued | routing | submitting | running | waiting_human | succeeded | failed | cancelled`
- TeamTask 仍固定：`planned | queued | running | waiting_deps | succeeded | failed | cancelled`
- ScheduledJob 仍固定：`draft | enabled | paused | error | archived`

2. Phase 2 范围收缩不改变主状态机，只改变允许出现的页面与场景
- Loop 因为收缩到 PC-only / basic cron，并不新增任何 ScheduledJob 状态。
- B03 合并并不新增 TemplateCenter 或 EnterpriseTemplateDraft 等跨模块共享主对象作为第一批前置依赖。

3. Payment/provider mock 只改实现边界，不改业务对象意义
- `RechargeRecord`、`EnterpriseBalance` 仍可存在。
- 但状态流转来源必须允许来自 mock callback，而不是把真实 provider id 当成唯一真相字段。

### 4.4 角色与权限 delta

1. 角色集合不变
- 企业侧：`owner | enterprise_admin | finance_admin | member`
- 平台侧：`system_admin | system_operator`

2. 语义进一步收紧
- `finance_admin` 的正式视图范围仍聚焦 B04/B09，不扩展到员工配置、模板治理或系统后台。
- `system_operator` 可维护模板与方案，但 Phase 2 中只有系统后台 S02/S03 承接该能力，不再借 B03 旁路进入企业后台。
- 任何文档、代码或 mock 中出现 `admin / manager / viewer / sub_admin` 这类历史枚举，都视为 contract break。

### 4.5 Provider / external boundary delta

1. 登录 provider
- 业务上保留“微信扫码 + 手机号验证码”两条入口。
- 技术上 Phase 2 只冻结 provider-neutral contract，不冻结真实微信/短信联调。

2. 支付 provider
- 业务上保留“充值 -> 回调 -> 余额生效 / 失败可见”的完整链路。
- 技术上 Phase 2 明确只允许 mock provider；真实法币支付不在范围内。

3. 通知/外发 provider
- 不得向真实短信、企业微信等外部渠道发真实消息。
- 所有外发语义必须可以在本地或测试环境中以 mock/outbox 方式验证。

## 5. Approved changes 清单

以下变更视为本轮正式批准，可直接作为下游任务实现输入。

### 5.1 API changes

- 批准保留并实现 `Auth / Talent Market / Recruit / Employee / Billing / Run Stream` 现有主分组。
- 批准 S01 system-accounts 以 `POST /api/system-admin/enterprises/{id}/actions` 作为唯一正式写入口，split `/ban|/recharge|/notify` 只允许作为 backend 兼容 alias。
- 批准删除 Phase 2 中企业后台 B03 独立页面及其 `/admin/templates` 开发依赖。
- 批准将模板消费链路统一收束到 P03/P04，将模板治理统一收束到 S02。
- 批准充值链路以 mock provider 驱动，不等待真实支付联调。
- 批准登录链路以 mock provider 驱动，不等待真实微信/短信联调。

### 5.2 Data changes

- 批准不新增新的共享主对象和新的共享主状态枚举。
- 批准让已招募员工的后续配置完全落在 B01 员工实例对象上，而不是新增企业模板编辑对象。
- 批准 `RechargeRecord`/`EnterpriseBalance` 继续作为业务对象存在，但 provider 侧只绑定 mock 生命周期。

### 5.3 Role changes

- 批准继续只使用 `owner / enterprise_admin / finance_admin / member / system_admin / system_operator`。
- 批准将 `system_operator` 的模板/方案维护权限定在系统后台，不下放到企业后台 B03。
- 批准把 `finance_admin` 权限严格限制在费用/充值视图，不扩散至员工配置和模板治理。

### 5.4 Status changes

- 批准不做任何新的共享状态枚举扩展。
- 批准继续把 `waiting_reply / streaming / resolved / reconnecting / waiting_children` 视为展示态或聚合态，而非主状态字段。

## 6. Remaining non-goals

以下内容即使 PRD 提到，也不作为 Phase 2 开发启动 blocker：

1. 真实微信开放平台接入
2. 真实短信网关接入
3. 真实法币支付接入
4. 移动端页面与移动端 Loop 展示
5. 企业后台独立模板中心 B03
6. 为支付/登录 provider 增加产品外显配置中心

## 7. Failing test plan

本计划的原则是：先把 contract 变成会失败的验证，再允许实现进入 green。

### 7.1 Contract smoke tests

1. 页面/路由面
- 断言 Phase 2 页面导航中不再出现 `/admin/templates`
- 断言人才市场正式入口是 `/app/marketplace` 与 `/app/marketplace/:templateId`
- 断言系统模板治理入口是 `/system/templates`

2. 共享运行口径
- 断言 SSE 只输出 `event: timeline`
- 断言时间线 payload 可反序列化为 `RunTimelineEvent`
- 断言补拉/流式接口只接受和返回 numeric cursor

3. 状态/角色
- 断言共享 schema 中不存在历史角色枚举 `admin / manager / viewer`
- 断言 Conversation/TeamRun/TeamTask/ScheduledJob 只出现冻结后的枚举值
- 断言 `waiting_children` 不作为 `team_run.status` 落库

### 7.2 Auth tests

1. 登录 provider mock
- 微信扫码 mock 成功：返回登录成功、首登企业创建或加载、owner 角色绑定
- 微信扫码 mock 过期：二维码状态过期后刷新成功
- 手机验证码 mock 成功：同一手机号可完成登录与会话恢复
- 手机验证码频控：60s 冷却、同 IP 每分钟 10 次请求超过阈值时失败

2. 会话安全
- access token 过期后 refresh 成功
- 超过设备上限时最早设备会话失效
- `GET /api/me` 在无效 token 下返回未认证，而不是返回半初始化企业态

### 7.3 Talent / recruit / employee tests

1. B03 合并验证
- 企业后台路由表不存在 `/admin/templates`
- 前台 P03/P04 可完成模板浏览与详情展示
- 招募完成后进入 B01 员工实例，而不是进入企业模板编辑流

2. 招募链路
- `POST /api/team/recruitments` 成功后生成 `EmployeeInstance`
- 模板下架后 P03 不再允许新招募，但已招募员工不受影响
- 招募失败时不产生半初始化 employee/profile 脏数据

3. 员工配置
- `PATCH /api/team/employees/{id}` 只能改 allowlist 字段
- 配置变更写业务对象，不直接写 Runtime profile 文件
- 配置变更产生审计日志

### 7.4 Billing / payment tests

1. 余额与充值
- 余额不足时关键执行入口返回 402 并给出充值引导
- mock payment success 可把 `RechargeRecord` 从 pending 推进到 succeeded，并更新余额
- mock payment failed 可把记录推进到 failed，不更新余额
- 回调幂等：同一 mock callback 重放不重复入账

2. 费用聚合
- run 完成后 usage log 入库
- B04 overview 与 records 可按同一底层账本复现
- S04 平台财务聚合不泄露企业明细给普通企业角色

### 7.5 Loop / ScheduledJob tests

1. 范围约束
- ScheduledJob 创建入口只在 PC 页面/接口可达
- 移动端相关路由或菜单不展示 Loop 入口

2. 基础 cron 行为
- 创建 `ScheduledJob(draft)` 后可启用为 `enabled`
- cron tick 触发后生成 TeamRun 并回流 timeline
- 失败阈值触发后 `ScheduledJob` 进入 `error` 或维持 `enabled` + 错误统计，行为需与详细设计一致，但不得新增主状态

3. 结果回流
- Loop 产物能回到工作台/员工视图
- UI 只读展示最近运行，不把“本次正在执行”写成 `scheduled_job.status=running`

### 7.6 Governance / permission tests

- `finance_admin` 访问 B01/B03/S02 被拒绝
- `system_operator` 能维护 S02/S03，但不能执行 S01 封禁/人工充值
- 任意 API 返回的角色字段不出现旧角色枚举
- 所有管理写操作都有审计记录

## 8. 风险与边界

### 8.1 主要风险

1. 旧文档仍残留 B03 路由与模板中心描述，开发者可能误实现 `/admin/templates`
2. 若 mock provider 契约不先冻结，登录/充值会被真实第三方接入拖慢
3. 若移动端不明确标记为非目标，Loop 和会话页会继续被错误扩 scope
4. 若角色/状态仍从旧草稿复制，后续 QA 会出现跨模块不一致

### 8.2 风险应对

- 以本文作为 fan-out 前置文档
- 下游任务引用本文时，只能在本文批准范围内展开实现
- 任何新增共享角色、共享状态、正式北向页面、正式北向 API 分组，都必须重新走 architect 收口

## 9. 验证方式

本文有效性的验证标准不是“看起来合理”，而是以下三条都成立：

1. 下游卡在实现说明中不再引用 B03 独立页面、真实支付、真实短信、移动端 Loop 作为前置依赖
2. 路由/API/schema/mock 中只出现冻结后的角色、状态和页面面
3. 第一批 failing tests 能明确失败在 contract break，而不是失败在环境偶然性

## 10. 最终结论

推荐设计：保持既有四段式架构和共享运行口径不动，只对 Phase 2 的范围和共享契约做减法冻结。

边界：本次冻结只解决 Phase 2 启动前的共享 contract，不展开真实第三方 provider 联调，不开启移动端，不恢复 B03 独立页面。

风险：旧文档仍有残留表述，若不显式标注 supersede，开发实现容易回到旧路线。

验证：以本文 + failing test plan 为准推进 fan-out；若后续实现需要越过本文新增共享 contract，必须重新提交 architect 裁决。