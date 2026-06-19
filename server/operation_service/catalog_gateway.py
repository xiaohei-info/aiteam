"""Operator → Manager 目录变更通知网关（05 §5.1/§5.4 F03，D4/D14）。

封装一条云侧写调用：目录发布/下架/可见范围变更通知。经 shared/service_client
（TLS + 服务身份签名占位）发起，写调用必带 `Idempotency-Key`（05 §5.1）。

设计要点：
- Operator **不写 Manager 租户库**——这里只是 service-to-service 通知，Manager 自行缓存
  租户可见目录索引（F03："Manager 可缓存租户可见目录索引"）。
- 抽象出 CatalogManagerGateway 协议，业务层依赖协议；测试注入 fake，无需真实 Manager。
"""

from __future__ import annotations

from typing import Protocol

from shared.contracts.crosstier import CatalogReleaseNotify
from shared.service_client import ServiceClient


class CatalogManagerGateway(Protocol):
    """Operator 视角的 Manager 目录通知接口（窄）。实现可为真实 HTTP 客户端或测试 fake。"""

    def notify_catalog_release(
        self, notify: CatalogReleaseNotify, *, idempotency_key: str
    ) -> None:
        """F03：通知 Manager 模板/方案的发布/下架/可见范围变更。"""
        ...


class HttpCatalogManagerGateway:
    """经 service_client 的真实 Manager 目录通知网关（生产/集成用）。"""

    _NOTIFY_PATH = "/api/manager/catalog/notify"

    def __init__(self, client: ServiceClient):
        self._client = client

    def notify_catalog_release(
        self, notify: CatalogReleaseNotify, *, idempotency_key: str
    ) -> None:
        self._client.post(
            self._NOTIFY_PATH,
            json=notify.model_dump(mode="json", exclude_none=True),
            idempotency_key=idempotency_key,
        )
