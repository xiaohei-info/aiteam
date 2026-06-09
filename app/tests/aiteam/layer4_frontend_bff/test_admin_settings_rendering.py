from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PAGE_PATH = ROOT / "static" / "aiteam" / "pages" / "admin-settings.js"


def _run_admin_settings() -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const moduleSource = fs.readFileSync({json.dumps(str(PAGE_PATH))}, 'utf8');
const apiCalls = [];
global.window = {{
  aiteam: {{
    pages: {{}},
    states: {{
      handleApiResult(result, container) {{ container.innerHTML = '<div>' + (result && result.status || 'error') + '</div>'; }},
    }},
    api: {{
      get(url) {{
        apiCalls.push({{ method: 'GET', url }});
        if (url === '/api/team/settings') {{
          return Promise.resolve({{
            ok: true,
            data: {{
              enterprise_id: 'ent_demo',
              name: '示例企业',
              logo_url: 'https://example.test/logo.png',
              contact_phone: '13800138000',
              contact_wechat: 'team-demo',
              invite_code: 'INV-DEMO',
              help_doc_url: '/docs',
              feedback_form_url: '/support/feedback',
              version_label: 'v0.9.2',
              version_notes_url: '/docs/changelog',
              notification_policy: {{
                employee_task_completed: true,
                system_announcements: false,
                low_balance_email: true
              }},
              admin_members: [
                {{ membership_id: 'm1', user_id: 'u_admin', role: 'enterprise_admin', status: 'active', joined_at: '2026-06-01T10:00:00Z' }},
              ],
              admin_invites: [
                {{ invite_id: 'inv1', phone: '13900001111', role: 'finance_admin', status: 'pending', invite_code: 'INV-001' }},
              ],
              low_balance_threshold_cents: 5000,
              warning_enabled: true,
            }},
          }});
        }}
        return Promise.resolve({{ ok: false, status: 404 }});
      }},
      patch(url, payload) {{
        apiCalls.push({{ method: 'PATCH', url, payload }});
        return Promise.resolve({{ ok: true, data: {{}} }});
      }},
      post(url, payload) {{
        apiCalls.push({{ method: 'POST', url, payload }});
        return Promise.resolve({{ ok: true, data: {{ invite_id: 'inv2', phone: '13900002222', role: 'enterprise_admin', status: 'pending', invite_code: 'INV-002' }} }});
      }},
      delete(url) {{
        apiCalls.push({{ method: 'DELETE', url }});
        return Promise.resolve({{ ok: true, data: {{ invite_id: 'inv1', status: 'revoked' }} }});
      }},
    }},
  }},
}};
global.aiteam = global.window.aiteam;
vm.runInThisContext(moduleSource, {{ filename: 'admin-settings.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
  }};
  aiteam.pages.adminSettings.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await container.lastProfileHandler({{
    name: '新的企业名称',
    logo_url: 'https://example.test/new-logo.png',
    contact_phone: '13900002222',
    contact_wechat: 'new-team-demo',
  }});
  await container.lastPreferencesHandler({{
    help_doc_url: '/docs/new',
    feedback_form_url: '/support/new-feedback',
    version_label: 'v1.0.0',
    version_notes_url: '/docs/changelog/v1',
    low_balance_threshold_cents: 8800,
    warning_enabled: false,
    notification_policy: {{
      employee_task_completed: false,
      system_announcements: true,
      low_balance_email: true
    }},
  }});
  await container.lastInviteHandler({{
    phone: '13900002222',
    role: 'enterprise_admin',
    permissions: {{ billing: true, employees: false, audit: true }},
    message: '请协助处理财务与审计',
    idempotency_key: 'inv-002'
  }});
  await container.lastDeleteInviteHandler('inv1');
  console.log(JSON.stringify({{ html: container.innerHTML, apiCalls }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


def test_admin_settings_renders_account_admin_and_other_setting_sections() -> None:
    payload = _run_admin_settings()
    assert payload["apiCalls"][0] == {"method": "GET", "url": "/api/team/settings"}
    patch_calls = [call for call in payload["apiCalls"] if call["method"] == "PATCH" and call["url"] == "/api/team/settings"]
    assert len(patch_calls) == 2
    assert patch_calls[0]["payload"] == {
        "name": "新的企业名称",
        "logo_url": "https://example.test/new-logo.png",
        "contact_phone": "13900002222",
        "contact_wechat": "new-team-demo",
    }
    assert patch_calls[1]["payload"] == {
        "help_doc_url": "/docs/new",
        "feedback_form_url": "/support/new-feedback",
        "version_label": "v1.0.0",
        "version_notes_url": "/docs/changelog/v1",
        "low_balance_threshold_cents": 8800,
        "warning_enabled": False,
        "notification_policy": {
            "employee_task_completed": False,
            "system_announcements": True,
            "low_balance_email": True,
        },
    }
    assert any(call["method"] == "POST" and call["url"] == "/api/team/settings/admin-invites" for call in payload["apiCalls"])
    assert any(call["method"] == "DELETE" and call["url"] == "/api/team/settings/admin-invites/inv1" for call in payload["apiCalls"])
    assert "账户管理" in payload["html"]
    assert "子管理员账号" in payload["html"]
    assert "其他设置" in payload["html"]
    assert "新的企业名称" in payload["html"]
    assert "INV-DEMO" in payload["html"]
    assert "Logo 上传" in payload["html"]
    assert "更换绑定信息" in payload["html"]
    assert "保存企业资料" in payload["html"]
    assert "权限范围" in payload["html"]
    assert "财务与充值" in payload["html"]
    assert "员工与组织" in payload["html"]
    assert "检查更新" in payload["html"]
    assert "更新日志" in payload["html"]
    assert "帮助与反馈" in payload["html"]
    assert "通知设置" in payload["html"]
    assert "员工任务完成通知" in payload["html"]
    assert "系统公告" in payload["html"]
    assert "低余额邮件预警" in payload["html"]
    assert "保存通知与支持设置" in payload["html"]
    assert "发送邀请" in payload["html"]
    assert "撤销邀请" in payload["html"]
    assert "管理员邀请已撤销" in payload["html"]
