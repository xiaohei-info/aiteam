from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "admin-memories.js"


def _run_admin_memories() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
global.window = {{
  aiteam: {{
    pages: {{}},
    api: {{
      getMemories() {{
        return Promise.resolve({{
          ok: true,
          data: {{
            items: [
              {{
                memory_id: 'mem_1',
                employee_id: 'emp_1',
                employee_name: 'Alice',
                content: '客户更喜欢日报格式',
                category: 'preference',
                importance: 5,
                source_type: 'manual',
                tags: ['日报'],
                created_at: '2026-06-01T10:00:00Z',
                updated_at: '2026-06-02T10:00:00Z',
                audit_trace: [{{ action: 'created', actor_name: 'owner', timestamp: '2026-06-01T10:00:00Z' }}],
              }},
              {{
                memory_id: 'mem_2',
                employee_id: 'emp_2',
                employee_name: 'Bob',
                content: '优先标注风险事项',
                category: 'decision',
                importance: 4,
                source_type: 'auto',
                tags: ['风险'],
                created_at: '2026-06-01T11:00:00Z',
                updated_at: '2026-06-02T11:00:00Z',
                audit_trace: [{{ action: 'created', actor_name: 'system', timestamp: '2026-06-01T11:00:00Z' }}],
              }}
            ]
          }}
        }});
      }},
      createMemory() {{ return Promise.resolve({{ ok: true, data: {{}} }}); }},
      updateMemory() {{ return Promise.resolve({{ ok: true, data: {{}} }}); }},
      deleteMemory() {{ return Promise.resolve({{ ok: true, data: {{}} }}); }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-memories.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.adminMemories.init(container);
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


def test_admin_memories_renders_employee_sidebar_and_batch_delete_toolbar() -> None:
    payload = _run_admin_memories()
    assert "左侧员工选择器" in payload["html"]
    assert "批量删除" in payload["html"]
    assert "Alice" in payload["html"]
    assert "Bob" in payload["html"]
    assert "工作偏好" in payload["html"] or "preference" in payload["html"]
