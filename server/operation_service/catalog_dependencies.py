"""运营端目录依赖装配（DI，05 F03）。

集中提供 CatalogService 的构造：进程内仓储 + Manager 通知网关（经 service_client）。
测试经 app.dependency_overrides 注入 fake 网关/仓储，无需真实 Manager（对端 mock）。
"""

from __future__ import annotations

from functools import lru_cache

from shared.config import load_settings
from shared.service_client import ServiceClient

from .catalog_gateway import CatalogManagerGateway, HttpCatalogManagerGateway
from .catalog_repository import CatalogRepository, PgCatalogRepository
from .catalog_service import CatalogService
from .repository import apply_migrations


@lru_cache(maxsize=1)
def get_catalog_repository() -> CatalogRepository:
    """单例目录仓储。有 admin_db_url → PostgreSQL；否则内存（dev/测试）。"""
    settings = load_settings("operation")
    db_url = settings.admin_db_url
    if db_url:
        apply_migrations(settings.admin_db_url, settings.app_rw_password)
        return PgCatalogRepository(db_url)
    return CatalogRepository()


def get_catalog_gateway() -> CatalogManagerGateway:
    """Manager 目录通知网关。manager_url 缺省时仍可构造（dev），调用失败由错误模型暴露。"""
    settings = load_settings("operation")
    client = ServiceClient(
        settings.manager_url or "http://manager.invalid",
        service_identity=settings.service_name,
    )
    return HttpCatalogManagerGateway(client)


def get_catalog_service() -> CatalogService:
    return CatalogService(get_catalog_repository(), get_catalog_gateway())
