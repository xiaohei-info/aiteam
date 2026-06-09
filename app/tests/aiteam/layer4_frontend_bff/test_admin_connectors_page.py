from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "admin-connectors.js"
API_CLIENT_PATH = ROOT / "static" / "aiteam" / "api-client.js"
STATE_HELPERS_PATH = ROOT / "static" / "aiteam" / "state-helpers.js"
ROLE_STATE_PATH = ROOT / "static" / "aiteam" / "role-state.js"


def _page_source() -> str:
    return PAGE_PATH.read_text(encoding="utf-8")


def _run_page_node(role: str = "owner") -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const roleStateSource = fs.readFileSync({json.dumps(str(ROLE_STATE_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
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
const connectorSnapshots = [
  {{
    items: [{{
      connector_id: 'conn_truth',
      definition_id: 'def_slack_webhook',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      status: 'online',
      scopes: ['invoke'],
      credential_mask: '已配置',
      credential_state: 'configured',
      rotation_version: 2,
      config: {{ tenant_hint: 'acme', channel: '#seed', bot_secret: 'hidden' }},
      employee_grants: [{{
        binding_id: 'bind_seed',
        employee_id: 'emp_seed',
        employee_display_name: '种子员工',
        access_mode: 'invoke',
        enabled: true,
      }}],
      granted_employee_ids: ['emp_seed'],
      last_test_result: {{
        result: 'passed',
        checked_at: '2026-06-05T00:00:00Z',
        checked_by: 'user_seed',
        error_code: '',
        message: '最近一次连接测试通过',
        log_ref: 'audit://connector-test/seed',
      }},
      updated_at: '2026-06-05T00:00:00Z',
      updated_by: 'user_seed',
      created_at: '2026-06-04T00:00:00Z',
    }}],
    definitions: [{{
      definition_id: 'def_slack_webhook',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      display_name: 'Slack Webhook',
      auth_scheme: 'opaque_ref',
      status: 'active',
    }}],
  }},
  {{
    items: [{{
      connector_id: 'conn_truth',
      definition_id: 'def_slack_webhook',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      status: 'draft',
      scopes: ['invoke'],
      credential_mask: '已轮换',
      credential_state: 'rotated',
      rotation_version: 3,
      config: {{ tenant_hint: 'acme-updated', channel: '#ops', bot_secret: 'hidden' }},
      employee_grants: [{{
        binding_id: 'bind_seed',
        employee_id: 'emp_seed',
        employee_display_name: '种子员工',
        access_mode: 'invoke',
        enabled: true,
      }}],
      granted_employee_ids: ['emp_seed'],
      last_test_result: {{
        result: 'never_tested',
        checked_at: '',
        checked_by: '',
        error_code: '',
        message: '等待复测',
        log_ref: '',
      }},
      updated_at: '2026-06-06T12:00:00Z',
      updated_by: 'user_editor',
      created_at: '2026-06-04T00:00:00Z',
    }}],
    definitions: [{{
      definition_id: 'def_slack_webhook',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      display_name: 'Slack Webhook',
      auth_scheme: 'opaque_ref',
      status: 'active',
    }}],
  }},
  {{
    items: [{{
      connector_id: 'conn_truth',
      definition_id: 'def_slack_webhook',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      status: 'draft',
      scopes: ['invoke'],
      credential_mask: '已轮换',
      credential_state: 'rotated',
      rotation_version: 3,
      config: {{ tenant_hint: 'acme-updated', channel: '#ops', bot_secret: 'hidden' }},
      employee_grants: [{{
        binding_id: 'bind_seed',
        employee_id: 'emp_seed',
        employee_display_name: '种子员工',
        access_mode: 'invoke',
        enabled: true,
      }}],
      granted_employee_ids: ['emp_seed'],
      last_test_result: {{
        result: 'never_tested',
        checked_at: '',
        checked_by: '',
        error_code: '',
        message: '等待复测',
        log_ref: '',
      }},
      updated_at: '2026-06-06T12:00:00Z',
      updated_by: 'user_editor',
      created_at: '2026-06-04T00:00:00Z',
    }}],
    definitions: [{{
      definition_id: 'def_slack_webhook',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      display_name: 'Slack Webhook',
      auth_scheme: 'opaque_ref',
      status: 'active',
    }}],
  }},
  {{
    items: [{{
      connector_id: 'conn_truth',
      definition_id: 'def_slack_webhook',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      status: 'online',
      scopes: ['invoke'],
      credential_mask: '已轮换',
      credential_state: 'rotated',
      rotation_version: 3,
      config: {{ tenant_hint: 'acme-updated', channel: '#ops', bot_secret: 'hidden' }},
      employee_grants: [{{
        binding_id: 'bind_backend',
        employee_id: 'emp_backend',
        employee_display_name: '后端同步员工',
        access_mode: 'invoke',
        enabled: true,
      }}],
      granted_employee_ids: ['emp_backend'],
      last_test_result: {{
        result: 'passed',
        checked_at: '2026-06-06T00:00:00Z',
        checked_by: 'user_test',
        error_code: '',
        message: 'rechecked from backend',
        log_ref: 'audit://connector-test/recheck',
      }},
      updated_at: '2026-06-06T12:00:00Z',
      updated_by: 'user_test',
      created_at: '2026-06-04T00:00:00Z',
    }}],
    definitions: [{{
      definition_id: 'def_slack_webhook',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      display_name: 'Slack Webhook',
      auth_scheme: 'opaque_ref',
      status: 'active',
    }}],
  }},
  {{
    items: [{{
      connector_id: 'conn_truth',
      definition_id: 'def_slack_webhook',
      name: 'Slack Connector',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      status: 'online',
      scopes: ['invoke'],
      credential_mask: '已轮换',
      credential_state: 'rotated',
      rotation_version: 3,
      config: {{ tenant_hint: 'acme-updated', channel: '#ops', bot_secret: 'hidden' }},
      employee_grants: [{{
        binding_id: 'bind_backend',
        employee_id: 'emp_backend',
        employee_display_name: '后端同步员工',
        access_mode: 'invoke',
        enabled: true,
      }}],
      granted_employee_ids: ['emp_backend'],
      last_test_result: {{
        result: 'passed',
        checked_at: '2026-06-06T00:00:00Z',
        checked_by: 'user_test',
        error_code: '',
        message: 'rechecked from backend',
        log_ref: 'audit://connector-test/recheck',
      }},
      updated_at: '2026-06-06T12:00:00Z',
      updated_by: 'user_test',
      created_at: '2026-06-04T00:00:00Z',
    }}],
    definitions: [{{
      definition_id: 'def_slack_webhook',
      provider_code: 'slack',
      connector_type: 'webhook_target',
      display_name: 'Slack Webhook',
      auth_scheme: 'opaque_ref',
      status: 'active',
    }}],
  }},
];
let connectorIndex = 0;
let employeeCalls = 0;
let detailCalls = 0;
let createPayload = null;
let updatePayload = null;
let grantPayload = null;
let testCalls = 0;
let statusCalls = 0;
global.fetch = async (url, options) => {{
  fetchCalls.push({{ url, method: options.method, body: options.body || null }});
  if (url === '/api/team/connectors' && options.method === 'GET') {{
    const data = connectorSnapshots[Math.min(connectorIndex, connectorSnapshots.length - 1)];
    connectorIndex += 1;
    return {{ ok: true, status: 200, statusText: 'OK', async text() {{ return JSON.stringify(data); }} }};
  }}
  if (url === '/api/team/employees' && options.method === 'GET') {{
    employeeCalls += 1;
    return {{ ok: true, status: 200, statusText: 'OK', async text() {{ return JSON.stringify({{ employees: [
      {{ employee_id: 'emp_seed', display_name: '种子员工', status: 'active' }},
      {{ employee_id: 'emp_backend', display_name: '后端同步员工', status: 'active' }},
      {{ employee_id: 'emp_extra', display_name: '扩展员工', status: 'paused' }},
    ] }}); }} }};
  }}
  if (url === '/api/team/connectors' && options.method === 'POST') {{
    createPayload = JSON.parse(options.body || '{{}}');
    return {{ ok: true, status: 201, statusText: 'Created', async text() {{ return JSON.stringify({{ connector_id: 'conn_new', status: 'draft', credential_state: 'configured' }}); }} }};
  }}
  if (url === '/api/team/connectors/conn_truth' && options.method === 'GET') {{
    detailCalls += 1;
    const index = detailCalls === 1 ? 0 : 2;
    return {{ ok: true, status: 200, statusText: 'OK', async text() {{ return JSON.stringify(connectorSnapshots[index].items[0]); }} }};
  }}
  if (url === '/api/team/connectors/conn_truth' && options.method === 'PATCH') {{
    updatePayload = JSON.parse(options.body || '{{}}');
    return {{ ok: true, status: 200, statusText: 'OK', async text() {{ return JSON.stringify({{ connector_id: 'conn_truth', status: 'draft', credential_state: 'rotated' }}); }} }};
  }}
  if (url === '/api/team/connectors/conn_truth/grants' && options.method === 'PATCH') {{
    grantPayload = JSON.parse(options.body || '{{}}');
    return {{ ok: true, status: 200, statusText: 'OK', async text() {{ return JSON.stringify({{ granted: [{{ binding_id: 'bind_backend', employee_id: 'emp_backend' }}], revoked: ['bind_seed'], errors: [] }}); }} }};
  }}
  if (url === '/api/team/connectors/conn_truth/test' && options.method === 'POST') {{
    testCalls += 1;
    return {{ ok: true, status: 200, statusText: 'OK', async text() {{ return JSON.stringify({{ connector_id: 'conn_truth', result: 'passed', status: 'online' }}); }} }};
  }}
  if (url === '/api/team/connectors/conn_truth/status' && options.method === 'GET') {{
    statusCalls += 1;
    return {{ ok: true, status: 200, statusText: 'OK', async text() {{ return JSON.stringify({{
      connector_id: 'conn_truth',
      status: 'online',
      credential_state: 'rotated',
      updated_at: '2026-06-07T00:00:00Z',
      last_test_result: {{
        result: 'passed',
        checked_at: '2026-06-07T00:00:00Z',
        checked_by: 'user_status',
        error_code: '',
        message: 'status poll refreshed',
        log_ref: 'audit://connector-status/1',
      }},
    }}); }} }};
  }}
  return {{ ok: false, status: 500, statusText: 'Error', async text() {{ return JSON.stringify({{ error: 'Unexpected call', url }}); }} }};
}};
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(roleStateSource, {{ filename: 'role-state.js' }});
aiteam.role.setActiveRole({json.dumps(role)});
vm.runInThisContext(moduleSource, {{ filename: 'admin-connectors.js' }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.pages.adminConnectors.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const initialHtml = container.innerHTML;
  await container.lastUpdateHandler('conn_truth', {{
    name: 'Slack Connector',
    config: {{ tenant_hint: 'acme-updated', channel: '#ops' }},
    credential_input: {{ mode: 'opaque_ref', credential_ref: 'cred://vault/slack/updated' }},
  }});
  await new Promise((resolve) => setImmediate(resolve));
  const afterUpdateHtml = container.innerHTML;
  await container.lastCreateHandler({{
    definition_id: 'def_slack_webhook',
    name: '公司 Slack',
    provider_code: 'slack',
    connector_type: 'webhook_target',
    config: {{ tenant_hint: 'acme', channel: '#sales' }},
    credential_input: {{ mode: 'opaque_ref', credential_ref: 'cred://enterprise/new' }},
  }});
  await new Promise((resolve) => setImmediate(resolve));
  await container.lastGrantHandler('conn_truth', {{
    grant: [{{ employee_ids: ['emp_backend', 'emp_extra'], access_mode: 'invoke' }}],
    revoke: [{{ binding_id: 'bind_seed' }}],
  }});
  await new Promise((resolve) => setImmediate(resolve));
  const afterGrantHtml = container.innerHTML;
  await container.lastTestHandler('conn_truth', {{ mode: 'manual', dry_run: false }});
  await new Promise((resolve) => setImmediate(resolve));
  const afterTestHtml = container.innerHTML;
  await container.lastStatusHandler('conn_truth');
  await new Promise((resolve) => setImmediate(resolve));
  const afterStatusHtml = container.innerHTML;
  console.log(JSON.stringify({{
    fetchCalls,
    employeeCalls,
    detailCalls,
    createPayload,
    updatePayload,
    grantPayload,
    testCalls,
    statusCalls,
    initialHtml,
    afterUpdateHtml,
    afterGrantHtml,
    afterTestHtml,
    afterStatusHtml,
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


def test_admin_connectors_page_exists() -> None:
    assert PAGE_PATH.exists(), f"Missing admin-connectors page: {PAGE_PATH}"


def test_admin_connectors_source_uses_contract_fields() -> None:
    source = _page_source()
    for snippet in [
        "credential_mask",
        "credential_state",
        "last_test_result",
        "employee_grants",
        "getConnector",
        "updateConnector",
        "getConnectorStatus",
        "credential_input",
        "connector-definition",
        "grant-checkbox",
    ]:
        assert snippet in source, f"Missing B05 contract snippet: {snippet}"
    assert "window.prompt" not in source, "page must not use prompt-based grant UX"


def test_admin_connectors_runtime_flow_masks_and_refreshes_truthfully() -> None:
    result = _run_page_node()
    assert result["employeeCalls"] == 1
    assert result["detailCalls"] == 2
    assert result["updatePayload"]["credential_input"]["credential_ref"] == "cred://vault/slack/updated"
    assert "credential_ref" not in result["updatePayload"]
    assert result["createPayload"]["credential_input"]["credential_ref"] == "cred://enterprise/new"
    assert "credential_ref" not in result["createPayload"]
    assert result["grantPayload"]["revoke"] == [{"binding_id": "bind_seed"}]
    assert result["testCalls"] == 1
    assert result["statusCalls"] == 1

    initial_html = result["initialHtml"]
    assert "凭据显示" in initial_html
    assert "凭据引用" not in initial_html
    assert "cred://vault/slack/ent_test" not in initial_html
    assert "bot_secret: hidden" not in initial_html
    assert "bot_secret: ****" in initial_html
    assert "最近一次连接测试通过" in initial_html
    assert "Slack Webhook" in initial_html
    assert "受控输入" in initial_html
    assert "种子员工" in initial_html
    assert "保存详情" in initial_html

    after_update_html = result["afterUpdateHtml"]
    assert "已轮换" in after_update_html
    assert "草稿" in after_update_html
    assert "#ops" in after_update_html
    assert "等待复测" in after_update_html
    assert "cred://vault/slack/updated" not in after_update_html

    after_grant_html = result["afterGrantHtml"]
    assert "后端同步员工" in after_grant_html
    assert "种子员工</span><span class=\"aiteam-shell__meta-value\">emp_seed · 仅调用" not in after_grant_html

    after_test_html = result["afterTestHtml"]
    assert "rechecked from backend" in after_test_html
    assert "2026-06-06T00:00:00Z" in after_test_html

    after_status_html = result["afterStatusHtml"]
    assert "已轮换待复测" in after_status_html
    assert "status poll refreshed" in after_status_html


def test_admin_connectors_member_sees_permission_denied() -> None:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const roleStateSource = fs.readFileSync({json.dumps(str(ROLE_STATE_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(roleStateSource, {{ filename: 'role-state.js' }});
aiteam.role.setActiveRole('member');
vm.runInThisContext(moduleSource, {{ filename: 'admin-connectors.js' }});
const container = {{ innerHTML: '' }};
aiteam.pages.adminConnectors.init(container);
console.log(JSON.stringify({{ html: container.innerHTML }}));
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    result = json.loads(completed.stdout)
    assert "您没有权限访问此内容" in result["html"]
