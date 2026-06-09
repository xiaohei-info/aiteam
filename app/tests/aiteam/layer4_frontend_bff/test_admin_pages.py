"""Layer4-S04 — admin/system page API consumption tests.

Validates that the frontend admin/system modules use the correct northbound API
prefixes (/api/enterprise-admin/*, /api/system-admin/*) rather than old runtime
or session routes.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

AITEAM_STATIC = os.path.join(os.path.dirname(__file__), "..", "..", "..", "static", "aiteam")
PAGES_DIR = os.path.join(AITEAM_STATIC, "pages")
ROOT = Path(__file__).resolve().parents[3]
API_CLIENT_PATH = ROOT / "static" / "aiteam" / "api-client.js"
STATE_HELPERS_PATH = ROOT / "static" / "aiteam" / "state-helpers.js"
ROLE_STATE_PATH = ROOT / "static" / "aiteam" / "role-state.js"


def _read_js(filename: str) -> str:
    path = os.path.join(PAGES_DIR, filename)
    if not os.path.isfile(path):
        pytest.fail(f"Missing expected page module: {path}")
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def _run_page_module(module_file: str, handler_name: str, expected_calls: list[dict[str, str]]) -> dict:
    module_path = Path(PAGES_DIR) / module_file
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const roleStateSource = fs.readFileSync({json.dumps(str(ROLE_STATE_PATH))}, 'utf8');
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
    ok: false,
    status: 501,
    statusText: 'Not Implemented',
    async text() {{ return JSON.stringify({{ error: 'Not Implemented' }}); }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(roleStateSource, {{ filename: 'role-state.js' }});
vm.runInThisContext(moduleSource, {{ filename: {json.dumps(module_file)} }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.pages[{json.dumps(handler_name)}].init(container);
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    hasApi: !!aiteam.api,
    hasStates: !!aiteam.states,
    hasRole: !!aiteam.role,
    fetchCalls,
    html: container.innerHTML,
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
    result = json.loads(completed.stdout)
    assert result["hasApi"] is True
    assert result["hasStates"] is True
    assert result["fetchCalls"] == expected_calls
    return result


# ── Test data ──
EXPECTED_ADMIN_PREFIXES = [
    ("admin-employees.js", ["/api/team/employees", "/api/team/employees/"]),
    ("admin-billing.js",   ["/api/team/billing/usage/"]),
    ("admin-skills.js",    ["/api/team/skills/catalog", "/api/team/skills/installs"]),
    ("admin-solutions.js", ["/api/team/solutions", "/api/team/solutions/"]),
    ("admin-templates.js", ["/api/team/templates", "/api/team/recruitments"]),
]

EXPECTED_SYSTEM_PREFIXES = [
    ("system-health.js",   ["/api/system-admin/"]),
    ("system-accounts.js", ["/api/system-admin/enterprises", "/api/system-admin/enterprises/"]),
]

FORBIDDEN_PREFIXES = [
    "/api/chat/start",
    "/api/session/",
    "/api/sessions",
    "single_agent_started",
    "task_stream_delta",
    "run_completed",
]


class TestAdminPagesUseTeamApi:
    """L4-S04-T01: admin page modules call the canonical Team Panel APIs."""

    @pytest.mark.parametrize("module_file,expected_prefixes", EXPECTED_ADMIN_PREFIXES)
    def test_module_uses_team_prefix(self, module_file, expected_prefixes):
        content = _read_js(module_file)
        for prefix in expected_prefixes:
            assert prefix in content, (
                f"{module_file} must call {prefix} but no reference found"
            )

    @pytest.mark.parametrize("module_file,_", EXPECTED_ADMIN_PREFIXES)
    def test_module_does_not_use_runtime_routes(self, module_file, _):
        content = _read_js(module_file)
        for forbidden in FORBIDDEN_PREFIXES:
            assert forbidden not in content, (
                f"{module_file} must not call {forbidden}"
            )


class TestSystemPagesUseSystemAdminApi:
    """L4-S04-T02: system page modules call /api/system-admin/*."""

    @pytest.mark.parametrize("module_file,expected_prefixes", EXPECTED_SYSTEM_PREFIXES)
    def test_module_uses_system_admin_prefix(self, module_file, expected_prefixes):
        content = _read_js(module_file)
        for prefix in expected_prefixes:
            assert prefix in content, (
                f"{module_file} must call {prefix} but no reference found"
            )

    @pytest.mark.parametrize("module_file,_", EXPECTED_SYSTEM_PREFIXES)
    def test_module_does_not_use_runtime_routes(self, module_file, _):
        content = _read_js(module_file)
        for forbidden in FORBIDDEN_PREFIXES:
            assert forbidden not in content, (
                f"{module_file} must not call {forbidden}"
            )


class TestAdminSystemPageRuntimeInit:
    def test_admin_employees_init_executes_with_loaded_dependencies(self):
        result = _run_page_module(
            "admin-employees.js",
            "adminEmployees",
            [{"url": "/api/team/employees", "method": "GET"}],
        )
        assert "员工 API 尚未实现" in result["html"]

    def test_admin_billing_init_executes_with_loaded_dependencies(self):
        result = _run_page_module(
            "admin-billing.js",
            "adminBilling",
            [
                {"url": "/api/team/billing/usage/overview", "method": "GET"},
                {"url": "/api/team/billing/usage/records", "method": "GET"},
            ],
        )
        assert "费用接口尚未实现" in result["html"]

    def test_admin_skills_init_executes_with_loaded_dependencies(self):
        result = _run_page_module(
            "admin-skills.js",
            "adminSkills",
            [
                {"url": "/api/team/skills/installs", "method": "GET"},
                {"url": "/api/team/skills/catalog", "method": "GET"},
            ],
        )
        assert "技能市场读取失败" in result["html"] or "技能市场目录接口未完全就绪" in result["html"]

    def test_admin_solutions_init_executes_with_loaded_dependencies(self):
        result = _run_page_module(
            "admin-solutions.js",
            "adminSolutions",
            [{"url": "/api/team/solutions", "method": "GET"}],
        )
        assert "行业方案接口尚未实现" in result["html"] or "行业方案接口尚未开放" in result["html"]

    def test_admin_templates_init_executes_with_loaded_dependencies(self):
        result = _run_page_module(
            "admin-templates.js",
            "adminTemplates",
            [{"url": "/api/team/templates", "method": "GET"}],
        )
        assert "企业后台人才市场接口尚未实现" in result["html"]

    def test_system_health_init_executes_with_loaded_dependencies(self):
        result = _run_page_module(
            "system-health.js",
            "systemHealth",
            [{"url": "/api/system-admin/health", "method": "GET"}],
        )
        assert "系统管理员 API 尚未实现" in result["html"]

    def test_system_accounts_init_executes_with_loaded_dependencies(self):
        result = _run_page_module(
            "system-accounts.js",
            "systemAccounts",
            [{"url": "/api/system-admin/enterprises", "method": "GET"}],
        )
        assert "企业账号 API 尚未实现" in result["html"]


class TestDynamicPageLoading:
    """L4-S04-T08: page-shell loads admin/system modules for matching paths."""

    def test_page_shell_references_admin_routes(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert ("'/admin/employees'" in content or
                "\"/admin/employees\"" in content), "page-shell must route /admin/employees"
        assert ("'/admin/billing/usage'" in content or
                "\"/admin/billing/usage\"" in content), "page-shell must route /admin/billing/usage"
        assert ("'/admin/templates'" in content or
                "\"/admin/templates\"" in content), "page-shell must route /admin/templates"

    def test_page_shell_references_system_routes(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert ("'/system/accounts'" in content or
                "\"/system/accounts\"" in content), "page-shell must route /system/accounts"
        assert ("'/system/health'" in content or
                "\"/system/health\"" in content), "page-shell must route /system/health"

    def test_page_shell_loads_admin_employees_module(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert "admin-employees.js" in content, "page-shell must reference admin-employees.js"
        assert "aiteam.pages" in content, "page-shell must reference aiteam.pages namespace"
        assert "adminEmployees" in content, "page-shell must call adminEmployees handler"

    def test_page_shell_has_role_aware_navigation(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert "_filteredNavItems" in content, "page-shell must have role-aware navigation filtering"
        assert "visibleNavItems" in content, "page-shell must call role-state visibleNavItems"
        assert "FULL_SECTION_PAGES" in content, "page-shell must retain full navigation catalog"
        assert "_hasPathAccess" in content, "page-shell must guard direct links with per-path permission checks"
        assert "renderPermissionDenied" in content, "page-shell must render denied UX for restricted paths"


class TestExistingLayer4Compatibility:
    """Ensure S04/D2 additions don't break existing Layer4 test assertions."""

    def test_page_shell_section_nav_unchanged(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        for label in ["工作台", "对话", "群聊", "员工", "连接器", "费用", "企业", "健康"]:
            assert label in content, f"Nav entry '{label}' must survive in page-shell"
        assert "企业前台" in content
        assert "企业后台" in content
        assert "系统后台" in content

    def test_index_html_loads_role_state_script(self):
        index_path = ROOT / "static" / "index.html"
        with open(index_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert 'static/aiteam/role-state.js' in content, "index.html must load role-state.js"
        role_pos = content.index('static/aiteam/role-state.js')
        page_shell_pos = content.index('static/aiteam/page-shell.js')
        assert role_pos < page_shell_pos, "role-state.js must load before page-shell.js"


class TestKnowledgeOfficePageModules:
    """L4-S04: knowledge.js and office.js page modules for P08/P09."""

    def test_knowledge_module_file_exists(self):
        module_path = os.path.join(PAGES_DIR, "knowledge.js")
        assert os.path.isfile(module_path), f"Missing page module: {module_path}"

    def test_office_module_file_exists(self):
        module_path = os.path.join(PAGES_DIR, "office.js")
        assert os.path.isfile(module_path), f"Missing page module: {module_path}"

    def test_knowledge_module_registers_on_pages(self):
        content = _read_js("knowledge.js")
        assert "ns.pages.knowledge" in content, "knowledge.js must register on ns.pages.knowledge"
        assert "init: function" in content, "knowledge.js must expose init method"

    def test_office_module_registers_on_pages(self):
        content = _read_js("office.js")
        assert "ns.pages.office" in content, "office.js must register on ns.pages.office"
        assert "init: function" in content, "office.js must expose init method"

    def test_knowledge_module_uses_team_api(self):
        content = _read_js("knowledge.js")
        assert "/api/team/knowledge-bases" in content or "/knowledge-bases" in content, \
            "knowledge.js must call knowledge-bases endpoint"
        assert "/knowledge-bases/" not in content or "documents" in content, \
            "knowledge.js must reference document POST endpoint"

    def test_office_module_uses_team_api(self):
        content = _read_js("office.js")
        assert "/api/team/office/" in content or "/office/scene" in content or "/office/feed" in content, \
            "office.js must call office API endpoints"

    def test_knowledge_module_uses_state_helpers(self):
        content = _read_js("knowledge.js")
        assert "renderLoading" in content, "knowledge.js must use loading state"
        assert "renderEmpty" in content, "knowledge.js must handle empty state"
        assert "renderError" in content, "knowledge.js must handle error state"

    def test_office_module_uses_state_helpers(self):
        content = _read_js("office.js")
        assert "renderLoading" in content, "office.js must use loading state"
        assert "renderError" in content, "office.js must handle error state"

    def test_knowledge_module_does_not_use_runtime_routes(self):
        content = _read_js("knowledge.js")
        forbidden = ["/api/chat/start", "/api/session/", "/api/sessions",
                     "single_agent_started", "task_stream_delta", "run_completed"]
        for f in forbidden:
            assert f not in content, f"knowledge.js must not call {f}"

    def test_office_module_does_not_use_runtime_routes(self):
        content = _read_js("office.js")
        forbidden = ["/api/chat/start", "/api/session/", "/api/sessions",
                     "single_agent_started", "task_stream_delta", "run_completed"]
        for f in forbidden:
            assert f not in content, f"office.js must not call {f}"

    def test_office_module_consumes_event_seam(self):
        content = _read_js("office.js")
        assert "latest_event_cursor" in content, "office.js must render latest_event_cursor"
        assert "events_url" in content, "office.js must reference events_url"
        assert "generated_cursor" in content, "office.js must render generated_cursor"
        assert "refresh_hint_ms" in content, "office.js must consume refresh_hint_ms"

    def test_office_module_has_polling(self):
        content = _read_js("office.js")
        assert "setInterval" in content, "office.js must use setInterval for polling"
        assert "_stopPolling" in content, "office.js must have stop-polling cleanup"
        assert "_refreshData" in content, "office.js must have refresh-data function"

    def test_office_module_seam_meta_html(self):
        content = _read_js("office.js")
        assert "aiteam-office-seam-meta" in content, "office.js must render seam metadata bar"
        assert "aiteam-office-seam-meta__item" in content, "office.js must render seam metadata items"

    def test_page_shell_references_knowledge_route(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert "'/app/knowledge'" in content or '"/app/knowledge"' in content, \
            "page-shell must route /app/knowledge"
        assert "knowledge.js" in content, "page-shell must reference knowledge.js"

    def test_page_shell_references_office_route(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert "'/app/office'" in content or '"/app/office"' in content, \
            "page-shell must route /app/office"
        assert "office.js" in content, "page-shell must reference office.js"

    def test_page_shell_knowledge_handler_registered(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert "aiteam.pages" in content
        assert "knowledge" in content

    def test_page_shell_office_handler_registered(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert "aiteam.pages" in content
        assert "office" in content
