"""Boot the in-process knowledge MCP listener (Agentic RAG, D2/D6).

Runs the FastMCP streamable-http ASGI app on a loopback port in a daemon
thread, sharing this process's ``lightrag_service`` registry/embedder. Hermes
employee profiles connect to it via ``url`` + ``Authorization: Bearer
<employee_id>`` (see profile_provisioner.set_profile_mcp).
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

_started = False
_lock = threading.Lock()


def start_knowledge_mcp() -> bool:
    """Idempotently start the knowledge MCP listener. Returns True if running."""
    global _started
    with _lock:
        if _started:
            return True
        from api.config import KNOWLEDGE_MCP_PORT
        from team_panel.integration.knowledge_mcp_server import build_asgi_app

        host, port = "127.0.0.1", KNOWLEDGE_MCP_PORT
        app = build_asgi_app(host=host, port=port)

        def _serve() -> None:
            import uvicorn
            uvicorn.run(app, host=host, port=port, log_level="warning")

        t = threading.Thread(target=_serve, name="knowledge-mcp", daemon=True)
        t.start()
        _started = True
        print(f'  Knowledge MCP listening on http://{host}:{port}/mcp', flush=True)
        return True
