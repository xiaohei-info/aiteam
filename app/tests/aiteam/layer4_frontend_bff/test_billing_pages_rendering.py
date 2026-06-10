from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PAGES_DIR = ROOT / "static" / "aiteam" / "pages"


def _run_admin_billing() -> dict:
    page_path = PAGES_DIR / "admin-billing.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(page_path))}, 'utf8');
global.window = {{
  aiteam: {{
    pages: {{}},
    role: {{
      getActiveRole() {{ return 'owner'; }},
      canExportBilling() {{ return true; }},
    }},
    states: {{
      renderLoading(container) {{ container.innerHTML = '<div>loading</div>'; }},
      renderPermissionDenied(container) {{ container.innerHTML = '<div>denied</div>'; }},
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      getBillingUsageOverview() {{
        return Promise.resolve({{
          ok: true,
          data: {{
            total_tokens: 2847320,
            total_cost_cents: 39860,
            period_start: '2026-06-01',
            period_end: '2026-06-30',
            by_employee: [
              {{ employee_id: 'emp_marketing', display_name: '营销分析师', tokens: 1234560, cost_cents: 12840 }},
              {{ employee_id: 'emp_finance', display_name: '财务顾问', tokens: 892000, cost_cents: 8920 }},
            ],
          }},
        }});
      }},
      getBillingUsageRecords() {{
        return Promise.resolve({{
          ok: true,
          data: {{
            total: 3,
            items: [
              {{ employee_id: 'emp_marketing', display_name: '营销分析师', run_id: 'run_1', tokens: 420000, cost_cents: 4200, source: 'run_summary', event_ts: '2026-06-03T10:00:00Z' }},
              {{ employee_id: 'emp_marketing', display_name: '营销分析师', run_id: 'run_2', tokens: 380000, cost_cents: 3840, source: 'run_summary', event_ts: '2026-06-10T10:00:00Z' }},
              {{ employee_id: 'emp_finance', display_name: '财务顾问', run_id: 'run_3', tokens: 300000, cost_cents: 3020, source: 'run_summary', event_ts: '2026-06-18T10:00:00Z' }},
            ],
          }},
        }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-billing.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
  }};
  aiteam.pages.adminBilling.init(container);
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


def _run_admin_billing_export_flow() -> dict:
    page_path = PAGES_DIR / "admin-billing.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(page_path))}, 'utf8');
const assignedUrls = [];
const recordsQueries = [];
global.window = {{
  location: {{
    assign(url) {{ assignedUrls.push(url); }},
  }},
  aiteam: {{
    pages: {{}},
    role: {{
      getActiveRole() {{ return 'owner'; }},
      canExportBilling() {{ return true; }},
    }},
    states: {{
      renderLoading(container) {{ container.innerHTML = '<div>loading</div>'; }},
      renderPermissionDenied(container) {{ container.innerHTML = '<div>denied</div>'; }},
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      getBillingUsageOverview() {{
        return Promise.resolve({{
          ok: true,
          data: {{
            total_tokens: 2847320,
            total_cost_cents: 39860,
            period_start: '2026-06-01',
            period_end: '2026-06-30',
            by_employee: [
              {{ employee_id: 'emp_marketing', display_name: '营销分析师', tokens: 1234560, cost_cents: 12840 }},
              {{ employee_id: 'emp_finance', display_name: '财务顾问', tokens: 892000, cost_cents: 8920 }},
            ],
          }},
        }});
      }},
      getBillingUsageRecords(query) {{
        recordsQueries.push(query || '');
        return Promise.resolve({{
          ok: true,
          data: {{
            total: 2,
            items: [
              {{ employee_id: 'emp_marketing', display_name: '营销分析师', run_id: 'run_1', tokens: 420000, cost_cents: 4200, source: 'run_summary', event_ts: '2026-06-03T10:00:00Z' }},
              {{ employee_id: 'emp_finance', display_name: '财务顾问', run_id: 'run_3', tokens: 300000, cost_cents: 3020, source: 'run_summary', event_ts: '2026-06-18T10:00:00Z' }},
            ],
          }},
        }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-billing.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
  }};
  aiteam.pages.adminBilling.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const beforeHtml = container.innerHTML;
  await container.lastFilterHandler({{
    period_start: '2026-06-05',
    period_end: '2026-06-20',
    employee_id: 'emp_finance',
  }});
  await new Promise((resolve) => setImmediate(resolve));
  const exportUrl = container.lastExportHandler();
  console.log(JSON.stringify({{
    beforeHtml,
    afterHtml: container.innerHTML,
    exportUrl,
    assignedUrls,
    recordsQueries,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def _run_admin_billing_rank_expand_flow() -> dict:
    page_path = PAGES_DIR / "admin-billing.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(page_path))}, 'utf8');
function makeRankRow(employeeId) {{
  return {{
    listeners: {{}},
    getAttribute(name) {{
      if (name === 'data-employee-id') return employeeId;
      return null;
    }},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{
      if (this.listeners.click) this.listeners.click.call(this, {{ currentTarget: this, preventDefault() {{}} }});
    }},
  }};
}}
const rankRows = [makeRankRow('emp_marketing'), makeRankRow('emp_finance')];
global.window = {{
  aiteam: {{
    pages: {{}},
    role: {{
      getActiveRole() {{ return 'owner'; }},
      canExportBilling() {{ return true; }},
    }},
    states: {{
      renderLoading(container) {{ container.innerHTML = '<div>loading</div>'; }},
      renderPermissionDenied(container) {{ container.innerHTML = '<div>denied</div>'; }},
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      getBillingUsageOverview() {{
        return Promise.resolve({{
          ok: true,
          data: {{
            total_tokens: 2847320,
            total_cost_cents: 39860,
            period_start: '2026-06-01',
            period_end: '2026-06-30',
            by_employee: [
              {{ employee_id: 'emp_marketing', display_name: '营销分析师', tokens: 1234560, cost_cents: 12840 }},
              {{ employee_id: 'emp_finance', display_name: '财务顾问', tokens: 892000, cost_cents: 8920 }},
            ],
          }},
        }});
      }},
      getBillingUsageRecords() {{
        return Promise.resolve({{
          ok: true,
          data: {{
            total: 3,
            items: [
              {{ employee_id: 'emp_marketing', display_name: '营销分析师', run_id: 'run_1', tokens: 420000, cost_cents: 4200, source: 'run_summary', event_ts: '2026-06-03T10:00:00Z' }},
              {{ employee_id: 'emp_marketing', display_name: '营销分析师', run_id: 'run_2', tokens: 380000, cost_cents: 3840, source: 'run_summary', event_ts: '2026-06-10T10:00:00Z' }},
              {{ employee_id: 'emp_finance', display_name: '财务顾问', run_id: 'run_3', tokens: 300000, cost_cents: 3020, source: 'run_summary', event_ts: '2026-06-18T10:00:00Z' }},
            ],
          }},
        }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-billing.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll(selector) {{
      if (selector === '[data-role="billing-rank-row"]') return rankRows;
      return [];
    }},
  }};
  aiteam.pages.adminBilling.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const beforeHtml = container.innerHTML;
  rankRows[1].click();
  const afterHtml = container.innerHTML;
  console.log(JSON.stringify({{
    beforeHtml,
    afterHtml,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def _run_admin_recharge() -> dict:
    page_path = PAGES_DIR / "admin-recharge.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(page_path))}, 'utf8');
global.window = {{
  aiteam: {{
    pages: {{}},
    states: {{
      renderLoading(container) {{ container.innerHTML = '<div>loading</div>'; }},
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      get(url) {{
        if (url === '/api/team/billing/balance') {{
          return Promise.resolve({{
            ok: true,
            data: {{
              balance: '48.60',
              balance_cents: 4860,
              token_balance: 48600,
              estimated_days_remaining: 7,
              low_balance_warning: true,
              low_balance_threshold_cents: 5000,
              usage_summary: {{ total_tokens: 2847320, total_cost_cents: 39860 }},
            }},
          }});
        }}
        if (url === '/api/team/billing/recharges') {{
          return Promise.resolve({{
            ok: true,
            data: {{
              items: [
                {{ recharge_id: 'rch_1', amount: '100.00', amount_cents: 10000, payment_method: 'wechat_pay', status: 'succeeded', token_credited: 100000, created_at: '2026-06-01T10:00:00Z' }},
              ],
            }},
          }});
        }}
        return Promise.resolve({{ ok: false, status: 404 }});
      }},
      post() {{
        return Promise.resolve({{ ok: true, data: {{ recharge_id: 'rch_new' }} }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-recharge.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.adminRecharge.init(container);
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


def _run_admin_recharge_threshold_update() -> dict:
    page_path = PAGES_DIR / "admin-recharge.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(page_path))}, 'utf8');
const patchCalls = [];
let balanceResponse = {{
  balance: '48.60',
  balance_cents: 4860,
  token_balance: 48600,
  estimated_days_remaining: 7,
  low_balance_warning: true,
  low_balance_threshold_cents: 5000,
  warning_enabled: true,
  usage_summary: {{ total_tokens: 2847320, total_cost_cents: 39860 }},
}};
global.window = {{
  aiteam: {{
    pages: {{}},
    states: {{
      renderLoading(container) {{ container.innerHTML = '<div>loading</div>'; }},
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      get(url) {{
        if (url === '/api/team/billing/balance') {{
          return Promise.resolve({{ ok: true, data: balanceResponse }});
        }}
        if (url === '/api/team/billing/recharges') {{
          return Promise.resolve({{
            ok: true,
            data: {{
              items: [
                {{ recharge_id: 'rch_1', amount: '100.00', amount_cents: 10000, payment_method: 'wechat_pay', status: 'succeeded', token_credited: 100000, created_at: '2026-06-01T10:00:00Z' }},
              ],
            }},
          }});
        }}
        return Promise.resolve({{ ok: false, status: 404 }});
      }},
      post() {{
        return Promise.resolve({{ ok: true, data: {{ recharge_id: 'rch_new' }} }});
      }},
      patch(url, body) {{
        patchCalls.push({{ url, body }});
        balanceResponse = {{
          ...balanceResponse,
          low_balance_threshold_cents: body.low_balance_threshold_cents,
          warning_enabled: body.warning_enabled,
        }};
        return Promise.resolve({{ ok: true, data: {{ low_balance_threshold_cents: body.low_balance_threshold_cents, warning_enabled: body.warning_enabled }} }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-recharge.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.adminRecharge.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const beforeHtml = container.innerHTML;
  await container.lastWarningHandler({{ low_balance_threshold_cents: 8800, warning_enabled: true }});
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    beforeHtml,
    afterHtml: container.innerHTML,
    patchCalls,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def _run_admin_recharge_submit_flow(success: bool) -> dict:
    page_path = PAGES_DIR / "admin-recharge.js"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(page_path))}, 'utf8');
const apiCalls = [];
let balanceResponse = {{
  balance: '48.60',
  balance_cents: 4860,
  token_balance: 48600,
  estimated_days_remaining: 7,
  low_balance_warning: true,
  low_balance_threshold_cents: 5000,
  warning_enabled: true,
  usage_summary: {{ total_tokens: 2847320, total_cost_cents: 39860 }},
}};
let rechargeItems = [
  {{ recharge_id: 'rch_1', amount: '100.00', amount_cents: 10000, payment_method: 'wechat_pay', status: 'succeeded', token_credited: 100000, created_at: '2026-06-01T10:00:00Z' }},
];
global.window = {{
  aiteam: {{
    pages: {{}},
    states: {{
      renderLoading(container) {{ container.innerHTML = '<div>loading</div>'; }},
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      get(url) {{
        apiCalls.push({{ method: 'GET', url }});
        if (url === '/api/team/billing/balance') {{
          return Promise.resolve({{ ok: true, data: balanceResponse }});
        }}
        if (url === '/api/team/billing/recharges') {{
          return Promise.resolve({{ ok: true, data: {{ items: rechargeItems }} }});
        }}
        return Promise.resolve({{ ok: false, status: 404 }});
      }},
      post(url, body) {{
        apiCalls.push({{ method: 'POST', url, body }});
        if ({'true' if success else 'false'}) {{
          balanceResponse = {{
            ...balanceResponse,
            balance: '148.60',
            balance_cents: 14860,
            token_balance: 148600,
            low_balance_warning: false,
          }};
          rechargeItems = [
            {{ recharge_id: 'rch_new', amount: '100.00', amount_cents: 10000, payment_method: body.payment_method, status: 'succeeded', token_credited: 100000, created_at: '2026-06-10T10:00:00Z' }},
          ].concat(rechargeItems);
          return Promise.resolve({{ ok: true, data: {{ recharge_id: 'rch_new', status: 'succeeded', token_credited: 100000 }} }});
        }}
        return Promise.resolve({{ ok: false, status: 502, error: 'provider_unavailable' }});
      }},
      patch() {{
        return Promise.resolve({{ ok: true, data: {{}} }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-recharge.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.adminRecharge.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const beforeHtml = container.innerHTML;
  await container.lastSubmitHandler({{ amountYuan: 100, paymentMethod: 'mock_pay', idempotencyKey: 'ui-recharge-001' }});
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    beforeHtml,
    afterHtml: container.innerHTML,
    apiCalls,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def test_admin_billing_renders_prd_period_switch_trend_and_ranking_sections() -> None:
    payload = _run_admin_billing()
    assert "本月" in payload["html"]
    assert "上月" in payload["html"]
    assert "全部" in payload["html"]
    assert "较上月" in payload["html"]
    assert "按市场价计算" in payload["html"]
    assert "每日 Token 消耗趋势" in payload["html"]
    assert "工资最高员工" in payload["html"]
    assert "员工工资排行" in payload["html"]
    assert "导出报表" in payload["html"]


def test_admin_billing_trend_bars_expose_daily_employee_breakdown_tooltip() -> None:
    payload = _run_admin_billing()
    assert "title=\"2026-06-03" in payload["html"]
    assert "营销分析师" in payload["html"]
    assert "420000 tokens" in payload["html"]


def test_admin_recharge_renders_warning_threshold_payment_methods_and_usage_entry() -> None:
    payload = _run_admin_recharge()
    assert "低余额预警" in payload["html"]
    assert "低余额预警阈值" in payload["html"]
    assert "微信支付" in payload["html"]
    assert "支付宝" in payload["html"]
    assert "查看消耗看板" in payload["html"]


def test_admin_recharge_can_update_low_balance_threshold_and_refresh_notice() -> None:
    payload = _run_admin_recharge_threshold_update()
    assert "低余额预警阈值" in payload["beforeHtml"]
    assert payload["patchCalls"] == [
        {
            "url": "/api/team/settings",
            "body": {"low_balance_threshold_cents": 8800, "warning_enabled": True},
        }
    ]
    assert "预警阈值已更新" in payload["afterHtml"]
    assert "¥88.00" in payload["afterHtml"]


def test_admin_recharge_submit_success_renders_result_and_refreshes_balance_records() -> None:
    payload = _run_admin_recharge_submit_flow(True)
    assert payload["apiCalls"][2] == {
        "method": "POST",
        "url": "/api/team/billing/recharges",
        "body": {"amount": 100, "payment_method": "mock_pay", "idempotency_key": "ui-recharge-001"},
    }
    assert "充值结果" in payload["afterHtml"]
    assert "已到账" in payload["afterHtml"]
    assert "充值已提交并已按后端返回刷新余额与记录" in payload["afterHtml"]
    assert "¥148.60" in payload["afterHtml"]
    assert "rch_new" in payload["afterHtml"]


def test_admin_recharge_submit_failure_renders_result_feedback() -> None:
    payload = _run_admin_recharge_submit_flow(False)
    assert "充值结果" in payload["afterHtml"]
    assert "失败" in payload["afterHtml"]
    assert "充值请求提交失败" in payload["afterHtml"]


def test_admin_billing_export_uses_current_filters_and_download_path() -> None:
    payload = _run_admin_billing_export_flow()
    assert "/api/team/billing/usage/records/export" in payload["beforeHtml"]
    assert payload["recordsQueries"] == [
        "",
        "period_start=2026-06-05&period_end=2026-06-20&employee_id=emp_finance",
    ]
    assert payload["exportUrl"] == "/api/team/billing/usage/records/export?period_start=2026-06-05&period_end=2026-06-20&employee_id=emp_finance"
    assert payload["assignedUrls"] == [payload["exportUrl"]]
    assert "period_start=2026-06-05" in payload["afterHtml"]
    assert "employee_id=emp_finance" in payload["afterHtml"]


def test_admin_billing_rank_row_expands_employee_specific_run_details() -> None:
    payload = _run_admin_billing_rank_expand_flow()
    assert "run_1" in payload["beforeHtml"]
    assert "run_2" in payload["beforeHtml"]
    assert "run_3" in payload["beforeHtml"]
    assert "当前明细：财务顾问" in payload["afterHtml"]
    assert "run_3" in payload["afterHtml"]
    assert "run_1" not in payload["afterHtml"]
    assert "run_2" not in payload["afterHtml"]
