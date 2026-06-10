# B06 B08 Governance Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 B08 管理邀请正式命名空间和 B06 行业方案 Apply 真实模式语义，使当前验收规格中的真实缺口闭环。

**Architecture:** B08 复用现有 invite 存储与审计逻辑，只补 enterprise-admin 正式路由与前端主调用。B06 维持单事务 apply，但把 `replace/reapply` 从兼容别名提升为真实策略，并通过历史 `solution_apply_record` 精确定位受影响员工。

**Tech Stack:** Python, Team Panel routers/repositories, vanilla JS admin pages, pytest

---

### Task 1: B08 enterprise-admin invites contract

**Files:**
- Modify: `app/team_panel/api_team/router_team_settings_billing.py`
- Modify: `app/team_panel/api_team/router_enterprise_admin.py`
- Modify: `app/tests/aiteam/layer0_contracts/test_host_routing.py`
- Modify: `app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py`

- [ ] **Step 1: Write the failing tests**

Add coverage for:
- `GET /api/enterprise-admin/invites`
- `POST /api/enterprise-admin/invites`
- `DELETE /api/enterprise-admin/invites/{invite_id}`
- team alias still works

- [ ] **Step 2: Run targeted tests to verify they fail**

Run: `pytest app/tests/aiteam/layer0_contracts/test_host_routing.py app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py -k "invite or enterprise_admin"`  
Expected: FAIL because enterprise-admin invite routes are still `501 not_implemented`

- [ ] **Step 3: Implement the minimal route and handler changes**

Expose independent invite list handler, mount enterprise-admin GET/POST/DELETE routes, preserve team alias behavior.

- [ ] **Step 4: Run targeted tests to verify they pass**

Run: `pytest app/tests/aiteam/layer0_contracts/test_host_routing.py app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py -k "invite or enterprise_admin"`

### Task 2: B08 frontend canonical invite path

**Files:**
- Modify: `app/static/aiteam/pages/admin-settings.js`
- Modify: `app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py`
- Modify: `app/tests/aiteam/layer4_frontend_bff/test_admin_settings_rendering.py`

- [ ] **Step 1: Write the failing frontend assertions**

Change the expected canonical invite path from `/api/team/settings/admin-invites` to `/api/enterprise-admin/invites`.

- [ ] **Step 2: Run targeted frontend tests to verify they fail**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py app/tests/aiteam/layer4_frontend_bff/test_admin_settings_rendering.py`

- [ ] **Step 3: Update the page to use the canonical path**

Switch POST/DELETE calls and user-facing copy to the enterprise-admin namespace.

- [ ] **Step 4: Run targeted frontend tests to verify they pass**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py app/tests/aiteam/layer4_frontend_bff/test_admin_settings_rendering.py`

### Task 3: B06 replace/reapply true semantics

**Files:**
- Modify: `app/team_panel/api_team/router_team.py`
- Modify: `app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py`

- [ ] **Step 1: Write the failing flow tests**

Add coverage that:
- `replace` archives previously created solution employees and creates a fresh batch
- `reapply` keeps previous employees and creates a new batch

- [ ] **Step 2: Run targeted flow tests to verify they fail**

Run: `pytest app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py -k "replace or reapply"`

- [ ] **Step 3: Implement minimal transactional semantics**

Use historical `solution_apply_record` rows to gather prior employee ids for the same enterprise+solution.  
For `replace`, archive previous employees and delete their knowledge bindings in the same transaction before creating the new batch.  
For `reapply`, preserve previous employees and add another batch.

- [ ] **Step 4: Run targeted flow tests to verify they pass**

Run: `pytest app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py -k "replace or reapply"`

### Task 4: Final focused verification

**Files:**
- Modify: none

- [ ] **Step 1: Run the combined verification commands**

Run:
- `pytest app/tests/aiteam/layer0_contracts/test_host_routing.py app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py -k "invite or enterprise_admin"`
- `pytest app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py app/tests/aiteam/layer4_frontend_bff/test_admin_settings_rendering.py app/tests/aiteam/layer4_frontend_bff/test_admin_solutions_rendering.py`
- `pytest app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py`

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-10-b06-b08-governance-closeout-design.md docs/superpowers/plans/2026-06-10-b06-b08-governance-closeout.md app/team_panel/api_team/router_team_settings_billing.py app/team_panel/api_team/router_enterprise_admin.py app/team_panel/api_team/router_team.py app/static/aiteam/pages/admin-settings.js app/tests/aiteam/layer0_contracts/test_host_routing.py app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py app/tests/aiteam/layer4_frontend_bff/test_admin_pages.py app/tests/aiteam/layer4_frontend_bff/test_admin_settings_rendering.py app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py
git commit -m "feat: close b06 b08 governance gaps"
```
