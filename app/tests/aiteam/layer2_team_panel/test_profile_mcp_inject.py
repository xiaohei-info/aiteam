"""Task 4 — profile_provisioner.set_profile_mcp 注入 knowledge MCP。"""

from __future__ import annotations

import yaml

from agent_gateway.profile_provisioner import set_profile_mcp


def test_set_profile_mcp_writes_url_and_bearer(tmp_path):
    (tmp_path / "config.yaml").write_text("model:\n  default: gpt-4o\n", encoding="utf-8")
    ok = set_profile_mcp(tmp_path, "http://127.0.0.1:9701/mcp", "emp_42")
    assert ok is True
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text(encoding="utf-8"))
    srv = cfg["mcp_servers"]["aiteam-knowledge"]
    assert srv["url"] == "http://127.0.0.1:9701/mcp"
    assert srv["headers"]["Authorization"] == "Bearer emp_42"
    # 既有字段保留。
    assert cfg["model"]["default"] == "gpt-4o"


def test_set_profile_mcp_noop_without_token(tmp_path):
    (tmp_path / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    assert set_profile_mcp(tmp_path, "http://x/mcp", "") is False
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text(encoding="utf-8"))
    assert "mcp_servers" not in cfg
