"""operation_service/catalog_dependencies.py DI 装配测试。

覆盖 get_catalog_repository (内存 / PG 双路径), get_catalog_gateway, get_catalog_service。
"""

import pytest

import operation_service.catalog_dependencies as cat_deps
from operation_service.catalog_dependencies import (
    get_catalog_gateway,
    get_catalog_repository,
    get_catalog_service,
)
from operation_service.catalog_repository import CatalogRepository, PgCatalogRepository
from operation_service.catalog_service import CatalogService


@pytest.fixture(autouse=True)
def _clear_cache():
    get_catalog_repository.cache_clear()
    yield
    get_catalog_repository.cache_clear()


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OPERATION_SYSTEM_USERNAME", "sysadmin")
    monkeypatch.setenv("OPERATION_SYSTEM_PASSWORD", "changeme")


def test_get_catalog_repository_memory(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL"):
        monkeypatch.delenv(k, raising=False)
    repo = get_catalog_repository()
    assert isinstance(repo, CatalogRepository)
    assert get_catalog_repository() is repo


def test_get_catalog_repository_pg(monkeypatch):
    monkeypatch.setenv("DB_URL", "postgresql://app_rw@localhost/oper")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@localhost/oper")
    monkeypatch.setenv("APP_RW_PASSWORD", "secret")
    monkeypatch.setattr(cat_deps, "apply_migrations", lambda *a, **k: None)
    repo = get_catalog_repository()
    assert isinstance(repo, PgCatalogRepository)


def test_get_catalog_gateway_no_url(monkeypatch):
    for k in ("MANAGER_URL", "ADMIN_DB_URL", "DB_URL"):
        monkeypatch.delenv(k, raising=False)
    gw = get_catalog_gateway()
    assert gw is not None
    assert "manager.invalid" in gw._client._base_url


def test_get_catalog_gateway_with_url(monkeypatch):
    monkeypatch.setenv("MANAGER_URL", "http://manager-catalog:9000")
    gw = get_catalog_gateway()
    assert "manager-catalog" in gw._client._base_url


def test_get_catalog_service(monkeypatch):
    for k in ("MANAGER_URL", "ADMIN_DB_URL", "DB_URL"):
        monkeypatch.delenv(k, raising=False)
    svc = get_catalog_service()
    assert isinstance(svc, CatalogService)
