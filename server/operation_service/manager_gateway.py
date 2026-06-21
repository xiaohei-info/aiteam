"""Operator → Manager 窄通信网关（05 §5.1/§5.4 F01/F02，D4/D14）。

封装两条云侧写调用：创建 tenant、同步负责人 bootstrap。统一经 shared/service_client
（TLS + 服务身份签名占位）发起，写调用必带 `Idempotency-Key`（05 §5.1）。

设计要点：
- Operator **不写 Manager 租户库**——这里只是 service-to-service 调用，Manager 自行落库。
- 抽象出 ManagerGateway 协议，业务层依赖协议；测试注入 fake，无需真实 Manager（对端先 mock）。
- 不在本端持企业长期密码：只传 OwnerBootstrapSync（明文（TLS 服务间），Manager 单次 scrypt 落库）。
"""

from __future__ import annotations

from typing import Protocol

from shared.contracts.crosstier import OwnerBootstrapSync, TenantProvisionRequest
from shared.service_client import ServiceClient


class ManagerGateway(Protocol):
    """Operator 视角的 Manager 写接口（窄）。实现可为真实 HTTP 客户端或测试 fake。"""

    def provision_tenant(self, req: TenantProvisionRequest, *, idempotency_key: str) -> None:
        """F01：请求 Manager 创建 tenant 并初始化租户数据空间。"""
        ...

    def sync_owner_bootstrap(self, req: OwnerBootstrapSync, *, idempotency_key: str) -> None:
        """F02：把负责人初始/重置 bootstrap（明文（TLS 服务间），Manager 单次 scrypt 落库）同步给 Manager tenant。"""
        ...


class HttpManagerGateway:
    """经 service_client 的真实 Manager 网关（生产/集成用）。"""

    _PROVISION_PATH = "/api/manager/tenants"
    _BOOTSTRAP_PATH = "/api/manager/owner-bootstrap"

    def __init__(self, client: ServiceClient):
        self._client = client

    def provision_tenant(self, req: TenantProvisionRequest, *, idempotency_key: str) -> None:
        self._client.post(
            self._PROVISION_PATH,
            json=req.model_dump(mode="json", exclude_none=True),
            idempotency_key=idempotency_key,
        )

    def sync_owner_bootstrap(self, req: OwnerBootstrapSync, *, idempotency_key: str) -> None:
        self._client.post(
            self._BOOTSTRAP_PATH,
            json=req.model_dump(mode="json", exclude_none=True),
            idempotency_key=idempotency_key,
        )
