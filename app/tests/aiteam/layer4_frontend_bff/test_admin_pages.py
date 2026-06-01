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


def _read_js(filename: str) -> str:
    path = os.path.join(PAGES_DIR, filename)
    if not os.path.isfile(path):
        pytest.fail(f"Missing expected page module: {path}")
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def _run_page_module(module_file: str, handler_name: str, expected_url: str) -> dict:
    module_path = Path(PAGES_DIR) / module_file
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
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
vm.runInThisContext(moduleSource, {{ filename: {json.dumps(module_file)} }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.pages[{json.dumps(handler_name)}].init(container);
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    hasApi: !!aiteam.api,
    hasStates: !!aiteam.states,
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
    assert result["fetchCalls"] == [{"url": expected_url, "method": "GET"}]
    return result


# ── Test data ──
EXPECTED_ADMIN_PREFIXES = [
    ("admin-employees.js", ["/api/enterprise-admin/"]),
    ("admin-billing.js",   ["/api/enterprise-admin/"]),
]

EXPECTED_SYSTEM_PREFIXES = [
    ("system-health.js",   ["/api/system-admin/"]),
]

FORBIDDEN_PREFIXES = [
    "/api/chat/start",
    "/api/session/",
    "/api/sessions",
    "single_agent_started",
    "task_stream_delta",
    "run_completed",
]


class TestAdminPagesUseEnterpriseAdminApi:
    """L4-S04-T01: admin page modules call /api/enterprise-admin/*."""

    @pytest.mark.parametrize("module_file,expected_prefixes", EXPECTED_ADMIN_PREFIXES)
    def test_module_uses_enterprise_admin_prefix(self, module_file, expected_prefixes):
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
        result = _run_page_module("admin-employees.js", "adminEmployees", "/api/enterprise-admin/employees")
        assert "企业管理员 API 尚未实现" in result["html"]

    def test_admin_billing_init_executes_with_loaded_dependencies(self):
        result = _run_page_module("admin-billing.js", "adminBilling", "/api/enterprise-admin/billing/usage")
        assert "费用 API 尚未实现" in result["html"]

    def test_system_health_init_executes_with_loaded_dependencies(self):
        result = _run_page_module("system-health.js", "systemHealth", "/api/system-admin/health")
        assert "系统管理员 API 尚未实现" in result["html"]


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

    def test_page_shell_references_system_routes(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert ("'/system/health'" in content or
                "\"/system/health\"" in content), "page-shell must route /system/health"

    def test_page_shell_loads_admin_employees_module(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        assert "admin-employees.js" in content, "page-shell must reference admin-employees.js"
        assert "aiteam.pages" in content, "page-shell must reference aiteam.pages namespace"
        assert "adminEmployees" in content, "page-shell must call adminEmployees handler"


class TestExistingLayer4Compatibility:
    """Ensure S04 additions don't break existing Layer4 test assertions."""

    def test_page_shell_section_nav_unchanged(self):
        shell_path = os.path.join(AITEAM_STATIC, "page-shell.js")
        with open(shell_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        for label in ["工作台", "对话", "群聊", "员工", "连接器", "费用", "企业", "健康"]:
            assert label in content, f"Nav entry '{label}' must survive in page-shell"
        assert "企业前台" in content
        assert "企业后台" in content
        assert "系统后台" in content
