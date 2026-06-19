"""Driver 底座验收（06 §7.5.4）：custom_args denylist + 事件包装 + run 作用域 MCP materialize。"""

import json
import os

from agent_gateway.drivers.base import _BaseDriver, materialize_mcp_config
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.runspec import McpServerConfig


class _Probe(_BaseDriver):
    """最小子类，仅用于测试底座行为。"""

    runtime_name = "probe"

    def capabilities(self):  # pragma: no cover - 未在本测试断言
        raise NotImplementedError

    def build_command(self, run_spec):  # pragma: no cover
        raise NotImplementedError

    def extract_session_id(self, raw):  # pragma: no cover
        return None

    def extract_usage(self, raw):  # pragma: no cover
        return None

    def _map_raw(self, raw):
        if raw.get("type") == "say":
            return "text_delta", {"text": raw.get("text", "")}
        return None


def test_filter_custom_args_drops_denied_flag_and_value():
    d = _Probe()
    out = d.filter_custom_args(
        ["--mcp-config", "/evil.json", "--keep", "v", "--system-prompt", "x"]
    )
    assert out == ["--keep", "v"]


def test_filter_custom_args_drops_denied_with_equals():
    d = _Probe()
    assert d.filter_custom_args(["--model=gpt", "--resume=sid", "--ok=1"]) == [
        "--model=gpt",
        "--ok=1",
    ]


def test_filter_custom_args_honors_extra_denylist():
    class _D(_Probe):
        extra_arg_denylist = frozenset({"--brand-danger"})

    assert _D().filter_custom_args(["--brand-danger", "x", "--fine"]) == ["--fine"]


def test_parse_event_wraps_with_seq_and_source():
    d = _Probe()
    e1 = d.parse_event({"type": "say", "text": "a", "run_id": "r1"})
    e2 = d.parse_event({"type": "say", "text": "b", "run_id": "r1"})
    assert isinstance(e1, AgentRuntimeEvent)
    assert e1.source == "probe" and e1.run_id == "r1"
    assert e1.seq == 1 and e2.seq == 2  # 单 run 内单调递增
    assert e1.type == "text_delta" and e1.payload == {"text": "a"}


def test_parse_event_returns_none_for_unmappable_and_non_dict():
    d = _Probe()
    assert d.parse_event({"type": "unknown"}) is None
    assert d.parse_event("not-a-dict") is None
    assert d.parse_event(None) is None


def test_materialize_mcp_config_writes_run_scoped_file():
    cfg = [
        McpServerConfig(name="kb", command="lightrag-mcp", args=["--idx", "x"], env={"K": "v"}),
        McpServerConfig(name="conn", url="http://127.0.0.1:9000"),
    ]
    path = materialize_mcp_config(cfg)
    try:
        assert path and os.path.exists(path)
        data = json.loads(open(path, encoding="utf-8").read())
        assert set(data["mcpServers"]) == {"kb", "conn"}
        assert data["mcpServers"]["kb"]["command"] == "lightrag-mcp"
        assert data["mcpServers"]["kb"]["env"] == {"K": "v"}
        assert data["mcpServers"]["conn"]["url"] == "http://127.0.0.1:9000"
        # 落在系统临时目录（run 作用域），不碰任何共享 profile。
        import tempfile

        assert path.startswith(tempfile.gettempdir())
    finally:
        if path:
            os.unlink(path)


def test_materialize_mcp_config_empty_returns_none():
    assert materialize_mcp_config([]) is None
