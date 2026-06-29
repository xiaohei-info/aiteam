"""运营端依赖装配（DI）。

集中提供 ProvisioningService 的构造：仓储（内存/PostgreSQL）+ Manager 网关（经 service_client）。
测试经 app.dependency_overrides 注入 fake 网关/仓储，无需真实 Manager（对端 mock）。
"""

from __future__ import annotations

from functools import lru_cache

from shared.config import load_settings
from shared.service_client import ServiceClient

from .manager_gateway import HttpManagerGateway, ManagerGateway
from .repository import (
    EnterpriseRepository,
    InMemoryEnterpriseRepository,
    PgEnterpriseRepository,
    apply_migrations,
)
from .rollup_repository import CrossEnterpriseRollupRepository
from .rollup_service import RollupService
from .service import ProvisioningService


@lru_cache(maxsize=1)
def get_repository() -> EnterpriseRepository:
    """单例企业账号仓储。有 admin_db_url → PostgreSQL；否则内存（dev/测试）。"""
    settings = load_settings("operation")
    # 运营端使用 admin_db_url 作为数据库连接（运营端表是控制面表，直连管理库）
    db_url = settings.admin_db_url

    if db_url:
        # PostgreSQL 实现：自动应用迁移，连管理 DSN。
        admin_url = settings.admin_db_url
        app_rw_password = settings.app_rw_password
        apply_migrations(admin_url, app_rw_password)
        return PgEnterpriseRepository(db_url)

    # 内存实现（dev/测试）。
    return InMemoryEnterpriseRepository()


@lru_cache(maxsize=1)
def get_rollup_repository() -> CrossEnterpriseRollupRepository:
    """单例跨企业 rollup 仓储（骨架进程内）。详设替换为 DB-backed 实现。"""
    return CrossEnterpriseRollupRepository()


def get_manager_gateway() -> ManagerGateway:
    """Manager 窄通信网关。manager_url 缺省时仍可构造（dev），实际调用失败由错误模型暴露。"""
    settings = load_settings("operation")
    client = ServiceClient(
        settings.manager_url or "http://manager.invalid",
        service_identity=settings.service_name,
        service_token=settings.service_token,
    )
    return HttpManagerGateway(client)


def get_provisioning_service() -> ProvisioningService:
    return ProvisioningService(get_repository(), get_manager_gateway())


def get_rollup_service() -> RollupService:
    return RollupService(get_rollup_repository())
