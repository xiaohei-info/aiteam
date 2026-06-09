# AI Team Product Delivery Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `aiteam` 代码基线上，以最小必要改动完成 AI Team 全产品交付收口，覆盖 `docs/需求文档/` 与 `docs/技术设计/` 中约束的前台、后台、系统端功能、页面交互与验收验证。

**Architecture:** 保持既有分层不变：前端页面继续走 `app/static/aiteam/pages/*`，北向业务接口继续走 `app/team_panel/api_team/*`，控制面聚合查询与命令继续落在 `app/team_panel/application/*`，运行态适配继续落在 `app/agent_gateway/*`。本计划不走“重做整个产品”路线，而是先建立验收基线，再按 `P01 -> P02-P09 -> B01-B09 -> S01-S04 -> 交付验证` 的波次补齐真实缺口。

**Tech Stack:** Python 3.12, Team Panel / Agent Gateway, PostgreSQL(ephemeral test DB), pytest, Node.js page tests, vanilla JS page shell, SSE timeline.

---

## 当前基线

- 当前仓库已存在完整的 AI Team 主代码面：
  - `app/team_panel/api_team/router_team.py`
  - `app/team_panel/api_team/router_auth.py`
  - `app/team_panel/application/queries/*`
  - `app/team_panel/application/commands/*`
  - `app/static/aiteam/page-shell.js`
  - `app/static/aiteam/pages/*`
  - `app/tests/aiteam/*`
- 当前可直接复用的现有回归面：
  - 页面壳与前台路由：`app/tests/aiteam/layer4_frontend_bff/test_aiteam_app_pages.py`
  - 前台主链路：`app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py`、`test_private_chat_flow.py`、`test_group_conversation_flow.py`
  - 企业后台：`app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py`、`test_team_api_contracts.py`
  - 系统后台：`app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
- 本轮已确认的真实验证现状：
  - `node app/static/aiteam/pages/app-marketplace.test.js` 通过
  - `node app/static/aiteam/pages/app-template-detail.test.js` 通过
  - `node app/static/aiteam/pages/admin-employees.test.js` 通过
  - `node app/static/aiteam/pages/admin-connectors.test.js` 失败，现象为“page should render opaque credential ref”
  - `pytest app/tests/aiteam/*` 当前被 `ModuleNotFoundError: No module named 'psycopg2'` 阻塞，只能说明环境未就绪，不能说明功能已坏或已好

## 文件结构与责任

- `app/team_panel/api_team/router_auth.py`
  - P01 登录入户北向 Auth 契约
- `app/team_panel/api_team/router_team.py`
  - P02-P09、B01-B09 的主要 Team Panel northbound 写读入口
- `app/team_panel/api_team/router_system_admin.py`
  - S01-S04 系统后台入口
- `app/team_panel/application/queries/*.py`
  - workbench / conversation / office / billing / system-admin 聚合查询
- `app/team_panel/application/commands/*.py`
  - 招募、对话、Loop、技能安装、员工配置、系统内容管理
- `app/static/aiteam/page-shell.js`
  - `/app/*`、`/admin/*`、`/system/*` 页面装配与路由
- `app/static/aiteam/pages/*.js`
  - P/B/S 页面具体交互
- `app/tests/aiteam/layer2_*`、`layer4_*`、`layer5_*`
  - 分层契约、页面壳、业务流回归

## 推进策略

- 只补真实缺口，不重写已被现有测试覆盖的模块
- 先恢复可重复验证能力，再做功能收口
- 每一波次都先跑最小失败验证，再做最小实现，再跑回归
- 并行上限控制为 `1 个主控 + 4 个实现轨`：
  - 轨 1：P01 Auth / 登录入户
  - 轨 2：前台 P02-P09
  - 轨 3：企业后台 B01-B09
  - 轨 4：系统后台 S01-S04 / 交付验证

### Task 1: 恢复本地验收基线

**Files:**
- Modify: `app/requirements-dev.txt`
- Modify: `app/README.md`
- Modify: `app/.env.example`
- Modify: `app/tests/aiteam/layer1_data/fixtures.py`
- Test: `app/tests/aiteam/conftest.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py`

- [ ] **Step 1: 先写一个最小环境 smoke 断言，冻结测试依赖前提**

```python
def test_dev_requirements_include_psycopg2_dependency():
    from pathlib import Path

    content = Path("app/requirements-dev.txt").read_text(encoding="utf-8")
    assert "psycopg2-binary" in content
```

- [ ] **Step 2: 运行最小 smoke 断言，确认当前计划的真实阻塞点是环境而不是代码**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'psycopg2'`

- [ ] **Step 3: 最小化补齐本地后端验证说明，不改产品逻辑**

```text
在 `app/README.md` 与 `app/.env.example` 中明确：
1. `pip install -r app/requirements-dev.txt`
2. `TEST_DATABASE_URL=postgresql://aiteam:change-me@127.0.0.1:5433/aiteam_test`
3. 使用 `app/tests/aiteam/layer1_data/fixtures.py` 的 ephemeral postgres
4. `docker` 与 `psycopg2-binary` 为 AI Team pytest 前置条件
```

- [ ] **Step 4: 环境就绪后重跑 Auth 基线**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/requirements-dev.txt app/README.md app/.env.example app/tests/aiteam/layer1_data/fixtures.py
git commit -m "chore(aiteam): restore backend verification prerequisites"
```

### Task 2: 收口 P01 登录与企业入户体验

**Files:**
- Create: `app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py`
- Modify: `app/static/login.js`
- Modify: `app/static/index.html`
- Modify: `app/team_panel/api_team/router_auth.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py`

- [ ] **Step 1: 先写 P01 页面契约失败测试，冻结“微信扫码 + 手机号验证码”目标，而不是继续沿用 passkey/password 页面**

```python
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_login_page_mentions_wechat_and_phone_auth():
    source = (ROOT / "static" / "login.js").read_text(encoding="utf-8")
    assert "/api/auth/login/wechat/init" in source
    assert "/api/auth/login/phone/send-code" in source
    assert "/api/auth/login/phone/verify" in source
```

- [ ] **Step 2: 运行 P01 页面契约测试，确认当前前端仍旧绑定旧登录模型**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py -q`
Expected: FAIL because `app/static/login.js` currently still uses `api/auth/login` and passkey-first flow

- [ ] **Step 3: 用最小实现把 P01 前端切到现有 Auth 北向契约，不重写后端**

```javascript
// login.js 目标交互
// 1. 默认调用 POST /api/auth/login/wechat/init 获取二维码 state
// 2. 轮询 GET /api/auth/login/wechat/poll?state=...
// 3. 手机 Tab 走 POST /api/auth/login/phone/send-code 与 /verify
// 4. 成功后统一跳转到 /app/workbench 或 onboarding 指定入口
```

- [ ] **Step 4: 跑 Auth 后端契约与 P01 页面契约回归**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/static/login.js app/static/index.html app/team_panel/api_team/router_auth.py app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py
git commit -m "feat(aiteam): align p01 login experience with auth contract"
```

### Task 3: 收口企业前台 P02-P09

**Files:**
- Modify: `app/static/aiteam/page-shell.js`
- Modify: `app/static/aiteam/pages/app-workbench.js`
- Modify: `app/static/aiteam/pages/app-marketplace.js`
- Modify: `app/static/aiteam/pages/app-template-detail.js`
- Modify: `app/static/aiteam/pages/app-chat.js`
- Modify: `app/static/aiteam/pages/app-group.js`
- Modify: `app/static/aiteam/pages/app-org.js`
- Modify: `app/static/aiteam/pages/knowledge.js`
- Modify: `app/static/aiteam/pages/office.js`
- Modify: `app/team_panel/application/queries/workbench_view_service.py`
- Modify: `app/team_panel/application/queries/conversation_view_service.py`
- Modify: `app/team_panel/application/queries/office_view_service.py`
- Modify: `app/team_panel/api_team/router_team.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_aiteam_app_pages.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_chat_page_rendering.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_group_page_reconnect_recovery.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_org_page.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_office_page.py`
- Test: `app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py`
- Test: `app/tests/aiteam/layer5_flows/test_private_chat_flow.py`
- Test: `app/tests/aiteam/layer5_flows/test_group_conversation_flow.py`

- [ ] **Step 1: 先跑已存在的前台页面和主链路测试，建立 P02-P09 的真实缺口列表**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_aiteam_app_pages.py app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py app/tests/aiteam/layer5_flows/test_private_chat_flow.py app/tests/aiteam/layer5_flows/test_group_conversation_flow.py -q`
Expected: PASS on covered slices; any FAIL becomes唯一允许进入本波次的缺口清单

- [ ] **Step 2: 若页面交互与 PRD 原型不一致，先补前端断言，再补页面最小实现**

```python
def test_group_page_exposes_member_settings_and_recovery_status():
    source = _read(PAGES_DIR / "app-group.js")
    for snippet in ["成员管理", "群设置", "SSE 恢复状态", "data-group-recovery"]:
        assert snippet in source
```

- [ ] **Step 3: 若聚合视图缺字段，优先在 query service / serializer 补齐，不在页面端伪造状态**

```python
return {
    "conversation_id": conv.id,
    "latest_run": latest_run,
    "latest_route_decision": latest_route_decision,
    "task_tree": task_tree,
    "display_state": display_state,
}
```

- [ ] **Step 4: 跑前台 Node 页面测试 + pytest 页面壳/流程回归**

Run: `node app/static/aiteam/pages/app-marketplace.test.js && node app/static/aiteam/pages/app-template-detail.test.js && pytest app/tests/aiteam/layer4_frontend_bff/test_aiteam_app_pages.py app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py app/tests/aiteam/layer5_flows/test_private_chat_flow.py app/tests/aiteam/layer5_flows/test_group_conversation_flow.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/static/aiteam/page-shell.js app/static/aiteam/pages/app-workbench.js app/static/aiteam/pages/app-marketplace.js app/static/aiteam/pages/app-template-detail.js app/static/aiteam/pages/app-chat.js app/static/aiteam/pages/app-group.js app/static/aiteam/pages/app-org.js app/static/aiteam/pages/knowledge.js app/static/aiteam/pages/office.js app/team_panel/application/queries/workbench_view_service.py app/team_panel/application/queries/conversation_view_service.py app/team_panel/application/queries/office_view_service.py app/team_panel/api_team/router_team.py app/tests/aiteam/layer4_frontend_bff/test_aiteam_app_pages.py app/tests/aiteam/layer4_frontend_bff/test_chat_page_rendering.py app/tests/aiteam/layer4_frontend_bff/test_group_page_reconnect_recovery.py app/tests/aiteam/layer4_frontend_bff/test_org_page.py app/tests/aiteam/layer4_frontend_bff/test_office_page.py app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py app/tests/aiteam/layer5_flows/test_private_chat_flow.py app/tests/aiteam/layer5_flows/test_group_conversation_flow.py
git commit -m "feat(aiteam): close app-side product gaps"
```

### Task 4: 收口企业后台 B01-B09

**Files:**
- Modify: `app/static/aiteam/pages/admin-employees.js`
- Modify: `app/static/aiteam/pages/admin-skills.js`
- Modify: `app/static/aiteam/pages/admin-solutions.js`
- Modify: `app/static/aiteam/pages/admin-memories.js`
- Modify: `app/static/aiteam/pages/admin-connectors.js`
- Modify: `app/static/aiteam/pages/admin-billing.js`
- Modify: `app/static/aiteam/pages/admin-recharge.js`
- Modify: `app/static/aiteam/pages/admin-settings.js`
- Modify: `app/team_panel/application/queries/employee_admin_view_service.py`
- Modify: `app/team_panel/application/queries/billing_view_service.py`
- Modify: `app/team_panel/api_team/router_team.py`
- Test: `app/static/aiteam/pages/admin-connectors.test.js`
- Test: `app/static/aiteam/pages/admin-employees.test.js`
- Test: `app/static/aiteam/pages/admin-skills.test.js`
- Test: `app/static/aiteam/pages/admin-solutions.test.js`
- Test: `app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_memory_api_contracts.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py`
- Test: `app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py`

- [ ] **Step 1: 先冻结当前已知失败面，补 Node 断言而不是先改页面**

```javascript
assert(
  host.innerHTML.indexOf('cred://vault/slack/ent_test') !== -1,
  'page should render opaque credential ref'
);
```

- [ ] **Step 2: 跑企业后台页面测试，确认 B 端当前真实缺口**

Run: `node app/static/aiteam/pages/admin-connectors.test.js && node app/static/aiteam/pages/admin-employees.test.js && node app/static/aiteam/pages/admin-skills.test.js && node app/static/aiteam/pages/admin-solutions.test.js`
Expected: only real product gaps fail; current已知失败为 `admin-connectors.test.js`

- [ ] **Step 3: 优先修补 B05 连接器页面与 detail/edit/test/grants 契约的一致性**

```javascript
return {
  connector_id: item.connector_id,
  credential_ref: stringValue(item.credential_ref, ''),
  credential_mask: credentialMask,
  credential_state: credentialState,
  last_test_result: lastTestResult,
};
```

- [ ] **Step 4: 跑后台 API 契约、页面测试和 solution governance 流回归**

Run: `node app/static/aiteam/pages/admin-connectors.test.js && pytest app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py app/tests/aiteam/layer2_team_panel/test_memory_api_contracts.py app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/static/aiteam/pages/admin-employees.js app/static/aiteam/pages/admin-skills.js app/static/aiteam/pages/admin-solutions.js app/static/aiteam/pages/admin-memories.js app/static/aiteam/pages/admin-connectors.js app/static/aiteam/pages/admin-billing.js app/static/aiteam/pages/admin-recharge.js app/static/aiteam/pages/admin-settings.js app/team_panel/application/queries/employee_admin_view_service.py app/team_panel/application/queries/billing_view_service.py app/team_panel/api_team/router_team.py app/static/aiteam/pages/admin-connectors.test.js app/static/aiteam/pages/admin-employees.test.js app/static/aiteam/pages/admin-skills.test.js app/static/aiteam/pages/admin-solutions.test.js app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py app/tests/aiteam/layer2_team_panel/test_memory_api_contracts.py app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py
git commit -m "feat(aiteam): close enterprise admin governance gaps"
```

### Task 5: 收口系统后台 S01-S04

**Files:**
- Modify: `app/static/aiteam/pages/system-accounts.js`
- Modify: `app/static/aiteam/pages/system-templates.js`
- Modify: `app/static/aiteam/pages/system-solutions.js`
- Modify: `app/static/aiteam/pages/system-finance.js`
- Modify: `app/static/aiteam/pages/system-health.js`
- Modify: `app/team_panel/application/queries/system_admin_view_service.py`
- Modify: `app/team_panel/application/commands/system_admin_content_service.py`
- Modify: `app/team_panel/api_team/router_system_admin.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py`

- [ ] **Step 1: 先跑系统后台现有契约与页面测试**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py -q`
Expected: PASS on已覆盖能力；若 FAIL，仅围绕 system northbound / 页面契约修补

- [ ] **Step 2: 若页面只剩 stub copy，先补页面契约断言，再接真实 northbound 数据**

```python
def test_system_accounts_init_executes_with_loaded_dependencies():
    result = _run_page_module(
        "system-accounts.js",
        "systemAccounts",
        [{"url": "/api/system-admin/enterprises", "method": "GET"}],
    )
    assert "企业账号 API 尚未实现" not in result["html"]
```

- [ ] **Step 3: 最小实现只补 northbound 数据与页面渲染，不扩展新系统角色或新命名空间**

```python
return {
    "items": enterprises,
    "total": len(enterprises),
    "page": 1,
    "has_more": False,
}
```

- [ ] **Step 4: 跑系统后台回归**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/static/aiteam/pages/system-accounts.js app/static/aiteam/pages/system-templates.js app/static/aiteam/pages/system-solutions.js app/static/aiteam/pages/system-finance.js app/static/aiteam/pages/system-health.js app/team_panel/application/queries/system_admin_view_service.py app/team_panel/application/commands/system_admin_content_service.py app/team_panel/api_team/router_system_admin.py app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py
git commit -m "feat(aiteam): close system admin delivery gaps"
```

### Task 6: 交付验证与验收文档

**Files:**
- Create: `docs/implementation_audits/2026-06-09-aiteam-delivery-verification.md`
- Modify: `app/README.md`
- Test: `app/tests/aiteam/**/*`

- [ ] **Step 1: 汇总最终验证命令，按“Node 页面 -> Layer2/4/5 pytest -> 手工前台走查”顺序执行**

```bash
node app/static/aiteam/pages/app-marketplace.test.js
node app/static/aiteam/pages/app-template-detail.test.js
node app/static/aiteam/pages/admin-employees.test.js
node app/static/aiteam/pages/admin-connectors.test.js
pytest app/tests/aiteam/layer2_team_panel -q
pytest app/tests/aiteam/layer4_frontend_bff -q
pytest app/tests/aiteam/layer5_flows -q
```

- [ ] **Step 2: 写交付验证文档，固定输出格式**

```text
章节顺序固定为：
1. 总体状态
2. 已验证范围
3. 失败项 / 风险项
4. 证据命令
5. 页面走查结论
6. 发布前阻塞项
```

- [ ] **Step 3: 若任一关键链路未验证通过，不宣称完成，只记录阻塞**

```text
禁止写：
- “理论上没问题”
- “应该已完成”

允许写：
- “pytest 被 psycopg2 阻塞，当前环境未完成后端验证”
- “B05 页面测试失败，发布阻塞”
```

- [ ] **Step 4: 运行最终 `git status` 与交付检查**

Run: `git status --short`
Expected: only expected source/test/docs changes remain

- [ ] **Step 5: Commit**

```bash
git add docs/implementation_audits/2026-06-09-aiteam-delivery-verification.md app/README.md
git commit -m "docs(aiteam): record delivery verification evidence"
```

## Self-Review

- Spec coverage:
  - P01 登录入户：Task 2
  - P02-P09 企业前台：Task 3
  - B01-B09 企业后台：Task 4
  - S01-S04 系统后台：Task 5
  - 整体验收与交付：Task 1 + Task 6
- Placeholder scan:
  - 未使用 `TODO/TBD/implement later`
  - 所有任务均给出明确文件、命令、测试入口
- Type consistency:
  - 前台统一走 `app/static/aiteam/pages/*`
  - Team northbound 统一走 `app/team_panel/api_team/router_team.py`
  - System northbound 统一走 `app/team_panel/api_team/router_system_admin.py`
  - 验证统一围绕 `app/tests/aiteam/layer2_* / layer4_* / layer5_*`

## 执行建议

- 先执行 `Task 1`，否则后续所有 pytest 计划都只是纸面动作
- `Task 2` 与 `Task 3` 可以并行，但 `Task 2` 完成后再做前台整体验收
- `Task 4` 与 `Task 5` 可以并行，但共享页面壳与 Team Panel 路由合并要由主控统一收口
- 完成 `Task 6` 前，不要对外宣称“全功能交付完成”
