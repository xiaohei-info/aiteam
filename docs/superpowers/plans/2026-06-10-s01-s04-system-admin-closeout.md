# S01-S04 System Admin Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out S01 account management, S02 template governance, S03 solution governance, and S04 platform finance on the shared system-admin surface so the current codebase satisfies the approved S01-S04 closeout spec and the linked acceptance pack.

**Architecture:** Keep a single implementation branch and one shared `router_system_admin.py` surface, but execute the work as four sequential checkpoints: S01 contract/read-model hardening, S02 template governance and marketplace visibility, S03 solution governance and B06 apply consistency, and S04 platform-finance aggregation. Each checkpoint must start with a failing test, land the smallest production change needed, and finish with targeted layer2/layer4 verification plus the required cross-domain flow test.

**Tech Stack:** Python, pytest, Team Panel repositories/UoW services, vanilla JS page modules under `app/static/aiteam/pages`, Node-based frontend rendering harnesses

---

## File Structure

- `app/team_panel/api_team/router_system_admin.py`
  Owns the northbound system-admin read/write routes for S01-S04.
- `app/team_panel/repositories/enterprise_repo.py`
  Owns S01 enterprise list filtering and pagination behavior.
- `app/team_panel/application/commands/system_admin_content_service.py`
  Owns S02/S03 create/update/publish governance writes.
- `app/team_panel/application/queries/system_admin_view_service.py`
  Owns S02/S03 read projections and S04 platform-finance aggregation.
- `app/team_panel/api_team/router_team.py`
  Owns team-facing template/solution consumption surfaces that S02/S03 must influence.
- `app/static/aiteam/pages/system-accounts.js`
  Owns the S01 system-admin account-management page behavior.
- `app/static/aiteam/pages/system-templates.js`
  Owns the S02 system-admin template-governance page behavior.
- `app/static/aiteam/pages/system-solutions.js`
  Owns the S03 system-admin solution-governance page behavior.
- `app/static/aiteam/pages/system-finance.js`
  Owns the S04 system-admin finance page behavior.
- `app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py`
  S01 contract regression suite.
- `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
  S02/S03/S04 contract regression suite.
- `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
  System-admin RBAC regression suite.
- `app/tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py`
  S01 frontend rendering and affordance verification.
- `app/tests/aiteam/layer4_frontend_bff/test_governance_ux.py`
  S01 canonical action-posting and readonly UX verification.
- `app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py`
  S02/S03 frontend rendering and preview verification.
- `app/tests/aiteam/layer4_frontend_bff/test_system_finance_rendering.py`
  S04 frontend rendering and export-path verification.
- `app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py`
  P03/P04 recruitment flow regression that S02 governance must influence.
- `app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py`
  B06 apply flow regression that S03 governance must influence.

### Task 1: S01 Backend Filter And Canonical Actions Closeout

**Files:**
- Modify: `app/team_panel/repositories/enterprise_repo.py`
- Modify: `app/team_panel/api_team/router_system_admin.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`

- [ ] **Step 1: Write the failing S01 backend acceptance tests**

```python
def test_filter_by_created_range_returns_matching_enterprise(seeded_enterprise):
    _, body = _get(
        _system_admin_path(
            "/api/system-admin/enterprises?created_from=2026-01-01&created_to=2099-12-31"
        )
    )
    ids = [item["id"] for item in body["enterprises"]]
    assert seeded_enterprise["enterprise_id"] in ids


def test_filter_by_created_range_excludes_out_of_window(seeded_enterprise):
    _, body = _get(
        _system_admin_path(
            "/api/system-admin/enterprises?created_from=2099-01-01&created_to=2099-12-31"
        )
    )
    assert body["total"] == 0
```

- [ ] **Step 2: Run the S01 backend tests to verify they fail**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py -k "created_range or TestSystemAdminListEnterprises or TestSystemAdminSearchEnterprises" -v`

Expected: FAIL because `router_system_admin._handle_list_enterprises()` and `EnterpriseRepo.list_with_filter()` only accept `name` and `status`, so the new created-range assertions do not hold yet.

- [ ] **Step 3: Implement the minimal S01 backend filter change**

```python
# app/team_panel/repositories/enterprise_repo.py
def list_with_filter(
    self,
    name: Optional[str] = None,
    status: Optional[str] = None,
    created_from: Optional[str] = None,
    created_to: Optional[str] = None,
    page: int = 1,
    limit: int = 20,
) -> tuple[list[Enterprise], int]:
    conditions = ["deleted_at IS NULL"]
    params: list = []
    if name:
        like = f"%{name}%"
        conditions.append("(name ILIKE %s OR slug ILIKE %s)")
        params.extend([like, like])
    if status:
        conditions.append("status = %s")
        params.append(status)
    if created_from:
        conditions.append("created_at::date >= %s::date")
        params.append(created_from)
    if created_to:
        conditions.append("created_at::date <= %s::date")
        params.append(created_to)
```

```python
# app/team_panel/api_team/router_system_admin.py
def _handle_list_enterprises(path: str) -> tuple[int, dict]:
    query = _parse_query(path)
    created_from = query.get("created_from", "").strip() or None
    created_to = query.get("created_to", "").strip() or None
    items, total = repo.list_with_filter(
        name=name,
        status=status,
        created_from=created_from,
        created_to=created_to,
        page=page,
        limit=limit,
    )
```

- [ ] **Step 4: Run the S01 backend tests and RBAC regression**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py tests/aiteam/layer2_team_panel/test_system_admin_rbac.py -k "system_admin or created_range" -v`

Expected: PASS with the new created-range cases green and the existing `/actions`/RBAC contract still green.

- [ ] **Step 5: Commit the S01 backend checkpoint**

```bash
cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam
git add app/team_panel/repositories/enterprise_repo.py \
        app/team_panel/api_team/router_system_admin.py \
        app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py
git commit -m "feat: add system admin enterprise date filters"
```

### Task 2: S01 Frontend Filter And Readonly UX Closeout

**Files:**
- Modify: `app/static/aiteam/pages/system-accounts.js`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_governance_ux.py`

- [ ] **Step 1: Write the failing S01 frontend behavior tests**

```python
def test_system_accounts_filters_by_created_range_in_browser_state() -> None:
    payload = _run_system_accounts()
    assert "YYYY-MM-DD ~ YYYY-MM-DD" in payload["html"]
    assert "data-role=\"enterprise-created-range\"" in payload["html"]


def test_system_accounts_system_operator_keeps_readonly_actions() -> None:
    result = _run_page_with_role(
        "system-accounts.js",
        "systemAccounts",
        role="system_operator",
        fetch_status=200,
        fetch_body=json.dumps({"enterprises": [{"enterprise_id": "ent_acme", "name": "Acme", "status": "active"}]}),
    )
    assert "只读" in result["html"]
```

- [ ] **Step 2: Run the S01 frontend tests to verify the acceptance delta**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py tests/aiteam/layer4_frontend_bff/test_governance_ux.py -k "system_accounts" -v`

Expected: At least one FAIL around the created-range affordance not participating in `filterEnterprises()` and/or the readonly state not being preserved through re-render after the new filter input is wired.

- [ ] **Step 3: Implement the minimal S01 frontend filter and readonly fix**

```javascript
// app/static/aiteam/pages/system-accounts.js
function _withinCreatedRange(item, rawRange) {
  var range = trimText(rawRange);
  if (!range) return true;
  var parts = range.split("~");
  if (parts.length !== 2) return true;
  var start = trimText(parts[0]);
  var end = trimText(parts[1]);
  var created = String(item.created_at || "").slice(0, 10);
  if (start && created < start) return false;
  if (end && created > end) return false;
  return true;
}

function filterEnterprises(items, state) {
  return (items || []).filter(function (item) {
    if (!_withinCreatedRange(item, state.createdRange)) return false;
    if (state.statusFilter && String(item.status || '').toLowerCase() !== state.statusFilter) return false;
    if (!state.query) return true;
    var haystack = [
      item.name,
      item.owner_name,
      item.owner_phone,
      item.enterprise_id,
    ].join(' ').toLowerCase();
    return haystack.indexOf(trimText(state.query).toLowerCase()) !== -1;
  });
}
```

```javascript
// inside render()
var createdRangeInput = container.querySelector('[data-role="enterprise-created-range"]');
if (createdRangeInput && createdRangeInput.addEventListener) {
  createdRangeInput.addEventListener('input', function () {
    state.createdRange = this.value || '';
    render();
  });
}
```

- [ ] **Step 4: Run the S01 frontend tests again**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py tests/aiteam/layer4_frontend_bff/test_governance_ux.py -k "system_accounts" -v`

Expected: PASS with readonly/system-write behavior preserved and the created-range affordance wired into the page state.

- [ ] **Step 5: Commit the S01 frontend checkpoint**

```bash
cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam
git add app/static/aiteam/pages/system-accounts.js \
        app/tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py \
        app/tests/aiteam/layer4_frontend_bff/test_governance_ux.py
git commit -m "feat: close out system admin account page filters"
```

### Task 3: S02 Template Governance And Marketplace Visibility

**Files:**
- Modify: `app/team_panel/application/queries/system_admin_view_service.py`
- Modify: `app/team_panel/application/commands/system_admin_content_service.py`
- Modify: `app/team_panel/api_team/router_team.py:1376-1447`
- Modify: `app/static/aiteam/pages/system-templates.js`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py`
- Test: `app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py`

- [ ] **Step 1: Write the failing S02 contract and consumption tests**

```python
def test_unpublished_template_is_hidden_from_team_marketplace(seeded_enterprise):
    template_id = seeded_enterprise["template_id"]
    patch_status, _ = _patch(
        f"/api/system-admin/templates/{template_id}?role=system_admin",
        {"publish_action": "unpublish"},
    )
    assert patch_status == 200
    status, body = _get("/api/team/templates")
    assert status == 200
    assert all(item["template_id"] != template_id for item in body["items"])


def test_system_template_projection_exposes_preview_fields(seeded_enterprise):
    status, body = _get(_system_admin_path("/api/system-admin/templates"))
    seeded = next(item for item in body["items"] if item["template_id"] == seeded_enterprise["template_id"])
    assert seeded["description"]
    assert seeded["default_model"] or seeded["default_model_ref"]
```

- [ ] **Step 2: Run the S02 contract and flow tests to verify failure**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py tests/aiteam/layer2_team_panel/test_team_api_contracts.py tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py -k "template or marketplace" -v`

Expected: FAIL because `router_team._handle_talent_templates()` currently uses `AgentTemplateRepo.list_all()` without filtering `published` status, and the system-admin projection does not expose the preview-friendly flattened fields the page expects.

- [ ] **Step 3: Implement the minimal S02 governance and visibility fix**

```python
# app/team_panel/api_team/router_team.py
templates = [t for t in repo.list_all() if t.deleted_at is None and t.status == "published"]
```

```python
# app/team_panel/application/queries/system_admin_view_service.py
items.append(
    {
        "template_id": template.id,
        "name": template.name,
        "role_name": template.role_name,
        "status": template.status,
        "description": _parse_json(template.prompt_pack_json, {}).get("description") or template.name,
        "default_model": (_parse_json(template.default_model_json, {}) or {}).get("model"),
        "default_model_ref": _parse_json(template.default_model_json, {}),
        "tags": [template.category_code] if template.category_code else [],
        "publish_record": publish_record,
        "recruit_count": recruit_counts.get(template.id, 0),
        "version_no": template.version_no,
        "source_type": template.source_type,
        "prompt_pack": _parse_json(template.prompt_pack_json, {}),
        "default_binding": _parse_json(template.default_binding_json, {}),
        "created_at": template.created_at,
        "updated_at": template.updated_at,
    }
)
```

```javascript
// app/static/aiteam/pages/system-templates.js
var previewModel = item.default_model || ((item.default_model_ref || {}).model) || '—';
var previewDescription = item.description || ((item.prompt_pack || {}).description) || '暂无岗位描述';
```

- [ ] **Step 4: Run the S02 layer2/layer4/flow regressions**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py tests/aiteam/layer2_team_panel/test_team_api_contracts.py tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py -k "template or marketplace" -v`

Expected: PASS with unpublished templates absent from the team marketplace while the system-admin template page still shows preview, clone, publish, and recruit-count metadata.

- [ ] **Step 5: Commit the S02 checkpoint**

```bash
cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam
git add app/team_panel/application/queries/system_admin_view_service.py \
        app/team_panel/api_team/router_team.py \
        app/static/aiteam/pages/system-templates.js \
        app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py \
        app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py \
        app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py \
        app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py
git commit -m "feat: align system template governance with marketplace visibility"
```

### Task 4: S03 Solution Governance And B06 Apply Consistency

**Files:**
- Modify: `app/team_panel/application/queries/system_admin_view_service.py`
- Modify: `app/team_panel/application/commands/system_admin_content_service.py`
- Modify: `app/team_panel/api_team/router_team.py:3110-3194`
- Modify: `app/static/aiteam/pages/system-solutions.js`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py`
- Test: `app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py`

- [ ] **Step 1: Write the failing S03 contract and apply-consistency tests**

```python
def test_unpublished_solution_is_hidden_from_team_solution_list(seeded_enterprise):
    solution_id = seeded_enterprise["solution_id"]
    patch_status, _ = _patch(
        f"/api/system-admin/solutions/{solution_id}?role=system_admin",
        {"publish_action": "unpublish"},
    )
    assert patch_status == 200
    status, body = _get("/api/team/solutions")
    assert status == 200
    assert all(item["solution_id"] != solution_id for item in body["solutions"])


def test_system_solution_projection_flattens_apply_stats(seeded_enterprise):
    status, body = _get(_system_admin_path("/api/system-admin/solutions"))
    seeded = next(item for item in body["items"] if item["solution_id"] == seeded_enterprise["solution_id"])
    assert seeded["solution_stats"]["template_count"] == len(seeded["template_ids"])
    assert "publish_record" in seeded
```

- [ ] **Step 2: Run the S03 tests to prove the current mismatch**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py tests/aiteam/layer2_team_panel/test_team_api_contracts.py tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py -k "solution" -v`

Expected: FAIL because `router_team` currently returns all solutions regardless of publish state, so system-side unpublish does not yet gate enterprise-side consumption.

- [ ] **Step 3: Implement the minimal S03 governance/consumption fix**

```python
# app/team_panel/api_team/router_team.py
if row[2] != "published":
    continue
```

```python
# keep the system-admin view richer than the team-consumption view
items.append(
    {
        "solution_id": solution.id,
        "name": solution.name,
        "status": solution.status,
        "template_ids": template_ids,
        "solution_stats": {
            "apply_count": apply_count,
            "active_employee_count": active_employee_count,
            "template_count": len(template_ids),
        },
        "publish_record": _latest_publish_record(
            uow.audit_events().list_by_target("solution", solution.id, limit=20)
        ),
        "apply_count": apply_count,
        "template_count": len(template_ids),
        "default_kb_blueprint": _parse_json(solution.default_kb_blueprint_json, {}),
        "default_skill_bundle": _parse_json(solution.default_skill_bundle_json, {}),
        "default_collaboration_template_ref": solution.default_collaboration_template_ref,
        "created_at": solution.created_at,
        "updated_at": solution.updated_at,
    }
)
```

```javascript
// app/static/aiteam/pages/system-solutions.js
var applyCount = item.apply_count;
if (typeof applyCount === 'undefined' && item.solution_stats) {
  applyCount = item.solution_stats.apply_count;
}
```

- [ ] **Step 4: Run the S03 contract, page, and flow regressions**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py tests/aiteam/layer2_team_panel/test_team_api_contracts.py tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py -k "solution" -v`

Expected: PASS with unpublished solutions no longer visible to enterprise consumption and the B06 apply flow still creating employees, audits, and billing traces from the published solution only.

- [ ] **Step 5: Commit the S03 checkpoint**

```bash
cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam
git add app/team_panel/application/queries/system_admin_view_service.py \
        app/team_panel/api_team/router_team.py \
        app/static/aiteam/pages/system-solutions.js \
        app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py \
        app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py \
        app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py \
        app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py
git commit -m "feat: align system solution governance with apply flow"
```

### Task 5: S04 Platform Finance Revenue, Profit, And Export Closeout

**Files:**
- Modify: `app/team_panel/application/queries/system_admin_view_service.py`
- Modify: `app/team_panel/api_team/router_system_admin.py`
- Modify: `app/static/aiteam/pages/system-finance.js`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_system_finance_rendering.py`

- [ ] **Step 1: Write the failing S04 finance-aggregation tests**

```python
def test_finance_overview_derives_profit_from_revenue_minus_cost(db_conn, seeded_enterprise):
    status, overview = _get(
        _system_admin_path("/api/system-admin/finance/overview?period_start=2000-01-01&period_end=2099-12-31")
    )
    assert status == 200
    assert overview["total_revenue_cents"] > overview["total_cost_cents"]
    assert overview["total_profit_cents"] == (
        overview["total_revenue_cents"] - overview["total_cost_cents"]
    )


def test_finance_reports_return_summary_and_trend_payload(db_conn, seeded_enterprise):
    status, reports = _get(
        _system_admin_path("/api/system-admin/finance/reports?period_start=2000-01-01&period_end=2099-12-31")
    )
    assert status == 200
    assert "summary" in reports
    assert "trend" in reports
    assert "top_enterprises" in reports
```

- [ ] **Step 2: Run the S04 backend tests to verify failure**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py tests/aiteam/layer2_team_panel/test_system_admin_rbac.py -k "finance" -v`

Expected: FAIL because `system_admin_view_service.get_platform_finance_overview()` currently mirrors `cost_cents` into `revenue_cents` and hard-codes `total_profit_cents = 0`, while the report payload does not match the frontend’s `summary/trend/top_enterprises` shape.

- [ ] **Step 3: Implement the minimal S04 aggregation and payload fix**

```python
# app/team_panel/application/queries/system_admin_view_service.py
def _aggregate_recharge_revenue(cur, enterprise_id: str, period_start: str, period_end: str) -> int:
    cur.execute(
        """
        SELECT COALESCE(SUM(amount_cents), 0)
        FROM recharge_order
        WHERE enterprise_id = %s
          AND status = 'succeeded'
          AND deleted_at IS NULL
          AND created_at::date >= %s::date
          AND created_at::date < %s::date
        """,
        (enterprise_id, period_start, period_end),
    )
    return int(cur.fetchone()[0] or 0)
```

```python
# inside get_platform_finance_overview()
summary = {
    "total_revenue_cents": aggregate["total_revenue_cents"],
    "total_cost_cents": aggregate["total_cost_cents"],
    "total_profit_cents": aggregate["total_revenue_cents"] - aggregate["total_cost_cents"],
    "paying_enterprise_count": aggregate["paying_enterprise_count"],
}
return {
    "summary": summary,
    "trend": aggregate["trend_rows"],
    "top_enterprises": aggregate["top_enterprises"],
    **summary,
}
```

```javascript
// app/static/aiteam/pages/system-finance.js
var trendItems = normalizeTrend(payload);
var summary = payload.summary || payload.snapshot || payload;
var topEnterprises = payload.top_enterprises || payload.top_enterprise_costs || [];
```

- [ ] **Step 4: Run the S04 backend/frontend regression suite**

Run: `cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app && pytest tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py tests/aiteam/layer2_team_panel/test_system_admin_rbac.py tests/aiteam/layer4_frontend_bff/test_system_finance_rendering.py -k "finance" -v`

Expected: PASS with non-zero profit, frontend-compatible `summary/trend/top_enterprises` payloads, and existing RBAC denial behavior unchanged for enterprise roles.

- [ ] **Step 5: Commit the S04 checkpoint**

```bash
cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam
git add app/team_panel/application/queries/system_admin_view_service.py \
        app/team_panel/api_team/router_system_admin.py \
        app/static/aiteam/pages/system-finance.js \
        app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py \
        app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py \
        app/tests/aiteam/layer4_frontend_bff/test_system_finance_rendering.py
git commit -m "feat: close out system platform finance aggregation"
```

### Task 6: Full S01-S04 Regression, Acceptance Evidence, And Final Commit

**Files:**
- Modify: `app/team_panel/api_team/router_system_admin.py`
- Modify: `app/team_panel/repositories/enterprise_repo.py`
- Modify: `app/team_panel/application/commands/system_admin_content_service.py`
- Modify: `app/team_panel/application/queries/system_admin_view_service.py`
- Modify: `app/team_panel/api_team/router_team.py`
- Modify: `app/static/aiteam/pages/system-accounts.js`
- Modify: `app/static/aiteam/pages/system-templates.js`
- Modify: `app/static/aiteam/pages/system-solutions.js`
- Modify: `app/static/aiteam/pages/system-finance.js`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`
- Test: `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_governance_ux.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py`
- Test: `app/tests/aiteam/layer4_frontend_bff/test_system_finance_rendering.py`
- Test: `app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py`
- Test: `app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py`

- [ ] **Step 1: Run the full targeted regression pack**

```bash
cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam/app
pytest \
  tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py \
  tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py \
  tests/aiteam/layer2_team_panel/test_system_admin_rbac.py \
  tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py \
  tests/aiteam/layer4_frontend_bff/test_governance_ux.py \
  tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py \
  tests/aiteam/layer4_frontend_bff/test_system_finance_rendering.py \
  tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py \
  tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py -v
```

Expected: PASS for all S01-S04 targeted suites.

- [ ] **Step 2: Verify spec-to-code coverage before final commit**

```text
Check S01:
- list/filter/detail/quota/export green
- /actions canonical write path green

Check S02:
- create/update/publish/unpublish green
- marketplace hides unpublished templates

Check S03:
- create/update/bind/publish/unpublish green
- team apply only sees published solutions

Check S04:
- revenue/cost/profit/trend/top/export green
- enterprise roles still blocked from system-admin finance
```

- [ ] **Step 3: Stage the final implementation set**

```bash
cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam
git add app/team_panel/api_team/router_system_admin.py \
        app/team_panel/repositories/enterprise_repo.py \
        app/team_panel/application/commands/system_admin_content_service.py \
        app/team_panel/application/queries/system_admin_view_service.py \
        app/team_panel/api_team/router_team.py \
        app/static/aiteam/pages/system-accounts.js \
        app/static/aiteam/pages/system-templates.js \
        app/static/aiteam/pages/system-solutions.js \
        app/static/aiteam/pages/system-finance.js \
        app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py \
        app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py \
        app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py \
        app/tests/aiteam/layer4_frontend_bff/test_system_accounts_rendering.py \
        app/tests/aiteam/layer4_frontend_bff/test_governance_ux.py \
        app/tests/aiteam/layer4_frontend_bff/test_system_content_rendering.py \
        app/tests/aiteam/layer4_frontend_bff/test_system_finance_rendering.py \
        app/tests/aiteam/layer5_flows/test_marketplace_recruitment_flow.py \
        app/tests/aiteam/layer5_flows/test_solution_apply_governance_flow.py
```

- [ ] **Step 4: Create the final implementation commit**

```bash
cd /Users/chiangguantik/.codex/worktrees/64a2/aiteam
git commit -m "feat: close out s01-s04 system admin acceptance"
```

- [ ] **Step 5: Record verification output in the handoff**

```text
Include:
- exact pytest command that passed
- whether any docs/implementation records were updated
- remaining non-blocking risks, if any
```
