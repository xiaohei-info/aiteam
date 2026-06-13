from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "admin-solutions.js"


def _run_admin_solutions() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
global.window = {{
  aiteam: {{
    pages: {{}},
    role: {{
      getActiveRole() {{ return 'owner'; }},
    }},
    api: {{
      getSolutions() {{
        return Promise.resolve({{ ok: true, data: {{ items: [
          {{
            solution_id: 'sol_truth',
            name: '零售增长方案',
            status: 'published',
            description: '覆盖门店运营、销售分析与复购增长',
            tags: ['零售', '增长'],
            template_ids: ['tpl_ops', 'tpl_sales'],
            template_summaries: [
              {{
                template_id: 'tpl_ops',
                name: '门店运营专员',
                role_name: '门店运营',
                default_model_ref: {{ provider: 'openai', model: 'gpt-4o' }},
              }},
              {{
                template_id: 'tpl_sales',
                name: '销售分析师',
                role_name: '销售分析',
                default_model_ref: {{ provider: 'anthropic', model: 'claude-3-7-sonnet' }},
              }},
            ],
            template_count: 2,
            apply_count: 4,
            active_employee_count: 3,
            publish_record: {{ created_at: '2026-06-04T00:00:00Z' }},
            last_apply_record_id: 'apply_002',
            last_apply_status: 'succeeded',
            created_employee_ids: ['emp_backend'],
            created_knowledge_base_ids: ['kb_backend'],
          }}
        ] }} }});
      }},
      applySolution() {{
        return Promise.resolve({{ ok: true, data: {{}} }});
      }},
    }},
    states: {{
      renderLoading(container) {{ container.innerHTML = '<div>loading</div>'; }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-solutions.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.adminSolutions.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const listHtml = container.innerHTML;
  // 列表是 slim 行；详情/应用控件在点击后的模态里。
  container.lastOpenHandler('sol_truth');
  console.log(JSON.stringify({{ html: container.innerHTML, listHtml }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def _run_admin_solutions_preview_flow() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
let applyCalls = 0;
global.window = {{
  aiteam: {{
    pages: {{}},
    role: {{
      getActiveRole() {{ return 'owner'; }},
    }},
    api: {{
      getSolutions() {{
        return Promise.resolve({{ ok: true, data: {{ items: [
          {{
            solution_id: 'sol_truth',
            name: '零售增长方案',
            status: 'published',
            description: '覆盖门店运营、销售分析与复购增长',
            tags: ['零售', '增长'],
            template_ids: ['tpl_ops', 'tpl_sales'],
            template_summaries: [
              {{
                template_id: 'tpl_ops',
                name: '门店运营专员',
                role_name: '门店运营',
                default_model_ref: {{ provider: 'openai', model: 'gpt-4o' }},
              }},
              {{
                template_id: 'tpl_sales',
                name: '销售分析师',
                role_name: '销售分析',
                default_model_ref: {{ provider: 'anthropic', model: 'claude-3-7-sonnet' }},
              }},
            ],
            template_count: 2,
            apply_count: 4,
            active_employee_count: 3,
            publish_record: {{ created_at: '2026-06-04T00:00:00Z' }},
            last_apply_record_id: 'apply_002',
            last_apply_status: 'succeeded',
            created_employee_ids: ['emp_backend'],
            created_knowledge_base_ids: ['kb_backend'],
          }}
        ] }} }});
      }},
      applySolution() {{
        applyCalls += 1;
        return Promise.resolve({{ ok: true, data: {{
          mode: 'reapply',
          created_employee_ids: ['emp_new_a'],
          replaced_employee_ids: [],
          reapplied_from_employee_ids: ['emp_backend', 'emp_legacy'],
        }} }});
      }},
    }},
    states: {{
      renderLoading(container) {{ container.innerHTML = '<div>loading</div>'; }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-solutions.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.adminSolutions.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await container.lastPreviewHandler('sol_truth', {{
    mode: 'reapply',
    department_id: 'dept_marketing',
    idempotency_key: 'preview-001',
  }});
  const previewHtml = container.innerHTML;
  const applyCallsBeforeConfirm = applyCalls;
  await container.lastConfirmApplyHandler();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    previewHtml,
    finalHtml: container.innerHTML,
    applyCallsBeforeConfirm,
    applyCallsAfterConfirm: applyCalls,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def test_admin_solutions_renders_detail_and_atomic_apply_hints() -> None:
    payload = _run_admin_solutions()
    assert "行业 AI 解决方案" in payload["html"]
    # 列表默认只铺名字+描述（slim 行），详情在点击后的模态里。
    assert "data-solution-open" in payload["listHtml"]
    assert "aiteam-solution-modal" in payload["html"]
    assert "覆盖门店运营、销售分析与复购增长" in payload["html"]  # 方案描述（模态内）
    assert "包含 AI 员工" in payload["html"]
    assert "待创建员工预览" in payload["html"]
    assert "门店运营专员" in payload["html"]
    assert "销售分析师" in payload["html"]
    assert "gpt-4o" in payload["html"]
    assert "claude-3-7-sonnet" in payload["html"]
    assert "预期价值" in payload["html"]
    assert "失败时整体回滚" in payload["html"]
    assert "已应用" in payload["html"]
    assert "重新应用" in payload["html"]
    assert "覆盖重建" in payload["html"]
    assert "追加应用" in payload["html"]
    assert "没有我的行业？告诉我们" in payload["html"]
    assert payload["html"].index('data-mode="reapply"') < payload["html"].index('data-mode="append"')


def test_admin_solutions_requires_apply_preview_confirmation_before_submit() -> None:
    payload = _run_admin_solutions_preview_flow()
    assert "应用前确认" in payload["previewHtml"]
    assert "门店运营专员" in payload["previewHtml"]
    assert "销售分析师" in payload["previewHtml"]
    assert "gpt-4o" in payload["previewHtml"]
    assert "claude-3-7-sonnet" in payload["previewHtml"]
    assert "dept_marketing" in payload["previewHtml"]
    assert payload["applyCallsBeforeConfirm"] == 0
    assert payload["applyCallsAfterConfirm"] == 1
    assert "行业方案应用已提交" in payload["finalHtml"]
    # 新建/归档员工以刷新后的后端清单为准，提交摘要不再展示 apply 响应中的临时 ID。
    assert "emp_new_a" not in payload["finalHtml"]
    assert "emp_backend" in payload["finalHtml"]
