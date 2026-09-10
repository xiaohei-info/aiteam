"""统一跨端客户端与短期 signed service identity。

每个请求在发送前生成一个新的 RS256 service assertion。断言绑定目标
path/body、purpose/scope、audience 与 enterprise/tenant 作用域，并通过
``Authorization: Bearer`` 传输；``X-Service-Identity`` 仅是可选审计标签。

``SERVICE_TOKEN`` 共享密钥仅作为显式 dev/test 兼容路径保留，production
绝不发送或接受该 header。
"""

from __future__ import annotations

import json
import os
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
from shared.observability import get_propagation_headers, get_request_id, get_trace_id
from shared.service_identity import (
    DEFAULT_SERVICE_ASSERTION_TTL_SECONDS,
    ServiceIdentitySigner,
    canonical_json_bytes,
    canonical_origin,
    request_target,
)
from shared.service_token import required_service_scope

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

    ``service_signer`` is injectable for isolated contract tests and deployment
    adapters.  When omitted, the complete ``SERVICE_IDENTITY_*`` environment
    configuration is loaded; partial production configuration fails closed.
    """

    def __init__(
        self,
        base_url: str,
        *,
        service_identity: str | None = None,
        service_token: str | None = None,
        service_signer: ServiceIdentitySigner | None = None,
        signer: ServiceIdentitySigner | None = None,
        service_private_key: str | None = None,
        service_key_id: str | None = None,
        service_issuer: str | None = None,
        service_deployment_id: str | None = None,
        service_ttl_seconds: int | None = None,
        service_origin: str | None = None,
        service_audience: str | None = None,
        service_scope: typing.Iterable[str] = (),
        service_capability: str | None = None,
        service_enterprise_id: str | None = None,
        service_tenant_id: str | None = None,
        service_auth_mode: str | None = None,
        aiteam_env: str | None = None,
        load_env_signer: bool = True,
        allow_legacy_service_token: bool | None = None,
        timeout: float = 10.0,
        transport: httpx.BaseTransport | None = None,
        user_token_provider: typing.Callable[[], str | None] | None = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._user_token_provider = user_token_provider
        self._service_identity = service_identity
        self._service_token = service_token
        self._environment = (aiteam_env or os.getenv("AITEAM_ENV") or "development").strip().lower()
        self._service_auth_mode = (service_auth_mode or os.getenv("SERVICE_AUTH_MODE") or "auto").strip().lower()
        if self._service_auth_mode not in {"auto", "signed", "legacy"}:
            raise ValueError("service_auth_mode must be auto, signed, or legacy")
        self._service_audience = (
            service_audience
            or os.getenv("SERVICE_IDENTITY_PEER_AUDIENCE")
            or os.getenv("SERVICE_IDENTITY_AUDIENCE")
            or ""
        ).strip() or None
        try:
            # ``service_origin`` is the validated local deployment origin. The
            # target origin is derived from the peer base URL (or an explicit
            # target-only override), so local and peer origins cannot be
            # conflated in outbound construction.
            self._service_origin = canonical_origin(service_origin, require_https=self._environment == "production") if service_origin else None
            target_override = os.getenv("SERVICE_IDENTITY_TARGET_ORIGIN")
            self._target_origin = canonical_origin(
                target_override or self._base_url,
                require_https=self._environment == "production",
            )
            if target_override and canonical_origin(self._base_url, require_https=self._environment == "production") != self._target_origin:
                raise ValueError("service target origin does not match base_url")
        except ValueError as exc:
            raise ValueError("service client target origin is invalid") from exc
        if isinstance(service_scope, str):
            service_scope = (service_scope,)
        self._service_scope = tuple(item for item in service_scope if isinstance(item, str) and item.strip())
        self._service_capability = service_capability
        self._service_enterprise_id = service_enterprise_id
        self._service_tenant_id = service_tenant_id
        self._service_signer = service_signer or signer
        if self._service_signer is None and service_private_key:
            if not service_key_id or not service_issuer or not service_deployment_id:
                raise ValueError("service_key_id, service_issuer and service_deployment_id are required with service_private_key")
            self._service_signer = ServiceIdentitySigner(
                service_private_key,
                kid=service_key_id,
                issuer=service_issuer,
                subject=service_identity or service_issuer,
                deployment_id=service_deployment_id,
                audience=self._service_audience,
                ttl_seconds=(service_ttl_seconds if service_ttl_seconds is not None else DEFAULT_SERVICE_ASSERTION_TTL_SECONDS),
            )
        if self._service_signer is None and load_env_signer and self._service_auth_mode != "legacy":
            try:
                self._service_signer = ServiceIdentitySigner.from_env(subject=service_identity)
            except ValueError:
                # The request path will fail closed with a typed auth error;
                # do not downgrade a malformed key into SERVICE_TOKEN.
                self._service_signer = None
                self._service_identity_configuration_error = True
            else:
                self._service_identity_configuration_error = False
        else:
            self._service_identity_configuration_error = False
        self._allow_legacy = (
            allow_legacy_service_token
            if allow_legacy_service_token is not None
            else self._environment != "production" and self._service_auth_mode != "signed"
        )
        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=timeout,
            transport=transport,
            follow_redirects=False,
        )

    def _headers(
        self,
        idempotency_key: str | None,
        *,
        path: str | None = None,
        body: bytes | None = None,
        purpose: str | None = None,
        capability: str | None = None,
        enterprise_id: str | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, str]:
        headers: dict[str, str] = {}
        if (rid := get_request_id()):
            headers["X-Request-ID"] = rid
        if (tid := get_trace_id()):
            headers["X-Trace-ID"] = tid
        headers.update(get_propagation_headers())
        if self._service_identity:
            # This is an audit label only.  The receiver never uses it as an
            # authentication decision.
            headers["X-Service-Identity"] = self._service_identity
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        target = request_target(path or "/")
        resolved_purpose = purpose or required_service_scope((path or "/").split("?", 1)[0]) or "service:call"
        resolved_scope = self._service_scope or ((resolved_purpose,) if resolved_purpose != "service:call" else ())
        resolved_enterprise_id = enterprise_id if enterprise_id is not None else self._service_enterprise_id
        resolved_tenant_id = tenant_id if tenant_id is not None else self._service_tenant_id
        if body:
            try:
                body_values = json.loads(body)
            except (TypeError, ValueError):
                body_values = None
            if isinstance(body_values, dict):
                if resolved_enterprise_id is None:
                    resolved_enterprise_id = body_values.get("enterprise_id") or body_values.get("org_id")
                if resolved_tenant_id is None:
                    resolved_tenant_id = body_values.get("tenant_id")
        if resolved_tenant_id is None and "?" in target:
            query = target.split("?", 1)[1]
            for item in query.split("&"):
                key, _, value = item.partition("=")
                if key == "tenant_id" and value:
                    resolved_tenant_id = value
                    break

        if self._service_signer is not None:
            if self._environment == "production" and self._service_auth_mode == "legacy":
                raise Unauthorized("legacy service token mode is not allowed in production")
            audience = self._service_audience or getattr(self._service_signer, "audience", None)
            if not audience:
                raise Unauthorized("SERVICE_IDENTITY_AUDIENCE is not configured")
            assertion = self._service_signer.sign(
                audience=audience,
                scope=resolved_scope,
                enterprise_id=resolved_enterprise_id,
                tenant_id=resolved_tenant_id,
                path=target,
                body=body,
                origin=self._target_origin,
                capability=capability if capability is not None else self._service_capability,
                idempotency_key=idempotency_key,
            )
            headers["Authorization"] = f"Bearer {assertion}"
            # A user token may be forwarded for audit/context, but must never
            # replace the service assertion in Authorization.
            if self._user_token_provider is not None and (tok := self._user_token_provider()):
                headers["X-User-Authorization"] = f"Bearer {tok}"
            return headers

        if self._environment == "production":
            # Never fall back to X-Service-Token in production, even when a
            # legacy secret was accidentally injected into the process.
            raise Unauthorized("signed service identity is required in production")
        if self._service_auth_mode == "signed" or getattr(self, "_service_identity_configuration_error", False):
            raise Unauthorized("signed service identity is not configured")
        if self._allow_legacy and self._service_token:
            headers["X-Service-Token"] = self._service_token
        if self._user_token_provider is not None and (tok := self._user_token_provider()):
            headers["Authorization"] = f"Bearer {tok}"
        return headers

    def _decode(self, resp: httpx.Response) -> dict:
        if 300 <= resp.status_code < 400:
            raise Unauthorized("service client refused redirect response")
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

    def get(
        self,
        path: str,
        *,
        service_purpose: str | None = None,
        service_enterprise_id: str | None = None,
        service_tenant_id: str | None = None,
    ) -> dict:
        headers = self._headers(
            None,
            path=path,
            purpose=service_purpose,
            enterprise_id=service_enterprise_id,
            tenant_id=service_tenant_id,
        )
        return self._decode(self._client.get(path, headers=headers))

    def post(
        self,
        path: str,
        json: dict,
        *,
        idempotency_key: str | None = None,
        service_purpose: str | None = None,
        service_capability: str | None = None,
        service_enterprise_id: str | None = None,
        service_tenant_id: str | None = None,
    ) -> dict:
        body = canonical_json_bytes(json)
        headers = self._headers(
            idempotency_key,
            path=path,
            body=body,
            purpose=service_purpose,
            capability=service_capability,
            enterprise_id=service_enterprise_id,
            tenant_id=service_tenant_id,
        )
        headers.setdefault("Content-Type", "application/json")
        return self._decode(self._client.post(path, content=body, headers=headers))

    def close(self) -> None:
        self._client.close()
