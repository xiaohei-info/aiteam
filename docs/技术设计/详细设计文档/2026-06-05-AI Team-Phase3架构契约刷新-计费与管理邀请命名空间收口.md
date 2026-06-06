---
created: 2026-06-05
updated: 2026-06-06
status: ready-for-development-gate
stage: phase3-contract-refresh
canonical_name: 2026-06-05-AI Team-Phase3架构契约刷新-计费与管理邀请命名空间收口
supersedes:
  - (对现有 billing + admin-invite 路由分散问题的统一收口)
source_docs:
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-06-02-AI Team-Phase2共享契约与架构冻结说明.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-06-02-AI Team-Auth与登录会话企业入户契约收口.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md
  - /home/ubuntu/code/aiteam/docs/技术设计/详细设计文档/2026-05-27-AI Team-前端页面与接口契约详细设计.md
  - /home/ubuntu/code/aiteam/docs/复盘/2026-06-05-aiteam-phase3-pm-remaining-row-framing.md
  - /home/ubuntu/code/aiteam/app/team_panel/api_team/router_team.py
  - /home/ubuntu/code/aiteam/app/team_panel/api_team/router_team_settings_billing.py
  - /home/ubuntu/code/aiteam/app/team_panel/api_team/router_enterprise_admin.py
---

# AI Team Phase 3 架构契约刷新：计费与管理邀请命名空间收口

## 1. 文档定位

本文是 Phase 3 全产品封闭启动前的架构契约收口文档，解决两个跨模块命名空间一致性问题，
并确认剩余 12 行的前端/后端/数据边界与实现门控。

本文不重复现有共享运行口径或 auth 契约，只在以下两处做显式收口裁决：

1. **计费（billing）命名空间**：当前实现中 `/api/team/billing/*` 与 `/api/enterprise-admin/billing/usage` 两套路由共存，需裁决。
2. **管理邀请（admin-invite）命名空间**：当前实现中 `POST /api/team/settings/admin-invites` 与 auth 契约中 `POST /api/enterprise-admin/invites` 不一致，需裁决。

若现有代码/契约与本文冲突，Phase 3 实现一律以本文为准。

## 2. 方案调研

### 2.1 已核对材料

- Phase 2 冻结说明 §4.2 中 billing/recharge API 保留列表
- Auth 契约收口 §7.4 中 `POST /api/enterprise-admin/invites` / `GET /api/enterprise-admin/invites`
- 前端页面与接口契约详细设计 §4 中 B04/B05/B08 的推荐 API 分组
- 当前 `router_team.py` / `router_team_settings_billing.py` / `router_enterprise_admin.py` 三条路由的实际挂载路径
- PM 最新 framing 文档中的 12 行验收标准

### 2.2 复用判断结论

不引入新的架构层或路由分组。目标是把已存在的三条路由中因渐进实现积累的命名空间偏离
收束到与已有 frozen contract 一致的路径上。

## 3. 计费命名空间裁决

### 3.1 问题

当前计费接口分散在两个命名空间下：

| 接口 | 当前路径 | 所属路由模块 |
|------|----------|------------|
| 余额查询 | `GET /api/team/billing/balance` | router_team（委托 router_team_settings_billing） |
| 充值记录 | `GET /api/team/billing/recharges` | router_team（委托 router_team_settings_billing） |
| 创建充值 | `POST /api/team/billing/recharges` | router_team（委托 router_team_settings_billing） |
| 用量聚合 | `GET /api/enterprise-admin/billing/usage` | router_enterprise_admin |

Phase 2 冻结说明 §4.2(4) 批准的接口列表是：
- `GET /api/team/billing/usage/overview`
- `GET /api/team/billing/usage/records`
- `GET /api/team/billing/balance`
- `GET /api/team/billing/recharges`

前端页面契约 §4 中 B04 指定的也是 `/api/team/billing/usage/overview` 与 `/api/team/billing/usage/records`。

**当前实现的 `/api/enterprise-admin/billing/usage` 不符合已冻结的共享契约。**

### 3.2 裁决

计费命名空间统一收敛到 `/api/team/billing/*`。最终固定路由：

| 方法 | 路径 | 用途 | 当前实现状态 |
|------|------|------|-----------|
| GET | `/api/team/billing/balance` | 余额与用量摘要 | 已实现 |
| GET | `/api/team/billing/recharges` | 充值记录列表 | 已实现 |
| POST | `/api/team/billing/recharges` | 创建充值（mock provider） | 已实现 |
| GET | `/api/team/billing/usage/overview` | 用量聚合概览（B04 看板） | 需从 `/api/enterprise-admin/billing/usage` 迁移 |
| GET | `/api/team/billing/usage/records` | 用量明细（按员工/时间段） | 新增 |

实现约束：

- `/api/enterprise-admin/billing/usage` 作为兼容别名保留一期（Phase 3 内），标记为 deprecated，不删除；日志中记录 deprecated 调用。
- `usage/overview` 响应体复用现有 `get_billing_view` 的聚合结构（`total_tokens`、`total_cost_cents`、`by_employee`）。
- `usage/records` 返回分页列表，加 `employee_id`、`period_start`、`period_end` 筛选。
- 所有计费接口权限：`owner / enterprise_admin / finance_admin` 可读；写操作（recharge）限 `owner / finance_admin`。
- 余额不足拦截（`guard_run_creation_allowed`）继续在 run/message 创建前检查 `enterprise_billing_account`。

## 4. 管理邀请命名空间裁决

### 4.1 问题

Auth 契约收口 §7.4 明确定义管理邀请 API：

```
POST   /api/enterprise-admin/invites   # 创建邀请
GET    /api/enterprise-admin/invites   # 邀请列表
DELETE /api/enterprise-admin/invites/{invite_id}  # 撤销邀请
```

当前实现中邀请创建挂载在 `POST /api/team/settings/admin-invites`，邀请列表聚合在 `GET /api/team/settings` 的响应中。
这与 auth 契约不一致。

### 4.2 裁决

管理邀请 CRUD 统一收敛到 `/api/enterprise-admin/invites`。最终固定路由：

| 方法 | 路径 | 用途 | 当前实现状态 |
|------|------|------|-----------|
| POST | `/api/enterprise-admin/invites` | 创建管理邀请（含 idempotency_key） | 需从 `/api/team/settings/admin-invites` 迁移 |
| GET | `/api/enterprise-admin/invites` | 邀请列表（按 enterprise 过滤） | 新增独立端点 |
| DELETE | `/api/enterprise-admin/invites/{invite_id}` | 撤销/过期邀请 | 新增 |

实现约束：

- `POST /api/team/settings/admin-invites` 作为兼容别名保留一期，标记为 deprecated。
- `GET /api/team/settings` 响应中的 `admin_invites` 字段保留不变（只读聚合），不删除现有字段。
- 邀请创建权限：`owner / enterprise_admin`。
- 邀请 payload 保持不变：`phone`、`role`（限 `owner/enterprise_admin/finance_admin`）、`permissions`、`message`、`idempotency_key`。
- 邀请生命周期：`pending → accepted | revoked | expired`。已存在于 `admin_invite` 表的 status CHECK 约束中。

### 4.3 与 onboarding 邀请的区分

两类邀请是不同业务域，不可混用：

| 维度 | 管理邀请（admin-invite） | Onboarding 加入 |
|------|------------------------|----------------|
| 路由 | `/api/enterprise-admin/invites` | `/api/auth/onboarding/join-enterprise` |
| 发起者 | 企业管理员 | 新用户自举 |
| 目标用户 | 已存在的用户（通过手机号关联） | 刚注册的新用户 |
| 角色 | owner / enterprise_admin / finance_admin | member（默认） |
| 邀请形式 | phone + invite_code | invite_code（从 URL 或管理员分享） |

两条路径的 invite_code 格式共享 `ADM-` 前缀约束，但分属不同表（`admin_invite` vs 待实现的 `enterprise_invite_code`）。
Phase 3 不要求合并两表，只需确保路由与 auth 契约一致。

## 5. 剩余12行分解确认

以下按 PM framing 文档中 12 行逐行确认前端/后端/数据边界与当前差距，
并标注是否需要额外的 data-rd 所有权或 frontend/backend 拆分修正。

### 5.1 P02 — 主界面/工作台

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | ✅ `workbench_view_service` + `get_workbench_view` 聚合查询已实现 | — |
| 后端 | ✅ `GET /api/team/workbench` 已实现 | 需补充空态/错误态/权限拒绝态的响应体规范 |
| 前端 | 部分完成 | 需完善空态渲染、错误态展示、导航路由完整性 |

**不需要额外修正。**

### 5.2 P03 — 人才市场

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | ✅ templates + recruitment_order 表完整 | — |
| 后端 | ✅ `GET templates`, `GET templates/{id}`, `POST recruitments` 已实现 | 需补充搜索/筛选/category/tag 查询参数；招募并发限制（同一用户同一模板 5 分钟内不可重复招募） |
| 前端 | 部分完成 | 需实现搜索框、分类筛选、标签过滤、招募动画、并发限制反馈 |

**不需要额外修正。** 招募并发限制是后端业务逻辑，现有 `recruitment_order` 表可承载幂等检查。

### 5.3 P04 — 专家详情页

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | ✅ templates 表完整（profile/skills/knowledge/memory 在 capabilities_json 中） | — |
| 后端 | ✅ `GET /api/team/talent-market/templates/{id}` 已实现 | 响应体需确认包含完整 capabilities（skills/knowledge/memory 预设值） |
| 前端 | 缺失 | 需新建 detail page：Tab 组件 + 招募按钮 |

**不需要额外修正。** 但前端实现前须先确认 `GET templates/{id}` 响应体中的 `prompt_pack_json` / `default_binding_json` 已被前端正确映射到 Tab 内容。

### 5.4 P05 — 单聊对话页

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | ✅ conversation + team_run + run_event 完整 | — |
| 后端 | ✅ conversation CRUD + run 创建 + SSE stream + 补拉已实现 | 需补充：附件上传与展示、消息引用、重试失败消息、中止 streaming |
| 前端 | 部分完成 | 需实现：tool_call 渲染组件、重试/中止按钮、附件处理 |

**不需要额外修正。** 但 tool_call 渲染依赖 Gateway 正确映射 Runtime 原始 tool 事件到 `RunTimelineEvent(event_type="tool_call")`。

### 5.5 P06 — 群聊页面

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | ✅ group conversation + members + team_run（orchestration）完整 | — |
| 后端 | ✅ `POST group-conversations/{id}/messages` + SSE stream 已实现 | 需补充：成员管理 API、@mention 路由解析、SSE 断流重连 |
| 前端 | 部分完成 | 需实现：成员管理面板、@mention UI、任务树可视化、SSE 重连 |

**不需要额外修正。** SSE 断流重连策略应由 `timeline-client.js` 统一封装（已有 `timeline-client.js`/`api-client.js`）。

### 5.6 P08 — 知识库

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | 部分（仅有 `employee_knowledge_binding` 绑定表，无文档/索引表） | **需 data-rd 所有权：文档上传表、索引状态表、LightRAG 集成状态表** |
| 后端 | 部分（仅有绑定 CRUD） | 需新增：文件上传 pipeline、LightRAG 触发、检索 API、citation 注入 |
| 前端 | 缺失 | 需新建：知识库管理页、上传界面、检索结果展示、citation 高亮 |

**需修正：P08 data-rd 层缺少文档存储与索引状态建模。** 推荐在现有 DB 中新增：

- `knowledge_document`（文档元数据：file_name、file_type、status、rag_doc_id、error_message）
- `knowledge_index_binding`（RAG 索引 → employee 绑定：rag_index_id、employee_id、scope）

LightRAG 自身不在此层建模（属于 External Capability），但 Team Panel 必须持有其调用状态和绑定关系。

### 5.7 P09 — 办公室动态

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | ✅ `office_view_service` 聚合已实现 | — |
| 后端 | ✅ `GET /api/team/office/scene` + `GET /api/team/office/feed` 已实现 | 需补充：事件驱动的实时推送（当前依赖轮询） |
| 前端 | 部分完成（`office-scene.js`） | 需实现：实时状态气泡、全屏视图、SSE 订阅 |

**不需要额外修正。** 实时推送建议复用现有 SSE 通道（`event: timeline`），在 Gateway 层过滤出 office-relevant 事件（`run_started`、`run_succeeded`、`run_failed`、`heartbeat`）转发到 office SSE 端点。

### 5.8 B01 — 数字员工管理

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | ✅ employee + bindings 表完整 | — |
| 后端 | ✅ `GET/PATCH employees` + 绑定 CRUD 已实现 | 需补充：dismiss（解雇）语义实现（soft-delete/archive）、完整配置抽屉的 PATCH allowlist 审计 |
| 前端 | 部分完成（`admin-employees.js` + `admin-employee-drawer.js`） | 需完善：Model/Prompt/Skills/KB/Connector 全部配置 tab、dismiss 确认流程 |

**不需要额外重做命名空间裁决，但需显式继承 Phase 2 已冻结口径。** B01 页面北向接口继续以 `GET /api/team/employees`、`GET /api/team/employees/{id}`、`PATCH /api/team/employees/{id}` 为唯一正式路径；`/api/enterprise-admin/employees` 仅可视为当前运行时仍保留的兼容读别名，不能作为 `admin-employees.js`、前端验收或 QA 断言的 truth source。现有 PATCH allowlist（`display_name`、`status`、`skills_add`、`skills_remove`）需扩展到 Model、Prompt、Connector 等完整字段，并在 `_ALLOWED_PATCH_FIELDS` 中同步更新。

### 5.9 B04 — 工资管理（Token 消耗）

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | 部分（`enterprise_billing_account` 有，但 usage log 聚合 cron 未实现） | **需 data-rd 所有权：usage log 聚合 cron 归属谁？** |
| 后端 | 部分（balance/recharges 有，usage overview/records 需迁移补全） | 需补充：usage log 聚合定时任务、B04 看板数据查询 |
| 前端 | 部分（`admin-billing.js`） | 需完善：趋势图、员工排行、明细查询 |

**需修正：usage log 聚合逻辑的 data-rd 所有权。** 裁决如下：

- `run_event` 表已承载 usage_recorded 事件（事件类型在共享口径 §4.3 中已定义）。
- 聚合 cron 归属 **Team Panel 层**（属于业务口径），而不是 Hermes Cron。
- 聚合 cron 可复用 Hermes Cron 的基础调度能力，但聚合逻辑写在 `team_panel/application/queries/billing_aggregation_service.py`。
- 聚合频率：每小时一次，计算窗口内新完成的 `usage_recorded` 事件。

### 5.10 B05 — 连接器

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | 仅为设计阶段，无实现 | **需 data-rd 所有权：connector 配置表、credential 存储表** |
| 后端 | 缺失 | 需新增：connector CRUD、连接测试、credential 安全存储与脱敏 |
| 前端 | 缺失 | 需新建：连接器管理页、预设/自定义 MCP 配置表单、连接状态展示 |

**需修正：B05 在 data-rd 和后端两层均缺失实现。** 推荐数据模型：

- `connector_definition`（系统预设连接器定义：code、name、schema、auth_type）
- `enterprise_connector`（企业连接器实例：config_json、credential_ref、status、last_test_at）
- `employee_connector_grant`（员工连接器授权：employee_id、connector_id、enabled）

credential 安全存储约束：
- `credential_ref` 字段只存引用（如 vault path 或加密 key id），不存明文。
- API 响应中 credential 字段一律脱敏为 `****`。
- 连接测试 API（`POST /api/team/connectors/{id}/test`）返回测试日志，不返回 credential。

### 5.11 B06 — 行业 AI 解决方案

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | ✅ `industry_solution` + `solution_template_binding` 表完整 | — |
| 后端 | 部分（solution CRUD 在 system-admin 层实现，apply 逻辑未实现） | 需新增：apply 事务（原子性、失败全量回滚）、应用状态查询 |
| 前端 | 缺失 | 需新建：方案详情页、Apply 按钮与进度、已应用状态展示 |

**不需要额外修正。** Apply 事务原子性约束：

- Apply 是一组 `recruitment_order` 的批量创建，走同一个 DB 事务。
- 任一步失败则全部回滚，不产生半初始化 employee。
- 幂等键为 `solution_apply:{solution_id}:{enterprise_id}:{version_no}`。

### 5.12 All — 平台运营权限/横切

| 层 | 状态 | 差距 |
|----|------|------|
| 数据 | ✅ enterprise + membership + enums 完整 | — |
| 后端 | 部分（audit_event 有，但 RBAC 中间件未做全端点覆盖） | 需补充：所有 `/api/team/*`、`/api/enterprise-admin/*`、`/api/system-admin/*` 的 RBAC 拦截、数据导出 API |
| 前端 | 部分 | 需确保所有管理页面展示 audit log 入口，export 按钮 |

**不需要额外修正。** RBAC 权限矩阵以共享口径 §8 的角色集合为准。实现要求：

- 所有写操作（POST/PATCH/DELETE）必须记录 audit_event。
- `finance_admin` 不得访问 B01（员工配置）/B05（连接器）/S01（企业账号写操作）/S02（模板治理）。
- `system_operator` 不得执行 S01 的封禁/人工充值操作。
- 任意 API 响应中不出现 `admin`/`manager`/`viewer` 等旧角色枚举。

## 6. 共享前置契约门控

以下契约必须在并行实现之前完成收口，否则下游实现会出现命名空间或数据模型冲突：

### 6.1 本阶段必须完成的契约

| 序号 | 契约项 | 状态 | 门控影响 |
|------|--------|------|---------|
| C1 | 计费命名空间收口（本文 §3） | **本文裁决** | 门控 B04、B09 的 API 实现 |
| C2 | 管理邀请命名空间收口（本文 §4） | **本文裁决** | 门控 B08 的 API 实现 |
| C3 | P08 知识库 data-rd 建模（本文 §5.6） | **本文裁决** | 门控 P08 的数据层实现 |
| C4 | B05 连接器 data-rd 建模（本文 §5.10） | **本文裁决** | 门控 B05 的数据层实现 |
| C5 | 用量聚合 cron 所有权（本文 §5.9） | **本文裁决** | 门控 B04 的后端实现 |

### 6.2 已冻结、可直接引用的契约

以下契约已在 Phase 2 冻结，Phase 3 不需要重新裁决：

- Auth / session / token / device / onboarding（`2026-06-02-AI Team-Auth与登录会话企业入户契约收口.md`）
- 事件协议 / 游标 / 状态机 / 北向 API / 角色（`2026-05-28-AI Team-共享运行口径定稿版.md`）
- Phase 2 范围冻结与非目标（`2026-06-02-AI Team-Phase2共享契约与架构冻结说明.md`）
- S01 系统账号管理（`2026-06-03-AI Team-S01系统账号管理契约收口.md`）

## 7. 实施门控摘要

为下游 kanban 任务拆解提供明确的实现顺序与依赖关系：

### 7.1 实现批次建议

**Batch A（共享契约先行 — 没有行级依赖）**
- A1: 计费命名空间迁移（`/api/enterprise-admin/billing/usage` → `/api/team/billing/usage/*`）
- A2: 管理邀请命名空间迁移（`POST /api/team/settings/admin-invites` → `/api/enterprise-admin/invites`，补全 GET/DELETE）
- A3: P08 知识库 data-rd 表创建（`knowledge_document`、`knowledge_index_binding`）
- A4: B05 连接器 data-rd 表创建（`connector_definition`、`enterprise_connector`、`employee_connector_grant`）

**Batch B（后端先行 — 依赖 Batch A 数据表）**
- B1: P08 知识库后端（文件上传 → LightRAG → 检索 → citation）
- B2: B05 连接器后端（CRUD + 连接测试 + credential 安全存储）
- B3: B04 用量聚合 cron + usage/overview + usage/records API
- B4: B06 Apply 事务逻辑 + 应用状态 API

**Batch C（前端 — 依赖 Batch B 后端 API）**
- C1: P03 搜索/筛选/招募动画（依赖已有 API，不依赖 Batch B）
- C2: P04 专家详情页（依赖已有 API，不依赖 Batch B）
- C3: P05 单聊 tool_call 渲染 + 重试/中止 UI
- C4: P06 群聊成员管理 + @mention + task tree + SSE 重连
- C5: P08 知识库管理页
- C6: P09 办公室实时状态气泡 + 全屏
- C7: B01 完整配置抽屉（Model/Prompt/Skills/KB/Connector tab）
- C8: B04 工资看板（趋势图 + 排行 + 明细）
- C9: B05 连接器管理页
- C10: B06 行业方案详情页 + Apply 进度

**Batch D（横切 — 可与 Batch B/C 并行）**
- D1: P02 工作台空态/错误态/权限态处理
- D2: All RBAC 全端点覆盖 + 数据导出
- D3: 全量 E2E 验证

### 7.2 可并行事项

- Batch A1/A2 与 A3/A4 各自独立，可并行。
- Batch B1（P08 知识库）与 B2（B05 连接器）完全独立，可并行。
- Batch C1/C2 不依赖 Batch B，可即刻开始。
- Batch D 与 Batch B/C 除 RBAC 外无依赖，可并行。
- P05/P06/P09/B01 前端工作在 Batch B 后端完成后可立即并行。

### 7.3 必须串行的事项

- Batch A 必须在 Batch B 之前完成（数据表依赖）。
- B04 用量聚合 cron 必须先于 B04 前端看板。
- P08/B05/B06 后端必须先于对应前端。

## 8. 风险与边界

### 8.1 主要风险

1. 计费路由迁移时若同步删除旧路径，可能导致已有前端/测试中断。对策：旧路径保留为 deprecated alias 一期。
2. P08 LightRAG 集成若遇到性能/内存瓶颈，可能阻塞 P08 整体交付。对策：先做小规模 spike 验证。
3. B05 credential 安全存储若选择不当（如明文 DB），会导致安全债务。对策：先冻结 credential_ref 模式，具体存储方案可在实现阶段用 env-secret 或 Vault path。

### 8.2 非目标

以下不在本次契约刷新范围内：

- 真实支付/短信/微信 provider 联调
- 移动端页面
- B03 独立后台（已合并）
- P10 Scheduled Job/Loop（已延期）
- 新角色枚举或新主状态枚举

## 9. 验证方式

本文裁决有效性的验证标准：

1. 计费接口不再出现 `/api/enterprise-admin/billing/usage` 作为正式北向路径（deprecated alias 除外）。
2. 管理邀请创建不再走 `/api/team/settings/admin-invites` 作为正式北向路径（deprecated alias 除外）。
3. P08/B05 数据表在数据库中可用，且 schema 满足本文约束。
4. 下游实现卡在说明中引用本文作为计费/邀请命名空间的唯一裁决来源。
5. 批量 A 的 migration/fix 完成后，已有测试继续通过（兼容别名不破坏现有行为）。

## 10. 最终结论

推荐设计：计费统一收口到 `/api/team/billing/*`，管理邀请统一收口到 `/api/enterprise-admin/invites`，P08/B05 新增 data-rd 建模，B04 用量聚合 cron 归 Team Panel 层。

边界：不新增路由分组，不改变共享角色/状态/事件/游标协议，不改变 team/enterprise-admin/system-admin 三前缀原则。

风险：旧路由路径保留为 deprecated alias 一期，避免破坏现有前端和测试。

验证：以迁移后已有测试通过 + 新表可用 + 新路由可调为完成标准。实现顺序严格按 §7 批次推进。
