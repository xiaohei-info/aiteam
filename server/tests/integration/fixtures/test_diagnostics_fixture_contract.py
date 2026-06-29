"""P1-F7 契约：失败诊断不泄露 secret / 会话正文 / 文件正文 / 工具 I/O（纯逻辑，无 PG）。

锁住 closeout DAG §8 统一诊断纪律。
"""

from __future__ import annotations

import json

from tests.integration.fixtures.diagnostics import (
    REDACTED,
    DiagnosticLayer,
    FailureDiagnostics,
    assert_no_sensitive_leak,
    capture_problem_json,
    redact,
    redact_text,
)


def test_redact_masks_sensitive_keys():
    out = redact(
        {
            "tenant_id": "t-1",
            "service_token": "sk-supersecret",
            "Authorization": "Bearer abc.def",
            "private_pem": "-----BEGIN PRIVATE KEY-----",
            "nested": {"api_key": "ak-123", "ok": "visible"},
        }
    )
    assert out["tenant_id"] == "t-1"
    assert out["service_token"] == REDACTED
    assert out["Authorization"] == REDACTED
    assert out["private_pem"] == REDACTED
    assert out["nested"]["api_key"] == REDACTED
    assert out["nested"]["ok"] == "visible"


def test_redact_masks_cookie_and_session_keys():
    """认证/会话类 secret（cookie/session/session_id）必须整值脱敏（Python↔TS 对齐）。"""
    out = redact(
        {
            "cookie": "sessionid=s3cr3t",
            "Authorization": "Bearer x",
            "session_id": "sess-abc-123",
            "session": "stateful-secret",
            "tenant_id": "t-9",
        }
    )
    assert out["cookie"] == REDACTED
    assert out["Authorization"] == REDACTED
    assert out["session_id"] == REDACTED
    assert out["session"] == REDACTED
    assert out["tenant_id"] == "t-9"
    assert "s3cr3t" not in str(out)
    assert "sess-abc-123" not in str(out)


def test_redact_drops_session_file_tool_content_keys():
    out = redact(
        {
            "layer": "outbox",
            "messages": [{"role": "user", "content": "客户身份证号 1234"}],
            "tool_output": "secret tool result",
            "file_content": "proprietary doc body",
            "kept": 1,
        }
    )
    assert "messages" not in out
    assert "tool_output" not in out
    assert "file_content" not in out
    assert out["kept"] == 1


def test_capture_problem_json_keeps_only_locator_fields():
    cap = capture_problem_json(
        403,
        {
            "type": "https://errors/forbidden",
            "title": "Forbidden",
            "detail": "user 客户会话正文不该带进来",
            "instance": "/api/...",
            "status": 403,
        },
    )
    assert cap == {
        "status": 403,
        "problem_json": True,
        "type": "https://errors/forbidden",
        "title": "Forbidden",
    }
    assert "detail" not in cap
    assert "instance" not in cap


def test_capture_problem_json_non_dict_body_no_passthrough():
    cap = capture_problem_json(500, "<!doctype html><body>oops secret</body>")
    assert cap == {"status": 500, "problem_json": False}
    assert "secret" not in json.dumps(cap)


def test_failure_diagnostics_record_is_clean():
    diag = FailureDiagnostics(
        layer=DiagnosticLayer.AUTH,
        summary="service token negative did not 401",
        tenant_id="t-9",
        current_user="app_rw",
        problem=capture_problem_json(401, {"type": "x", "title": "Unauthorized", "status": 401}),
    )
    diag.add_context(
        attempted_token="sk-leak-me",  # 命中 token -> 脱敏
        messages=["会话正文不该出现"],  # 命中内容键 -> 丢弃
        observed_status=401,
    )
    record = diag.to_dict()
    assert record["layer"] == "auth"
    assert record["current_user"] == "app_rw"
    assert record["context"]["observed_status"] == 401
    assert record["context"]["attempted_token"] == REDACTED
    assert "messages" not in record["context"]
    # 硬验：已知 secret 与禁止键名都不在序列化文本里。
    assert_no_sensitive_leak(record, secrets=("sk-leak-me", "会话正文不该出现"))


def test_assert_no_sensitive_leak_catches_a_leak():
    bad = {"context": {"note": "token=sk-plain-leak"}}  # 值里夹带 secret 字面量
    raised = False
    try:
        assert_no_sensitive_leak(bad, secrets=("sk-plain-leak",))
    except AssertionError:
        raised = True
    assert raised


def test_redact_scalar_with_sensitive_key_and_nested_list():
    # 标量直接带敏感 key -> 脱敏。
    assert redact("plain-secret-value", "access_token") == REDACTED
    # 非敏感 key 下的列表逐元素递归（含内层敏感 dict）。
    out = redact({"actors": [{"password": "p"}, {"name": "ok"}]})
    assert out["actors"][0]["password"] == REDACTED
    assert out["actors"][1]["name"] == "ok"


def test_assert_no_sensitive_leak_catches_forbidden_content_key():
    # 文本里出现被禁内容键名（如 messages）即判泄露。
    raised = False
    try:
        assert_no_sensitive_leak({"note": "dumped messages here"})
    except AssertionError:
        raised = True
    assert raised


def test_summary_free_text_secret_literals_scrubbed():
    """summary 自由文本里的 Bearer / 敏感 key=value 字面量必须脱敏（与 TS 同口径）。"""
    assert redact_text("x Bearer abc.def-123 y") == f"x Bearer {REDACTED} y"
    assert redact_text("denied token=sk-leak password: hunter2") == (
        f"denied token={REDACTED} password:{REDACTED}"
    )
    assert redact_text("plain message no secrets") == "plain message no secrets"
    assert redact_text(None) is None

    # reviewer 复审 probe：Bearer 后任意非空白 token（含 *** 占位）都必须脱敏。
    scrubbed = redact_text("request denied: Bearer *** token=sk-sum-leak password=hunter2")
    assert "***" not in scrubbed
    assert "sk-sum-leak" not in scrubbed
    assert "hunter2" not in scrubbed
    assert scrubbed == f"request denied: Bearer {REDACTED} token={REDACTED} password={REDACTED}"

    diag = FailureDiagnostics(
        layer=DiagnosticLayer.AUTH,
        summary="login failed token=sk-summary-leak for Bearer eyJabc.def",
    )
    record = diag.to_dict()
    assert "sk-summary-leak" not in str(record)
    assert "eyJabc.def" not in str(record)
    assert record["context"] == {}


def test_all_layers_serialize():
    for layer in DiagnosticLayer:
        d = FailureDiagnostics(layer=layer, summary="x").to_dict()
        assert d["layer"] == layer.value
