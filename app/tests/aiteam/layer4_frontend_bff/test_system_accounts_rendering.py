from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "system-accounts.js"
API_CLIENT_PATH = ROOT / "static" / "aiteam" / "api-client.js"
STATE_HELPERS_PATH = ROOT / "static" / "aiteam" / "state-helpers.js"
ROLE_STATE_PATH = ROOT / "static" / "aiteam" / "role-state.js"


def _run_system_accounts() -> dict:
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
global.fetch = async (url, options) => {{
  fetchCalls.push({{ url, method: (options && options.method) || 'GET' }});
  if (url === '/api/system-admin/enterprises') {{
    return {{
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {{ return JSON.stringify({{
        enterprises: [
          {{ enterprise_id: 'ent_1', name: '太乙知行AI科技', status: 'active', plan: 'pro', balance: 5000, owner_name: '荆超', owner_phone: '138****8888', total_recharged: 5000, total_tokens_used: 8400000, created_at: '2026-01-15', last_active_at: '2026-06-09' }},
          {{ enterprise_id: 'ent_2', name: '豪恩声学', status: 'active', plan: 'basic', balance: 2000, owner_name: '张经理', owner_phone: '139****0001', total_recharged: 2000, total_tokens_used: 3200000, created_at: '2026-02-20', last_active_at: '2026-06-08' }},
          {{ enterprise_id: 'ent_3', name: '示例企业C', status: 'suspended', plan: 'starter', balance: 100, owner_name: '李总', owner_phone: '137****5566', total_recharged: 100, total_tokens_used: 100000, created_at: '2026-03-05', last_active_at: '2026-05-20' }},
        ],
        total: 3,
        page: 1,
        limit: 20,
        has_more: false,
      }}); }},
    }};
  }}
  if (url === '/api/system-admin/enterprises/ent_1') {{
    return {{
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {{ return JSON.stringify({{
        id: 'ent_1',
        name: '太乙知行AI科技',
        slug: 'taiyi',
        status: 'active',
        owner_user_id: 'usr_1',
        created_at: '2026-01-15',
      }}); }},
    }};
  }}
  if (url === '/api/system-admin/enterprises/ent_1/quota') {{
    return {{
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {{ return JSON.stringify({{
        id: 'ent_1',
        employee_quota: 120,
        storage_quota_mb: 2048,
        api_rate_limit: 300,
      }}); }},
    }};
  }}
  if (url === '/api/system-admin/enterprises/export') {{
    return {{
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {{ return JSON.stringify({{
        items: [
          {{ id: 'ent_1', name: '太乙知行AI科技', status: 'active' }},
          {{ id: 'ent_2', name: '豪恩声学', status: 'active' }},
        ],
        total: 2,
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
vm.runInThisContext(moduleSource, {{ filename: 'system-accounts.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.role.setActiveRole('system_admin');
  aiteam.pages.systemAccounts.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{ html: container.innerHTML, fetchCalls }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def test_system_accounts_renders_stat_cards_search_and_detail_region() -> None:
    payload = _run_system_accounts()
    assert {"url": "/api/system-admin/enterprises", "method": "GET"} in payload["fetchCalls"]
    assert {"url": "/api/system-admin/enterprises/ent_1", "method": "GET"} in payload["fetchCalls"]
    assert {"url": "/api/system-admin/enterprises/ent_1/quota", "method": "GET"} in payload["fetchCalls"]
    assert {"url": "/api/system-admin/enterprises/export", "method": "GET"} in payload["fetchCalls"]
    assert "总企业数" in payload["html"]
    assert "本月新增" in payload["html"]
    assert "月活企业" in payload["html"]
    assert "总充值" in payload["html"]
    assert "搜索企业名称/手机号" in payload["html"]
    assert "搜索企业名称/手机号/邮箱" in payload["html"]
    assert "注册时间范围" in payload["html"]
    assert "欠费" in payload["html"]
    assert "企业账号详情" in payload["html"]
    assert "基本信息" in payload["html"]
    assert "充值记录" in payload["html"]
    assert "员工列表" in payload["html"]
    assert "Token消耗历史" in payload["html"]
    assert "太乙知行AI科技" in payload["html"]
    assert "企业配额" in payload["html"]
    assert "员工上限" in payload["html"]
    assert "导出视图" in payload["html"]
    assert "导出 Excel" in payload["html"]
