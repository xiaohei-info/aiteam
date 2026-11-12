"""请求体大小上限（纯 ASGI 中间件）。

FastAPI 在跑鉴权依赖之前就会把 multipart 请求体整个读完（文件部分落到临时文件），所以路由里的
大小检查挡不住超大请求，未登录的请求也能让服务器写盘。这里在读请求体之前按路径前缀限流：
- 声明了 `Content-Length` 且超限：不读请求体，直接 413；
- 未声明（chunked）：边读边计数，一超限就中断读取，并把下游给出的任何响应替换为 413。

要装在 `RequestContextMiddleware` 内侧，413 才带 request_id（见 `create_app(body_limits=...)`）。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from shared.errors import RequestTooLarge, problem_response
from shared.observability import get_request_id

Scope = dict[str, Any]
Message = dict[str, Any]


@dataclass(frozen=True)
class BodyLimit:
    path_prefix: str
    max_bytes: int


class _BodyTooLarge(Exception):
    """读请求体时超限。下游可能把它包装成别的错误，所以最终响应以 `exceeded` 标记为准。"""


def _declared_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", ()):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


class BodySizeLimitMiddleware:
    def __init__(self, app: Any, limits: Sequence[BodyLimit]):
        self.app = app
        self._limits = tuple(limits)

    def _limit_for(self, path: str) -> int | None:
        for limit in self._limits:
            if path.startswith(limit.path_prefix):
                return limit.max_bytes
        return None

    async def __call__(self, scope: Scope, receive: Any, send: Any) -> None:
        limit = self._limit_for(scope.get("path", "")) if scope["type"] == "http" else None
        if limit is None:
            await self.app(scope, receive, send)
            return
        declared = _declared_length(scope)
        if declared is not None and declared > limit:
            await self._reject(scope, receive, send, limit)
            return

        received = 0
        exceeded = False
        replaced = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise _BodyTooLarge
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal replaced
            if exceeded:
                # 下游把中断的读取变成了 400 / 500 等响应：丢弃，换成 413。
                if message["type"] == "http.response.start" and not replaced:
                    replaced = True
                    await self._reject(scope, receive, send, limit)
                return
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except _BodyTooLarge:
            if not replaced:
                await self._reject(scope, receive, send, limit)

    @staticmethod
    async def _reject(scope: Scope, receive: Any, send: Any, limit: int) -> None:
        response = problem_response(
            RequestTooLarge(f"the request body exceeds the {limit} byte limit for this endpoint"),
            instance=scope.get("path"), request_id=get_request_id(),
        )
        response.headers["Connection"] = "close"
        await response(scope, receive, send)
