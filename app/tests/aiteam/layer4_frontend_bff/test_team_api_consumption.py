from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
API_CLIENT_PATH = ROOT / "static" / "aiteam" / "api-client.js"


def _client_source() -> str:
    return API_CLIENT_PATH.read_text(encoding="utf-8")


def _run_node(path: str) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const calls = [];
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
  calls.push({{ url, method: options.method, headers: Array.from(options.headers.map.entries()) }});
  return {{
    ok: true,
    status: 200,
    async text() {{ return JSON.stringify({{ ok: true }}); }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(source, {{ filename: 'api-client.js' }});
(async () => {{
  const path = {json.dumps(path)};
  const result = await aiteam.api.get(path);
  console.log(JSON.stringify({{
    result,
    call: calls[0],
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


def test_api_client_file_exists() -> None:
    assert API_CLIENT_PATH.exists(), f"Missing API client: {API_CLIENT_PATH}"


def test_api_client_uses_team_api_prefix() -> None:
    source = _client_source()
    assert "BASE: '/api/team'" in source
    assert "_buildUrl(path)" in source
    assert "return this.BASE + requestPath;" in source


def test_api_client_does_not_call_runtime_routes() -> None:
    source = _client_source()
    banned_routes = [
        '/api/session/',
        '/api/sessions',
        '/api/chat/start',
        '/api/chat/cancel',
        '/api/runtime',
        '/api/kanban',
    ]
    for route in banned_routes:
        assert route not in source, f"Found forbidden runtime/private route reference: {route}"


def test_api_client_exposes_team_panel_endpoint_helpers() -> None:
    source = _client_source()
    expected_snippets = [
        "return this.get('/workbench'",
        "return this.post('/workbench/state'",
        "return this.get('/talent-market/templates'",
        "return this.post('/recruitments'",
        "return this.get(`/conversations/${encodeURIComponent(conversationId)}`",
        "return this.get(`/group-conversations/${encodeURIComponent(conversationId)}`",
        "return this.post(`/group-conversations/${encodeURIComponent(conversationId)}/messages`",
        "return this.post('/runs'",
        "return this.post(`/runs/${encodeURIComponent(runId)}/retry`",
        "return this.post(`/runs/${encodeURIComponent(runId)}/abort`",
        "return fetch(`${this.BASE}/runs/${encodeURIComponent(runId)}/stream?cursor=${value}`)",
        "return this.get(",
        "`/runs/${encodeURIComponent(runId)}/events?cursor=${eventCursor}&limit=${pageLimit}`",
        "return this.post('/uploads'",
        "return this.get('/employees'",
        "return this.get(`/employees/${encodeURIComponent(employeeId)}`",
        "return this.patch(`/employees/${encodeURIComponent(employeeId)}`",
    ]
    for snippet in expected_snippets:
        assert snippet in source, f"Missing expected API helper snippet: {snippet}"


def test_api_client_normalizes_response_shape() -> None:
    source = _client_source()
    assert 'ok: res.ok' in source
    assert 'status: res.status' in source
    assert 'data,' in source or 'data: data' in source
    assert 'error,' in source or 'error: err' in source


def test_api_client_prefixes_team_panel_routes_at_runtime() -> None:
    result = _run_node('/workbench')
    assert result['result']['ok'] is True
    assert result['call']['url'] == '/api/team/workbench'
    assert result['call']['method'] == 'GET'


def test_api_client_preserves_enterprise_admin_routes_at_runtime() -> None:
    result = _run_node('/api/enterprise-admin/employees')
    assert result['result']['ok'] is True
    assert result['call']['url'] == '/api/enterprise-admin/employees'


def test_api_client_preserves_system_admin_routes_at_runtime() -> None:
    result = _run_node('/api/system-admin/health')
    assert result['result']['ok'] is True
    assert result['call']['url'] == '/api/system-admin/health'
