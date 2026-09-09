"""operation_service/dependencies.py DI 装配测试。

覆盖 get_repository (PG + memory 双路径), get_admin_repository / get_rollup_repository /
get_solution_repository / get_catalog_repository 双路径，get_manager_gateway,
get_provisioning_service, get_rollup_service。需要清 lru_cache 保证隔离。
"""

import pytest

import operation_service.catalog_dependencies as cat_deps
import operation_service.admin_dependencies as admin_deps
import operation_service.dependencies as deps
from operation_service.admin_dependencies import get_solution_repository
from operation_service.admin_repository import AdminRepository, PgAdminRepository
from operation_service.catalog_repository import CatalogRepository, PgCatalogRepository
from operation_service.dependencies import (
    get_admin_repository,
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
from operation_service.rollup_repository import (
    CrossEnterpriseRollupRepository,
    PgRollupRepository,
)
from operation_service.solution_repository import (
    PgSolutionRepository,
    SolutionRepository,
)


@pytest.fixture(autouse=True)
def _clear_caches():
    for fn in (
        get_repository, get_admin_repository, get_rollup_repository,
        get_solution_repository, cat_deps.get_catalog_repository,
    ):
        fn.cache_clear()
    yield
    for fn in (
        get_repository, get_admin_repository, get_rollup_repository,
        get_solution_repository, cat_deps.get_catalog_repository,
    ):
        fn.cache_clear()


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("OPERATION_SYSTEM_USERNAME", "sysadmin")
    monkeypatch.setenv("OPERATION_SYSTEM_PASSWORD", "changeme")


def _stub_migrations(monkeypatch):
    monkeypatch.setattr(deps, "apply_migrations", lambda *a, **k: None)
    monkeypatch.setattr(cat_deps, "apply_migrations", lambda *a, **k: None)
    monkeypatch.setattr(admin_deps, "apply_migrations", lambda *a, **k: None)


# ---- memory path (default) ----

def test_get_repository_memory(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL", "APP_RW_PASSWORD"):
        monkeypatch.delenv(k, raising=False)
    repo = get_repository()
    assert isinstance(repo, InMemoryEnterpriseRepository)


def test_get_admin_repository_memory(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL"):
        monkeypatch.delenv(k, raising=False)
    repo = get_admin_repository()
    assert isinstance(repo, AdminRepository)


def test_get_rollup_repository_memory(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL"):
        monkeypatch.delenv(k, raising=False)
    repo = get_rollup_repository()
    assert isinstance(repo, CrossEnterpriseRollupRepository)


def test_get_solution_repository_memory(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL"):
        monkeypatch.delenv(k, raising=False)
    repo = get_solution_repository()
    assert isinstance(repo, SolutionRepository)


def test_get_catalog_repository_memory(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL"):
        monkeypatch.delenv(k, raising=False)
    repo = cat_deps.get_catalog_repository()
    assert isinstance(repo, CatalogRepository)


# ---- PG path (admin_db_url set) ----

def test_get_repository_pg(monkeypatch):
    monkeypatch.setenv("DB_URL", "postgresql://app_rw@localhost/oper")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@localhost/oper")
    monkeypatch.setenv("APP_RW_PASSWORD", "secret")
    called = {"migrations": False}

    def _fake_apply_migrations(db_url, pw=None):
        called["migrations"] = True

    monkeypatch.setattr(deps, "apply_migrations", _fake_apply_migrations)
    repo = get_repository()
    assert isinstance(repo, PgEnterpriseRepository)
    assert repo._dsn == "postgresql://app_rw@localhost/oper"
    assert called["migrations"] is True


def test_get_admin_repository_pg(monkeypatch):
    monkeypatch.setenv("DB_URL", "postgresql://app_rw@localhost/oper")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@localhost/oper")
    monkeypatch.setenv("APP_RW_PASSWORD", "secret")
    _stub_migrations(monkeypatch)
    repo = get_admin_repository()
    assert isinstance(repo, PgAdminRepository)


def test_get_rollup_repository_pg(monkeypatch):
    monkeypatch.setenv("DB_URL", "postgresql://app_rw@localhost/oper")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@localhost/oper")
    monkeypatch.setenv("APP_RW_PASSWORD", "secret")
    _stub_migrations(monkeypatch)
    repo = get_rollup_repository()
    assert isinstance(repo, PgRollupRepository)


def test_get_solution_repository_pg(monkeypatch):
    monkeypatch.setenv("DB_URL", "postgresql://app_rw@localhost/oper")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@localhost/oper")
    monkeypatch.setenv("APP_RW_PASSWORD", "secret")
    _stub_migrations(monkeypatch)
    repo = get_solution_repository()
    assert isinstance(repo, PgSolutionRepository)


def test_get_catalog_repository_pg(monkeypatch):
    monkeypatch.setenv("DB_URL", "postgresql://app_rw@localhost/oper")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@localhost/oper")
    monkeypatch.setenv("APP_RW_PASSWORD", "secret")
    _stub_migrations(monkeypatch)
    repo = cat_deps.get_catalog_repository()
    assert isinstance(repo, PgCatalogRepository)


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


def test_get_rollup_service(monkeypatch):
    for k in ("ADMIN_DB_URL", "DB_URL"):
        monkeypatch.delenv(k, raising=False)
    svc = get_rollup_service()
    assert svc is not None
