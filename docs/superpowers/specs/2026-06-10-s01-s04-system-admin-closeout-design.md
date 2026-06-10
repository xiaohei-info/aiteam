# S01-S04 System Admin Closeout Design

## 1. Goal

在当前 `master` 基线代码之上，收口系统后台 `S01` 账号管理、`S02` 专家管理、`S03` 行业方案管理、`S04` 财务管理四个子域，使其满足：

- `docs/实施计划/验收规格包/2026-06-06-AI-Team-S01-S04-系统后台验收规格.md`
- `docs/需求文档/` 中 PRD/原型表达
- `docs/技术设计/` 中正式设计与收口文档

本次工作只负责该规格包对应功能，不扩展到其他 PRD 域。

## 2. Scope And Boundaries

### In Scope

- `S01-F01` 企业账号列表、筛选、详情
- `S01-F02` 封禁/解封/人工充值/通知统一动作入口
- `S02-F01` 模板 CRUD、预览、克隆、发布记录
- `S02-F02` 模板治理与前台消费链路打通
- `S03-F01` 行业方案平台治理
- `S03-F02` 方案治理与企业侧 Apply 一致
- `S04-F01` 平台财务总览、趋势、Top 企业、导出
- `S04-F02` 权限边界与数据隔离

### Out Of Scope

- 移动端
- 规格包之外的企业后台、工作台、聊天、Loop 新功能
- 任何 Hermes Runtime 业务逻辑扩写
- 与本规格包无关的重构

## 3. Current-State Assessment

当前主线不是从零开始，已存在以下系统后台骨架：

- 后端入口：`app/team_panel/api_team/router_system_admin.py`
- 系统治理命令：`app/team_panel/application/commands/system_admin_content_service.py`
- 系统治理查询：`app/team_panel/application/queries/system_admin_view_service.py`
- 页面：
  - `app/static/aiteam/pages/system-accounts.js`
  - `app/static/aiteam/pages/system-templates.js`
  - `app/static/aiteam/pages/system-solutions.js`
  - `app/static/aiteam/pages/system-finance.js`
- 已有验证：
  - `app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py`
  - `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
  - `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
  - `app/tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py`
  - `app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py`
  - `app/tests/aiteam/layer4_frontend_bff/test_system_finance_rendering.py`
  - `app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py`

这意味着本次任务本质上是“按验收规格补齐与收口”，不是新建第二套系统后台实现。

## 4. Design Principles

### 4.1 Single Worktree, Single Branch, Sequential Closeout

当前 worktree 已固定到独立分支 `codex/s01-s04-system-admin-closeout`。后续实现与提交都在这个 worktree 连续进行，不拆成多个并行分支。

### 4.2 One Subdomain At A Time

按 `S01 -> S02 -> S03 -> S04` 顺序推进。每个子域必须完成：

1. 设计对齐
2. failing tests
3. 最小实现
4. 子域验证
5. 回归验证

在前一个子域没有形成可验证闭环前，不开始下一个子域的产品代码实现。

### 4.3 Evidence Over Matrix Status

`docs/实施计划/2026-06-06-AI-Team-PRD行级验收矩阵.md` 中现有状态字段只作为历史线索，不作为当前完成判断。当前完成性只由真实代码、测试、页面行为和验收规格共同决定。

### 4.4 No Parallel Shadow Contract

系统后台所有 northbound 行为继续收束在现有 `router_system_admin.py` 契约面上，不新增平行 router、平行页面或平行 service。

## 5. Subdomain Completion Definitions

### 5.1 S01 Account Management

完成标准：

- 企业列表、搜索筛选、详情、quota、导出可用
- 正式写入口为 `POST /api/system-admin/enterprises/{enterprise_id}/actions`
- `ban/unban/recharge/notify` 都有完整请求语义、确认语义和审计记录
- legacy split `/ban|/recharge|/notify` 只允许作为兼容 alias，不能成为正式完成口径
- 系统后台页面表达与 PRD 的账号治理场景一致，不以简单数据表替代

主要实现落点：

- `app/team_panel/api_team/router_system_admin.py`
- `app/static/aiteam/pages/system-accounts.js`

主要验证落点：

- `app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py`
- `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
- `app/tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py`

### 5.2 S02 Template Governance

完成标准：

- 系统后台模板 CRUD 可用
- 模板预览、clone、publish/unpublish、发布记录完整
- 治理语义仅落在系统后台 `S02`，不回退到企业后台模板中心
- 模板上下架真实影响 `P03/P04` 招募消费入口
- 已招募员工继续遵守“实例对象独立于模板治理”的既有设计

主要实现落点：

- `app/team_panel/application/commands/system_admin_content_service.py`
- `app/team_panel/application/queries/system_admin_view_service.py`
- `app/static/aiteam/pages/system-templates.js`

主要验证落点：

- `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
- `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
- `app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py`
- 与 `P03/P04` 消费侧相关测试

### 5.3 S03 Solution Governance

完成标准：

- 行业方案 CRUD、模板绑定、发布控制、统计字段完整
- 平台治理结果与企业侧 `B06 Apply` 使用同一事实源
- 页面具备方案预览和治理动作表达，不是只有裸列表
- 方案配置真实驱动企业侧 Apply 结果与统计结果

主要实现落点：

- `app/team_panel/application/commands/system_admin_content_service.py`
- `app/team_panel/application/queries/system_admin_view_service.py`
- `app/static/aiteam/pages/system-solutions.js`

主要验证落点：

- `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
- `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
- `app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py`
- `app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py`

### 5.4 S04 Platform Finance

完成标准：

- 平台级收入、成本、利润、趋势、Top 企业、导出完整
- 口径是平台经营聚合，不是企业账本页面换壳
- 权限隔离严格：普通企业角色不能看到平台财务明细
- 导出与页面展示使用同一聚合事实

主要实现落点：

- `app/team_panel/application/queries/system_admin_view_service.py`
- `app/team_panel/api_team/router_system_admin.py`
- `app/static/aiteam/pages/system-finance.js`

主要验证落点：

- `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
- `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
- `app/tests/aiteam/layer4_frontend_bff/test_system_finance_rendering.py`

## 6. Implementation Order

### Phase 1: S01

先收口系统后台账号治理。原因：

- S01 的 northbound 写契约已有专门收口文档
- 它是 system-admin 入口里最基础的治理面
- 先稳定 system-admin 基线可降低后续 `S02/S03/S04` 的测试噪音

### Phase 2: S02

在 `S01` 稳定后补模板治理，确保系统侧模板发布口径与前台消费口径一致。

### Phase 3: S03

在模板治理稳定后补方案治理，保证方案绑定与 `B06 Apply` 使用同一对象语义。

### Phase 4: S04

最后补平台财务聚合和权限边界，避免在前面治理对象还未稳定时误判财务数据口径。

## 7. Testing Strategy

### 7.1 Test-First Rule

每个子域先扩 failing tests，再写实现。不得先写产品代码再补测试。

### 7.2 Layered Verification

每个子域至少覆盖：

- `layer2_team_panel`：northbound 契约、查询/写入语义、RBAC
- `layer4_frontend_bff`：页面渲染、交互入口、导出/预览等前端语义

跨域一致性必须额外覆盖：

- `S02`：消费侧模板可见性/招募链路回归
- `S03`：`layer5_flows/test_solution_apply_governance_flow.py`
- `S04`：平台财务与权限隔离回归

### 7.3 Completion Evidence

每个子域完成时至少保留：

- 对应测试命令与通过结果
- 关键 API 语义证据
- 关键页面渲染/交互证据
- 若有跨域一致性要求，则提供 flow 级证据

## 8. File-Level Change Intent

预计主要改动文件集中在：

- `app/team_panel/api_team/router_system_admin.py`
- `app/team_panel/application/commands/system_admin_content_service.py`
- `app/team_panel/application/queries/system_admin_view_service.py`
- `app/static/aiteam/pages/system-accounts.js`
- `app/static/aiteam/pages/system-templates.js`
- `app/static/aiteam/pages/system-solutions.js`
- `app/static/aiteam/pages/system-finance.js`
- 对应的 `app/tests/aiteam/layer2_team_panel/*`
- 对应的 `app/tests/aiteam/layer4_frontend_bff/*`
- `app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py`

本次不计划修改：

- `./.hermes/hermes-agent/`
- 与系统后台规格包无关的团队前台页面
- 与本规格包无关的共享契约

## 9. Risks And Controls

### Risk 1: Matrix Status Drift

控制：所有实现与验收判断回到真实代码、测试和规格包，不复用旧状态结论。

### Risk 2: Placeholder-Shaped Platform Finance

控制：`S04` 明确要求平台财务口径必须与企业账本区分，测试必须直接证明这一点。

### Risk 3: Template/Solution Governance Looks Complete But Does Not Drive Consumption

控制：`S02/S03` 不以系统后台页面自身通过为完成，必须同时验证前台消费或 Apply flow 一致性。

### Risk 4: Detached Worktree Commit Loss

控制：当前 worktree 已切到独立分支，后续提交不会悬空。

## 10. Success Criteria

当且仅当以下条件同时满足，才可进入“实现完成”判断：

- `S01-S04` 对应 `spec_id` 的产品行为被真实代码覆盖
- 对应测试按层次通过
- 系统后台页面不再是占位表达
- 跨域消费一致性要求被证明
- 最终变更在当前 worktree 的独立分支上形成可审查 commit
