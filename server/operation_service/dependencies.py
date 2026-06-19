"""运营端依赖装配（DI）。

集中提供 ProvisioningService 的构造：进程内仓储 + Manager 网关（经 service_client）。
测试经 app.dependency_overrides 注入 fake 网关/仓储，无需真实 Manager（对端 mock）。
"""

from __future__ import annotations

from functools import lru_cache

from shared.config import load_settings
from shared.service_client import ServiceClient

from .manager_gateway import HttpManagerGateway, ManagerGateway
from .repository import EnterpriseRepository
from .service import ProvisioningService


@lru_cache(maxsize=1)
def get_repository() -> EnterpriseRepository:
    """单例企业账号仓储（骨架进程内）。详设替换为 DB-backed 实现。"""
    return EnterpriseRepository()


def get_manager_gateway() -> ManagerGateway:
    """Manager 窄通信网关。manager_url 缺省时仍可构造（dev），实际调用失败由错误模型暴露。"""
    settings = load_settings("operation")
    client = ServiceClient(
        settings.manager_url or "http://manager.invalid",
        service_identity=settings.service_name,
    )
    return HttpManagerGateway(client)


def get_provisioning_service() -> ProvisioningService:
    return ProvisioningService(get_repository(), get_manager_gateway())
