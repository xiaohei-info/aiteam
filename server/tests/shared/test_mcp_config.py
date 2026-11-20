"""shared.mcp_config 与 web/shared/src/contracts/mcp-config.test.ts 同一组用例（两边规则须一致）。"""

import json

from shared.mcp_config import parse_mcp_config, suggest_mcp_ref

CR = '''"cr-test": {
  "type": "streamableHttp",
  "url": "https://mcp-test.cycplus.com/mcp/cr-test",
  "timeout": 30000
}'''


def servers(text: str) -> dict:
    result = parse_mcp_config(text)
    assert result["ok"], result
    return result


def test_reads_snippet_without_outer_braces():
    result = servers(CR)
    assert result["rejected"] == []
    server = result["servers"][0]
    assert server["name"] == "cr-test" and server["ref"] == "cr-test" and not server["ref_adjusted"]
    assert server["url"] == "https://mcp-test.cycplus.com/mcp/cr-test" and server["timeout_ms"] == 30000
    assert not server["dropped_secret"] and "auth" not in server


def test_accepts_the_four_formats():
    assert servers("{" + CR + "}")["servers"][0]["ref"] == "cr-test"
    assert servers(CR + ",")["servers"][0]["ref"] == "cr-test"
    wrapped = {"mcpServers": {"a": {"type": "http", "url": "https://a.example.com/mcp"}, "b": {"url": "https://b.example.com/mcp"}}}
    assert [item["ref"] for item in servers(json.dumps(wrapped))["servers"]] == ["a", "b"]
    assert servers(json.dumps({"servers": {"c": {"type": "streamable-http", "url": "https://c.example.com/mcp"}}}))["servers"][0]["ref"] == "c"
    unnamed = servers(json.dumps({"type": "streamableHttp", "url": "https://mcp.example.com/mcp/notion"}))["servers"][0]
    assert (unnamed["name"], unnamed["ref"], unnamed["ref_adjusted"]) == ("", "notion", False)
    link = servers("https://mcp-test.cycplus.com/mcp/cr-test")["servers"][0]
    assert (link["name"], link["ref"], link["url"]) == ("", "cr-test", "https://mcp-test.cycplus.com/mcp/cr-test")


def test_rejects_stdio_command_and_sse_but_keeps_usable_ones():
    result = servers(json.dumps({"mcpServers": {
        "local": {"command": "npx", "args": ["x"]},
        "pipe": {"type": "stdio"},
        "events": {"type": "sse", "url": "https://e.example.com/sse"},
        "nourl": {"type": "http"},
        "ok": {"url": "https://ok.example.com/mcp"},
    }}))
    assert [item["ref"] for item in result["servers"]] == ["ok"]
    assert [item["name"] for item in result["rejected"]] == ["local", "pipe", "events", "nourl"]
    assert all("只支持 streamable HTTP" in item["reason"] for item in result["rejected"][:3])
    assert parse_mcp_config(json.dumps({"command": "uvx"}))["servers"] == []


def test_token_headers_become_bearer_and_values_are_dropped():
    text = json.dumps({"crm": {"url": "https://crm.example.com/mcp", "headers": {"X-API-Key": "super-secret-value", "X-Trace": "1"}}})
    result = servers(text)
    item = result["servers"][0]
    assert (item["auth"], item["auth_header"], item["dropped_secret"], item["ignored_headers"]) == ("bearer", "X-API-Key", True, ["X-Trace"])
    assert "super-secret-value" not in json.dumps(result)
    bearer = servers(json.dumps({"x": {"url": "https://x.example.com/mcp", "headers": {"Authorization": "Bearer abc123"}}}))["servers"][0]
    assert (bearer["auth"], bearer["auth_header"], bearer["dropped_secret"]) == ("bearer", "", True)
    assert "abc123" not in json.dumps(bearer)


def test_suggests_valid_ref_and_converts_seconds():
    item = servers(json.dumps({"My CRM Server": {"url": "https://crm.example.com/mcp", "timeout": 60}}))["servers"][0]
    assert (item["name"], item["ref"], item["ref_adjusted"], item["timeout_ms"]) == ("My CRM Server", "my-crm-server", True, 60000)
    assert servers(json.dumps({"a": {"url": "https://a.example.com/mcp", "timeout": 999999}}))["servers"][0]["timeout_ms"] == 300000
    assert suggest_mcp_ref("123 Tool") == "mcp-123-tool"
    assert suggest_mcp_ref("中文") == "mcp"


def test_explains_what_it_cannot_read():
    assert parse_mcp_config("")["ok"] is False
    assert parse_mcp_config("not json")["ok"] is False
    assert parse_mcp_config("ftp://x.example.com")["ok"] is False
    bad = parse_mcp_config(json.dumps({"a": {"url": "javascript:alert(1)"}}))
    assert bad["ok"] and bad["servers"] == [] and bad["rejected"][0]["name"] == "a"


def test_rejects_malformed_urls_and_keeps_plain_headers_out_of_auth():
    malformed = parse_mcp_config(json.dumps({"a": {"url": "::not a url::"}}))
    assert malformed["servers"] == [] and malformed["rejected"][0]["name"] == "a"
    parsed = parse_mcp_config(json.dumps({"a": {"url": "https://a.example.com/mcp", "headers": {"X-Trace": "abc"}}}))
    assert parsed["servers"][0]["ref"] == "a" and "auth" not in parsed["servers"][0] and parsed["rejected"] == []
