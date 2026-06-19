"""跨端调用统一客户端（05 §5.3，D4/D14）。

统一 base-url 解析、超时、重试、trace 透传、服务身份签名与 problem+json 解码；各端不手写 httpx。
- 只读 GET 可幂等重试（request-id 去重）；写默认不自动重试，由调用方依 Idempotency-Key 决定（05 §5.1）。
- 非 2xx 响应按 problem+json 解码为 AppError 子类抛出（02 §11.2）。
- 服务身份签名为占位（平面③，03 §9.1）；真实密钥建立留详设（09 §14.3）。

骨架用同步 httpx.Client（便于无 async 插件测试）；异步变体后续按需补。
"""

from __future__ import annotations

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
    """面向单个对端服务的窄通信客户端。"""

    def __init__(
        self,
        base_url: str,
        *,
        service_identity: str | None = None,
        timeout: float = 10.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._service_identity = service_identity
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
            # 占位：真实为 TLS + 签名服务令牌（平面③，03 §9.1）。
            headers["X-Service-Identity"] = self._service_identity
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
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
