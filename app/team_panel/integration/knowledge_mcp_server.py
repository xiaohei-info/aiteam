"""Knowledge retrieval exposed as an MCP tool (Agentic RAG).

Per 调研方案 D2/D4：AI Team 同进程内的 FastMCP streamable-http 服务，暴露唯一
只读工具 ``knowledge_search(query, top_k?)``。员工身份走连接级凭据
``Authorization: Bearer <employee_id>``（服务绑定 127.0.0.1 回环，模型无法篡改
header，故 employee_id 直接作为可信身份）。服务端按员工解析其 enabled 知识库绑定
后检索并合并，KB 范围绝不由模型传入。

纯函数（``parse_bearer_token`` / ``resolve_employee_kb_ids`` /
``search_for_employee``）与 FastMCP 装配分离，便于单测。
"""

from __future__ import annotations

import logging

from mcp.server.fastmcp import Context, FastMCP

from team_panel.integration import lightrag_service
from team_panel.transactions.db import create_connection
from team_panel.transactions.uow import UnitOfWork

logger = logging.getLogger(__name__)

MCP_SERVER_NAME = "aiteam-knowledge"


def parse_bearer_token(header_value: str | None) -> str:
    """Extract the employee_id from an ``Authorization: Bearer <id>`` header."""
    if not header_value:
        return ""
    parts = str(header_value).split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return ""


def resolve_employee_kb_ids(conn, employee_id: str) -> list[str]:
    """Return the enabled knowledge-base ids bound to this employee."""
    if not employee_id:
        return []
    with UnitOfWork(conn) as uow:
        bindings = uow.employee_knowledge_bindings().list_by_employee(employee_id)
    return [
        b.knowledge_base_id for b in bindings
        if getattr(b, "enabled", True) and getattr(b, "knowledge_base_id", "")
    ]


def search_for_employee(conn, employee_id: str, query: str,
                        top_k: int = 5) -> dict:
    """Retrieve across the employee's bound KBs and merge results.

    Returns ``{"chunks": [...], "citations": [...]}``. Authorization is by
    employee → KB binding; the caller never supplies a kb_id.
    """
    query = (query or "").strip()
    if not query:
        return {"chunks": [], "citations": []}
    kb_ids = resolve_employee_kb_ids(conn, employee_id)
    chunks: list[dict] = []
    citations: list[dict] = []
    for kb_id in kb_ids[:5]:
        try:
            result = lightrag_service.query(kb_id, query, top_k=top_k)
        except Exception as exc:  # noqa: BLE001 — retrieval is best-effort
            logger.warning("[knowledge-mcp] kb %s query failed: %s", kb_id, exc)
            continue
        for ch in result.get("chunks", []):
            content = (ch.get("content") or "").strip()
            if not content:
                continue
            source = ch.get("file_name") or ch.get("doc_id") or kb_id
            chunks.append({
                "content": content,
                "doc_id": ch.get("doc_id") or "",
                "file_name": source,
                "kb_id": kb_id,
                "score": ch.get("score") or 0.0,
            })
            citations.append({
                "knowledge_base_id": kb_id,
                "document_id": ch.get("doc_id") or "",
                "title": source,
                "snippet": content[:200],
                "source_type": "knowledge_document",
            })
    # 多 KB 合并后按 score 降序，截断到 top_k。
    chunks.sort(key=lambda c: c.get("score") or 0.0, reverse=True)
    return {"chunks": chunks[:top_k], "citations": citations[:top_k]}


# ── FastMCP wiring (streamable-http) ──────────────────────────────────────

def _employee_from_context(ctx) -> str:
    """Best-effort extraction of the Bearer employee_id from the HTTP request."""
    try:
        request = ctx.request_context.request  # Starlette Request under HTTP
        header = request.headers.get("authorization")
    except Exception:  # noqa: BLE001 — non-HTTP transport / missing context
        return ""
    return parse_bearer_token(header)


def build_mcp_server(conn_factory=create_connection, *, host: str = "127.0.0.1",
                     port: int = 9701):
    """Construct the FastMCP server exposing ``knowledge_search``."""
    # FastMCP resolves tool annotations via eval against module globals, so
    # FastMCP/Context must be importable at module scope (see top of file).
    mcp = FastMCP(MCP_SERVER_NAME, host=host, port=port)

    @mcp.tool(
        description="检索当前数字员工被授权的企业知识库，返回相关片段。"
                    "仅在需要企业内部知识时调用；只需提供 query。"
    )
    def knowledge_search(query: str, top_k: int = 5, ctx: Context = None) -> dict:
        employee_id = _employee_from_context(ctx)
        if not employee_id:
            return {"error": "unauthenticated",
                    "message": "missing or invalid Authorization bearer token"}
        conn = conn_factory()
        try:
            return search_for_employee(conn, employee_id, query, top_k)
        except Exception as exc:  # noqa: BLE001 — surface as structured error
            logger.exception("[knowledge-mcp] search failed")
            return {"error": "knowledge_unavailable", "message": str(exc)[:200]}
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    return mcp


def build_asgi_app(conn_factory=create_connection, *, host: str = "127.0.0.1",
                   port: int = 9701):
    """Return the streamable-http ASGI app for mounting/serving."""
    return build_mcp_server(conn_factory, host=host, port=port).streamable_http_app()
