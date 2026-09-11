"""可观测性底座（CLAUDE/AGENTS §13）。

- request_id / W3C traceparent 注入并贯穿日志；兼容 X-* 头但不回显任意调用方值。
- 跨端 pull 透传由 service_client 负责；本模块提供安全的传播上下文/兼容元数据。
- HTTP metrics 使用固定、低基数标签；不记录 query、请求体、用户/租户标识或运行时事件。

The shared layer intentionally uses only the standard library.  It exposes a
small Prometheus text renderer for the control-plane ``/metrics`` endpoint
rather than introducing a second telemetry dependency or collecting business
payloads at the HTTP boundary.
"""

from __future__ import annotations

from collections import defaultdict
import contextvars
from dataclasses import dataclass
import logging
import math
import re
import threading
import time
import uuid
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

_REQUEST_ID_HEADER = "X-Request-ID"
_TRACE_ID_HEADER = "X-Trace-ID"
_TRACEPARENT_HEADER = "traceparent"
_MAX_CONTEXT_VALUE_LENGTH = 128
_MAX_LOG_VALUE_LENGTH = 128
_MAX_METRIC_LABEL_LENGTH = 128

_REQUEST_ID_RE = re.compile(
    r"(?:req_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
)
_TRACE_ID_RE = re.compile(r"[0-9a-f]{32}")
_TRACEPARENT_RE = re.compile(
    r"(?P<version>[0-9a-f]{2})-(?P<trace_id>[0-9a-f]{32})-(?P<span_id>[0-9a-f]{16})-(?P<flags>[0-9a-f]{2})"
)
_ALLOWED_HTTP_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"})

_request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
_trace_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("trace_id", default=None)
_traceparent_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("traceparent", default=None)
_service_name_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("service_name", default=None)
_default_service_name: str | None = None
_record_factory_installed = False

logger = logging.getLogger(__name__)

# Keep the label set deliberately small and stable.  In particular, request,
# trace, and tenant identifiers must never become metric labels.
_DURATION_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, math.inf)
_METRIC_TOKEN_RE = re.compile(r"[^A-Za-z0-9_.:/{}*?\-]+")
_LOG_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f\r\n]+")
_URL_RE = re.compile(r"https?://[^\s\"']+")
_RELATIVE_QUERY_RE = re.compile(r"(?<![A-Za-z0-9])(?P<path>/[^\s\"'?]*)\?[^\s\"']+")
_SENSITIVE_VALUE_RE = re.compile(
    r"(?ix)(?P<prefix>[\"']?(?:access_token|refresh_token|token|password|passwd|secret|api[_-]?key|provider[_-]?key|authorization)[\"']?\s*[:=]\s*[\"']?(?:bearer\s+)?)"
    r"(?P<value>[^\"'\s,;}\]]+)"
)
_STANDALONE_BEARER_RE = re.compile(r"(?i)(?P<prefix>\bbearer\s+)(?P<value>[^\s,;}\]]+)")
_BODY_FIELD_RE = re.compile(
    r"(?ixs)(?P<prefix>\b(?:body|payload|prompt|content|query|input|output|message|event)\s*[:=]\s*)"
    r"(?P<value>.*)$"
)


def get_request_id() -> str | None:
    """Return the current safe request id, if called inside a request context."""

    return _request_id_var.get()


def get_trace_id() -> str | None:
    """Return the current 32-hex W3C trace id, if inside a request context."""

    return _trace_id_var.get()


def get_traceparent() -> str | None:
    """Return the current generated/validated W3C ``traceparent`` value."""

    return _traceparent_var.get()


def get_trace_headers() -> dict[str, str]:
    """Return safe trace headers for callers that can inject standard context.

    ``X-Trace-ID`` is retained only as bounded compatibility metadata.  The
    standard ``traceparent`` value is authoritative.  ``ServiceClient`` still
    owns its existing legacy-header injection and must adopt this helper in its
    own change scope for end-to-end W3C propagation.
    """

    headers: dict[str, str] = {}
    if traceparent := get_traceparent():
        headers[_TRACEPARENT_HEADER] = traceparent
    if trace_id := get_trace_id():
        headers[_TRACE_ID_HEADER] = trace_id
    return headers


def get_propagation_headers() -> dict[str, str]:
    """Return request plus trace headers without caller-controlled values."""

    headers = get_trace_headers()
    if _TRACEPARENT_HEADER not in headers:
        trace_id = _compat_trace_id(get_trace_id()) or _new_trace_id()
        headers[_TRACEPARENT_HEADER] = TraceContext(trace_id=trace_id, span_id=_new_span_id()).traceparent
    if request_id := get_request_id():
        headers[_REQUEST_ID_HEADER] = request_id
    return headers


def _new_trace_id() -> str:
    return uuid.uuid4().hex


def _new_span_id() -> str:
    return uuid.uuid4().hex[:16]


@dataclass(frozen=True)
class TraceContext:
    """Validated W3C trace context for one inbound request span."""

    trace_id: str
    span_id: str
    flags: str = "01"
    version: str = "00"

    @property
    def traceparent(self) -> str:
        return f"{self.version}-{self.trace_id}-{self.span_id}-{self.flags}"


def _parse_traceparent(value: str | None) -> tuple[str, str] | None:
    """Parse strict W3C version-00 traceparent, rejecting zero identifiers."""

    if not value or len(value) != 55:
        return None
    match = _TRACEPARENT_RE.fullmatch(value)
    if not match or match.group("version") != "00":
        return None
    trace_id = match.group("trace_id")
    span_id = match.group("span_id")
    if trace_id == "0" * 32 or span_id == "0" * 16:
        return None
    return trace_id, match.group("flags")


def _compat_trace_id(value: str | None) -> str | None:
    """Accept only a non-zero strict trace id as compatibility metadata."""

    if value and _TRACE_ID_RE.fullmatch(value) and value != "0" * 32:
        return value
    return None


def _safe_request_id(value: str | None) -> str:
    """Keep only generated-shaped request ids; otherwise mint a fresh id."""

    if value and len(value) <= _MAX_CONTEXT_VALUE_LENGTH and _REQUEST_ID_RE.fullmatch(value):
        return value
    return f"req_{uuid.uuid4().hex}"


def canonical_http_method(value: str) -> str:
    """Map arbitrary inbound method tokens to a bounded metric/log label."""

    method = value.upper() if isinstance(value, str) else ""
    return method if method in _ALLOWED_HTTP_METHODS else "OTHER"


def _safe_log_value(value: Any, fallback: str = "-") -> str:
    text = fallback if value is None else str(value)
    text = _LOG_CONTROL_RE.sub("_", text)
    return text[:_MAX_LOG_VALUE_LENGTH] or fallback


def _safe_metric_label(value: Any, fallback: str = "unknown") -> str:
    """Normalize a metric label without retaining caller-controlled content."""

    text = _safe_log_value(value, fallback=fallback)
    text = _METRIC_TOKEN_RE.sub("_", text)
    return text[:_MAX_METRIC_LABEL_LENGTH] or fallback


def _escape_prometheus_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _safe_route_label(request: Request) -> str:
    """Return a route template, never the raw request path.

    Starlette resolves the route after the downstream application runs.  A
    route template contains only server-owned literals and ``{parameters}``;
    unmatched paths are collapsed to a fixed bucket so a conversation id,
    token-like path segment, or arbitrary user input cannot create a metric
    series or appear in a diagnostic log.
    """

    route = request.scope.get("route")
    template = getattr(route, "path", None)
    if not isinstance(template, str) or not template.startswith("/"):
        path = request.scope.get("path")
        if isinstance(path, str):
            if path in {"/", "/healthz", "/readyz", "/metrics"}:
                return path
            if path.startswith("/api/"):
                return "/api/*"
        return "/unmatched"
    return _safe_metric_label(template, fallback="/unmatched")


class RequestMetrics:
    """Small in-process Prometheus text collector for HTTP request diagnostics.

    Labels are limited to service, allowlisted method, route template, and
    status.  The collector is process-local by design: deployments can scrape
    each service instance without a registry or a new persistence dependency.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: dict[tuple[str, str, str, str], int] = defaultdict(int)
        self._duration_sum: dict[tuple[str, str, str, str], float] = defaultdict(float)
        self._duration_buckets: dict[tuple[str, str, str, str], list[int]] = {}

    def record(
        self,
        *,
        service_name: str,
        method: str,
        route: str,
        status_code: int,
        duration_seconds: float,
    ) -> None:
        """Record one completed HTTP request using fixed low-cardinality labels."""

        key = (
            _safe_metric_label(service_name),
            canonical_http_method(method),
            _safe_metric_label(route, fallback="/unmatched"),
            _safe_metric_label(status_code, fallback="unknown"),
        )
        try:
            duration = float(duration_seconds)
        except (TypeError, ValueError):
            duration = 0.0
        if not math.isfinite(duration) or duration < 0:
            duration = 0.0

        with self._lock:
            self._requests[key] += 1
            self._duration_sum[key] += duration
            buckets = self._duration_buckets.setdefault(key, [0] * len(_DURATION_BUCKETS))
            for index, upper_bound in enumerate(_DURATION_BUCKETS):
                if duration <= upper_bound:
                    buckets[index] += 1

    def render(self) -> str:
        """Render a privacy-safe Prometheus 0.0.4 text exposition."""

        lines = [
            "# HELP aiteam_http_requests_total Total HTTP requests handled by this service.",
            "# TYPE aiteam_http_requests_total counter",
            "# HELP aiteam_http_request_duration_seconds HTTP request duration in seconds.",
            "# TYPE aiteam_http_request_duration_seconds histogram",
        ]
        with self._lock:
            rows = [
                (key, count, self._duration_sum[key], tuple(self._duration_buckets.get(key, ())))
                for key, count in sorted(self._requests.items())
            ]

        for (service, method, route, status), count, duration_sum, buckets in rows:
            labels = (
                f'service="{_escape_prometheus_label(service)}",'
                f'method="{_escape_prometheus_label(method)}",'
                f'route="{_escape_prometheus_label(route)}",'
                f'status="{_escape_prometheus_label(status)}"'
            )
            lines.append(f"aiteam_http_requests_total{{{labels}}} {count}")
            for upper_bound, bucket_count in zip(_DURATION_BUCKETS, buckets):
                bound = "+Inf" if math.isinf(upper_bound) else f"{upper_bound:g}"
                lines.append(
                    f'aiteam_http_request_duration_seconds_bucket{{{labels},le="{bound}"}} {bucket_count}'
                )
            lines.append(f"aiteam_http_request_duration_seconds_sum{{{labels}}} {duration_sum:.9f}")
            lines.append(f"aiteam_http_request_duration_seconds_count{{{labels}}} {count}")
        return "\n".join(lines) + "\n"


def _install_record_factory() -> None:
    """Attach context fields to every LogRecord without changing caller APIs."""

    global _record_factory_installed
    if _record_factory_installed:
        return
    previous_factory = logging.getLogRecordFactory()

    def _record_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = previous_factory(*args, **kwargs)
        if not hasattr(record, "request_id"):
            record.request_id = get_request_id() or "-"
        if not hasattr(record, "trace_id"):
            record.trace_id = get_trace_id() or "-"
        if not hasattr(record, "service"):
            record.service = _service_name_var.get() or _default_service_name or "-"
        return record

    logging.setLogRecordFactory(_record_factory)
    _record_factory_installed = True


def _redact_balanced_payloads(value: str) -> str:
    """Replace complete nested JSON/list payloads, including whitespace."""

    output: list[str] = []
    index = 0
    while index < len(value):
        opener = value[index]
        if opener not in "[{":
            output.append(opener)
            index += 1
            continue
        closer = "]" if opener == "[" else "}"
        stack = [closer]
        cursor = index + 1
        quote: str | None = None
        escaped = False
        while cursor < len(value) and stack:
            char = value[cursor]
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
            elif char in "\"'":
                quote = char
            elif char in "[{":
                stack.append("]" if char == "[" else "}")
            elif char in "]}":
                if char != stack[-1]:
                    break
                stack.pop()
            cursor += 1
        if not stack:
            output.append("<payload redacted>")
            index = cursor
        else:
            output.append(opener)
            index += 1
    return "".join(output)


def _contains_base_exception(value: Any) -> bool:
    if isinstance(value, BaseException):
        return True
    if isinstance(value, dict):
        return any(_contains_base_exception(item) for item in value.values())
    if isinstance(value, (tuple, list, set, frozenset)):
        return any(_contains_base_exception(item) for item in value)
    return False


def _redact_log_message(value: str, *, exception: bool = False) -> str:
    """Remove request targets, complete payloads, and credential material."""

    if exception:
        return "<exception redacted>"
    message = _URL_RE.sub("<url>", value)
    message = _RELATIVE_QUERY_RE.sub(r"\g<path>?<redacted>", message)
    message = _redact_balanced_payloads(message)
    message = _SENSITIVE_VALUE_RE.sub(r"\g<prefix><redacted>", message)
    message = _STANDALONE_BEARER_RE.sub(r"\g<prefix><redacted>", message)
    message = _BODY_FIELD_RE.sub(r"\g<prefix><redacted>", message)
    message = _LOG_CONTROL_RE.sub("_", message)
    return message[:512]


class _ContextFormatter(logging.Formatter):
    """Allowlisted key/value formatter without exception/request payload fields."""

    _ALLOWED_FIELDS = ("event", "http_method", "http_route", "status_code", "duration_ms", "reason", "code")

    def format(self, record: logging.LogRecord) -> str:
        timestamp = self.formatTime(record, self.datefmt)
        fields = [
            f"service={_safe_log_value(getattr(record, 'service', None))}",
            f"request_id={_safe_log_value(getattr(record, 'request_id', None))}",
            f"trace_id={_safe_log_value(getattr(record, 'trace_id', None))}",
            f"tenant_id={_safe_log_value(getattr(record, 'tenant_id', None))}",
        ]
        for name in self._ALLOWED_FIELDS:
            if hasattr(record, name):
                fields.append(f"{name}={_safe_log_value(getattr(record, name))}")
        has_exception = bool(
            record.exc_info
            or record.exc_text
            or _contains_base_exception(record.args)
            or _contains_base_exception(record.msg)
        )
        message = "<exception redacted>" if has_exception else _redact_log_message(record.getMessage())
        return f"{timestamp} {record.levelname} {' '.join(fields)} {record.name} message={message}"


def configure_logging(service_name: str, level: str = "INFO") -> None:
    """Configure bounded structured diagnostics for one control-plane service.

    The formatter omits exception text/tracebacks, raw headers, query strings,
    request bodies, and runtime events.  Request middleware emits only
    allowlisted method, route template, status, and duration fields.
    """

    global _default_service_name
    _default_service_name = _safe_log_value(service_name)
    _install_record_factory()
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(level=numeric_level)
    root = logging.getLogger()
    root.setLevel(numeric_level)
    for handler in root.handlers:
        handler.setFormatter(_ContextFormatter())


def _record_request_metrics(request: Request, response_status: int, duration_seconds: float) -> None:
    metrics = getattr(request.app.state, "metrics", None)
    if not isinstance(metrics, RequestMetrics):
        return
    settings = getattr(request.app.state, "settings", None)
    service_name = getattr(settings, "service_name", None) or _service_name_var.get() or "unknown"
    metrics.record(
        service_name=service_name,
        method=request.method,
        route=_safe_route_label(request),
        status_code=response_status,
        duration_seconds=duration_seconds,
    )


def _log_request(request: Request, *, status_code: int, duration_seconds: float, failed: bool = False) -> None:
    route = _safe_route_label(request)
    event = "request failed" if failed else "request completed"
    level = logging.WARNING if failed or status_code >= 500 else logging.INFO
    duration_ms = max(0.0, duration_seconds) * 1000
    safe_method = canonical_http_method(request.method)
    logger.log(
        level,
        event,
        extra={
            "event": event,
            "http_method": safe_method,
            "http_route": route,
            "status_code": status_code,
            "duration_ms": round(duration_ms, 3),
        },
    )


class RequestContextMiddleware(BaseHTTPMiddleware):
    """为每个请求分配/透传安全 request_id 与 W3C traceparent。"""

    def __init__(self, app: Any, service_name: str | None = None) -> None:
        super().__init__(app)
        self._service_name = service_name

    async def dispatch(self, request: Request, call_next: Any) -> Any:
        request_id = _safe_request_id(request.headers.get(_REQUEST_ID_HEADER))
        parsed_trace = _parse_traceparent(request.headers.get(_TRACEPARENT_HEADER))
        compatibility_trace_id = _compat_trace_id(request.headers.get(_TRACE_ID_HEADER))
        if parsed_trace:
            trace_id, flags = parsed_trace
        else:
            trace_id = compatibility_trace_id or _new_trace_id()
            flags = "01"
        trace_context = TraceContext(trace_id=trace_id, span_id=_new_span_id(), flags=flags)
        traceparent = trace_context.traceparent

        request.state.request_id = request_id
        request.state.trace_id = trace_context.trace_id
        request.state.traceparent = traceparent
        request.state.trace_context = trace_context
        settings = getattr(request.app.state, "settings", None)
        service_name = getattr(settings, "service_name", None) or self._service_name or _default_service_name
        token_r = _request_id_var.set(request_id)
        token_t = _trace_id_var.set(trace_context.trace_id)
        token_p = _traceparent_var.set(traceparent)
        token_s = _service_name_var.set(service_name)
        started = time.perf_counter()
        try:
            try:
                response = await call_next(request)
            except Exception:
                duration_seconds = time.perf_counter() - started
                _record_request_metrics(request, 500, duration_seconds)
                _log_request(request, status_code=500, duration_seconds=duration_seconds, failed=True)
                raise
            duration_seconds = time.perf_counter() - started
            _record_request_metrics(request, response.status_code, duration_seconds)
            _log_request(request, status_code=response.status_code, duration_seconds=duration_seconds)
            response.headers[_REQUEST_ID_HEADER] = request_id
            response.headers[_TRACE_ID_HEADER] = trace_context.trace_id
            response.headers[_TRACEPARENT_HEADER] = traceparent
            return response
        finally:
            _service_name_var.reset(token_s)
            _traceparent_var.reset(token_p)
            _request_id_var.reset(token_r)
            _trace_id_var.reset(token_t)
