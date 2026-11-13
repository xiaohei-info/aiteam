"""Operator → Manager 窄通信网关（05 §5.1/§5.4 F01/F02/F17，D4/D14）。

封装云侧写调用：创建 tenant、同步负责人 bootstrap、运营通知企业。统一经 shared/service_client
（TLS + 每请求短期 signed service identity）发起，写调用必带 `Idempotency-Key`（05 §5.1）。

设计要点：
- Operator **不写 Manager 租户库**——这里只是 service-to-service 调用，Manager 自行在租户上下文内落库。
- 抽象出 ManagerGateway 协议，业务层依赖协议；测试注入 fake，无需真实 Manager（对端先 mock）。
- 不在本端持企业长期密码：只传 OwnerBootstrapSync（明文（TLS 服务间），Manager 单次 scrypt 落库）。
"""

from __future__ import annotations

from typing import Protocol

from shared.contracts.crosstier import (
    EnterpriseNotifyRequest, OwnerBootstrapSync, TenantProvisionRequest, TenantPurgeRequest, TenantStatusSync,
)
from shared.service_client import ServiceClient


class ManagerGateway(Protocol):
    """Operator 视角的 Manager 写接口（窄）。实现可为真实 HTTP 客户端或测试 fake。"""

    def provision_tenant(self, req: TenantProvisionRequest, *, idempotency_key: str) -> None:
        """F01：请求 Manager 创建 tenant 并初始化租户数据空间。"""
        ...

    def sync_owner_bootstrap(self, req: OwnerBootstrapSync, *, idempotency_key: str) -> dict | None:
        """F02：把负责人初始/重置 bootstrap（明文（TLS 服务间），Manager 单次 scrypt 落库）同步给 Manager tenant。

        返回 Manager 的响应 `data`（重置已有负责人时含 `cleared` 计数）；测试 fake 可返回 None。
        """
        ...

    def notify_enterprise(self, req: EnterpriseNotifyRequest, *, idempotency_key: str) -> None:
        """F17：通知 Manager 向运营指定企业发送运营侧消息（站内信）。Manager 在租户上下文内落库。"""
        ...

    def set_tenant_status(self, tenant_id: str, status: str, *, reason: str | None = None, idempotency_key: str) -> None:
        """R5：同步企业生命周期状态（active / suspended / banned / closed / deleted）。"""
        ...

    def purge_tenant(self, tenant_id: str, *, idempotency_key: str) -> None:
        """R5：保留期后清理该 tenant 的全部数据（仅对 deleted 的租户生效）。"""
        ...


class HttpManagerGateway:
    """经 service_client 的真实 Manager 网关（生产/集成用）。"""

    _PROVISION_PATH = "/api/manager/tenants"
    _BOOTSTRAP_PATH = "/api/manager/owner-bootstrap"
    _NOTIFY_PATH = "/api/manager/enterprise/notify"

    def __init__(self, client: ServiceClient):
        self._client = client

    def provision_tenant(self, req: TenantProvisionRequest, *, idempotency_key: str) -> None:
        self._client.post(
            self._PROVISION_PATH,
            json=req.model_dump(mode="json", exclude_none=True),
            idempotency_key=idempotency_key,
            service_purpose="enterprise:provision",
            service_capability="provision-enterprise",
            service_enterprise_id=req.enterprise_id,
            service_tenant_id=req.tenant_id,
        )

    def sync_owner_bootstrap(self, req: OwnerBootstrapSync, *, idempotency_key: str) -> dict | None:
        response = self._client.post(
            self._BOOTSTRAP_PATH,
            json=req.model_dump(mode="json", exclude_none=True),
            idempotency_key=idempotency_key,
            service_purpose="owner:bootstrap",
            service_tenant_id=req.tenant_id,
        )
        data = response.get("data") if isinstance(response, dict) else None
        return data if isinstance(data, dict) else None

    def notify_enterprise(self, req: EnterpriseNotifyRequest, *, idempotency_key: str) -> None:
        self._client.post(
            self._NOTIFY_PATH,
            json=req.model_dump(mode="json", exclude_none=True),
            idempotency_key=idempotency_key,
            service_purpose="notification:write",
            service_enterprise_id=req.org_id,
            service_tenant_id=req.tenant_id,
        )

    def set_tenant_status(self, tenant_id: str, status: str, *, reason: str | None = None, idempotency_key: str) -> None:
        self._client.post(
            f"/api/manager/tenants/{tenant_id}/status",
            json=TenantStatusSync(status=status, reason=reason).model_dump(mode="json", exclude_none=True),
            idempotency_key=idempotency_key,
            service_purpose="tenant:lifecycle",
            service_tenant_id=tenant_id,
        )

    def purge_tenant(self, tenant_id: str, *, idempotency_key: str) -> None:
        self._client.post(
            f"/api/manager/tenants/{tenant_id}/purge",
            json=TenantPurgeRequest().model_dump(mode="json"),
            idempotency_key=idempotency_key,
            service_purpose="tenant:lifecycle",
            service_tenant_id=tenant_id,
        )
