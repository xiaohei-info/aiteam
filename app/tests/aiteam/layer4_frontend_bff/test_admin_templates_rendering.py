from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PAGE_SHELL = ROOT / "static" / "aiteam" / "page-shell.js"
API_CLIENT = ROOT / "static" / "aiteam" / "api-client.js"
PAGE = ROOT / "static" / "aiteam" / "pages" / "admin-templates.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_page_shell_registers_b03_admin_templates_route() -> None:
    source = _read(PAGE_SHELL)
    assert "'/admin/templates'" in source or '"/admin/templates"' in source
    assert "admin-templates.js" in source


def test_api_client_exposes_enterprise_template_aliases() -> None:
    source = _read(API_CLIENT)
    assert "getAdminTemplates(" in source
    assert "return this.get('/templates'" in source
    assert "getAdminTemplate(" in source
    assert "return this.get(`/templates/${encodeURIComponent(templateId)}`" in source


def test_admin_templates_page_renders_template_list_and_recruit_action() -> None:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE))}, 'utf8');
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
  if (url === '/api/team/templates' && options.method === 'GET') {{
    return {{
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {{ return JSON.stringify({{
        items: [
          {{ template_id: 'tpl_marketing', name: '营销分析师', role: 'marketing_analyst', category: 'marketing', description: '负责营销分析', recruit_count: 3, is_recruited: true }},
          {{ template_id: 'tpl_finance', name: '财务顾问', role: 'finance_advisor', category: 'finance', description: '负责财务分析', recruit_count: 0, is_recruited: false }}
        ],
        total: 2
      }}); }},
    }};
  }}
  if (url === '/api/team/recruitments' && options.method === 'POST') {{
    return {{
      ok: true,
      status: 201,
      statusText: 'Created',
      async text() {{ return JSON.stringify({{ order_id: 'ord_1', employee_id: 'emp_new', navigation: {{ workbench: '/app/workbench' }} }}); }},
    }};
  }}
  return {{ ok: false, status: 404, statusText: 'Not Found', async text() {{ return JSON.stringify({{ error: 'Not Found' }}); }} }};
}};
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
global.window.aiteam.states = {{
  renderLoading(container) {{ container.innerHTML = '<div>loading</div>'; }},
  handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
}};
vm.runInThisContext(moduleSource, {{ filename: 'admin-templates.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.adminTemplates.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{ html: container.innerHTML }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    payload = json.loads(completed.stdout)
    assert "人才市场" in payload["html"]
    assert "营销分析师" in payload["html"]
    assert "财务顾问" in payload["html"]
    assert "查看专家详情" in payload["html"]
    assert "立即招募" in payload["html"]
