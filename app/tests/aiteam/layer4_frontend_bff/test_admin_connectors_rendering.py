from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "admin-connectors.js"
API_CLIENT_PATH = ROOT / "static" / "aiteam" / "api-client.js"
STATE_HELPERS_PATH = ROOT / "static" / "aiteam" / "state-helpers.js"
ROLE_STATE_PATH = ROOT / "static" / "aiteam" / "role-state.js"


def _run_connectors_page() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const roleStateSource = fs.readFileSync({json.dumps(str(ROLE_STATE_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
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
  if (url === '/api/team/connectors' && options.method === 'GET') {{
    return {{
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {{ return JSON.stringify({{
        items: [{{
          connector_id: 'conn_truth',
          definition_id: 'def_slack_webhook',
          name: '公司 Slack',
          provider_code: 'slack',
          connector_type: 'webhook_target',
          status: 'online',
          scopes: ['invoke'],
          credential_mask: '已配置',
          credential_state: 'configured',
          rotation_version: 2,
          config: {{ tenant_hint: 'acme', channel: '#sales' }},
          employee_grants: [],
          granted_employee_ids: [],
          last_test_result: {{ result: 'passed', checked_at: '2026-06-06T00:00:00Z', message: 'ok' }},
          updated_at: '2026-06-06T00:00:00Z',
          updated_by: 'user_seed',
          created_at: '2026-06-04T00:00:00Z',
        }}],
        definitions: [
          {{ definition_id: 'def_feishu', provider_code: 'feishu', connector_type: 'preset_oauth', display_name: '飞书', auth_scheme: 'opaque_ref', status: 'active' }},
          {{ definition_id: 'def_dingtalk', provider_code: 'dingtalk', connector_type: 'preset_oauth', display_name: '钉钉', auth_scheme: 'opaque_ref', status: 'active' }},
          {{ definition_id: 'def_qywx', provider_code: 'wecom', connector_type: 'preset_oauth', display_name: '企微', auth_scheme: 'opaque_ref', status: 'active' }},
          {{ definition_id: 'def_salesforce', provider_code: 'salesforce', connector_type: 'preset_apikey', display_name: 'Salesforce', auth_scheme: 'opaque_ref', status: 'active' }},
          {{ definition_id: 'def_github', provider_code: 'github', connector_type: 'preset_oauth', display_name: 'Github', auth_scheme: 'opaque_ref', status: 'active' }},
          {{ definition_id: 'def_slack_webhook', provider_code: 'slack', connector_type: 'webhook_target', display_name: 'Slack', auth_scheme: 'opaque_ref', status: 'active' }},
          {{ definition_id: 'def_google', provider_code: 'google', connector_type: 'preset_oauth', display_name: 'Google', auth_scheme: 'opaque_ref', status: 'active' }},
        ],
      }}); }},
    }};
  }}
  if (url === '/api/team/employees' && options.method === 'GET') {{
    return {{ ok: true, status: 200, statusText: 'OK', async text() {{ return JSON.stringify({{ employees: [] }}); }} }};
  }}
  if (url === '/api/team/connectors/conn_truth' && options.method === 'GET') {{
    return {{
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {{ return JSON.stringify({{
        connector_id: 'conn_truth',
        definition_id: 'def_slack_webhook',
        name: '公司 Slack',
        provider_code: 'slack',
        connector_type: 'webhook_target',
        status: 'online',
        scopes: ['invoke'],
        credential_mask: '已配置',
        credential_state: 'configured',
        rotation_version: 2,
        config: {{ tenant_hint: 'acme', channel: '#sales' }},
        employee_grants: [],
        granted_employee_ids: [],
        last_test_result: {{ result: 'passed', checked_at: '2026-06-06T00:00:00Z', message: 'ok' }},
        updated_at: '2026-06-06T00:00:00Z',
        updated_by: 'user_seed',
        created_at: '2026-06-04T00:00:00Z',
      }}); }},
    }};
  }}
  return {{ ok: false, status: 404, statusText: 'Not Found', async text() {{ return JSON.stringify({{ error: 'Not Found' }}); }} }};
}};
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(roleStateSource, {{ filename: 'role-state.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'admin-connectors.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.role.setActiveRole('owner');
  aiteam.pages.adminConnectors.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{ html: container.innerHTML }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def test_admin_connectors_renders_connected_services_and_available_presets() -> None:
    payload = _run_connectors_page()
    assert "已连接服务" in payload["html"]
    assert "可用连接器" in payload["html"]
    assert "飞书" in payload["html"]
    assert "钉钉" in payload["html"]
    assert "企微" in payload["html"]
    assert "Salesforce" in payload["html"]
    assert "Github" in payload["html"]
    assert "Slack" in payload["html"]
    assert "Google" in payload["html"]
    assert "自定义MCP服务" in payload["html"]
