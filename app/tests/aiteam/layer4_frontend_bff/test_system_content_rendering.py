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


def _run_system_templates_preview_flow() -> dict:
    page_path = PAGES_DIR / "system-templates.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(page_path))}, 'utf8');
function makeButton(templateId) {{
  return {{
    listeners: {{}},
    getAttribute(name) {{
      if (name === 'data-aiteam-template-id') return templateId;
      if (name === 'data-aiteam-action') return 'preview';
      return null;
    }},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{
      if (this.listeners.click) this.listeners.click.call(this, {{ currentTarget: this, preventDefault() {{}} }});
    }},
  }};
}}
const previewButtons = [makeButton('tpl_marketing'), makeButton('tpl_finance')];
global.window = {{
  aiteam: {{
    pages: {{}},
    states: {{
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      get(url) {{
        if (url === '/api/system-admin/templates') {{
          return Promise.resolve({{
            ok: true,
            data: {{
              items: [
                {{
                  template_id: 'tpl_marketing',
                  name: '营销分析师',
                  role_name: 'marketing_analyst',
                  status: 'published',
                  version_no: 6,
                  recruit_count: 18,
                  description: '擅长品牌增长与投放复盘',
                  tags: ['营销', '增长'],
                  default_model: 'gpt-4o',
                }},
                {{
                  template_id: 'tpl_finance',
                  name: '财务顾问',
                  role_name: 'finance_advisor',
                  status: 'draft',
                  version_no: 3,
                  recruit_count: 4,
                  description: '擅长预算分析与利润测算',
                  tags: ['财务', '预算'],
                  default_model: 'gpt-4.1',
                }},
              ],
            }},
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
vm.runInThisContext(moduleSource, {{ filename: 'system-templates.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector(selector) {{
      return null;
    }},
    querySelectorAll(selector) {{
      if (selector === 'button[data-aiteam-action][data-aiteam-template-id]') return previewButtons;
      return [];
    }},
  }};
  aiteam.pages.systemTemplates.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const initialHtml = container.innerHTML;
  previewButtons[0].click();
  const firstPreviewHtml = container.innerHTML;
  previewButtons[1].click();
  const secondPreviewHtml = container.innerHTML;
  console.log(JSON.stringify({{
    initialHtml,
    firstPreviewHtml,
    secondPreviewHtml,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def _run_system_solutions_preview_flow() -> dict:
    page_path = PAGES_DIR / "system-solutions.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(page_path))}, 'utf8');
function makeCardButton(solutionId) {{
  return {{
    listeners: {{}},
    getAttribute(name) {{
      if (name === 'data-aiteam-solution-preview') return solutionId;
      return null;
    }},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{
      if (this.listeners.click) this.listeners.click.call(this, {{ currentTarget: this, preventDefault() {{}} }});
    }},
  }};
}}
const previewButtons = [makeCardButton('sol_retail'), makeCardButton('sol_finance')];
global.window = {{
  aiteam: {{
    pages: {{}},
    states: {{
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      get(url) {{
        if (url === '/api/system-admin/solutions') {{
          return Promise.resolve({{
            ok: true,
            data: {{
              items: [
                {{
                  solution_id: 'sol_retail',
                  name: '零售方案',
                  status: 'published',
                  icon: '🛍️',
                  description: '覆盖门店运营、销售分析与复购增长',
                  template_ids: ['tpl_ops', 'tpl_sales'],
                  template_count: 2,
                  apply_count: 12,
                  tags: ['零售', '增长'],
                }},
                {{
                  solution_id: 'sol_finance',
                  name: '财务方案',
                  status: 'draft',
                  icon: '📊',
                  description: '覆盖预算分析、利润测算与经营看板',
                  template_ids: ['tpl_finance'],
                  template_count: 1,
                  apply_count: 5,
                  tags: ['财务', '预算'],
                }},
              ],
            }},
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
vm.runInThisContext(moduleSource, {{ filename: 'system-solutions.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll(selector) {{
      if (selector === '[data-aiteam-solution-preview]') return previewButtons;
      return [];
    }},
  }};
  aiteam.pages.systemSolutions.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const initialHtml = container.innerHTML;
  previewButtons[0].click();
  const firstPreviewHtml = container.innerHTML;
  previewButtons[1].click();
  const secondPreviewHtml = container.innerHTML;
  console.log(JSON.stringify({{
    initialHtml,
    firstPreviewHtml,
    secondPreviewHtml,
  }}));
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
    assert "版本" in payload["html"]
    assert "招募数" in payload["html"]


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
    assert "编辑方案" in payload["html"]  # 专家绑定已并入编辑抽屉，不再有独立「绑定模板」
    assert "应用数" in payload["html"]
    assert "拖拽排序" not in payload["html"]  # 假交互已移除


def test_system_templates_preview_switches_between_template_profiles() -> None:
    payload = _run_system_templates_preview_flow()
    assert "预览效果：当前页面已保留产品位" not in payload["firstPreviewHtml"]
    assert "用户端预览" in payload["firstPreviewHtml"]
    assert "营销分析师" in payload["firstPreviewHtml"]
    assert "擅长品牌增长与投放复盘" in payload["firstPreviewHtml"]
    assert "gpt-4o" in payload["firstPreviewHtml"]
    assert "财务顾问" in payload["secondPreviewHtml"]
    assert "擅长预算分析与利润测算" in payload["secondPreviewHtml"]
    assert "gpt-4.1" in payload["secondPreviewHtml"]


def test_system_templates_preview_uses_flattened_field_fallbacks() -> None:
    payload = _run_page(
        "system-templates.js",
        "/api/system-admin/templates",
        {
            "items": [
                {
                    "template_id": "tpl_ops",
                    "name": "运营专家",
                    "role_name": "ops_specialist",
                    "status": "published",
                    "version_no": 2,
                    "prompt_pack": {"description": "负责 SOP 执行与流程巡检"},
                    "default_model_ref": {"provider": "openai", "model": "gpt-4.1-mini"},
                    "tags": ["运营"],
                }
            ]
        },
    )
    assert "负责 SOP 执行与流程巡检" in payload["html"]
    assert "gpt-4.1-mini" in payload["html"]


def test_system_solutions_preview_switches_between_solution_cards() -> None:
    payload = _run_system_solutions_preview_flow()
    assert "预览效果：当前页面已保留产品位" not in payload["firstPreviewHtml"]
    assert "方案详情" in payload["firstPreviewHtml"]
    assert "零售方案" in payload["firstPreviewHtml"]
    assert "覆盖门店运营、销售分析与复购增长" in payload["firstPreviewHtml"]
    # 详情按专家名渲染成独立 chip（无 templates 时回退为 ID）+ 编排规则成块展示。
    assert "tpl_ops" in payload["firstPreviewHtml"]
    assert "tpl_sales" in payload["firstPreviewHtml"]
    assert "协作编排规则" in payload["firstPreviewHtml"]
    assert "财务方案" in payload["secondPreviewHtml"]
    assert "覆盖预算分析、利润测算与经营看板" in payload["secondPreviewHtml"]
    assert "tpl_finance" in payload["secondPreviewHtml"]
