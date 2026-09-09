"""运营端依赖装配（DI）。

集中提供 ProvisioningService 的构造：仓储（内存/PostgreSQL）+ Manager 网关（经 service_client）。
测试经 app.dependency_overrides 注入 fake 网关/仓储，无需真实 Manager（对端 mock）。
"""

from __future__ import annotations

from functools import lru_cache

from shared.config import load_settings
from shared.service_client import ServiceClient

from .admin_repository import AdminRepository, PgAdminRepository
from .manager_gateway import HttpManagerGateway, ManagerGateway
from .repository import (
    EnterpriseRepository,
    InMemoryEnterpriseRepository,
    PgEnterpriseRepository,
    apply_migrations,
)
from .rollup_repository import CrossEnterpriseRollupRepository, PgRollupRepository
from .rollup_service import RollupService
from .service import ProvisioningService
from .platform_provider_service import build_platform_provider_service


@lru_cache(maxsize=1)
def get_repository() -> EnterpriseRepository:
    """单例企业账号仓储。有 db_url → app_rw PostgreSQL；否则内存（dev/测试）。"""
    settings = load_settings("operation")
    db_url = settings.db_url

    if db_url:
        # 迁移仅使用管理 DSN；业务查询始终使用受限 app_rw DSN。
        if settings.admin_db_url:
            apply_migrations(settings.admin_db_url, settings.app_rw_password)
        return PgEnterpriseRepository(db_url)

    # 内存实现（dev/测试）。
    return InMemoryEnterpriseRepository()


@lru_cache(maxsize=1)
def get_admin_repository() -> AdminRepository:
    """单例运营业务管理仓储。有 db_url → app_rw PostgreSQL；否则内存（dev/测试）。"""
    settings = load_settings("operation")
    db_url = settings.db_url
    if db_url:
        if settings.admin_db_url:
            apply_migrations(settings.admin_db_url, settings.app_rw_password)
        return PgAdminRepository(db_url)
    return AdminRepository()


@lru_cache(maxsize=1)
def get_rollup_repository() -> CrossEnterpriseRollupRepository:
    """单例跨企业 rollup 业务仓储。有 db_url → app_rw PostgreSQL；否则内存（dev/测试）。"""
    settings = load_settings("operation")
    db_url = settings.db_url
    if db_url:
        if settings.admin_db_url:
            apply_migrations(settings.admin_db_url, settings.app_rw_password)
        return PgRollupRepository(db_url)
    return CrossEnterpriseRollupRepository()


def get_manager_gateway() -> ManagerGateway:
    """Manager 窄通信网关。manager_url 缺省时仍可构造（dev），实际调用失败由错误模型暴露。"""
    settings = load_settings("operation")
    client = ServiceClient(
        settings.manager_url or "http://manager.invalid",
        service_identity=settings.service_name,
        service_token=settings.service_token,
        timeout=settings.service_client_timeout_ms / 1000,
    )
    return HttpManagerGateway(client)


def get_provisioning_service() -> ProvisioningService:
    try:
        platform_providers = build_platform_provider_service()
    except Exception:
        # Enterprise registration remains available before the optional NewAPI
        # admin credentials are bootstrapped; model refs are checked when the
        # platform catalog is available.
        platform_providers = None
    return ProvisioningService(
        get_repository(),
        get_manager_gateway(),
        admin_repo=get_admin_repository(),
        platform_provider_service=platform_providers,
    )


def get_rollup_service() -> RollupService:
    return RollupService(get_rollup_repository(), admin_repo=get_admin_repository())
