from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PAGES_DIR = ROOT / "static" / "aiteam" / "pages"


def _run_page(page_name: str, api_path: str, payload: dict) -> dict:
    page_path = PAGES_DIR / page_name
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(page_path))}, 'utf8');
global.window = {{
  aiteam: {{
    pages: {{}},
    states: {{
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      get(url) {{
        if (url === {json.dumps(api_path)}) {{
          return Promise.resolve({{
            ok: true,
            data: {json.dumps(payload, ensure_ascii=False)},
          }});
        }}
        return Promise.resolve({{ ok: false, status: 404 }});
      }},
      post() {{ return Promise.resolve({{ ok: true, data: {{}} }}); }},
      patch() {{ return Promise.resolve({{ ok: true, data: {{}} }}); }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: {json.dumps(page_name)} }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  const handler = {json.dumps('systemTemplates' if page_name == 'system-templates.js' else 'systemSolutions')};
  aiteam.pages[handler].init(container);
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


def test_system_templates_renders_preview_clone_and_publish_record_controls() -> None:
    payload = _run_page(
        "system-templates.js",
        "/api/system-admin/templates",
        {
            "items": [
                {
                    "template_id": "tpl_marketing",
                    "name": "营销分析师",
                    "role_name": "marketing_analyst",
                    "status": "published",
                    "version_no": 6,
                    "recruit_count": 18,
                }
            ]
        },
    )
    assert "预览效果" in payload["html"]
    assert "克隆" in payload["html"]
    assert "发布记录" in payload["html"]


def test_system_solutions_renders_industry_cards_sorting_slot_and_apply_stats() -> None:
    payload = _run_page(
        "system-solutions.js",
        "/api/system-admin/solutions",
        {
            "items": [
                {
                    "solution_id": "sol_retail",
                    "name": "零售方案",
                    "status": "published",
                    "template_ids": ["tpl_ops", "tpl_sales"],
                    "template_count": 2,
                    "apply_count": 12,
                }
            ]
        },
    )
    assert "9个行业卡片" in payload["html"]
    assert "拖拽排序" in payload["html"]
    assert "应用统计" in payload["html"]
