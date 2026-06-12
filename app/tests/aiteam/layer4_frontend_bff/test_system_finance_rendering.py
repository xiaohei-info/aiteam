from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "system-finance.js"


def _run_system_finance() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
global.window = {{
  aiteam: {{
    pages: {{}},
    states: {{
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
      renderEmpty(container, message) {{ container.innerHTML = '<div>' + message + '</div>'; }},
    }},
    api: {{
      get(url) {{
        if (url === '/api/system-admin/finance/overview') {{
          return Promise.resolve({{
            ok: true,
            data: {{
              summary: {{
                total_revenue: 486200,
                total_cost: 299800,
                total_profit: 186400,
                paying_enterprise_count: 876,
              }},
              trend: [
                {{ period: '2026-01', revenue: 120000, cost: 80000 }},
                {{ period: '2026-02', revenue: 140000, cost: 86000 }},
                {{ period: '2026-03', revenue: 226200, cost: 133800 }},
              ],
              top_enterprises: [
                {{ enterprise_name: '太乙知行AI科技', cost: 5000 }},
                {{ enterprise_name: '豪恩声学', cost: 2000 }},
              ],
            }},
          }});
        }}
        return Promise.resolve({{ ok: false, status: 404 }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'system-finance.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.systemFinance.init(container);
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


def _run_system_finance_export_flow() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
const assignedUrls = [];
const overviewCalls = [];
global.window = {{
  location: {{
    assign(url) {{ assignedUrls.push(url); }},
  }},
  aiteam: {{
    pages: {{}},
    states: {{
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
      renderEmpty(container, message) {{ container.innerHTML = '<div>' + message + '</div>'; }},
    }},
    api: {{
      get(url) {{
        overviewCalls.push(url);
        if (url.indexOf('/api/system-admin/finance/overview') === 0) {{
          return Promise.resolve({{
            ok: true,
            data: {{
              summary: {{
                total_revenue: 486200,
                total_cost: 299800,
                total_profit: 186400,
                paying_enterprise_count: 876,
              }},
              trend: [
                {{ period: '2026-01', revenue: 120000, cost: 80000 }},
                {{ period: '2026-02', revenue: 140000, cost: 86000 }},
                {{ period: '2026-03', revenue: 226200, cost: 133800 }},
              ],
              top_enterprises: [
                {{ enterprise_name: '太乙知行AI科技', cost: 5000 }},
                {{ enterprise_name: '豪恩声学', cost: 2000 }},
              ],
            }},
          }});
        }}
        return Promise.resolve({{ ok: false, status: 404 }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'system-finance.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.systemFinance.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const beforeHtml = container.innerHTML;
  const lastExportUrl = container.lastExportHandler();
  console.log(JSON.stringify({{
    beforeHtml,
    afterHtml: container.innerHTML,
    lastExportUrl,
    assignedUrls,
    overviewCalls,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def test_system_finance_renders_core_stat_cards_trend_and_top_enterprises() -> None:
    payload = _run_system_finance()
    assert "总充值金额" in payload["html"]
    assert "平台成本" in payload["html"] or "平台成本Token" in payload["html"]
    assert "平台利润" in payload["html"] or "利润（Token差价）" in payload["html"]
    assert "利润率" in payload["html"]
    assert "付费企业数" in payload["html"]
    assert "本月" in payload["html"]
    assert "本年" in payload["html"]
    assert "全部" in payload["html"]
    assert "月度收入趋势" in payload["html"]
    assert "充值收入" in payload["html"]
    assert "实际成本" in payload["html"]
    assert "TOP 5 消费企业" in payload["html"]
    assert "太乙知行AI科技" in payload["html"]
    assert 'href="/system/accounts?enterprise=%E5%A4%AA%E4%B9%99%E7%9F%A5%E8%A1%8CAI%E7%A7%91%E6%8A%80"' in payload["html"]


def test_system_finance_exposes_export_report_entry() -> None:
    payload = _run_system_finance_export_flow()
    assert "导出报表" in payload["beforeHtml"]
    assert payload["lastExportUrl"] == "/api/system-admin/finance/reports"
    # export now fetches the report data and downloads CSV client-side
    assert "/api/system-admin/finance/reports" in payload["overviewCalls"]
