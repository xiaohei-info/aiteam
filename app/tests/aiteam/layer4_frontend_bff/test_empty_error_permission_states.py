from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
STATE_HELPERS_PATH = ROOT / "static" / "aiteam" / "state-helpers.js"


def _helper_source() -> str:
    return STATE_HELPERS_PATH.read_text(encoding="utf-8")


def _run_node(payload: dict) -> dict:
    script = f"""
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync({json.dumps(str(STATE_HELPERS_PATH))}, 'utf8');
global.window = {{ aiteam: {{}} }};
global.aiteam = global.window.aiteam;
vm.runInThisContext(source, {{ filename: 'state-helpers.js' }});
const container = {{ innerHTML: '' }};
let callbackData = null;
const payload = {json.dumps(payload, ensure_ascii=False)};
if (payload.mode === 'loading') {{
  aiteam.states.renderLoading(container);
}} else if (payload.mode === 'helper_names') {{
  console.log(JSON.stringify({{
    names: Object.keys(aiteam.states).sort(),
    namespaceExists: !!window.aiteam,
  }}));
  process.exit(0);
}} else {{
  aiteam.states.handleApiResult(payload.result, container, function (data) {{
    callbackData = data;
  }});
}}
console.log(JSON.stringify({{
  html: container.innerHTML,
  callbackData: callbackData,
}}));
"""
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_state_helpers_file_exists() -> None:
    assert STATE_HELPERS_PATH.exists(), f"Missing state helper file: {STATE_HELPERS_PATH}"


def test_empty_state_rendered_when_no_data() -> None:
    result = _run_node({"mode": "handle", "result": {"ok": True, "status": 200, "data": []}})
    assert "aiteam-state aiteam-state-empty" in result["html"]
    assert "暂无数据" in result["html"]
    assert result["callbackData"] is None


def test_error_state_rendered_on_api_failure() -> None:
    result = _run_node({"mode": "handle", "result": {"ok": False, "status": 500, "error": "服务异常"}})
    assert "aiteam-state aiteam-state-error" in result["html"]
    assert "服务异常" in result["html"]


def test_error_state_falls_back_to_status_message() -> None:
    result = _run_node({"mode": "handle", "result": {"ok": False, "status": 502, "error": ""}})
    assert "aiteam-state aiteam-state-error" in result["html"]
    assert "请求失败 (502)" in result["html"]


def test_permission_denied_state_rendered_on_403() -> None:
    result = _run_node({"mode": "handle", "result": {"ok": False, "status": 403, "error": "forbidden"}})
    assert "aiteam-state aiteam-state-denied" in result["html"]
    assert "您没有权限访问此内容" in result["html"]


def test_loading_helper_and_expected_symbols_exist() -> None:
    helper_names = _run_node({"mode": "helper_names"})
    assert helper_names["namespaceExists"] is True
    assert helper_names["names"] == [
        "handleApiResult",
        "renderEmpty",
        "renderError",
        "renderInfo",
        "renderLoading",
        "renderPermissionDenied",
    ]

    result = _run_node({"mode": "loading"})
    assert "aiteam-state aiteam-state-loading" in result["html"]
    assert "加载中..." in result["html"]


def test_success_result_calls_callback_without_rendering_state() -> None:
    result = _run_node({
        "mode": "handle",
        "result": {"ok": True, "status": 200, "data": {"conversation_id": "conv_001"}},
    })
    assert result["html"] == ""
    assert result["callbackData"] == {"conversation_id": "conv_001"}


def test_source_declares_global_namespace() -> None:
    source = _helper_source()
    assert "window.aiteam = window.aiteam || {};" in source
    assert "aiteam.states = {" in source
