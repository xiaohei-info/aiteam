"""operation_service/dependencies.py DI 装配测试。

覆盖 get_repository (PG + memory 双路径), get_rollup_repository, get_manager_gateway,
get_provisioning_service, get_rollup_service。需要清 lru_cache 保证隔离。
"""

import pytest

import operation_service.dependencies as deps
from operation_service.dependencies import (
    get_manager_gateway,
    get_provisioning_service,
    get_repository,
    get_rollup_repository,
    get_rollup_service,
)
from operation_service.repository import (
    InMemoryEnterpriseRepository,
    PgEnterpriseRepository,
)


@pytest.fixture(autouse=True)
def _clear_caches():
    get_repository.cache_clear()
    get_rollup_repository.cache_clear()
    yield
    get_repository.cache_clear()
    get_rollup_repository.cache_clear()


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OPERATION_SYSTEM_USERNAME", "sysadmin")
    monkeypatch.setenv("OPERATION_SYSTEM_PASSWORD", "changeme")


def test_get_repository_memory(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL", "APP_RW_PASSWORD"):
        monkeypatch.delenv(k, raising=False)
    repo = get_repository()
    assert isinstance(repo, InMemoryEnterpriseRepository)


def test_get_repository_pg(monkeypatch):
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@localhost/oper")
    monkeypatch.setenv("APP_RW_PASSWORD", "secret")
    called = {"migrations": False}

    def _fake_apply_migrations(db_url, pw=None):
        called["migrations"] = True

    monkeypatch.setattr(deps, "apply_migrations", _fake_apply_migrations)
    repo = get_repository()
    assert isinstance(repo, PgEnterpriseRepository)
    assert called["migrations"] is True


def test_get_rollup_repository():
    repo = get_rollup_repository()
    assert repo is not None
    assert get_rollup_repository() is repo


def test_get_manager_gateway_no_url(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL", "MANAGER_URL"):
        monkeypatch.delenv(k, raising=False)
    gw = get_manager_gateway()
    assert gw is not None
    assert "manager.invalid" in gw._client._base_url


def test_get_manager_gateway_with_url(monkeypatch):
    monkeypatch.setenv("MANAGER_URL", "http://manager-svc:8000")
    gw = get_manager_gateway()
    assert "manager-svc" in gw._client._base_url


def test_get_manager_gateway_passes_service_token(monkeypatch):
    monkeypatch.setenv("MANAGER_URL", "http://manager-svc:8000")
    monkeypatch.setenv("SERVICE_TOKEN", "test-service-token")
    gw = get_manager_gateway()
    assert gw._client._service_token == "test-service-token"


def test_get_provisioning_service(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL"):
        monkeypatch.delenv(k, raising=False)
    svc = get_provisioning_service()
    assert svc is not None
    assert isinstance(svc._repo, InMemoryEnterpriseRepository)


def test_get_rollup_service():
    svc = get_rollup_service()
    assert svc is not None
