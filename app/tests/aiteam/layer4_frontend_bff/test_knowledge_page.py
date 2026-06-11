from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
AITEAM_STATIC = ROOT / "app" / "static" / "aiteam"
API_CLIENT_PATH = AITEAM_STATIC / "api-client.js"
STATE_HELPERS_PATH = AITEAM_STATIC / "state-helpers.js"
KNOWLEDGE_MODULE_PATH = AITEAM_STATIC / "pages" / "knowledge.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _run_knowledge_module(kb_response: dict) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(KNOWLEDGE_MODULE_PATH))}, 'utf8');
global.Headers = class Headers {{
  constructor(init) {{
    this.map = new Map();
    if (init) {{
      for (const [key, value] of Object.entries(init)) this.map.set(String(key).toLowerCase(), String(value));
    }}
  }}
  has(name) {{ return this.map.has(String(name).toLowerCase()); }}
  set(name, value) {{ this.map.set(String(name).toLowerCase(), String(value)); }}
}};
global.fetch = async () => {{
  return {{
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {{ return JSON.stringify({{ ok: true }}); }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.document = {{ getElementById() {{ return null; }} }};
global.window.document = global.document;
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'knowledge.js' }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.api.getKnowledgeBases = async () => ({json.dumps(kb_response)});
  aiteam.pages.knowledge.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    html: container.innerHTML,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_create_kb_lifecycle(post_result: dict, kb_responses: list[dict]) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(KNOWLEDGE_MODULE_PATH))}, 'utf8');
const calls = [];
let kbCallCount = 0;
const kbResponses = {json.dumps(kb_responses)};
function makeElement(initial) {{
  return Object.assign({{
    value: '',
    innerHTML: '',
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{ if (this.listeners.click) return this.listeners.click({{ preventDefault() {{}} }}); }},
  }}, initial || {{}});
}}
const elements = {{
  'kb-create-name': makeElement({{ value: '新知识库' }}),
  'kb-create-description': makeElement({{ value: '用于新员工资料' }}),
  'kb-create-submit': makeElement(),
  'kb-create-feedback': makeElement(),
}};
global.Headers = class Headers {{
  constructor(init) {{
    this.map = new Map();
    if (init) {{
      for (const [key, value] of Object.entries(init)) this.map.set(String(key).toLowerCase(), String(value));
    }}
  }}
  has(name) {{ return this.map.has(String(name).toLowerCase()); }}
  set(name, value) {{ this.map.set(String(name).toLowerCase(), String(value)); }}
}};
global.fetch = async () => {{
  return {{
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {{ return JSON.stringify({{ ok: true }}); }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.document = {{
  getElementById(id) {{
    return elements[id] || null;
  }},
}};
global.window.document = global.document;
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'knowledge.js' }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.api.getKnowledgeBases = async () => {{
    const index = Math.min(kbCallCount, kbResponses.length - 1);
    kbCallCount += 1;
    return kbResponses[index];
  }};
  aiteam.api.getEmployees = async () => ({{
    ok: true,
    status: 200,
    data: {{ employees: [] }},
  }});
  aiteam.api.postKnowledgeBase = async (body) => {{
    calls.push(body);
    return {json.dumps(post_result)};
  }};
  aiteam.pages.knowledge.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await elements['kb-create-submit'].click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    html: container.innerHTML,
    feedback: elements['kb-create-feedback'].innerHTML,
    calls,
    kbCallCount,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_upload_lifecycle(upload_result: dict, document_result: dict, kb_responses: list[dict] | None = None) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(KNOWLEDGE_MODULE_PATH))}, 'utf8');
const calls = [];
const kbResponses = {json.dumps(kb_responses or [{
  "ok": True,
  "status": 200,
  "data": {
    "knowledge_bases": [{
      "knowledge_base_id": "kb_sales",
      "name": "销售知识库",
      "description": "销售资料",
      "status": "active",
      "document_count": 0,
      "documents": [],
      "employee_bindings": [],
    }],
  },
}])};
let kbCallCount = 0;
function makeElement(initial) {{
  return Object.assign({{
    value: '',
    innerHTML: '',
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{ if (this.listeners.click) return this.listeners.click({{ preventDefault() {{}} }}); }},
  }}, initial || {{}});
}}
const elements = {{
  'kb-upload-select': makeElement({{ value: 'kb_sales' }}),
  'kb-upload-file': makeElement({{ files: [{{ name: 'faq.pdf', type: 'application/pdf', size: 4096 }}] }}),
  'kb-upload-display-name': makeElement({{ value: 'FAQ 文档' }}),
  'kb-upload-submit': makeElement(),
  'kb-upload-feedback': makeElement(),
}};
global.FileReader = class {{
  readAsText(file) {{
    this.result = 'FILE CONTENT';
    setImmediate(() => {{ if (this.onload) this.onload(); }});
  }}
}};
global.Headers = class Headers {{
  constructor(init) {{
    this.map = new Map();
    if (init) {{
      for (const [key, value] of Object.entries(init)) this.map.set(String(key).toLowerCase(), String(value));
    }}
  }}
  has(name) {{ return this.map.has(String(name).toLowerCase()); }}
  set(name, value) {{ this.map.set(String(name).toLowerCase(), String(value)); }}
}};
global.fetch = async () => {{
  return {{
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {{ return JSON.stringify({{ ok: true }}); }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.document = {{
  getElementById(id) {{
    return elements[id] || null;
  }},
}};
global.window.document = global.document;
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'knowledge.js' }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.api.getKnowledgeBases = async () => {{
    const index = Math.min(kbCallCount, kbResponses.length - 1);
    kbCallCount += 1;
    return kbResponses[index];
  }};
  aiteam.api.upload = async (body) => {{
    calls.push({{ kind: 'upload', body }});
    return {json.dumps(upload_result)};
  }};
  aiteam.api.postKnowledgeDocument = async (kbId, body) => {{
    calls.push({{ kind: 'document', kbId, body }});
    return {json.dumps(document_result)};
  }};
  aiteam.pages.knowledge.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await elements['kb-upload-submit'].click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    html: container.innerHTML,
    feedback: elements['kb-upload-feedback'].innerHTML,
    calls,
    kbCallCount,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_binding_lifecycle(employee_result: dict, patch_result: dict) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(KNOWLEDGE_MODULE_PATH))}, 'utf8');
const calls = [];
function makeElement(initial) {{
  return Object.assign({{
    value: '',
    innerHTML: '',
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{ if (this.listeners.click) return this.listeners.click({{ preventDefault() {{}} }}); }},
  }}, initial || {{}});
}}
const elements = {{
  'kb-bind-kb': makeElement({{ value: 'kb_sales' }}),
  'kb-bind-employee': makeElement({{ value: 'emp_member' }}),
  'kb-bind-submit': makeElement(),
  'kb-bind-feedback': makeElement(),
}};
global.Headers = class Headers {{
  constructor(init) {{
    this.map = new Map();
    if (init) {{
      for (const [key, value] of Object.entries(init)) this.map.set(String(key).toLowerCase(), String(value));
    }}
  }}
  has(name) {{ return this.map.has(String(name).toLowerCase()); }}
  set(name, value) {{ this.map.set(String(name).toLowerCase(), String(value)); }}
}};
global.fetch = async () => {{
  return {{
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {{ return JSON.stringify({{ ok: true }}); }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.document = {{
  getElementById(id) {{
    return elements[id] || null;
  }},
}};
global.window.document = global.document;
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'knowledge.js' }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.api.getKnowledgeBases = async () => ({{
    ok: true,
    status: 200,
    data: {{
      knowledge_bases: [
        {{
          knowledge_base_id: 'kb_sales',
          name: '销售知识库',
          description: '销售资料',
          status: 'active',
          document_count: 0,
          documents: [],
          employee_bindings: [],
        }},
        {{
          knowledge_base_id: 'kb_marketing',
          name: '市场知识库',
          description: '市场资料',
          status: 'active',
          document_count: 0,
          documents: [],
          employee_bindings: [{{ employee_id: 'emp_member', display_name: '成员A' }}],
        }},
      ],
    }},
  }});
  aiteam.api.getEmployees = async () => ({json.dumps(employee_result)});
  aiteam.api.updateEmployee = async (employeeId, body) => {{
    calls.push({{ employeeId, body }});
    return {json.dumps(patch_result)};
  }};
  aiteam.pages.knowledge.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await elements['kb-bind-submit'].click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    html: container.innerHTML,
    feedback: elements['kb-bind-feedback'].innerHTML,
    calls,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_retry_lifecycle(document_result: dict, kb_responses: list[dict] | None = None) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(KNOWLEDGE_MODULE_PATH))}, 'utf8');
const calls = [];
const kbResponses = {json.dumps(kb_responses or [{
  "ok": True,
  "status": 200,
  "data": {
    "knowledge_bases": [{
      "knowledge_base_id": "kb_sales",
      "name": "销售知识库",
      "description": "销售资料",
      "status": "active",
      "document_count": 1,
      "documents": [{
        "document_id": "doc_err",
        "asset_id": "ast_err",
        "display_name": "失败文档",
        "file_name": "error.pdf",
        "file_type": "application/pdf",
        "file_size": 2048,
        "status": "error",
        "error_code": "INGEST_FAILED",
        "error_message": "insert timeout",
      }],
      "employee_bindings": [],
    }],
  },
}])};
let kbCallCount = 0;
function makeElement(initial) {{
  return Object.assign({{
    value: '',
    innerHTML: '',
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{ if (this.listeners.click) return this.listeners.click({{ preventDefault() {{}} }}); }},
    getAttribute() {{ return null; }},
  }}, initial || {{}});
}}
const retryButton = makeElement({{
  getAttribute(name) {{
    if (name === 'data-kb-retry-kb') return 'kb_sales';
    if (name === 'data-kb-retry-asset-id') return 'ast_err';
    if (name === 'data-kb-retry-display-name') return '失败文档';
    if (name === 'data-kb-retry-file-name') return 'error.pdf';
    if (name === 'data-kb-retry-mime-type') return 'application/pdf';
    if (name === 'data-kb-retry-size') return '2048';
    return null;
  }},
}});
const feedback = makeElement();
global.Headers = class Headers {{
  constructor(init) {{
    this.map = new Map();
    if (init) {{
      for (const [key, value] of Object.entries(init)) this.map.set(String(key).toLowerCase(), String(value));
    }}
  }}
  has(name) {{ return this.map.has(String(name).toLowerCase()); }}
  set(name, value) {{ this.map.set(String(name).toLowerCase(), String(value)); }}
}};
global.fetch = async () => {{
  return {{
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {{ return JSON.stringify({{ ok: true }}); }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.document = {{
  getElementById(id) {{
    if (id === 'kb-retry-feedback') return feedback;
    return null;
  }},
}};
global.window.document = global.document;
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'knowledge.js' }});
(async () => {{
  const container = {{
    innerHTML: '',
    querySelectorAll(selector) {{
      if (selector === '[data-kb-retry]') return [retryButton];
      return [];
    }},
  }};
  aiteam.api.getKnowledgeBases = async () => {{
    const index = Math.min(kbCallCount, kbResponses.length - 1);
    kbCallCount += 1;
    return kbResponses[index];
  }};
  aiteam.api.getEmployees = async () => ({{
    ok: true,
    status: 200,
    data: {{ employees: [] }},
  }});
  aiteam.api.postKnowledgeDocument = async (kbId, body) => {{
    calls.push({{ kbId, body }});
    return {json.dumps(document_result)};
  }};
  aiteam.pages.knowledge.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await retryButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    html: container.innerHTML,
    feedback: feedback.innerHTML,
    calls,
    kbCallCount,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_search_lifecycle(search_result: dict) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const stateHelpersSource = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(KNOWLEDGE_MODULE_PATH))}, 'utf8');
const calls = [];
function makeElement(initial) {{
  return Object.assign({{
    value: '',
    innerHTML: '',
    listeners: {{}},
    addEventListener(type, handler) {{ this.listeners[type] = handler; }},
    click() {{ if (this.listeners.click) return this.listeners.click({{ preventDefault() {{}} }}); }},
  }}, initial || {{}});
}}
const elements = {{
  'kb-search-select': makeElement({{ value: 'kb_sales' }}),
  'kb-search-query': makeElement({{ value: '入职' }}),
  'kb-search-submit': makeElement(),
  'kb-search-feedback': makeElement(),
  'kb-search-results': makeElement(),
}};
global.Headers = class Headers {{
  constructor(init) {{
    this.map = new Map();
    if (init) {{
      for (const [key, value] of Object.entries(init)) this.map.set(String(key).toLowerCase(), String(value));
    }}
  }}
  has(name) {{ return this.map.has(String(name).toLowerCase()); }}
  set(name, value) {{ this.map.set(String(name).toLowerCase(), String(value)); }}
}};
global.fetch = async () => {{
  return {{
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {{ return JSON.stringify({{ ok: true }}); }},
  }};
}};
global.window = {{ aiteam: {{}} }};
global.document = {{
  getElementById(id) {{
    return elements[id] || null;
  }},
}};
global.window.document = global.document;
global.aiteam = global.window.aiteam;
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
vm.runInThisContext(stateHelpersSource, {{ filename: 'state-helpers.js' }});
vm.runInThisContext(moduleSource, {{ filename: 'knowledge.js' }});
(async () => {{
  const container = {{ innerHTML: '' }};
  aiteam.api.getKnowledgeBases = async () => ({{
    ok: true,
    status: 200,
    data: {{
      knowledge_bases: [{{
        knowledge_base_id: 'kb_sales',
        name: '销售知识库',
        description: '销售资料',
        status: 'active',
        document_count: 1,
        documents: [],
        employee_bindings: [],
      }}],
    }},
  }});
  aiteam.api.getEmployees = async () => ({{
    ok: true,
    status: 200,
    data: {{ employees: [] }},
  }});
  aiteam.api.getKnowledgeSearch = async (kbId, query) => {{
    calls.push({{ kbId, query }});
    return {json.dumps(search_result)};
  }};
  aiteam.pages.knowledge.init(container);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await elements['kb-search-submit'].click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({{
    html: container.innerHTML,
    feedback: elements['kb-search-feedback'].innerHTML,
    results: elements['kb-search-results'].innerHTML,
    calls,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_knowledge_module_exists() -> None:
    assert KNOWLEDGE_MODULE_PATH.exists(), f"Missing knowledge module: {KNOWLEDGE_MODULE_PATH}"


def test_knowledge_module_renders_create_form_when_empty() -> None:
    result = _run_knowledge_module(
        {
            "ok": True,
            "status": 200,
            "data": {
                "knowledge_bases": [],
            },
        }
    )
    assert "创建知识库" in result["html"]
    assert "kb-create-submit" in result["html"]


def test_knowledge_module_creates_kb_and_refreshes_list() -> None:
    result = _run_create_kb_lifecycle(
        {
            "ok": True,
            "status": 201,
            "data": {
                "knowledge_base_id": "kb_new",
                "name": "新知识库",
                "description": "用于新员工资料",
                "status": "active",
                "document_count": 0,
            },
        },
        [
            {
                "ok": True,
                "status": 200,
                "data": {
                    "knowledge_bases": [],
                },
            },
            {
                "ok": True,
                "status": 200,
                "data": {
                    "knowledge_bases": [
                        {
                            "knowledge_base_id": "kb_new",
                            "name": "新知识库",
                            "description": "用于新员工资料",
                            "status": "active",
                            "document_count": 0,
                            "documents": [],
                            "employee_bindings": [],
                        }
                    ]
                },
            },
        ],
    )
    assert result["calls"] == [{"name": "新知识库", "description": "用于新员工资料"}]
    assert result["kbCallCount"] == 2
    assert "新知识库" in result["html"]
    assert "创建成功" in result["feedback"]


def test_knowledge_module_renders_cards_and_upload_form() -> None:
    result = _run_knowledge_module(
        {
            "ok": True,
            "status": 200,
            "data": {
                "knowledge_bases": [
                    {
                        "knowledge_base_id": "kb_sales",
                        "name": "销售知识库",
                        "description": "销售资料",
                        "status": "active",
                        "document_count": 1,
                        "documents": [
                            {
                                "document_id": "doc_1",
                                "asset_id": "ast_1",
                                "display_name": "FAQ",
                                "status": "ready",
                                "chunk_count": 12,
                            }
                        ],
                        "employee_bindings": [{"employee_id": "emp_1", "display_name": "Alice"}],
                    }
                ]
            },
        }
    )
    assert "销售知识库" in result["html"]
    assert "FAQ" in result["html"]
    assert "Alice" in result["html"]
    assert "上传文档" in result["html"]
    assert "kb-upload-submit" in result["html"]
    assert "kb-upload-file" in result["html"]
    assert "知识查询" in result["html"]
    assert "kb-search-submit" in result["html"]


def test_knowledge_module_uploads_asset_then_posts_document() -> None:
    result = _run_upload_lifecycle(
        {
            "ok": True,
            "status": 201,
            "data": {
                "asset_id": "ast_001",
                "name": "faq.pdf",
                "size": 4096,
                "mime_type": "application/pdf",
                "storage_key": "aiteam/uploads/ast_001/faq.pdf",
            },
        },
        {
            "ok": True,
            "status": 201,
            "data": {
                "document_id": "doc_001",
                "status": "ingesting",
                "ingestion_job_id": "ing_001",
            },
        },
    )
    assert result["calls"] == [
        {
            "kind": "upload",
            "body": {
                "name": "faq.pdf",
                "mime_type": "application/pdf",
                "size": 4096,
                "content_text": "FILE CONTENT",
            },
        },
        {
            "kind": "document",
            "kbId": "kb_sales",
            "body": {
                "asset_id": "ast_001",
                "display_name": "FAQ 文档",
                "file_name": "faq.pdf",
                "mime_type": "application/pdf",
                "size": 4096,
                "storage_key": "aiteam/uploads/ast_001/faq.pdf",
            },
        },
    ]
    assert "上传成功" in result["feedback"]
    assert "doc_001" in result["feedback"]
    assert "ingesting" in result["feedback"]


def test_knowledge_module_refreshes_list_after_upload_success() -> None:
    result = _run_upload_lifecycle(
        {
            "ok": True,
            "status": 201,
            "data": {
                "asset_id": "ast_001",
                "name": "faq.pdf",
                "size": 4096,
                "mime_type": "application/pdf",
                "storage_key": "aiteam/uploads/ast_001/faq.pdf",
            },
        },
        {
            "ok": True,
            "status": 201,
            "data": {
                "document_id": "doc_001",
                "status": "ingesting",
                "ingestion_job_id": "ing_001",
            },
        },
        [
            {
                "ok": True,
                "status": 200,
                "data": {
                    "knowledge_bases": [
                        {
                            "knowledge_base_id": "kb_sales",
                            "name": "销售知识库",
                            "description": "销售资料",
                            "status": "active",
                            "document_count": 0,
                            "documents": [],
                            "employee_bindings": [],
                        }
                    ]
                },
            },
            {
                "ok": True,
                "status": 200,
                "data": {
                    "knowledge_bases": [
                        {
                            "knowledge_base_id": "kb_sales",
                            "name": "销售知识库",
                            "description": "销售资料",
                            "status": "active",
                            "document_count": 1,
                            "documents": [
                                {
                                    "document_id": "doc_001",
                                    "asset_id": "ast_001",
                                    "display_name": "FAQ 文档",
                                    "file_name": "faq.pdf",
                                    "file_type": "application/pdf",
                                    "file_size": 4096,
                                    "status": "ready",
                                    "chunk_count": 12,
                                }
                            ],
                            "employee_bindings": [],
                        }
                    ]
                },
            },
        ],
    )
    assert result["kbCallCount"] == 2
    assert "FAQ 文档" in result["html"]
    assert "ready" in result["html"]


def test_knowledge_module_shows_upload_error_before_document_post() -> None:
    result = _run_upload_lifecycle(
        {
            "ok": False,
            "status": 500,
            "data": None,
            "error": "upload failed",
        },
        {
            "ok": True,
            "status": 201,
            "data": {
                "document_id": "doc_001",
                "status": "ingesting",
                "ingestion_job_id": "ing_001",
            },
        },
    )
    assert result["calls"] == [
        {
            "kind": "upload",
            "body": {
                "name": "faq.pdf",
                "mime_type": "application/pdf",
                "size": 4096,
                "content_text": "FILE CONTENT",
            },
        }
    ]
    assert "上传失败" in result["feedback"]
    assert "upload failed" in result["feedback"]


def test_knowledge_module_shows_document_registration_error() -> None:
    result = _run_upload_lifecycle(
        {
            "ok": True,
            "status": 201,
            "data": {
                "asset_id": "ast_001",
                "name": "faq.pdf",
                "size": 4096,
                "mime_type": "application/pdf",
                "storage_key": "aiteam/uploads/ast_001/faq.pdf",
            },
        },
        {
            "ok": False,
            "status": 404,
            "data": None,
            "error": "KNOWLEDGE_BASE_NOT_FOUND",
        },
    )
    assert len(result["calls"]) == 2
    assert "文档登记失败" in result["feedback"]
    assert "KNOWLEDGE_BASE_NOT_FOUND" in result["feedback"]


def test_knowledge_module_renders_error_message_and_retry_button() -> None:
    result = _run_knowledge_module(
        {
            "ok": True,
            "status": 200,
            "data": {
                "knowledge_bases": [
                    {
                        "knowledge_base_id": "kb_sales",
                        "name": "销售知识库",
                        "description": "销售资料",
                        "status": "active",
                        "document_count": 1,
                        "documents": [
                            {
                                "document_id": "doc_err",
                                "asset_id": "ast_err",
                                "display_name": "失败文档",
                                "file_name": "error.pdf",
                                "file_type": "application/pdf",
                                "file_size": 2048,
                                "status": "error",
                                "error_code": "INGEST_FAILED",
                                "error_message": "insert timeout",
                            }
                        ],
                        "employee_bindings": [],
                    }
                ]
            },
        }
    )
    assert "insert timeout" in result["html"]
    assert "重试入库" in result["html"]
    assert "data-kb-retry" in result["html"]


def test_knowledge_module_retry_posts_retry_payload_and_shows_feedback() -> None:
    result = _run_retry_lifecycle(
        {
            "ok": True,
            "status": 201,
            "data": {
                "document_id": "doc_err",
                "status": "ingesting",
                "ingestion_job_id": "ing_retry",
            },
        }
    )
    assert result["calls"] == [
        {
            "kbId": "kb_sales",
            "body": {
                "asset_id": "ast_err",
                "display_name": "失败文档",
                "file_name": "error.pdf",
                "mime_type": "application/pdf",
                "size": 2048,
                "retry": True,
            },
        }
    ]
    assert "重试成功" in result["feedback"]


def test_knowledge_module_refreshes_list_after_retry_success() -> None:
    result = _run_retry_lifecycle(
        {
            "ok": True,
            "status": 201,
            "data": {
                "document_id": "doc_err",
                "status": "ingesting",
                "ingestion_job_id": "ing_retry",
            },
        },
        [
            {
                "ok": True,
                "status": 200,
                "data": {
                    "knowledge_bases": [
                        {
                            "knowledge_base_id": "kb_sales",
                            "name": "销售知识库",
                            "description": "销售资料",
                            "status": "active",
                            "document_count": 1,
                            "documents": [
                                {
                                    "document_id": "doc_err",
                                    "asset_id": "ast_err",
                                    "display_name": "失败文档",
                                    "file_name": "error.pdf",
                                    "file_type": "application/pdf",
                                    "file_size": 2048,
                                    "status": "error",
                                    "error_code": "INGEST_FAILED",
                                    "error_message": "insert timeout",
                                }
                            ],
                            "employee_bindings": [],
                        }
                    ]
                },
            },
            {
                "ok": True,
                "status": 200,
                "data": {
                    "knowledge_bases": [
                        {
                            "knowledge_base_id": "kb_sales",
                            "name": "销售知识库",
                            "description": "销售资料",
                            "status": "active",
                            "document_count": 1,
                            "documents": [
                                {
                                    "document_id": "doc_err",
                                    "asset_id": "ast_err",
                                    "display_name": "失败文档",
                                    "file_name": "error.pdf",
                                    "file_type": "application/pdf",
                                    "file_size": 2048,
                                    "status": "ready",
                                    "chunk_count": 9,
                                }
                            ],
                            "employee_bindings": [],
                        }
                    ]
                },
            },
        ],
    )
    assert result["kbCallCount"] == 2
    assert "失败文档" in result["html"]
    assert "ready" in result["html"]


def test_knowledge_module_queries_knowledge_and_renders_answer_with_citations() -> None:
    result = _run_search_lifecycle(
        {
            "ok": True,
            "status": 200,
            "data": {
                "knowledge_base_id": "kb_sales",
                "query": "入职",
                "answer": "已命中《入职手册》相关知识。",
                "citations": [{"title": "入职手册"}],
                "items": [
                    {
                        "document_id": "doc_001",
                        "title": "入职手册",
                        "snippet": "第一天请先完成账号激活与制度学习。",
                    }
                ],
            },
        }
    )
    assert result["calls"] == [{"kbId": "kb_sales", "query": "入职"}]
    assert "查询成功" in result["feedback"]
    assert "已命中《入职手册》相关知识。" in result["results"]
    assert "入职手册" in result["results"]
    assert "第一天请先完成账号激活与制度学习。" in result["results"]


def test_knowledge_module_shows_query_error() -> None:
    result = _run_search_lifecycle(
        {
            "ok": False,
            "status": 400,
            "data": None,
            "error": "MISSING_QUERY",
        }
    )
    assert result["calls"] == [{"kbId": "kb_sales", "query": "入职"}]
    assert "查询失败" in result["feedback"]
    assert "MISSING_QUERY" in result["feedback"]


def test_knowledge_module_renders_binding_form_and_patches_employee_knowledge_ids() -> None:
    result = _run_binding_lifecycle(
        {
            "ok": True,
            "status": 200,
            "data": {
                "employees": [
                    {"employee_id": "emp_member", "display_name": "成员A", "role_name": "分析师", "status": "active"},
                    {"employee_id": "emp_ops", "display_name": "成员B", "role_name": "运营", "status": "active"},
                ],
            },
        },
        {
            "ok": True,
            "status": 200,
            "data": {"employee_id": "emp_member"},
        },
    )
    assert "绑定员工" in result["html"]
    assert "kb-bind-submit" in result["html"]
    assert result["calls"] == [
        {
            "employeeId": "emp_member",
            "body": {"knowledge_base_ids": ["kb_marketing", "kb_sales"]},
        }
    ]
    assert "绑定成功" in result["feedback"]


def test_knowledge_module_shows_binding_error() -> None:
    result = _run_binding_lifecycle(
        {
            "ok": True,
            "status": 200,
            "data": {
                "employees": [
                    {"employee_id": "emp_member", "display_name": "成员A", "role_name": "分析师", "status": "active"},
                ],
            },
        },
        {
            "ok": False,
            "status": 403,
            "data": None,
            "error": "PERMISSION_DENIED",
        },
    )
    assert len(result["calls"]) == 1
    assert "绑定失败" in result["feedback"]
    assert "PERMISSION_DENIED" in result["feedback"]
