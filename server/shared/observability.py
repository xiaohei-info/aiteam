"""可观测性底座（CLAUDE/AGENTS §13）。

- request_id / trace_id 注入并贯穿日志；结构化日志强制带 request_id/trace_id/service。
- 跨端 pull 透传 trace_id（service_client 负责，05）；运行明细不跨端。

OpenTelemetry / Prometheus 接入留各端按需扩展；本模块提供 request 上下文注入与 request_id / trace_id 贯穿的结构化日志。
"""

from __future__ import annotations

import contextvars
import logging
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

_REQUEST_ID_HEADER = "X-Request-ID"
_TRACE_ID_HEADER = "X-Trace-ID"

_request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
_trace_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("trace_id", default=None)


def get_request_id() -> str | None:
    return _request_id_var.get()


def get_trace_id() -> str | None:
    return _trace_id_var.get()


def get_propagation_headers() -> dict[str, str]:
    """Create a fresh W3C child span header for a downstream request."""
    trace_id = _trace_id_var.get()
    if not isinstance(trace_id, str) or len(trace_id) != 32:
        trace_id = uuid.uuid4().hex
    request_id = _request_id_var.get()
    return {
        "traceparent": f"00-{trace_id}-{uuid.uuid4().hex[:16]}-01",
        **({"X-Request-ID": request_id} if request_id else {}),
    }


class RequestContextMiddleware(BaseHTTPMiddleware):
    """为每个请求分配/透传 request_id 与 trace_id，写入 request.state 与响应头。"""

    async def dispatch(self, request: Request, call_next):  # noqa: ANN001, ANN201
        request_id = request.headers.get(_REQUEST_ID_HEADER) or f"req_{uuid.uuid4().hex}"
        trace_id = request.headers.get(_TRACE_ID_HEADER) or f"trace_{uuid.uuid4().hex}"
        request.state.request_id = request_id
        request.state.trace_id = trace_id
        token_r = _request_id_var.set(request_id)
        token_t = _trace_id_var.set(trace_id)
        try:
            response = await call_next(request)
        finally:
            _request_id_var.reset(token_r)
            _trace_id_var.reset(token_t)
        response.headers[_REQUEST_ID_HEADER] = request_id
        response.headers[_TRACE_ID_HEADER] = trace_id
        return response


def configure_logging(service_name: str, level: str = "INFO") -> None:
    """最简结构化日志：每条带 service。request_id/trace_id 由各日志点经 get_* 取用。"""
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format=f"%(asctime)s %(levelname)s service={service_name} %(name)s %(message)s",
    )
