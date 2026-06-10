"""Layer4-D2 — Crosscutting governance UX tests.

Validates role-aware navigation, permission-denied states, export affordances,
and role-state consistency with the backend permission matrix.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ROLE_STATE_PATH = ROOT / "static" / "aiteam" / "role-state.js"
STATE_HELPERS_PATH = ROOT / "static" / "aiteam" / "state-helpers.js"


def _run_role_state_node(payload: dict) -> dict:
    """Load role-state.js in Node and run a test payload."""
    script = f"""
const fs = require('fs');
const vm = require('vm');
const roleSource = fs.readFileSync({json.dumps(str(ROLE_STATE_PATH))}, 'utf8');
const stateSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(stateSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(roleSource, {{ filename: 'role-state.js' }});

const payload = {json.dumps(payload)};

if (payload.mode === 'nav_items') {{
  const role = payload.role || '';
  aiteam.role.setActiveRole(role);
  const adminItems = aiteam.role.visibleNavItems(role, 'admin');
  const systemItems = aiteam.role.visibleNavItems(role, 'system');
  const sections = aiteam.role.visibleNavSections(role);
  console.log(JSON.stringify({{
    adminItems: adminItems.map(function (i) {{ return i.label; }}),
    systemItems: systemItems.map(function (i) {{ return i.label; }}),
    sections: sections,
    canExportBilling: aiteam.role.canExportBilling(role),
    canExportEmployees: aiteam.role.canExportEmployees(role),
    canViewAudit: aiteam.role.canViewAudit(role),
  }}));
}} else if (payload.mode === 'permission_denied') {{
  const container = {{ innerHTML: '' }};
  aiteam.states.renderPermissionDenied(container);
  console.log(JSON.stringify({{
    html: container.innerHTML,
    hasDeniedClass: container.innerHTML.indexOf('aiteam-state-denied') !== -1,
    hasMessage: container.innerHTML.indexOf('您没有权限访问此内容') !== -1,
  }}));
}} else if (payload.mode === 'has_permission') {{
  const result = aiteam.role.hasPermission(payload.role, payload.action);
  console.log(JSON.stringify({{ result: result }}));
}} else if (payload.mode === 'perm_matrix') {{
  const matrix = aiteam.role.PERMISSIONS;
  console.log(JSON.stringify({{
    owner: matrix.owner || [],
    enterprise_admin: matrix.enterprise_admin || [],
    finance_admin: matrix.finance_admin || [],
    member: matrix.member || [],
    system_admin: matrix.system_admin || [],
    system_operator: matrix.system_operator || [],
  }}));
}}
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_page_with_role(
    module_file: str,
    handler_name: str,
    role: str,
    fetch_status: int,
    fetch_body: str,
    browser_state: dict | None = None,
    after_init_js: str = "return {};",
) -> dict:
    """Load a page module with role-state and a mock fetch, run init, return html."""
    module_path = ROOT / "static" / "aiteam" / "pages" / module_file
    api_client_path = ROOT / "static" / "aiteam" / "api-client.js"
    state_helpers_path = ROOT / "static" / "aiteam" / "state-helpers.js"
    role_state_path = ROOT / "static" / "aiteam" / "role-state.js"
    browser_state_json = json.dumps(browser_state or {})

    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiSource = fs.readFileSync({json.dumps(str(api_client_path))}, 'utf8');
const stateSource = fs.readFileSync({json.dumps(str(state_helpers_path))}, 'utf8');
const roleSource = fs.readFileSync({json.dumps(str(role_state_path))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(module_path))}, 'utf8');

const fetchCalls = [];
global.Headers = class Headers {{
  constructor(init) {{
    this.map = new Map();
    if (init) {{
      for (const [key, value] of Object.entries(init)) this.map.set(String(key).toLowerCase(), String(value));
    }}
  }}
  has(name) {{ return this.map.has(String(name).toLowerCase()); }}
  set(name, value) {{ this.map.set(String(name).toLowerCase(), String(value)); }}
}};
global.fetch = async (url, options) => {{
  fetchCalls.push({{ url, method: options.method }});
  return {{
    ok: {json.dumps(fetch_status == 200)},
    status: {json.dumps(fetch_status)},
    statusText: {json.dumps('OK' if fetch_status == 200 else 'Forbidden' if fetch_status == 403 else 'Not Implemented')},
    async text() {{ return {json.dumps(fetch_body)}; }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.window.prompt = () => '';
global.window.confirm = () => true;
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(roleSource, {{ filename: 'role-state.js' }});
aiteam.role.setActiveRole({json.dumps(role)});
vm.runInThisContext(moduleSource, {{ filename: {json.dumps(module_file)} }});
const browserState = {browser_state_json};

function createEventTarget(initialValue) {{
  return {{
    value: initialValue || '',
    listeners: {{}},
    addEventListener(type, handler) {{
      this.listeners[type] = handler;
    }},
    dispatch(type) {{
      if (this.listeners[type]) {{
        this.listeners[type].call(this, {{ currentTarget: this, target: this }});
      }}
    }},
  }};
}}

async function flushTurns(count) {{
  for (let i = 0; i < count; i += 1) {{
    await new Promise((resolve) => setImmediate(resolve));
  }}
}}

async function applyBrowserState(nodes) {{
  if (!browserState || !browserState.createdRange) return;
  const createdRangeInput = nodes['[data-role="enterprise-created-range"]'];
  for (let i = 0; i < 10; i += 1) {{
    if (createdRangeInput.listeners && createdRangeInput.listeners.input) break;
    await new Promise((resolve) => setImmediate(resolve));
  }}
  createdRangeInput.value = browserState.createdRange;
  if (createdRangeInput.listeners && createdRangeInput.listeners.input) {{
    createdRangeInput.listeners.input.call(createdRangeInput, {{ currentTarget: createdRangeInput, target: createdRangeInput }});
  }}
}}

(async () => {{
  const nodes = {{
    '[data-role="enterprise-search"]': createEventTarget(''),
    '[data-role="enterprise-status"]': createEventTarget(''),
    '[data-role="enterprise-created-range"]': createEventTarget(''),
  }};
  const container = {{
    innerHTML: '',
    querySelector(selector) {{ return nodes[selector] || null; }},
    querySelectorAll() {{ return []; }},
  }};
  const handler = aiteam.pages[{json.dumps(handler_name)}];
  if (handler && handler.init) {{
    handler.init(container);
  }}
  await flushTurns(4);
  await applyBrowserState(nodes);
  const extra = await (async () => {
    {after_init_js}
  })();
  await flushTurns(2);
  console.log(JSON.stringify({{
    html: container.innerHTML,
    fetchCalls: fetchCalls,
    extra: extra,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_system_accounts_action(role: str, action: str, overrides: dict, response_body: dict) -> dict:
    module_path = ROOT / "static" / "aiteam" / "pages" / "system-accounts.js"
    api_client_path = ROOT / "static" / "aiteam" / "api-client.js"
    state_helpers_path = ROOT / "static" / "aiteam" / "state-helpers.js"
    role_state_path = ROOT / "static" / "aiteam" / "role-state.js"

    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiSource = fs.readFileSync({json.dumps(str(api_client_path))}, 'utf8');
const stateSource = fs.readFileSync({json.dumps(str(state_helpers_path))}, 'utf8');
const roleSource = fs.readFileSync({json.dumps(str(role_state_path))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(module_path))}, 'utf8');

const fetchCalls = [];
global.Headers = class Headers {{
  constructor(init) {{
    this.map = new Map();
    if (init) {{
      for (const [key, value] of Object.entries(init)) this.map.set(String(key).toLowerCase(), String(value));
    }}
  }}
  has(name) {{ return this.map.has(String(name).toLowerCase()); }}
  set(name, value) {{ this.map.set(String(name).toLowerCase(), String(value)); }}
}};
global.fetch = async (url, options) => {{
  fetchCalls.push({{
    url: url,
    method: options.method,
    body: options.body ? JSON.parse(options.body) : null,
  }});
  const isList = url === '/api/system-admin/enterprises' && options.method === 'GET';
  return {{
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {{
      return JSON.stringify(
        isList
          ? {{ enterprises: [{{ enterprise_id: 'ent_demo', name: 'Demo', status: 'active', plan: 'pro', balance: 1 }}] }}
          : {json.dumps(response_body)}
      );
    }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.window.prompt = () => '';
global.window.confirm = () => true;
global.aiteam = global.window.aiteam;
global.document = {{
  getElementById(id) {{
    if (id === 'aiteam-sys-accounts-feedback') return {{ innerHTML: '' }};
    return null;
  }}
}};
vm.runInThisContext(apiSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(roleSource, {{ filename: 'role-state.js' }});
aiteam.role.setActiveRole({json.dumps(role)});
vm.runInThisContext(moduleSource, {{ filename: 'system-accounts.js' }});

(async () => {{
  const container = {{
    innerHTML: '',
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.systemAccounts.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  const result = await aiteam.pages.systemAccounts.performAction('ent_demo', {json.dumps(action)}, {json.dumps(overrides)});
  console.log(JSON.stringify({{
    fetchCalls: fetchCalls,
    ok: result.ok,
    status: result.status,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_shell_with_role(pathname: str, role: str) -> dict:
    shell_path = ROOT / "static" / "aiteam" / "page-shell.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const shellSource = fs.readFileSync({json.dumps(str(shell_path))}, 'utf8');
const stateSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const roleSource = fs.readFileSync({json.dumps(str(ROLE_STATE_PATH))}, 'utf8');
const titlebar = {{ style: {{ display: '' }} }};
const layout = {{ style: {{ display: '' }} }};
const toast = {{ style: {{ display: '' }} }};
const title = {{ textContent: '' }};
const subtitle = {{ textContent: '' }};
const nav = {{ innerHTML: '' }};
const main = {{ innerHTML: '', hidden: false }};
const app = {{ hidden: true }};
const bodyClassManager = {{ add: function () {{}} }};
const document = {{
  querySelector(selector) {{
    if (selector === '.app-titlebar') return titlebar;
    if (selector === '.layout') return layout;
    return null;
  }},
  getElementById(id) {{
    if (id === 'toast') return toast;
    if (id === 'aiteam-shell-title') return title;
    if (id === 'aiteam-shell-subtitle') return subtitle;
    if (id === 'aiteam-nav') return nav;
    if (id === 'aiteam-main') return main;
    if (id === 'aiteam-app') return app;
    return null;
  }},
  createElement() {{ return {{}}; }},
  head: {{
    appendChild(scriptEl) {{
      global.window.aiteam.pages = global.window.aiteam.pages || {{}};
      global.window.aiteam.pages.systemAccounts = {{
        init(container) {{ container.innerHTML = '<p>loaded</p>'; }},
      }};
      if (scriptEl && typeof scriptEl.onload === 'function') scriptEl.onload();
    }}
  }},
}};
global.document = document;
global.bodyClassManager = bodyClassManager;
global.window = {{ aiteam: {{}}, location: {{ pathname: {json.dumps(pathname)} }} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(stateSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(roleSource, {{ filename: 'role-state.js' }});
aiteam.role.setActiveRole({json.dumps(role)});
vm.runInThisContext(shellSource, {{ filename: 'page-shell.js' }});
aiteam.shell.init(aiteam.shell.matchPath({json.dumps(pathname)}) || 'app');
console.log(JSON.stringify({{ nav: nav.innerHTML, main: main.innerHTML, title: title.textContent }}));
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


# ═══════════════════════════════════════════════════════
# D2-T01: Role-state file exists and has correct namespace
# ═══════════════════════════════════════════════════════

class TestRoleStateModule:
    def test_role_state_file_exists(self):
        assert ROLE_STATE_PATH.exists(), f"Missing role-state.js: {ROLE_STATE_PATH}"

    def test_role_state_exposes_expected_symbols(self):
        role_source = ROLE_STATE_PATH.read_text(encoding="utf-8")
        assert "ns.role = {" in role_source, "role-state must register aiteam.role"
        assert "visibleNavItems" in role_source
        assert "visibleNavSections" in role_source
        assert "canExportBilling" in role_source
        assert "canExportEmployees" in role_source
        assert "canViewAudit" in role_source
        assert "hasPermission" in role_source
        assert "getActiveRole" in role_source
        assert "setActiveRole" in role_source


# ═══════════════════════════════════════════════════════
# D2-T02: Permission matrix mirrors backend
# ═══════════════════════════════════════════════════════

class TestPermissionMatrixMatchesBackend:
    def test_owner_can_manage_employees(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "owner", "action": "manage_employees"})
        assert result["result"] is True

    def test_owner_can_view_billing(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "owner", "action": "view_billing"})
        assert result["result"] is True

    def test_owner_can_export_data(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "owner", "action": "export_data"})
        assert result["result"] is True

    def test_owner_can_view_audit_logs(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "owner", "action": "view_audit_logs"})
        assert result["result"] is True

    def test_member_cannot_manage_employees(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "member", "action": "manage_employees"})
        assert result["result"] is False

    def test_member_cannot_view_billing(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "member", "action": "view_billing"})
        assert result["result"] is False

    def test_finance_admin_can_view_billing(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "finance_admin", "action": "view_billing"})
        assert result["result"] is True

    def test_finance_admin_cannot_manage_employees(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "finance_admin", "action": "manage_employees"})
        assert result["result"] is False

    def test_finance_admin_can_export_data(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "finance_admin", "action": "export_data"})
        assert result["result"] is True

    def test_finance_admin_can_view_audit_logs(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "finance_admin", "action": "view_audit_logs"})
        assert result["result"] is True

    def test_enterprise_admin_can_manage_employees(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "enterprise_admin", "action": "manage_employees"})
        assert result["result"] is True

    def test_enterprise_admin_can_export_data(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "enterprise_admin", "action": "export_data"})
        assert result["result"] is True

    def test_enterprise_admin_can_view_audit_logs(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "enterprise_admin", "action": "view_audit_logs"})
        assert result["result"] is True

    def test_enterprise_admin_cannot_manage_enterprise(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "enterprise_admin", "action": "manage_enterprise"})
        assert result["result"] is False

    def test_system_admin_cannot_access_enterprise_data(self):
        result = _run_role_state_node({"mode": "has_permission", "role": "system_admin", "action": "manage_employees"})
        assert result["result"] is False


# ═══════════════════════════════════════════════════════
# D2-T03: Role-aware navigation visibility
# ═══════════════════════════════════════════════════════

class TestRoleAwareNavigation:
    def test_owner_sees_all_admin_nav(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "owner"})
        assert "员工" in result["adminItems"]
        assert "技能" in result["adminItems"]
        assert "人才市场" in result["adminItems"]
        assert "连接器" in result["adminItems"]
        assert "费用" in result["adminItems"]
        assert result["sections"]["admin"] is True

    def test_finance_admin_sees_only_billing_nav(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "finance_admin"})
        assert "员工" not in result["adminItems"], "finance_admin must not see employee nav"
        assert "技能" not in result["adminItems"], "finance_admin must not see skills nav"
        assert "人才市场" not in result["adminItems"], "finance_admin must not see templates nav"
        assert "连接器" not in result["adminItems"], "finance_admin must not see connector nav"
        assert "费用" in result["adminItems"], "finance_admin must see billing nav"
        assert result["sections"]["admin"] is True

    def test_member_sees_no_admin_nav(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "member"})
        assert result["adminItems"] == [], "member must see no admin nav items"
        assert result["sections"]["admin"] is False

    def test_enterprise_admin_sees_employee_connector_nav(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "enterprise_admin"})
        assert "员工" in result["adminItems"]
        assert "技能" in result["adminItems"]
        assert "人才市场" in result["adminItems"]
        assert "连接器" in result["adminItems"]
        assert "费用" not in result["adminItems"], "enterprise_admin must not see billing nav"
        assert result["sections"]["admin"] is True

    def test_system_admin_sees_system_nav(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "system_admin"})
        assert "企业" in result["systemItems"]
        assert "健康" in result["systemItems"]
        assert result["sections"]["system"] is True

    def test_no_role_shows_all_items(self):
        result = _run_role_state_node({"mode": "nav_items", "role": ""})
        # No role: visibleNavItems returns [] (empty string maps to no permissions),
        # but visibleNavSections falls back to True (legacy behavior — show all)
        assert result["sections"]["admin"] is True
        assert result["sections"]["system"] is True


# ═══════════════════════════════════════════════════════
# D2-T04: Permission-denied state rendering in pages
# ═══════════════════════════════════════════════════════

class TestPermissionDeniedState:
    def test_permission_denied_html_rendered(self):
        result = _run_role_state_node({"mode": "permission_denied"})
        assert result["hasDeniedClass"] is True
        assert result["hasMessage"] is True

    def test_finance_admin_gets_denied_on_employee_page(self):
        result = _run_page_with_role(
            "admin-employees.js", "adminEmployees",
            role="finance_admin",
            fetch_status=200,
            fetch_body=json.dumps({"employees": []}),
        )
        assert "aiteam-state-denied" in result["html"]
        assert "您没有权限访问此内容" in result["html"]
        # finance_admin must NOT reach the fetch call
        assert result["fetchCalls"] == []

    def test_member_gets_denied_on_billing_page(self):
        result = _run_page_with_role(
            "admin-billing.js", "adminBilling",
            role="member",
            fetch_status=200,
            fetch_body=json.dumps({"total_tokens": 0}),
        )
        assert "aiteam-state-denied" in result["html"]
        assert "您没有权限访问此内容" in result["html"]
        assert result["fetchCalls"] == []

    def test_finance_admin_gets_denied_on_skills_page(self):
        result = _run_page_with_role(
            "admin-skills.js", "adminSkills",
            role="finance_admin",
            fetch_status=200,
            fetch_body=json.dumps({"items": []}),
        )
        assert "aiteam-state-denied" in result["html"]
        assert result["fetchCalls"] == []

    def test_member_gets_denied_on_templates_page(self):
        result = _run_page_with_role(
            "admin-templates.js", "adminTemplates",
            role="member",
            fetch_status=200,
            fetch_body=json.dumps({"items": []}),
        )
        assert "aiteam-state-denied" in result["html"]
        assert result["fetchCalls"] == []

    def test_owner_sees_employee_page(self):
        result = _run_page_with_role(
            "admin-employees.js", "adminEmployees",
            role="owner",
            fetch_status=200,
            fetch_body=json.dumps({"employees": [{"employee_id": "e1", "display_name": "Test", "role_name": "analyst", "status": "active"}]}),
        )
        assert "aiteam-state-denied" not in result["html"]
        assert len(result["fetchCalls"]) == 1

    def test_enterprise_admin_gets_403_handled(self):
        result = _run_page_with_role(
            "admin-employees.js", "adminEmployees",
            role="enterprise_admin",
            fetch_status=403,
            fetch_body=json.dumps({"error": "forbidden"}),
        )
        assert "aiteam-state-denied" in result["html"]
        assert len(result["fetchCalls"]) == 1

    def test_member_gets_denied_on_system_accounts_page(self):
        result = _run_page_with_role(
            "system-accounts.js", "systemAccounts",
            role="member",
            fetch_status=200,
            fetch_body=json.dumps({"enterprises": []}),
        )
        assert "aiteam-state-denied" in result["html"]
        assert result["fetchCalls"] == []

    def test_system_operator_can_view_system_accounts_but_cannot_mutate(self):
        result = _run_page_with_role(
            "system-accounts.js", "systemAccounts",
            role="system_operator",
            fetch_status=200,
            fetch_body=json.dumps({
                "enterprises": [
                    {"enterprise_id": "ent_acme", "name": "Acme", "status": "active", "plan": "pro", "balance": 1200}
                ]
            }),
        )
        assert "只读" in result["html"]
        assert result["fetchCalls"] == [
            {"url": "/api/system-admin/enterprises", "method": "GET"},
            {"url": "/api/system-admin/enterprises/ent_acme", "method": "GET"},
            {"url": "/api/system-admin/enterprises/ent_acme/quota", "method": "GET"},
            {"url": "/api/system-admin/enterprises/export", "method": "GET"},
        ]
        module_source = (ROOT / "static" / "aiteam" / "pages" / "system-accounts.js").read_text(encoding="utf-8")
        assert "system_write" in module_source
        assert "permission_denied" in module_source

    def test_system_accounts_system_operator_keeps_readonly_actions_after_created_range_rerender(self):
        result = _run_page_with_role(
            "system-accounts.js",
            "systemAccounts",
            role="system_operator",
            fetch_status=200,
            browser_state={"createdRange": "2026-02-01 ~ 2026-02-28"},
            fetch_body=json.dumps(
                {
                    "enterprises": [
                        {"enterprise_id": "ent_old", "name": "Old Co", "status": "active", "created_at": "2026-01-15"},
                        {"enterprise_id": "ent_focus", "name": "Focus Co", "status": "active", "created_at": "2026-02-20"},
                    ]
                }
            ),
        )
        assert 'data-enterprise-row="ent_focus"' in result["html"]
        assert 'data-enterprise-row="ent_old"' not in result["html"]
        assert result["html"].count("只读") == 1
        assert 'data-aiteam-action="' not in result["html"]

    def test_system_accounts_perform_action_posts_canonical_actions_contract(self):
        result = _run_system_accounts_action(
            role="system_admin",
            action="ban",
            overrides={"reason": "policy"},
            response_body={
                "enterprise_id": "ent_demo",
                "action": "ban",
                "status": "succeeded",
                "message": "enterprise action applied",
                "audit_event_id": "audit_demo",
            },
        )
        assert result["ok"] is True
        assert result["status"] == 200
        assert result["fetchCalls"] == [
            {"url": "/api/system-admin/enterprises", "method": "GET", "body": None},
            {"url": "/api/system-admin/enterprises/ent_demo", "method": "GET", "body": None},
            {"url": "/api/system-admin/enterprises/ent_demo/quota", "method": "GET", "body": None},
            {"url": "/api/system-admin/enterprises/export", "method": "GET", "body": None},
            {
                "url": "/api/system-admin/enterprises/ent_demo/actions",
                "method": "POST",
                "body": {"action": "ban", "reason": "policy"},
            },
        ]


# ═══════════════════════════════════════════════════════
# D2-T05: Export affordances wired to contract paths
# ═══════════════════════════════════════════════════════

class TestExportAffordances:
    def test_owner_can_export_employees(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "owner"})
        assert result["canExportEmployees"] is True

    def test_owner_can_export_billing(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "owner"})
        assert result["canExportBilling"] is True

    def test_finance_admin_can_export_billing(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "finance_admin"})
        assert result["canExportBilling"] is True

    def test_finance_admin_can_export_employees_helper_tracks_export_permission(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "finance_admin"})
        assert result["canExportEmployees"] is True

    def test_member_cannot_export_billing(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "member"})
        assert result["canExportBilling"] is False

    def test_owner_can_view_audit(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "owner"})
        assert result["canViewAudit"] is True

    def test_finance_admin_can_view_audit(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "finance_admin"})
        assert result["canViewAudit"] is True

    def test_enterprise_admin_can_view_audit(self):
        result = _run_role_state_node({"mode": "nav_items", "role": "enterprise_admin"})
        assert result["canViewAudit"] is True

    def test_admin_billing_uses_canonical_path_declared(self):
        billing_path = ROOT / "static" / "aiteam" / "pages" / "admin-billing.js"
        content = billing_path.read_text(encoding="utf-8")
        assert "billing/usage/overview" in content, (
            "admin-billing.js must declare the canonical billing path /api/team/billing/usage/overview"
        )
        assert "billing/usage/records/export" in content, (
            "admin-billing.js must reference billing records export path"
        )

    def test_admin_employees_uses_employee_export_path(self):
        employees_path = ROOT / "static" / "aiteam" / "pages" / "admin-employees.js"
        content = employees_path.read_text(encoding="utf-8")
        assert "employees/export" in content, (
            "admin-employees.js must reference employee export path /api/team/employees/export"
        )


# ═══════════════════════════════════════════════════════
# D2-T06: State helpers properly handle 403 (existing regression check)
# ═══════════════════════════════════════════════════════

class TestStateHelpers403Regression:
    """Verify the existing state helpers handle 403 correctly (unchanged)."""

    def test_handle_api_result_403_renders_denied(self):
        from tests.aiteam.layer4_frontend_bff.test_empty_error_permission_states import _run_node as _run_states_node
        result = _run_states_node({"mode": "handle", "result": {"ok": False, "status": 403, "error": "forbidden"}})
        assert "aiteam-state-denied" in result["html"]
        assert "您没有权限访问此内容" in result["html"]


# ═══════════════════════════════════════════════════════
# D2-T07: page-shell has role-aware nav filtering source
# ═══════════════════════════════════════════════════════

class TestPageShellRoleAware:
    def test_page_shell_has_role_aware_filtering(self):
        shell_path = ROOT / "static" / "aiteam" / "page-shell.js"
        content = shell_path.read_text(encoding="utf-8")
        assert "_filteredNavItems" in content
        assert "_isSectionVisible" in content
        assert "_hasPathAccess" in content
        assert "system-accounts.js" in content

    def test_shell_denies_member_system_deep_link(self):
        result = _run_shell_with_role("/system/accounts", "member")
        assert "aiteam-state-denied" in result["main"]

    def test_shell_allows_system_operator_system_deep_link(self):
        result = _run_shell_with_role("/system/accounts", "system_operator")
        assert result["title"] == "系统后台"
        assert "aiteam-state-denied" not in result["main"]
