"""窄健康探测（运营端系统健康）。

AdminService 通过协议注入避免对 HTTP 传输产生硬依赖；测试可注入 fake。
生产路径经 shared.service_client 的真实 /healthz 端点探测 Manager / Agent。
"""

from __future__ import annotations

from typing import Any, Mapping, Protocol

from shared.config import load_settings, service_client_kwargs
from shared.service_client import ServiceClient


class ServiceHealthProbe(Protocol):
    """探测单个上游服务的 /healthz。"""

    def check(self) -> str:
        """返回 'up' 或 'degraded'。"""


class HttpServiceHealthProbe:
    """经 ServiceClient 的真实 HTTP 健康探测。"""

    def __init__(
        self,
        base_url: str,
        *,
        service_identity: str | None = None,
        service_token: str | None = None,
        service_audience: str | None = None,
        client_kwargs: Mapping[str, Any] | None = None,
    ) -> None:
        self._base_url = base_url
        self._service_identity = service_identity
        self._service_token = service_token
        self._service_audience = service_audience
        self._client_kwargs = dict(client_kwargs or {})

    def check(self) -> str:
        kwargs = dict(self._client_kwargs)
        kwargs.setdefault("service_identity", self._service_identity)
        kwargs.setdefault("service_token", self._service_token)
        kwargs.setdefault("service_audience", self._service_audience)
        client = ServiceClient(self._base_url, **kwargs)
        try:
            data = client.get("/healthz")
            return "up" if data.get("status") == "ok" else "degraded"
        finally:
            client.close()


def _manager_url() -> str | None:
    return load_settings("operation").manager_url


def _agent_url() -> str | None:
    return load_settings("operation").agent_url


def _identity_and_token() -> tuple[str | None, str | None]:
    settings = load_settings("operation")
    return settings.service_name, settings.service_token


def build_manager_health_probe() -> HttpServiceHealthProbe | None:
    settings = load_settings("operation")
    if not settings.manager_url:
        return None
    return HttpServiceHealthProbe(
        settings.manager_url,
        client_kwargs=service_client_kwargs(settings),
    )


def build_agent_health_probe() -> HttpServiceHealthProbe | None:
    settings = load_settings("operation")
    if not settings.agent_url:
        return None
    return HttpServiceHealthProbe(
        settings.agent_url,
        client_kwargs=service_client_kwargs(settings),
    )
