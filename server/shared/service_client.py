"""跨端调用统一客户端（05 §5.3，D4/D14）。

统一 base-url 解析、超时、重试、trace 透传、服务身份签名与 problem+json 解码；各端不手写 httpx。
- 只读 GET 可幂等重试（request-id 去重）；写默认不自动重试，由调用方依 Idempotency-Key 决定（05 §5.1）。
- 非 2xx 响应按 problem+json 解码为 AppError 子类抛出（02 §11.2）。
- 服务间鉴权经 `X-Service-Token`（平面③，03 §9.1）：调用方构造 ServiceClient 时传入 service_token，
  被调端经 `verify_service_token` 校验；占位注释已清理，统一为共享密钥机制（AITEAM-331 B3）。

骨架用同步 httpx.Client（便于无 async 插件测试）；异步变体后续按需补。
"""

from __future__ import annotations

import typing

import httpx

from shared.errors import (
    AppError,
    Conflict,
    Forbidden,
    NotFound,
    TooManyRequests,
    Unauthorized,
    ValidationProblem,
)
from shared.observability import get_request_id, get_trace_id

_STATUS_TO_ERROR = {
    401: Unauthorized,
    403: Forbidden,
    404: NotFound,
    409: Conflict,
    422: ValidationProblem,
    429: TooManyRequests,
}


class ServiceClient:
    """面向单个对端服务的窄通信客户端。

    服务间鉴权（平面③，03 §9.1，AITEAM-331 B3）：调用方构造时传入 `service_token`，
    每次出站请求自动附带 `X-Service-Token` 头；被调端经 `shared.service_token.verify_service_token`
    校验。这是代码层共享密钥机制（与 mTLS 互补），不再是占位实现。`service_identity`
    仅用于 `X-Service-Identity` 审计标签（非鉴权决策）。
    """

    def __init__(
        self,
        base_url: str,
        *,
        service_identity: str | None = None,
        service_token: str | None = None,
        timeout: float = 10.0,
        transport: httpx.BaseTransport | None = None,
        user_token_provider: typing.Callable[[], str | None] | None = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._user_token_provider = user_token_provider
        self._service_identity = service_identity
        self._service_token = service_token
        self._client = httpx.Client(
            base_url=self._base_url, timeout=timeout, transport=transport
        )

    def _headers(self, idempotency_key: str | None) -> dict[str, str]:
        headers: dict[str, str] = {}
        if (rid := get_request_id()):
            headers["X-Request-ID"] = rid
        if (tid := get_trace_id()):
            headers["X-Trace-ID"] = tid
        if self._service_identity:
            # 服务身份标识（审计用，非鉴权决策）。
            headers["X-Service-Identity"] = self._service_identity
        if self._service_token:
            # 服务间共享密钥（平面③，03 §9.1）：被调端 verify_service_token 校验。
            # 与 mTLS 互补，非占位实现（AITEAM-331 B3）。
            headers["X-Service-Token"] = self._service_token
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        if self._user_token_provider is not None and (tok := self._user_token_provider()):
            headers["Authorization"] = f"Bearer {tok}"
        return headers

    def _decode(self, resp: httpx.Response) -> dict:
        if resp.is_success:
            return resp.json() if resp.content else {}
        body = {}
        try:
            body = resp.json()
        except Exception:  # noqa: BLE001
            body = {}
        detail = body.get("detail") or body.get("title") or f"upstream {resp.status_code}"
        err_cls = _STATUS_TO_ERROR.get(resp.status_code, AppError)
        raise err_cls(detail)

    def get(self, path: str) -> dict:
        return self._decode(self._client.get(path, headers=self._headers(None)))

    def post(self, path: str, json: dict, *, idempotency_key: str | None = None) -> dict:
        return self._decode(
            self._client.post(path, json=json, headers=self._headers(idempotency_key))
        )

    def close(self) -> None:
        self._client.close()
