# AI Team PRD 行级验收矩阵（第一版）

> 用途：这份文档是 **AI Team 全功能交付的唯一验收真相层**。
>
> 目标口径：**当且仅当本矩阵中的全部非豁免项都达到 `accepted_verified` 时，才允许对外宣称“AI Team 已具备需求文档中定义的全部目标功能”。**
>
> 实现约束：所有开发、Review、QA、PM 验收都必须同时服从：
>
> 1. `docs/需求文档/` 下的 PRD / 原型 / 页面说明
> 2. `docs/技术设计/` 下的正式技术设计与冻结/收口文档
>
> 任何 closeout、回顾、口头结论、临时测试结论，都**不能**替代本矩阵。

---

## 1. 使用规则

### 1.1 这份文档解决什么问题

这份矩阵不是普通功能清单，而是把下面三件事绑定成同一个基线：

1. **功能定义**：PRD 到底要什么
2. **实现约束**：技术设计允许怎么实现
3. **验收标准**：什么情况下才算真的交付完成

这样可以避免再次出现：

- 路由存在就算完成
- 页面有壳就算完成
- API 有返回就算完成
- 某张 Story done 就被误当成 PRD 行关闭

### 1.2 谁必须使用它

- **Coding Agent**：实现任务时，以本矩阵的功能定义 + 设计引用为准
- **Reviewer**：评审时，以本矩阵的完成标准为准
- **QA**：验证时，以本矩阵的验收方式为准
- **PM**：签收时，只能按本矩阵升级状态
- **Orchestrator / Kanban**：所有开发卡必须显式绑定 `covers_prd`

### 1.3 前端强制约束（用户明确追加）

1. **前端功能实现必须以 PRD HTML 原型为准。**
   - 页面结构、布局、交互链路、信息层级、按钮关系、跳转关系，都以 PRD HTML 原型为准。
   - 默认前端原型权威来源：
     - `docs/需求文档/AI-Team-PRD-v2.html`
     - `docs/需求文档/AI-Team-PRD.html`
     - `docs/需求文档/AI-Team-Demo.html`
     - `docs/需求文档/AI-Team-Office.html`
   - 前端开发不允许自行发挥，不允许以“更简洁”“更工程化”“更现代”为理由偏离原型。
   - 若当前技术设计中的页面表达与 PRD HTML 原型冲突，**以 PRD HTML 原型为前端实现准绳**；若需要改设计，必须显式补设计，不得用代码先斩后奏。
2. **微信登录、短信登录、支付等外部真实服务，可暂时保留 mock 形式。**
   - 允许继续使用 provider-neutral / mock-first 方式实现。
   - 但 mock 只豁免真实外部联调，不豁免产品流程本身：页面、状态、异常、按钮、反馈链路都必须完整。

### 1.4 状态定义

### 1.4 状态定义

统一只允许以下状态：

- `not_started`：未开始
- `in_design_conflict`：PRD 目标与现有技术设计存在收缩/延期/合并冲突，必须先补裁决
- `contract_locked_but_not_complete`：现有技术设计已冻结实现约束，但按用户当前目标，这些约束本身仍不足以覆盖 PRD 原始功能，需要先补设计或升级约束后才能进入最终验收
- `backend_partial`：后端主能力未完整闭环
- `frontend_partial`：前端页面表达未完整闭环
- `integration_partial`：前后端都有，但产品路径未闭环
- `accepted_verified`：后端 + 前端 + 场景闭环 + QA/PM 证据齐全
- `design_exempted`：仅在用户或 PM 明确同意不做时使用；默认不允许使用来逃避全功能目标

### 1.5 强制规则

1. **所有非 `design_exempted` 的 PRD 行，最终都必须达到 `accepted_verified`。**
2. 若某个 PRD 功能被历史技术设计文档裁成了：
   - `deferred`
   - `mock-first`
   - `PC-only`
   - `merged`
   则必须先显式确认：
   - 是否接受该约束继续交付，或
   - 是否要补充设计，把约束解除
3. 若某个功能的现有技术设计只提供了“阶段性实现口径”，但用户当前目标要求恢复 PRD 原始功能，则该行必须进入 `in_design_conflict` 或 `contract_locked_but_not_complete`，在补充设计前不得直接进入开发收口。
4. 不允许把 `shell / stub / aggregate-only / mock-only` 判成 `accepted_verified`。
5. 每个 PRD 行都必须有至少一条：
   - 开发证据
   - Review 证据
   - QA 证据
   - PM 签收证据

---

## 2. 源文档与裁决顺序

### 2.1 需求源

优先按以下需求文档理解产品目标：

- `docs/需求文档/AI-Team-PRD-v2.html`
- `docs/需求文档/AI-Team-PRD.html`
- `docs/需求文档/AI-Team-Demo.html`
- `docs/需求文档/AI-Team-Office.html`
- `docs/需求文档/docx_unpacked/word/document.xml`

### 2.2 技术设计约束源

优先按以下技术设计文档约束实现：

- `docs/技术设计/技术设计.md`
- `docs/技术设计/2026-05-27-AI Team-技术详细设计.md`
- `docs/技术设计/详细设计文档/2026-05-27-AI Team-前端页面与接口契约详细设计.md`
- `docs/技术设计/详细设计文档/2026-05-27-AI Team-Team Panel领域模型与数据架构详细设计.md`
- `docs/技术设计/详细设计文档/2026-05-28-AI Team-Team Panel内部服务与聚合视图详细设计.md`
- `docs/技术设计/详细设计文档/2026-05-27-AI Team-Agent Gateway运行时适配与事件流详细设计.md`
- `docs/技术设计/详细设计文档/2026-05-27-AI Team-会话群聊编排Loop核心流程详细设计.md`
- `docs/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md`
- `docs/技术设计/详细设计文档/2026-06-02-AI Team-Phase2共享契约与架构冻结说明.md`
- `docs/技术设计/详细设计文档/2026-06-02-AI Team-Auth与登录会话企业入户契约收口.md`
- `docs/技术设计/详细设计文档/2026-06-03-AI Team-S01系统账号管理契约收口.md`
- `docs/技术设计/详细设计文档/2026-06-05-AI Team-Phase3架构契约刷新-计费与管理邀请命名空间收口.md`

### 2.3 冲突处理规则

若出现冲突，按以下顺序裁决：

1. **用户当前硬目标：PRD 全功能交付**
2. 最新、明确的技术收口文档
3. 模块级详细设计
4. 概要设计 / 业务方案设计
5. 历史 closeout / 回顾 / matrix 文档（只能作为现状证据，不能反过来改写目标）

---

## 3. PRD 行级验收矩阵

> 说明：`实施提醒` 列只写最少量的“防跑偏信息”，不是重新设计系统。

## 3.1 企业前台

| PRD ID | 功能 | PRD 目标定义 | 技术设计引用 | 完成标准 | 当前状态 | 实施提醒 |
|---|---|---|---|---|---|---|
| P01 | 登录页 | 支持微信扫码、手机号验证码、企业入口、会话安全、首次企业创建/加入路径 | 前端接口契约 P01；Auth 收口文档；Phase2 冻结说明 §4.2 Auth | 登录主路径可用；token/refresh/device/rate-limit/onboarding 完整；企业入户路径完整；QA 覆盖扫码/手机号/provider 行为；若最终交付仍采用 mock provider，需由你显式接受“功能路径完整、外部 provider 非真实联调”的交付口径 | integration_partial | 当前技术设计是 `provider-neutral + mock-first`；若你要求真实微信/短信接入，则需先补设计升级约束 |
| P02 | 主界面 / 工作台 | 企业主界面、私聊入口、最近会话、员工状态、任务摘要、主导航与空态 | 前端接口契约 P02；技术详细设计 §7.2；Phase3 收口文档 §5.1 | 页面结构与 PRD 原型一致；员工/会话/任务摘要真实；空/错/权限态完整；导航正确；不是聚合说明页 | frontend_partial | 不得以“聚合导航页”视为完成；必须达到 PRD 主工作区产品表达 |
| P03 | 人才市场 | 模板浏览、搜索、分类、标签、推荐、招募入口、招募动效 | 前端接口契约 P03；技术详细设计 §7.3；Phase3 收口文档 §5.2 | 搜索/分类/标签/排序完整；模板卡片信息完整；招募动作真实闭环；并发/限流反馈清晰；符合原型图信息密度 | accepted_verified | 已完成 P03/P04/B01 招募闭环交付；QA `t_81f0784c` confirmed pass，PM `t_12d201af` accepted。仍可后续补强非阻塞动效/视觉深度，但不影响本轮验收 |
| P04 | 专家详情页 | 完整展示专家信息、模型、skills、知识、初始记忆，并支持招募 | 前端接口契约 P04；技术详细设计 §7.3；Phase3 收口文档 §5.3 | 详情页/抽屉结构与 PRD 一致；tabs 信息完整；招募从详情页可闭环；非“仅 API / 基础详情” | accepted_verified | 已完成 P03/P04/B01 招募闭环交付；QA `t_81f0784c` confirmed pass，PM `t_12d201af` accepted。后续若补视觉/信息密度优化，按增量迭代处理 |
| P05 | 单聊对话页 | 完整私聊体验：历史、引用、附件、工具调用可解释、重试、中止、状态清晰 | 前端接口契约 P05；技术详细设计 §7.5；会话群聊编排Loop 详细设计；Phase3 收口文档 §5.4 | 长历史加载、引用、附件上传/展示、tool_call 渲染、retry、abort、错误恢复全部可用；不是只会发消息 + 看 timeline | accepted_verified | 已完成 P05 私聊执行闭环交付；QA `t_be5f407e` 完成验证，PM `t_5cffc2d9` 已签收。后续增强项不得回写为本轮未完成 |
| P06 | 群聊页面 | 成员管理、@提及、单/多 Agent 路由、任务树、协作时间线、断流恢复 | 前端接口契约 P06；技术详细设计 §7.6；会话群聊编排Loop 详细设计；Phase3 收口文档 §5.5 | 成员管理可用；@单人/@多人路由正确；任务树和协作时间线可视；SSE reconnect/catch-up 可用 | integration_partial | 不得以“能发 group message”视为完成；成员管理和恢复路径是硬验收项 |
| P07 | 组织架构 | 组织树、部门、岗位、员工归属调整、展示与权限边界 | 前端接口契约 P07；技术详细设计 §7.9 | 前端和后端均可用；拖拽/调整或等价组织调整动作真实生效；权限正确 | backend_partial | 需确认最终交付是否只接受表单式调整，还是必须达到原型中的交互表现 |
| P08 | 知识库 | P2-S02 | 知识库管理、文档上传、入库、绑定员工、检索问答、citation 可见 | 前端接口契约 P08；技术详细设计 §7.10；Phase3 收口文档 §5.6 | upload -> process -> bind -> query -> answer -> citation 全链路成立；失败降级清晰；不是仅绑定层 / 文档登记层 | pm | accepted_verified |
| P09 | 办公室动态 | 类 Marvis 的办公室动态、实时状态、任务气泡、全屏/强视觉表达 | 前端接口契约 P09；技术详细设计办公室/Loop 相关章节；Phase3 收口文档 §5.7 | 页面达到 PRD 原型表达层次；实时状态变化可视；任务气泡/全屏/动态更新成立；不是运营看板 | frontend_partial | 不得以 seat/feed 聚合 dashboard 视为完成；这是产品表达重灾区 |
| P10 | Scheduled Job / Loop | 周期任务/Loop 自主执行能力，含创建、启停、最近结果、产物回流 | 技术详细设计 §7.8；会话群聊编排Loop 详细设计 §8.4；Phase2 冻结说明 Loop 限制 | 最终必须实现满足 PRD 目标的 Loop 产品能力；在现有技术设计被 `PC-only / basic cron / 已延期` 锁定的前提下，进入开发前必须先补设计或明确升级这些约束 | contract_locked_but_not_complete | 当前技术设计提供的是阶段性实现口径，不足以直接宣称满足 PRD 原始目标 |
| P01_Mobile | 移动端基础页 | 移动端登录/入口/基础前台体验 | Phase2 冻结说明 PC-only / mobile 非目标 | 你已明确“移动端暂时不需要实现”，本轮不纳入交付验收 | design_exempted | 用户已明确豁免移动端实现 |
## 3.2 企业后台

| PRD ID | 功能 | PRD 目标定义 | 技术设计引用 | 完成标准 | 当前状态 | 实施提醒 |
|---|---|---|---|---|---|---|
| B01 | 数字员工管理 | 员工列表、配置抽屉、模型/Prompt/Skills/KB/Memory/Connector/Loop 全配置、解雇语义 | 前端接口契约 B01；技术详细设计 §7.4；Phase3 收口文档 §5.8 | 完整配置中心可用；PATCH 字段与设计一致；dismiss/soft-delete 生效；审计存在；Loop 面板可用 | accepted_verified | 已完成 P03/P04/B01 招募到员工配置闭环交付；QA `t_81f0784c` confirmed pass，PM `t_12d201af` accepted。已知仅剩非阻塞 URL nit，不影响本轮验收 |
| B02 | 技能市场 | 技能市场浏览、安装、授权、更新、卸载 | 前端接口契约 B02；技术详细设计技能相关章节 | 市场、安装、授权范围、版本管理、员工可见性完整闭环 | backend_partial | 当前能力较接近完成，但仍需按 PRD 原型确认 UX 深度 |
| B03 | 人才市场（后台） | 企业后台模板/人才管理面 | Phase2 冻结说明 §4.1 B03 合并；前端接口契约 B03/S02 说明 | 除非你明确接受“合并后等价覆盖”作为最终产品口径，否则必须补设计并恢复独立 B03 功能定义与页面/API 实现 | contract_locked_but_not_complete | 你已明确“除移动端外，其余都以 PRD 功能原型为准”，因此 B03 不能默认按历史合并直接关闭 |
| B04 | 工资管理 / Token 消耗 | usage 概览、趋势、排行、明细、导出 | 前端接口契约 B04；Phase3 收口文档 §5.9 | usage overview/records 真聚合；趋势/排行/明细/导出可用；与账本一致 | integration_partial | 不得以 balance/recharge 页面替代 B04；usage 聚合是主体 |
| B05 | 连接器 | 预设与自定义连接器、认证、测试、状态、员工授权、脱敏 | 前端接口契约 B05；技术详细设计连接器章节；Phase3 收口文档 §5.10 | connector data model、CRUD、test、credential_ref 安全、grant、前端页全部可用 | backend_partial | 这是明确缺口项，不能按“以后补”处理 |
| B06 | 行业 AI 解决方案 | 方案详情、Apply、进度、覆盖/重应用策略、统计一致 | 前端接口契约 B06；技术详细设计方案章节；Phase3 收口文档 §5.11 | 方案详情与 apply 原子事务完整；进度可见；失败全回滚；统计真实 | integration_partial | 不得以只有 system solution CRUD 视为完成；企业侧 Apply 是关键 |
| B07 | 记忆管理 | 记忆条目列表、搜索、筛选、编辑、重要度、审计、注入痕迹 | 前端接口契约 B07；B07 共享契约定稿版 | CRUD + 搜索 + 筛选 + 审计 + 注入可追踪完整可用 | backend_partial | 需按 B07 专项收口文档验收，不能只看基础 CRUD |
| B08 | 设置 | 企业资料、Logo、通知、子管理员、邀请码、帮助反馈 | 前端接口契约 B08；Phase3 文档中的 invite 命名空间收口 | 设置主路径、invite/create/list/delete、通知策略完整；与 RBAC/Audit 一致 | integration_partial | 需遵守邀请接口命名空间收口，避免旧路径漂移 |
| B09 | 充值与消耗 | 余额、充值套餐、充值记录、消耗入口、预警阈值 | 前端接口契约 B09；Phase2 冻结说明 billing/mock provider | 若你接受“功能路径完整但支付 provider 非真实联调”，则可按 mock provider 完成；若目标要求真实支付产品，则必须先补设计升级约束 | contract_locked_but_not_complete | 当前技术设计锁定的是 mock-first，不等于 PRD 意义上的真实支付产品完备 |

## 3.3 系统后台

| PRD ID | 功能 | PRD 目标定义 | 技术设计引用 | 完成标准 | 当前状态 | 实施提醒 |
|---|---|---|---|---|---|---|
| S01 | 账号管理 | 企业账号列表、筛选、详情、封禁/解封、人工充值、通知、审计 | 前端接口契约 S01；S01 契约收口文档 | `/actions` 为唯一正式写入口；列表/详情/导出/quota/action 全可用；审计完整 | integration_partial | 不得再接受 split `/ban` `/recharge` `/notify` 作为正式完成 |
| S02 | 专家管理 | 模板 CRUD、发布/下架、预览、克隆、发布记录 | 前端接口契约 S02；技术设计模板治理章节 | 模板平台治理功能完整；与 P03/P04 消费链路打通 | backend_partial | 不得只做管理 CRUD 而不验证前台可消费 |
| S03 | 行业方案管理 | 行业方案 CRUD、排序、绑定模板、统计、发布 | 前端接口契约 S03；技术设计方案治理章节 | 平台侧方案管理真实可用；与 B06 apply 链路一致 | backend_partial | 要与企业后台 B06 一起验证，不可割裂 |
| S04 | 财务管理 | 平台级收入/成本/利润、趋势、Top 企业、导出 | 前端接口契约 S04；Phase2/Phase3 billing 相关文档 | 平台财务聚合真实、权限正确、导出可用 | backend_partial | 不得用企业账本页面代替平台财务能力 |

---

## 4. 验收证据要求

每一行升级到 `accepted_verified` 前，至少要有以下证据：

1. **开发证据**
   - 对应 PR / commit / 文件路径
2. **Review 证据**
   - reviewer 明确确认：实现符合技术设计与本矩阵完成标准
3. **QA 证据**
   - 自动化测试 / 手工测试 / 场景录屏 / 截图 / 接口调用记录
4. **PM 签收证据**
   - 对应 PRD 行已满足产品目标

---

## 5. 使用方式（给执行卡 / Coding Agent）

每张开发卡必须显式写明：

```yaml
covers_prd: [P05]
design_refs:
  - docs/技术设计/详细设计文档/2026-05-27-AI Team-前端页面与接口契约详细设计.md#p05
  - docs/技术设计/详细设计文档/2026-05-27-AI Team-会话群聊编排Loop核心流程详细设计.md
matrix_ref:
  - docs/实施计划/2026-06-06-AI-Team-PRD行级验收矩阵.md#p05
```

并且必须包含：

- `task_scope`：本卡只完成什么
- `not_done_if`：哪些情况不能标 done
- `evidence_required`：需要提交什么证据

---

## 6. 执行要求

1. 本矩阵是后续所有开发、Review、QA、PM 签收的统一基线。
2. 任何开发任务都必须显式绑定一个或多个 PRD 行，并引用对应技术设计章节。
3. 任何 PRD 行只有在满足本矩阵中的完成标准，并补齐开发、Review、QA、PM 证据后，才能升级为 `accepted_verified`。
4. 若某行处于 `contract_locked_but_not_complete` 或 `in_design_conflict`，必须先补充设计裁决或明确升级约束，再进入开发收口。
5. 除 `design_exempted`（当前仅移动端）外，任何 PRD 行都不能被默认跳过。 
