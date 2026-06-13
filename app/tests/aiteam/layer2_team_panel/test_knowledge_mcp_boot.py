"""Task 6 — knowledge MCP listener 冒烟 + 端到端 tool 调用。"""

from __future__ import annotations

import pytest


def test_boot_module_imports_and_builds():
    from api.knowledge_mcp_boot import start_knowledge_mcp  # noqa: F401
    from team_panel.integration.knowledge_mcp_server import build_asgi_app
    app = build_asgi_app(conn_factory=lambda: None, host="127.0.0.1", port=9799)
    assert app is not None


@pytest.mark.asyncio
async def test_knowledge_search_tool_via_in_memory_client(monkeypatch):
    """端到端：经 MCP 协议带 Bearer 调 knowledge_search，断言授权解析生效。"""
    from mcp.shared.memory import create_connected_server_and_client_session

    from team_panel.integration import knowledge_mcp_server as kms

    # 用假 conn + 假检索，隔离 DB/embedding，只验证 MCP 装配与授权路径。
    monkeypatch.setattr(kms, "resolve_employee_kb_ids", lambda conn, eid: ["kb_x"] if eid == "emp_1" else [])
    monkeypatch.setattr(kms.lightrag_service, "query",
                        lambda kb, q, top_k=5, llm_provider=None: {
                            "chunks": [{"content": "命中片段", "doc_id": "d", "file_name": "f", "score": 1.0}]})

    server = kms.build_mcp_server(conn_factory=lambda: object())
    async with create_connected_server_and_client_session(server._mcp_server) as client:
        # 工具已注册。
        tools = await client.list_tools()
        assert any(t.name == "knowledge_search" for t in tools.tools)
        # 不带 token（内存传输无 HTTP header）→ 授权失败，结果含 unauthenticated。
        res = await client.call_tool("knowledge_search", {"query": "hi"})
        serialized = str(getattr(res, "structuredContent", None)) + str(getattr(res, "content", None))
        assert "unauthenticated" in serialized
