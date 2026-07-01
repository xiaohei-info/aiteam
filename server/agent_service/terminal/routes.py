"""Terminal command-execution northbound routes (issue #415).

POST /conversations/{id}/terminal/execute -> runs one bash command, streams normalized
events back over SSE (command_started / command_output / completed | error | cancelled).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Callable

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.auth import TokenClaims
from shared.errors import Unauthorized

from .service import TerminalService


class ExecuteCommandRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command: str = Field(min_length=1, description="bash command to execute")
    timeout_seconds: float | None = Field(
        default=None, ge=0,
        description="overall timeout in seconds (optional)",
    )


def _sse(event_name: str, data: dict) -> str:
    return f"event: {event_name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _stream(service: TerminalService, command: str, timeout_seconds):
    queue: asyncio.Queue = asyncio.Queue()

    async def on_event(ev) -> None:
        await queue.put(ev)

    run_task = asyncio.create_task(
        service.execute(command, on_event, timeout_seconds=timeout_seconds)
    )
    try:
        while True:
            ev = await queue.get()
            yield _sse("terminal.event", {
                "type": ev.type,
                "run_id": ev.run_id,
                "source": ev.source,
                "timestamp": ev.timestamp.isoformat() if ev.timestamp else None,
                "payload": ev.payload,
            })
            if ev.type in {"completed", "error", "cancelled"}:
                break
    finally:
        if not run_task.done():
            run_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await run_task


def _require_identity(identity_provider):
    if identity_provider is None:
        return
    if identity_provider() is None:
        raise Unauthorized("no valid local session")


def build_terminal_router(
    service: TerminalService,
    *,
    identity_provider: Callable[[], TokenClaims | None] | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent-terminal"])

    @router.post(
        "/conversations/{conversation_id}/terminal/execute",
        summary="Run one command in local Agent (SSE)",
        description="Runs a bash command through Gateway TerminalDriver/TerminalExecutor in an "
        "isolated cwd; stdout/stderr normalized and streamed over SSE.",
        operation_id="agent_terminal_execute",
    )
    async def execute_command(conversation_id: str, req: ExecuteCommandRequest):
        _require_identity(identity_provider)
        return StreamingResponse(
            _stream(service, req.command, req.timeout_seconds),
            media_type="text/event-stream",
        )

    return router


__all__ = ["build_terminal_router", "ExecuteCommandRequest"]
