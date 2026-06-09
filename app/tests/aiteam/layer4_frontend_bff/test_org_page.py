from __future__ import annotations

import json
import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
PAGE_SHELL = ROOT / 'app/static/aiteam/page-shell.js'
API_CLIENT = ROOT / 'app/static/aiteam/api-client.js'
ORG_PAGE = ROOT / 'app/static/aiteam/pages/app-org.js'


def run_node(script: str) -> dict:
    completed = subprocess.run(
        ['node', '-e', script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def test_page_shell_wires_org_navigation_and_module_route() -> None:
    content = PAGE_SHELL.read_text(encoding='utf-8')

    assert "{ label: '组织架构',  href: '/app/org',         note: 'Org' }" in content
    assert "pathToModule['/app/org'] = 'app-org.js';" in content
    assert "handler = aiteam.pages && aiteam.pages.appOrg;" in content


def test_team_api_client_uses_canonical_org_endpoints() -> None:
    script = textwrap.dedent(
        f"""
        const fs = require('fs');
        const vm = require('vm');

        (async () => {{
          const apiCode = fs.readFileSync({json.dumps(str(API_CLIENT))}, 'utf8');
          const context = {{
            window: {{ aiteam: {{}} }},
            Headers,
            fetch: async (url, options = {{}}) => ({{
              ok: true,
              status: 200,
              statusText: 'OK',
              text: async () => JSON.stringify({{
                url,
                method: options.method || 'GET',
                body: options.body ? JSON.parse(options.body) : null,
              }}),
            }}),
          }};
          vm.createContext(context);
          vm.runInContext(apiCode, context, {{ filename: 'api-client.js' }});

          const api = context.window.aiteam.api;
          const readResult = await api.getOrgTree();
          const patchResult = await api.updateOrgAssignment('asg-7', {{ department_id: 'dept-2' }});

          process.stdout.write(JSON.stringify({{
            readUrl: readResult.data.url,
            readMethod: readResult.data.method,
            patchUrl: patchResult.data.url,
            patchMethod: patchResult.data.method,
            patchBody: patchResult.data.body,
          }}));
        }})().catch((error) => {{
          console.error(error);
          process.exit(1);
        }});
        """
    )

    result = run_node(script)

    assert result == {
        'readUrl': '/api/team/org/tree',
        'readMethod': 'GET',
        'patchUrl': '/api/team/org/assignments/asg-7',
        'patchMethod': 'PATCH',
        'patchBody': {'department_id': 'dept-2'},
    }


def test_page_shell_loads_org_module_and_renders_navigation() -> None:
    payload = {
        'departments': [
            {
                'id': 'dept-root',
                'name': '研发中心',
                'members': [
                    {
                        'id': 'asg-1',
                        'display_name': 'Alice',
                        'presence': 'online',
                        'role': '工程师',
                    }
                ],
            }
        ]
    }
    script = textwrap.dedent(
        f"""
        const fs = require('fs');
        const vm = require('vm');

        function createElement() {{
          return {{
            innerHTML: '',
            hidden: true,
            style: {{}},
            attributes: {{}},
            textContent: '',
            setAttribute(name, value) {{ this.attributes[name] = value; }},
          }};
        }}

        (async () => {{
          const scripts = {{
            'static/aiteam/pages/app-org.js': fs.readFileSync({json.dumps(str(ORG_PAGE))}, 'utf8'),
          }};
          const main = createElement();
          const nav = createElement();
          const title = createElement();
          const subtitle = createElement();
          const shell = createElement();
          const toast = createElement();
          const titlebar = createElement();
          const layout = createElement();
          const context = {{
            window: {{
              aiteam: {{
                api: {{
                  getOrgTree: async () => ({{ ok: true, status: 200, data: {json.dumps(payload, ensure_ascii=False)} }}),
                }},
                pages: {{}},
              }},
              location: {{ pathname: '/app/org' }},
            }},
            document: {{
              head: {{
                appendChild(node) {{
                  const code = scripts[node.src];
                  if (!code) {{
                    if (node.onerror) node.onerror();
                    return;
                  }}
                  vm.runInContext(code, context, {{ filename: node.src }});
                  if (node.onload) node.onload();
                }},
              }},
              createElement() {{
                return {{ src: '', onload: null, onerror: null }};
              }},
              getElementById(id) {{
                return {{
                  'aiteam-main': main,
                  'aiteam-nav': nav,
                  'aiteam-shell-title': title,
                  'aiteam-shell-subtitle': subtitle,
                  'aiteam-app': shell,
                  'toast': toast,
                }}[id] || null;
              }},
              querySelector(selector) {{
                return {{
                  '.app-titlebar': titlebar,
                  '.layout': layout,
                }}[selector] || null;
              }},
            }},
            bodyClassManager: {{ add() {{}} }},
            aiteam: null,
            console,
            setTimeout,
            clearTimeout,
          }};
          context.aiteam = context.window.aiteam;
          context.window.document = context.document;
          vm.createContext(context);
          vm.runInContext(fs.readFileSync({json.dumps(str(PAGE_SHELL))}, 'utf8'), context, {{ filename: 'page-shell.js' }});

          context.window.aiteam.shell.init('/app/org');
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));

          process.stdout.write(JSON.stringify({{
            navHtml: nav.innerHTML,
            mainHtml: main.innerHTML,
            title: title.textContent,
            subtitle: subtitle.textContent,
          }}));
        }})().catch((error) => {{
          console.error(error);
          process.exit(1);
        }});
        """
    )

    result = run_node(script)

    assert '/app/org' in result['navHtml']
    assert '组织架构' in result['navHtml']
    assert '研发中心' in result['mainHtml']
    assert 'Alice' in result['mainHtml']
    assert result['title'] == '工作台'
    assert result['subtitle'] == '企业前台'


def test_org_page_emits_patch_to_canonical_assignment_endpoint_when_editable() -> None:
    payload = {
        'departments': [
            {
                'id': 'dept-root',
                'name': '研发中心',
                'members': [
                    {
                        'id': 'asg-1',
                        'display_name': 'Alice',
                        'presence': 'online',
                        'role': '工程师',
                        'can_edit': True,
                        'patch_field': 'department_id',
                        'department_id': 'dept-root',
                        'department_choices': [
                            {'id': 'dept-root', 'name': '研发中心'},
                            {'id': 'dept-market', 'name': '市场部'},
                        ],
                    }
                ],
            }
        ]
    }
    script = textwrap.dedent(
        f"""
        const fs = require('fs');
        const vm = require('vm');

        (async () => {{
          const pageCode = fs.readFileSync({json.dumps(str(ORG_PAGE))}, 'utf8');
          const patchCalls = [];
          const button = {{
            getAttribute(name) {{ return name === 'data-org-assignment-save' ? 'asg-1' : null; }},
            addEventListener(_name, handler) {{ this._handler = handler; }},
          }};
          const select = {{
            value: 'dept-market',
            getAttribute(name) {{ return name === 'data-org-patch-field' ? 'department_id' : null; }},
          }};
          const status = {{ textContent: '' }};
          const main = {{
            innerHTML: '',
            querySelectorAll(selector) {{ return selector === '[data-org-assignment-save]' ? [button] : []; }},
            querySelector(selector) {{
              if (selector === '[data-org-assignment-select="asg-1"]') return select;
              if (selector === '[data-org-assignment-status="asg-1"]') return status;
              return null;
            }},
          }};
          const context = {{
            window: {{
              aiteam: {{
                api: {{
                  getOrgTree: async () => ({{ ok: true, status: 200, data: {json.dumps(payload, ensure_ascii=False)} }}),
                  updateOrgAssignment: async (assignmentId, body) => {{
                    patchCalls.push({{ assignmentId, body }});
                    return {{ ok: true, status: 200, data: {{ ok: true }} }};
                  }},
                }},
                pages: {{}},
              }},
            }},
            document: {{}},
            console,
            setTimeout,
            clearTimeout,
          }};
          context.window.document = context.document;
          vm.createContext(context);
          vm.runInContext(pageCode, context, {{ filename: 'app-org.js' }});
          await context.window.aiteam.pages.appOrg.init(main);
          await button._handler();
          await new Promise((resolve) => setTimeout(resolve, 0));

          process.stdout.write(JSON.stringify({{
            patchCalls,
            statusText: status.textContent,
            renderedEditor: main.innerHTML.includes('调整归属'),
          }}));
        }})().catch((error) => {{
          console.error(error);
          process.exit(1);
        }});
        """
    )

    result = run_node(script)

    assert result['renderedEditor'] is True
    assert result['patchCalls'] == [
        {
            'assignmentId': 'asg-1',
            'body': {'department_id': 'dept-market'},
        }
    ]
    assert result['statusText'] == '归属已更新。'


def test_org_page_renders_success_empty_permission_and_error_states() -> None:
    scenarios = {
        'success': {
            'ok': True,
            'status': 200,
            'data': {
                'departments': [
                    {
                        'id': 'dept-root',
                        'name': '研发中心',
                        'description': '负责平台交付',
                        'members': [
                            {
                                'id': 'asg-1',
                                'display_name': 'Alice',
                                'presence': 'online',
                                'role': '工程师',
                            }
                        ],
                        'children': [
                            {
                                'id': 'dept-ai',
                                'name': 'AI实验室',
                                'employees': [
                                    {
                                        'id': 'asg-2',
                                        'name': 'Bob',
                                        'presence_label': 'busy',
                                        'title': '研究员',
                                    }
                                ],
                            }
                        ],
                    }
                ]
            },
        },
        'empty': {
            'ok': True,
            'status': 200,
            'data': {'departments': []},
        },
        'permission': {
            'ok': False,
            'status': 403,
            'error': 'Forbidden',
            'data': None,
        },
        'failure': {
            'ok': False,
            'status': 500,
            'error': 'server exploded',
            'data': None,
        },
    }
    script = textwrap.dedent(
        f"""
        const fs = require('fs');
        const vm = require('vm');

        (async () => {{
          const pageCode = fs.readFileSync({json.dumps(str(ORG_PAGE))}, 'utf8');
          const scenarios = {json.dumps(scenarios, ensure_ascii=False)};
          const outputs = {{}};

          for (const [name, response] of Object.entries(scenarios)) {{
            const main = {{ innerHTML: '' }};
            const context = {{
              window: {{
                aiteam: {{
                  api: {{ getOrgTree: async () => response }},
                  pages: {{}},
                }},
              }},
              document: {{}},
              console,
              setTimeout,
              clearTimeout,
            }};
            context.window.document = context.document;
            vm.createContext(context);
            vm.runInContext(pageCode, context, {{ filename: 'app-org.js' }});
            await context.window.aiteam.pages.appOrg.init(main);
            outputs[name] = main.innerHTML;
          }}

          process.stdout.write(JSON.stringify(outputs));
        }})().catch((error) => {{
          console.error(error);
          process.exit(1);
        }});
        """
    )

    result = run_node(script)

    assert '研发中心' in result['success']
    assert 'AI实验室' in result['success']
    assert 'Alice' in result['success']
    assert 'Bob' in result['success']
    assert 'online' in result['success']
    assert 'busy' in result['success']
    assert '+ 新建部门' in result['success']
    assert '状态图例' in result['success']
    assert '在线 / 离线 / 繁忙' in result['success']
    assert '拖拽调整层级' in result['success']
    assert '部门详情' in result['success']
    assert '数字员工' in result['success']
    assert '暂无组织信息' in result['empty']
    assert '无权查看组织架构' in result['permission']
    assert '组织架构加载失败' in result['failure']
    assert 'server exploded' in result['failure']
