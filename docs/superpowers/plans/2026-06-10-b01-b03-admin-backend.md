# B01-B03 Admin Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 B01/B02/B03 企业后台真实缺口，使员工配置、技能市场、后台模板消费页达到验收可验证状态。

**Architecture:** 复用既有 Team Panel northbound contracts；B03 继续是企业模板消费 alias，B01 通过现有 employee PATCH 闭合配置写入，B02 通过 audit_event 摘要补全安装治理可见性。

**Tech Stack:** Python Team Panel router/repository, vanilla JS admin pages, pytest, node page tests

---

### Task 1: 锁定 B03 企业模板暴露范围

**Files:**
- Modify: `app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py`
- Modify: `app/tests/aiteam/layer4_frontend_bff/test_admin_templates_rendering.py`
- Modify: `app/team_panel/api_team/router_team.py`

- [ ] **Step 1: 写失败测试，要求企业后台模板列表只展示已发布模板**

```python
def test_admin_templates_alias_hides_unpublished_templates(self, seeded_enterprise, db_conn):
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO agent_template (id, name, category_code, role_name, status, prompt_pack_json, default_model_json, default_binding_json, version_no, source_type) "
            "VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s)",
            ("tpl_draft_only", "草稿模板", "ops", "operator", "draft", "{}", "{}", "{}", 1, "system"),
        )
        db_conn.commit()
    finally:
        cur.close()
    status, body = _get("/api/team/templates")
    assert status == 200
    assert all(item["template_id"] != "tpl_draft_only" for item in body["items"])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py -q -k 'admin_templates_alias_hides_unpublished_templates'`
Expected: FAIL because current handler uses `list_all()`

- [ ] **Step 3: 最小实现 published-only 过滤**

```python
templates = repo.list_by_status("published")
templates = [template for template in templates if template.deleted_at is None]
```

- [ ] **Step 4: 重跑相关模板合同测试**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py -q -k 'template and recruit'`
Expected: PASS

### Task 2: 补齐 B02 技能安装审计状态

**Files:**
- Modify: `app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py`
- Modify: `app/tests/aiteam/layer4_frontend_bff/test_admin_skills_rendering.py`
- Modify: `app/team_panel/api_team/router_team.py`
- Modify: `app/static/aiteam/pages/admin-skills.js`

- [ ] **Step 1: 写失败测试，要求 installs 返回审计状态**

```python
def test_get_installs_exposes_audit_status(self, seeded_enterprise):
    _post("/api/team/skills/installs", {
        "skill_code": "slides",
        "display_name": "Slides",
        "scope_mode": "all_employees",
    })
    status, body = _get("/api/team/skills/installs")
    assert status == 200
    assert body["items"][0]["audit_status"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py -q -k 'audit_status'`
Expected: FAIL because payload has no `audit_status`

- [ ] **Step 3: 后端返回最近审计状态摘要**

```python
audits = AuditEventRepo(cur).list_by_target("enterprise_skill_install", inst.id, limit=1)
latest = audits[0] if audits else None
"audit_status": latest.event_type if latest else "",
"audit_recorded_at": latest.created_at if latest else None,
```

- [ ] **Step 4: 去掉前端降级文案并展示真实审计状态**

```javascript
var auditLine = item.audit_status
  ? '<div class="aiteam-skill-card__meta">审计状态：' + esc(item.audit_status) + '</div>'
  : '<div class="aiteam-skill-card__meta">审计状态：暂缺</div>';
```

- [ ] **Step 5: 重跑技能市场测试**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py app/tests/aiteam/layer4_frontend_bff/test_admin_skills_rendering.py -q`
Expected: PASS

### Task 3: 把 B01 抽屉从只读补到可保存

**Files:**
- Modify: `app/static/aiteam/pages/admin-employee-drawer.test.js`
- Modify: `app/static/aiteam/pages/admin-employee-drawer.js`

- [ ] **Step 1: 写失败测试，要求模型/Prompt/知识库/记忆/连接器/Loop tab 出现保存控件并调用 `updateEmployee`**

```javascript
updateEmployeeCalls.push({ employeeId, body });
assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('保存模型配置') !== -1);
assert(document.getElementById('aiteam-drawer-body').innerHTML.indexOf('保存提示词') !== -1);
```

- [ ] **Step 2: 跑 node 测试确认失败**

Run: `node app/static/aiteam/pages/admin-employee-drawer.test.js`
Expected: FAIL because tabs are display-only

- [ ] **Step 3: 在 drawer 中补最小表单与保存入口**

```javascript
ns.api.updateEmployee(_lastEmployeeId, {
  model_provider: provider,
  model_name: modelName,
});
```

- [ ] **Step 4: 每个 tab 保存成功后刷新本地聚合状态**

```javascript
_employeeData = normalizeEmployeePayload(Object.assign({}, _employeeDataRaw, patchResult));
_renderTabContent();
```

- [ ] **Step 5: 重跑 node 测试**

Run: `node app/static/aiteam/pages/admin-employee-drawer.test.js`
Expected: PASS

### Task 4: 运行目标范围验证

**Files:**
- No code changes

- [ ] **Step 1: 跑 layer2 验证**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py -q -k 'employee or skills or template or recruit'`
Expected: PASS

- [ ] **Step 2: 跑 layer4 / page 验证**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_admin_skills_rendering.py app/tests/aiteam/layer4_frontend_bff/test_admin_templates_rendering.py -q`
Expected: PASS

- [ ] **Step 3: 跑 drawer node 验证**

Run: `node app/static/aiteam/pages/admin-employee-drawer.test.js`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-06-10-b01-b03-admin-backend-design.md \
        docs/superpowers/plans/2026-06-10-b01-b03-admin-backend.md \
        app/team_panel/api_team/router_team.py \
        app/static/aiteam/pages/admin-skills.js \
        app/static/aiteam/pages/admin-employee-drawer.js \
        app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py \
        app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py \
        app/tests/aiteam/layer4_frontend_bff/test_admin_skills_rendering.py \
        app/tests/aiteam/layer4_frontend_bff/test_admin_templates_rendering.py \
        app/static/aiteam/pages/admin-employee-drawer.test.js
git commit -m "feat: close b01-b03 admin backend gaps"
```
