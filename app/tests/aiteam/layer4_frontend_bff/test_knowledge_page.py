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


def _run_upload_lifecycle(upload_result: dict, document_result: dict) -> dict:
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
  'kb-upload-select': makeElement({{ value: 'kb_sales' }}),
  'kb-upload-file-name': makeElement({{ value: 'faq.pdf' }}),
  'kb-upload-mime-type': makeElement({{ value: 'application/pdf' }}),
  'kb-upload-size': makeElement({{ value: '4096' }}),
  'kb-upload-display-name': makeElement({{ value: 'FAQ 文档' }}),
  'kb-upload-submit': makeElement(),
  'kb-upload-feedback': makeElement(),
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
        document_count: 0,
        documents: [],
        employee_bindings: [],
      }}],
    }},
  }});
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
    assert "kb-upload-file-name" in result["html"]


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
