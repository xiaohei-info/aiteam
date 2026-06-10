# B01-B03 Admin Backend Design

> Scope: `B01-F01/F02/F03`, `B02-F01/F02`, `B03-F03` in `docs/实施计划/验收规格包/2026-06-06-AI-Team-B01-B03-员工技能模板后台验收规格.md`

## Goal

在当前 Team Panel 北向契约基础上，把企业后台员工配置、技能市场、后台人才市场补到可验收状态，不新增第二套业务对象，不偏离既有 `P03/P04/B01/S02` 分层。

## Assumptions

- 按用户当前目标，`B03` 恢复为企业后台独立模板消费页 `/admin/templates` 的正式交付面。
- `B03` 只承担企业侧模板浏览、详情跳转、招募入口，不承担系统后台模板治理。
- 招募后员工的后续能力配置继续统一走 `B01 /api/team/employees/{id}`。

## Non-goals

- 不扩到 `B04+` 其他后台模块。
- 不修改系统后台 `S02` 的模板治理职责。
- 不引入新的企业模板编辑对象或新持久化表。

## Current State

### B01

- `GET/PATCH /api/team/employees/{id}` 已支持模型、Prompt、知识库、记忆、连接器、Scheduled Job 等字段写入。
- `admin-employee-drawer.js` 目前只有状态切换和技能授权是可操作的，其他 tab 主要是只读展示和说明文案。

### B02

- `/api/team/skills/catalog`、`/api/team/skills/installs`、安装/更新/卸载合同已存在。
- 前端 `admin-skills.js` 仍带“后端未返回安装审计字段”的降级提示。

### B03

- `/api/team/templates`、`/api/team/templates/{id}` 与 `admin-templates.js` 已存在。
- 当前模板列表处理器直接读取 `AgentTemplateRepo.list_all()`，企业侧可能看到不应暴露的未发布模板。

## Design

### 1. B03 enterprise templates

- 企业后台模板列表与详情只返回 `status=published` 且 `deleted_at is null` 的模板。
- `/api/team/templates` 继续作为 `/api/team/talent-market/templates` 的企业后台 alias。
- `admin-templates.js` 继续只做浏览、前台详情跳转、直接招募。

### 2. B02 skill install audit visibility

- 在技能安装/更新/卸载时已经写入 `audit_event`。
- `/api/team/skills/installs` 返回每个 install 的最近审计状态摘要，前端不再展示“后端未返回安装审计字段”的降级文案。
- 审计状态最小口径：最近事件类型与时间，供后台可见性验证使用。

### 3. B01 employee drawer editing

- 复用现有 `PATCH /api/team/employees/{id}`，在抽屉内为下列 tab 补最小保存表单：
  - `model`: `model_provider`, `model_name`
  - `prompt`: `prompt_version`, `prompt_system`, `prompt_behavior_rules_json`, `prompt_opening_message`
  - `knowledge`: `knowledge_base_ids`，先用逗号分隔输入
  - `memory`: `memory_mode`, `memory_provider_code`, `memory_retention_days`, `memory_writeback_enabled`
  - `connectors`: `connector_ids`，先用逗号分隔输入
  - `loop`: `scheduled_job` 创建/更新，`scheduled_job_action` 暂保留现有状态治理
- 保存成功后立即以返回值或重新聚合后的本地状态刷新当前 tab，保持“改动真实生效”。
- 不在本轮引入复杂选择器，先用最笨但清晰的表单控件闭合能力。

## Files

- Backend
  - `app/team_panel/api_team/router_team.py`
- Frontend
  - `app/static/aiteam/pages/admin-employee-drawer.js`
  - `app/static/aiteam/pages/admin-skills.js`
- Tests
  - `app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py`
  - `app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py`
  - `app/tests/aiteam/layer4_frontend_bff/test_admin_skills_rendering.py`
  - `app/tests/aiteam/layer4_frontend_bff/test_admin_templates_rendering.py`
  - `app/static/aiteam/pages/admin-employee-drawer.test.js`

## Validation

- Layer2:
  - `pytest app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py -q`
  - `pytest app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py -q -k 'employee or skills or template or recruit'`
- Layer4 / page modules:
  - `pytest app/tests/aiteam/layer4_frontend_bff/test_admin_skills_rendering.py app/tests/aiteam/layer4_frontend_bff/test_admin_templates_rendering.py -q`
  - `node app/static/aiteam/pages/admin-employee-drawer.test.js`
