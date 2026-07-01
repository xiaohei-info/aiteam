"""窄健康探测（运营端系统健康）。

AdminService 通过协议注入避免对 HTTP 传输产生硬依赖；测试可注入 fake。
生产路径经 shared.service_client 的真实 /healthz 端点探测 Manager / Agent。
"""

from __future__ import annotations

from typing import Protocol

from shared.config import load_settings
from shared.service_client import ServiceClient


class ServiceHealthProbe(Protocol):
    """探测单个上游服务的 /healthz。"""

    def check(self) -> str:
        """返回 'up' 或 'degraded'。"""


class HttpServiceHealthProbe:
    """经 ServiceClient 的真实 HTTP 健康探测。"""

    def __init__(self, base_url: str, *, service_identity: str | None, service_token: str | None) -> None:
        self._base_url = base_url
        self._service_identity = service_identity
        self._service_token = service_token

    def check(self) -> str:
        client = ServiceClient(
            self._base_url,
            service_identity=self._service_identity,
            service_token=self._service_token,
        )
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
    url = _manager_url()
    if not url:
        return None
    identity, token = _identity_and_token()
    return HttpServiceHealthProbe(url, service_identity=identity, service_token=token)


def build_agent_health_probe() -> HttpServiceHealthProbe | None:
    url = _agent_url()
    if not url:
        return None
    identity, token = _identity_and_token()
    return HttpServiceHealthProbe(url, service_identity=identity, service_token=token)
