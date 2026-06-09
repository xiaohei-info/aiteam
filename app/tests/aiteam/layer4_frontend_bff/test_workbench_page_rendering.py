from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORKBENCH_MODULE_PATH = ROOT / "static" / "aiteam" / "pages" / "app-workbench.js"


def _run_workbench(payload: dict) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(WORKBENCH_MODULE_PATH))}, 'utf8');
global.window = {{
  aiteam: {{
    util: {{
      escapeHtml(value) {{
        return String(value == null ? '' : value);
      }},
    }},
    pages: {{}},
    states: {{
      renderEmpty(container, message, actionHtml) {{
        container.innerHTML = '<div data-state-empty="1"><p>' + message + '</p>' + (actionHtml || '') + '</div>';
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'app-workbench.js' }});
const container = {{ innerHTML: '' }};
aiteam.pages.appWorkbench.render(container, {json.dumps(payload, ensure_ascii=False)});
console.log(JSON.stringify({{ html: container.innerHTML }}));
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_workbench_empty_state_uses_prd_split_shell_instead_of_generic_empty_state() -> None:
    result = _run_workbench(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [],
            "groups": [],
            "office_digest": {"online_employee_count": 0, "running_task_count": 0},
        }
    )
    assert "data-workbench-shell" in result["html"]
    assert "data-workbench-rail" in result["html"]
    assert 'href="/app/group"' in result["html"]
    assert 'href="/app/knowledge"' in result["html"]
    assert "data-workbench-empty" in result["html"]
    assert "前往人才市场" in result["html"]
    assert "从左侧选择员工开始对话" in result["html"]
    assert "data-state-empty" not in result["html"]


def test_workbench_populated_state_renders_search_employee_list_and_main_stage() -> None:
    result = _run_workbench(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [
                {
                    "employee_id": "emp_rex",
                    "display_name": "Rex",
                    "role_name": "代码工程师",
                    "status": "active",
                    "presence": "busy",
                    "conversation_id": "conv_rex",
                    "last_message_preview": "已整理本周回归结论",
                    "unread_count": 2,
                },
                {
                    "employee_id": "emp_nova",
                    "display_name": "Nova",
                    "role_name": "数据科学家",
                    "status": "active",
                    "presence": "online",
                    "conversation_id": "conv_nova",
                    "last_message_preview": "等待新的分析任务",
                    "unread_count": 0,
                    "avatar_url": "https://example.test/nova.png",
                    "last_active_at": "2026-06-10T10:00:00Z",
                    "is_starred": True,
                },
            ],
            "groups": [
                {
                    "conversation_id": "group_ops",
                    "title": "运营协作组",
                    "member_count": 3,
                    "running_count": 1,
                    "last_message_preview": "等待补充结论",
                }
            ],
            "office_digest": {"online_employee_count": 2, "running_task_count": 1},
        }
    )
    assert "data-workbench-shell" in result["html"]
    assert "data-workbench-rail" in result["html"]
    assert "私聊" in result["html"]
    assert "群聊" in result["html"]
    assert "知识库" in result["html"]
    assert "设置" in result["html"]
    assert "data-workbench-search" in result["html"]
    assert "data-workbench-list" in result["html"]
    assert "data-workbench-main" in result["html"]
    assert "Rex" in result["html"]
    assert "Nova" in result["html"]
    assert "运营协作组" in result["html"]
    assert "继续对话" in result["html"]
    assert "快捷操作" in result["html"]
    assert "查看详情" in result["html"]
    assert "设置为星标" in result["html"]
    assert "解雇" in result["html"]
    assert "data-workbench-avatar" in result["html"]
    assert "https://example.test/nova.png" in result["html"]
    assert "title=\"私聊\"" in result["html"]
    assert "title=\"群聊\"" in result["html"]
    assert "title=\"组织架构\"" in result["html"]
    assert "title=\"人才市场\"" in result["html"]
    assert "data-workbench-context-menu" in result["html"]
    assert "data-workbench-starred" in result["html"]
    assert 'href="/app/group"' in result["html"]
    assert 'href="/app/org"' in result["html"]


def test_workbench_starred_employee_is_sorted_to_top_and_context_menu_matches_prd_actions() -> None:
    result = _run_workbench(
        {
            "enterprise": {"enterprise_id": "ent_demo", "name": "示例企业"},
            "employees": [
                {
                    "employee_id": "emp_rex",
                    "display_name": "Rex",
                    "role_name": "代码工程师",
                    "status": "active",
                    "presence": "busy",
                    "conversation_id": "conv_rex",
                    "last_message_preview": "已整理本周回归结论",
                    "unread_count": 2,
                    "last_active_at": "2026-06-10T09:00:00Z",
                    "is_starred": False,
                },
                {
                    "employee_id": "emp_nova",
                    "display_name": "Nova",
                    "role_name": "数据科学家",
                    "status": "active",
                    "presence": "online",
                    "conversation_id": "conv_nova",
                    "last_message_preview": "等待新的分析任务",
                    "unread_count": 0,
                    "last_active_at": "2026-06-10T08:00:00Z",
                    "is_starred": True,
                },
            ],
            "groups": [],
            "office_digest": {"online_employee_count": 2, "running_task_count": 1},
        }
    )
    assert result["html"].index("Nova") < result["html"].index("Rex")
    assert "查看详情" in result["html"]
    assert "设置为星标" in result["html"]
    assert "解雇" in result["html"]
