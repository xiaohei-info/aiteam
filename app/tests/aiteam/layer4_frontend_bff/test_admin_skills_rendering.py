from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "admin-skills.js"


def _run_admin_skills() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
const apiCalls = [];
global.window = {{
  aiteam: {{
    pages: {{}},
    api: {{
      getSkillCatalog(options) {{
        const q = (options && options.query) || {{}};
        apiCalls.push({{ method: 'GET', url: '/api/team/skills/catalog', query: q }});
        return Promise.resolve({{ ok: true, data: {{
          items: [
            {{ skill_code: 'skill_excel', display_name: 'Excel分析', description: '处理表格', source_marketplace: 'skillhub', version: '1.2.0', latest_version: '1.3.0', update_available: true, install_count: 42, tags: ['分析', '表格'], authorization_scope: 'employee_grant' }},
          ],
          total: 2,
          page: q.page || 1,
          page_size: q.page_size || 12,
          sources: [
            {{ source_marketplace: 'skillhub', count: 14 }},
            {{ source_marketplace: 'clawhub', count: 6 }},
          ],
        }} }});
      }},
      getSkillInstalls() {{
        apiCalls.push({{ method: 'GET', url: '/api/team/skills/installs' }});
        return Promise.resolve({{ ok: true, data: {{ items: [
          {{ install_id: 'inst_1', skill_id: 'skill_excel', name: 'Excel分析', version: '1.2.0', latest_version: '1.3.0', update_available: true, source: 'skillhub', visibility: 'enterprise', audit_status: 'skill.install', granted_employee_ids: ['emp_1'], grants: [{{ employee_id: 'emp_1', enabled: true }}] }},
        ] }} }});
      }},
      installSkill(payload) {{
        apiCalls.push({{ method: 'POST', url: '/api/team/skills/installs', payload }});
        return Promise.resolve({{ ok: true, data: {{ skill_id: payload.skill_code, name: '联网搜索', source: 'clawhub', version: '0.9.0', granted_employee_ids: payload.employee_ids || [] }} }});
      }},
      patchSkillInstall() {{
        return Promise.resolve({{ ok: true, data: {{}} }});
      }},
      deleteSkillInstall() {{
        return Promise.resolve({{ ok: true, data: {{}} }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-skills.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.adminSkills.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{ html: container.innerHTML, apiCalls }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def test_admin_skills_renders_tabs_and_installed_management() -> None:
    payload = _run_admin_skills()
    # Default 已安装 tab: load installs, then a cheap facet probe for the tab bar.
    assert payload["apiCalls"][0] == {"method": "GET", "url": "/api/team/skills/installs"}
    assert payload["apiCalls"][1]["url"] == "/api/team/skills/catalog"
    assert "技能市场" in payload["html"]
    # Marketplace tabs replace the old side-by-side internal/external mix.
    assert "aiteam-skill-tab" in payload["html"]
    assert "已安装" in payload["html"]
    assert "skillhub.io" in payload["html"]
    assert "clawhub.io" in payload["html"]
    # Installed-skill management cards live on the 已安装 tab.
    assert "升级到最新" in payload["html"]
    assert "编辑授权员工" in payload["html"]
    assert "审计状态：skill.install" in payload["html"]
    assert "后端未返回安装审计字段" not in payload["html"]
    # Install-scope controls belong to the market tabs, not the installed tab.
    assert "安装时配置授权范围" not in payload["html"]
