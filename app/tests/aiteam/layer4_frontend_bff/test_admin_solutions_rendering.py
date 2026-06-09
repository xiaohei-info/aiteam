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
  console.log(JSON.stringify({{ html: container.innerHTML }}));
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
    assert "方案描述" in payload["html"]
    assert "包含 AI 员工" in payload["html"]
    assert "预期价值" in payload["html"]
    assert "失败时整体回滚" in payload["html"]
    assert "追加应用" in payload["html"]
    assert "覆盖重建" in payload["html"]
    assert "重新应用" in payload["html"]
