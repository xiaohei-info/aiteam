from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AITEAM_STATIC = ROOT / "static" / "aiteam"
PAGES_DIR = AITEAM_STATIC / "pages"
API_CLIENT_PATH = AITEAM_STATIC / "api-client.js"
CHAT_MODULE_PATH = PAGES_DIR / "app-chat.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _run_chat_module(payload: dict) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const apiClientSource = fs.readFileSync({json.dumps(str(API_CLIENT_PATH))}, 'utf8');
const moduleSource = fs.readFileSync({json.dumps(str(CHAT_MODULE_PATH))}, 'utf8');
const calls = [];
const payload = {json.dumps(payload)};
const queue = (payload.responses || []).slice();

function makeButton() {{
  return {{
    _handlers: {{}},
    addEventListener(name, handler) {{ this._handlers[name] = handler; }},
    dispatch(name) {{ if (this._handlers[name]) this._handlers[name]({{ preventDefault() {{}} }}); }},
    focus() {{}},
    querySelector() {{ return null; }},
    closest() {{ return null; }},
    getAttribute() {{ return null; }},
  }};
}}

function makeInteractiveBlock(extra = {{}}) {{
  return {{
    innerHTML: '',
    _handlers: {{}},
    addEventListener(name, handler) {{ this._handlers[name] = handler; }},
    dispatch(name) {{ if (this._handlers[name]) this._handlers[name]({{ preventDefault() {{}} }}); }},
    focus() {{}},
    querySelector() {{ return null; }},
    closest() {{ return null; }},
    getAttribute() {{ return null; }},
    ...extra,
  }};
}}

function flushPromises() {{
  return new Promise((resolve) => setImmediate(resolve));
}}

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

global.fetch = async (url, options) => {{
  calls.push({{ url, method: options.method, body: options.body ? JSON.parse(options.body) : null }});
  const next = queue.shift() || {{ ok: true, status: 200, body: {{ ok: true }} }};
  return {{
    ok: next.ok,
    status: next.status,
    statusText: next.statusText || 'OK',
    async text() {{ return JSON.stringify(next.body); }},
  }};
}};

global.window = {{ aiteam: {{ util: {{ escapeHtml(value) {{ return String(value == null ? '' : value); }} }} }} }};
global.aiteam = global.window.aiteam;
global.document = {{ baseURI: 'http://localhost/app/chat/conv_demo', querySelector() {{ return null; }} }};
vm.runInThisContext(apiClientSource, {{ filename: 'api-client.js' }});
window.aiteam.timeline = {{
  last: null,
  connect(runId, cursor, handler, options) {{ this.last = {{ runId, cursor, options: options || null }}; this.handler = handler; this.options = options || null; }},
  disconnect() {{ this.disconnected = true; }},
}};
vm.runInThisContext(moduleSource, {{ filename: 'app-chat.js' }});

(async () => {{
  const transcript = makeInteractiveBlock({{ scrollTop: 0, scrollHeight: 100 }});
  const history = makeInteractiveBlock();
  const status = {{ textContent: '' }};
  const quoteBanner = makeInteractiveBlock();
  const pendingAttachments = makeInteractiveBlock({{ querySelector(selector) {{ return selector === '[data-chat-clear-attachments]' ? makeButton() : null; }} }});
  const summary = {{ innerHTML: '' }};
  const hero = {{ innerHTML: '' }};
  const input = {{ value: payload.inputValue || '', focus() {{ this.focused = true; }} }};
  const form = makeButton();
  const quoteBtn = makeButton();
  const retryBtn = makeButton();
  const abortBtn = makeButton();
  const attachBtn = makeButton();
  const loadMoreBtn = makeButton();
  const container = {{
    innerHTML: '',
    querySelector(selector) {{
      const refs = {{
        '[data-chat-history]': history,
        '[data-chat-transcript]': transcript,
        '[data-chat-status]': status,
        '[data-chat-quote-banner]': quoteBanner,
        '[data-chat-pending-attachments]': pendingAttachments,
        '[data-chat-input]': input,
        '[data-chat-summary]': summary,
        '[data-chat-hero]': hero,
        '[data-chat-form]': form,
        '[data-chat-quote]': quoteBtn,
        '[data-chat-retry]': retryBtn,
        '[data-chat-abort]': abortBtn,
        '[data-chat-attach]': attachBtn,
        '[data-chat-load-more]': loadMoreBtn,
      }};
      return refs[selector] || null;
    }},
  }};

  aiteam.pages.appChat.render(container, payload.conversation);
  await flushPromises();
  await flushPromises();

  if (payload.action === 'attach') {{
    attachBtn.dispatch('click');
    await flushPromises();
    await flushPromises();
  }} else if (payload.action === 'send') {{
    form.dispatch('submit');
    await flushPromises();
    await flushPromises();
    await flushPromises();
  }} else if (payload.action === 'attach_then_send') {{
    attachBtn.dispatch('click');
    await flushPromises();
    await flushPromises();
    form.dispatch('submit');
    await flushPromises();
    await flushPromises();
    await flushPromises();
  }} else if (payload.action === 'retry') {{
    retryBtn.dispatch('click');
    await flushPromises();
    await flushPromises();
  }} else if (payload.action === 'abort') {{
    abortBtn.dispatch('click');
    await flushPromises();
    await flushPromises();
  }} else if (payload.action === 'invoke_reconnect') {{
    if (window.aiteam.timeline.options && typeof window.aiteam.timeline.options.onReconnect === 'function') {{
      window.aiteam.timeline.options.onReconnect(payload.reconnectCursor || 8);
      await flushPromises();
    }}
  }}

  console.log(JSON.stringify({{
    transcriptHtml: transcript.innerHTML,
    statusText: status.textContent,
    pendingAttachmentsHtml: pendingAttachments.innerHTML,
    calls,
    timeline: window.aiteam.timeline.last ? {{
      runId: window.aiteam.timeline.last.runId,
      cursor: window.aiteam.timeline.last.cursor,
      options: window.aiteam.timeline.last.options ? {{
        onReconnect: typeof window.aiteam.timeline.last.options.onReconnect === 'function',
        onOpen: typeof window.aiteam.timeline.last.options.onOpen === 'function',
      }} : null,
    }} : null,
    disconnected: !!window.aiteam.timeline.disconnected,
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


def _conversation_fixture() -> dict:
    return {
        "conversation_id": "conv_demo",
        "status": "active",
        "display_state": "resolved",
        "message_count": 2,
        "employee_ref": {"employee_id": "emp_demo", "display_name": "Rex"},
        "employee_summary": {
            "employee_id": "emp_demo",
            "display_name": "Rex",
            "role_name": "研究助理",
            "status": "active",
            "model_provider": "newapi",
            "model_name": "gpt-5.4",
            "usage_summary": {"total_runs": 3, "status_counts": {"succeeded": 2}},
            "skills": ["web-search"],
            "knowledge_bases": ["市场周报"],
        },
        "latest_run": {"run_id": "run_live", "status": "running"},
        "last_message_preview": {"event_cursor": 8, "preview": "已整理市场变化"},
        "messages": {
            "items": [
                {
                    "message_id": "msg_1",
                    "role": "user",
                    "sender_id": "usr_1",
                    "created_at": "2026-06-07T10:00:00Z",
                    "text": "请结合附件继续分析",
                    "quote": {"preview": "上一轮摘要"},
                    "attachments": [
                        {
                            "asset_id": "ast_1",
                            "name": "brief.pdf",
                            "mime_type": "application/pdf",
                            "size": 2048,
                            "preview_url": "/api/team/uploads/ast_1/preview",
                        }
                    ],
                    "citations": [],
                    "metadata": {"quote_message_id": "msg_prev"},
                },
                {
                    "message_id": "msg_2",
                    "role": "assistant",
                    "sender_id": "emp_demo",
                    "created_at": "2026-06-07T10:01:00Z",
                    "text": "我先读取文档，再给出结论。",
                    "quote": None,
                    "attachments": [],
                    "citations": [{"title": "市场周报"}],
                    "metadata": {"summary": "初步判断已完成"},
                },
            ],
            "next_cursor": 2,
            "has_more": False,
        },
    }


def test_chat_page_source_mentions_retry_abort_and_attachment_contract_helpers() -> None:
    source = _read(CHAT_MODULE_PATH)
    for snippet in [
        "pendingAttachments",
        "ns.api.retryRun",
        "ns.api.abortRun",
        "data-chat-pending-attachments",
        "run_cancelled",
        "run_waiting_human",
        "routing_decided",
        "查看入参",
        "SSE 连接中断",
    ]:
        assert snippet in source, f"Missing expected chat rendering snippet: {snippet}"


def test_chat_page_renders_quote_attachment_and_tool_card_html() -> None:
    payload = {
        "conversation": _conversation_fixture(),
    }
    result = _run_chat_module(payload)
    assert "引用：上一轮摘要" in result["transcriptHtml"]
    assert "brief.pdf" in result["transcriptHtml"]
    assert "预览" in result["transcriptHtml"]
    assert "市场周报" in result["transcriptHtml"]


def test_chat_page_tool_call_card_is_interpretable() -> None:
    conversation = _conversation_fixture()
    conversation["display_state"] = "streaming"
    payload = {
        "conversation": conversation,
        "responses": [
            {
                "ok": True,
                "status": 200,
                "body": {
                    "items": [
                        {
                            "event_cursor": 9,
                            "event_type": "tool_call",
                            "preview": "读取附件中",
                            "payload": {
                                "tool_name": "document_reader",
                                "status": "running",
                                "args": {"asset_id": "ast_1"},
                                "result": {"pages": 2},
                                "duration": "320ms",
                            },
                        }
                    ]
                },
            }
        ],
    }
    result = _run_chat_module(payload)
    assert "工具调用 · document_reader" in result["transcriptHtml"]
    assert "执行中" in result["transcriptHtml"]
    assert "查看入参" in result["transcriptHtml"]
    assert "pages" in result["transcriptHtml"]


def test_chat_page_timeline_status_notices_cover_streaming_recovery_and_waiting_human() -> None:
    conversation = _conversation_fixture()
    conversation["display_state"] = "streaming"
    payload = {
        "conversation": conversation,
        "responses": [
            {
                "ok": True,
                "status": 200,
                "body": {
                    "items": [
                        {
                            "event_cursor": 9,
                            "event_type": "routing_decided",
                            "preview": "已切换到研究助理继续处理",
                        },
                        {
                            "event_cursor": 10,
                            "event_type": "run_waiting_human",
                            "preview": "需要你确认关注的竞品名单",
                        },
                    ]
                },
            }
        ],
    }
    result = _run_chat_module(payload)
    assert "路由已决定" in result["transcriptHtml"]
    assert "等待人工输入" in result["transcriptHtml"]
    assert "需要你确认关注的竞品名单" in result["transcriptHtml"]
    assert result["timeline"]["options"] is not None
    assert result["timeline"]["options"]["onReconnect"] is True
    assert result["timeline"]["options"]["onOpen"] is True


def test_chat_page_attach_then_send_posts_uploaded_asset_refs() -> None:
    payload = {
        "conversation": _conversation_fixture(),
        "inputValue": "请分析附件",
        "responses": [
            {
                "ok": True,
                "status": 201,
                "body": {
                    "asset_id": "ast_new",
                    "name": "meeting-notes.txt",
                    "size": 128,
                    "mime_type": "text/plain",
                    "preview_url": "/api/team/uploads/ast_new/preview",
                },
            },
            {
                "ok": True,
                "status": 201,
                "body": {"run_id": "run_new"},
            },
            {
                "ok": True,
                "status": 200,
                "body": _conversation_fixture(),
            },
            {
                "ok": True,
                "status": 200,
                "body": {"items": []},
            },
        ],
        "action": "attach_then_send",
    }
    result = _run_chat_module(payload)
    assert result["calls"][0]["url"] == "/api/team/uploads"
    run_call = next(call for call in result["calls"] if call["url"] == "/api/team/runs")
    attachments = run_call["body"]["message"]["attachments"]
    assert attachments[0]["asset_id"] == "ast_new"
    assert attachments[0]["preview_url"] == "/api/team/uploads/ast_new/preview"


def test_chat_page_retry_and_abort_use_team_panel_run_routes() -> None:
    retry_result = _run_chat_module(
        {
            "conversation": _conversation_fixture(),
            "responses": [
                {"ok": True, "status": 201, "body": {"run_id": "run_retry"}},
                {"ok": True, "status": 200, "body": _conversation_fixture()},
                {"ok": True, "status": 200, "body": {"items": []}},
            ],
            "action": "retry",
        }
    )
    assert any(call["url"] == "/api/team/runs/run_live/retry" for call in retry_result["calls"])
    assert retry_result["timeline"]["runId"] == "run_retry"

    abort_result = _run_chat_module(
        {
            "conversation": _conversation_fixture(),
            "responses": [
                {"ok": True, "status": 200, "body": {"status": "cancelled", "aborted": True}},
                {"ok": True, "status": 200, "body": _conversation_fixture()},
            ],
            "action": "abort",
        }
    )
    assert any(call["url"] == "/api/team/runs/run_live/abort" for call in abort_result["calls"])
    assert abort_result["disconnected"] is True


def test_chat_page_reconnect_callbacks_surface_cursor_recovery_notice() -> None:
    conversation = _conversation_fixture()
    conversation["display_state"] = "reconnecting"
    payload = {
        "conversation": conversation,
        "responses": [
            {"ok": True, "status": 200, "body": {"items": []}},
        ],
        "action": "invoke_reconnect",
    }
    result = _run_chat_module(payload)
    assert "SSE 连接中断，正在从 cursor 8 补拉" in result["statusText"]
    assert "自动补拉" in result["transcriptHtml"]
