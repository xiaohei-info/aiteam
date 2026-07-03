"""Pg*仓储的 mock 单元测试（无需真实 PostgreSQL，标 `not integration`）。

用 mock 替代真实 PostgreSQL，覆盖各仓储 PG 实现类的核心方法路径、SQL 分支以及行为
契约。每个仓储至少验证：CRUD 入口调用了对应 SQL、抽象基类的签名实现一致，以及
DI 契约（`admin_db_url` 有值 → PG, 无值 → 内存现成实现）。
"""

import sys
from datetime import datetime, timezone
from decimal import Decimal
from importlib import reload
from uuid import uuid4

import pytest

import operation_service.admin_dependencies as admin_deps
import operation_service.dependencies as deps
from shared.contracts.enums import (
    AuditResult,
    AuditSeverity,
    CatalogStatus,
    CatalogType,
    EnterpriseOperationStatus,
)
from shared.contracts.summary import UsageSummary
from shared.errors import NotFound

# ---- shared psycopg mock -------------------------------------------------


class _FakeCursor:
    def __init__(self, rows=None):
        self.executed = []
        self.rowcount = 1
        self._rows = rows if rows is not None else []
        self._iter = iter(self._rows)

    def execute(self, sql, params=None):
        self.executed.append((sql, params or ()))
        # Simulate empty/no-row behaviour for "SELECT 1 ..."
        self._last_has_row = bool(self._rows) and any(r is not None for r in self._rows)

    def fetchone(self):
        try:
            return next(self._iter)
        except StopIteration:
            return None

    def fetchall(self):
        r, self._rows = self._rows, []
        return r

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _install_psycopg(monkeypatch, conn):
    import psycopg.errors as real_errors
    import psycopg.sql as real_sql

    fake = type("psycopg", (), {"connect": staticmethod(lambda dsn, **kw: conn)})()
    fake.errors = real_errors
    fake.sql = real_sql
    monkeypatch.setitem(sys.modules, "psycopg", fake)


def _summaries():
    return [
        UsageSummary(
            summary_id=f"s{i}", tenant_id="t1", window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            window_end=datetime(2026, 1, 2, tzinfo=timezone.utc),
            run_count=i, token_total=100 * i, cost_total=Decimal("1.5") * i,
            error_count=0, duration_seconds_total=10 * i,
        )
        for i in (1, 2)
    ]


# ---- AdminRepository PG --------------------------------------------------


class TestPgAdminRepository:
    @pytest.fixture(autouse=True)
    def _psy(self, monkeypatch):
        self.conn = _FakeConn(_FakeCursor())
        _install_psycopg(monkeypatch, self.conn)
        self.c = self.conn._cursor

    def _make(self):
        from operation_service.admin_repository import PgAdminRepository
        return PgAdminRepository("postgresql://test")

    def test_register_enterprise(self):
        # branch: no existing row -> INSERT, then _fetch_state returns a row.
        c = self.conn._cursor
        row = ("ent-1", "Test Corp", "13800000000", "active", Decimal("0"),
               datetime(2026, 1, 1, tzinfo=timezone.utc), None, None, None, None, None)

        def fake_execute(sql, params=None):
            c.executed.append((sql, params or ()))
            if sql.strip().startswith("SELECT 1 FROM enterprise_account"):
                c._iter = iter([])        # no existing row -> INSERT branch
            elif "FROM enterprise_account" in sql and sql.strip().startswith("SELECT"):
                c._iter = iter([row])     # _fetch_state
            else:
                c._iter = iter([])

        c.execute = fake_execute
        repo = self._make()
        state = repo.register_enterprise("ent-1", "Test Corp", "13800000000")
        joined = "\n".join(s for s, _ in c.executed)
        assert "enterprise_account" in joined
        assert state.enterprise_id == "ent-1"

    def test_pg_inherits_base(self):
        from operation_service.admin_repository import AdminRepositoryBase
        assert issubclass(type(self._make()), AdminRepositoryBase)


# ---- RollupRepository PG -------------------------------------------------


class TestPgRollupRepository:
    @pytest.fixture(autouse=True)
    def _psy(self, monkeypatch):
        self.conn = _FakeConn(_FakeCursor())
        _install_psycopg(monkeypatch, self.conn)

    def _make(self):
        from operation_service.rollup_repository import PgRollupRepository
        return PgRollupRepository("postgresql://test")

    def test_apply_summary_executes_both_sqls(self):
        s = _summaries()[0]
        calls = []
        self.conn._cursor.execute = lambda sql, params=None: calls.append(sql)
        self._make().apply_summary("ent-1", "t1", s)
        joined = "\n".join(calls)
        assert "operation_rollup_seen" in joined
        assert "cross_enterprise_usage_rollup" in joined

    def test_pg_inherits_base(self):
        from operation_service.rollup_repository import CrossEnterpriseRollupRepositoryBase
        assert issubclass(type(self._make()), CrossEnterpriseRollupRepositoryBase)


# ---- CatalogRepository PG ------------------------------------------------


class TestPgCatalogRepository:
    @pytest.fixture(autouse=True)
    def _psy(self, monkeypatch):
        self.conn = _FakeConn(_FakeCursor())
        _install_psycopg(monkeypatch, self.conn)

    def _make(self):
        from operation_service.catalog_repository import PgCatalogRepository
        return PgCatalogRepository("postgresql://test")

    def test_create_calls_insert(self):
        calls = []
        self.conn._cursor.execute = lambda sql, params=None: calls.append(sql)
        # match() does a SELECT - no rows -> then INSERT
        from operation_service.catalog_repository import CatalogEntry
        self._make().create(CatalogEntry(
            catalog_type=CatalogType.EXPERT_TEMPLATE, template_id="x1",
            version="1", display_name="X", status=CatalogStatus.DRAFT,
        ))
        assert any(s.startswith("INSERT INTO catalog_template") for s in calls)

    def test_pg_inherits_base(self):
        from operation_service.catalog_repository import CatalogRepositoryBase
        assert issubclass(type(self._make()), CatalogRepositoryBase)


# ---- SolutionRepository PG -----------------------------------------------


class TestPgSolutionRepository:
    @pytest.fixture(autouse=True)
    def _psy(self, monkeypatch):
        self.conn = _FakeConn(_FakeCursor())
        _install_psycopg(monkeypatch, self.conn)

    def _make(self):
        from operation_service.solution_repository import PgSolutionRepository
        return PgSolutionRepository("postgresql://test")

    def test_record_apply_calls_insert(self):
        calls = []
        self.conn._cursor.execute = lambda sql, params=None: calls.append(sql)
        self._make().record_apply(solution_id="sol-1", enterprise_id="ent-1")
        assert any(s.startswith("INSERT INTO solution_stat") for s in calls)

    def test_pg_inherits_base(self):
        from operation_service.solution_repository import SolutionRepositoryBase
        assert issubclass(type(self._make()), SolutionRepositoryBase)


# ---- DI factory 切换 ------------------------------------------------------


class TestDIFactoryBranch:
    @pytest.fixture(autouse=True)
    def _reset(self, monkeypatch):
        from operation_service import dependencies as d
        from operation_service import admin_dependencies as a
        from operation_service import catalog_dependencies as c
        monkeypatch.setattr(d, "apply_migrations", lambda *x, **y: None)
        monkeypatch.setattr(a, "apply_migrations", lambda *x, **y: None)
        monkeypatch.setattr(c, "apply_migrations", lambda *x, **y: None)
        from operation_service.dependencies import get_admin_repository
        get_admin_repository.cache_clear()
        d.get_repository.cache_clear()
        d.get_admin_repository.cache_clear()
        d.get_rollup_repository.cache_clear()
        a.get_solution_repository.cache_clear()
        c.get_catalog_repository.cache_clear()

    def test_all_memory_when_no_db(self, monkeypatch):
        for k in ("ADMIN_DB_URL", "DB_URL", "APP_RW_PASSWORD"):
            monkeypatch.delenv(k, raising=False)
        from operation_service.admin_repository import AdminRepository
        from operation_service.catalog_repository import CatalogRepository
        from operation_service.rollup_repository import CrossEnterpriseRollupRepository
        from operation_service.solution_repository import SolutionRepository
        from operation_service.dependencies import get_admin_repository, get_rollup_repository
        from operation_service.repository import InMemoryEnterpriseRepository
        assert isinstance(deps.get_repository(), InMemoryEnterpriseRepository)
        assert isinstance(deps.get_admin_repository(), AdminRepository)
        assert isinstance(deps.get_rollup_repository(), CrossEnterpriseRollupRepository)
        assert isinstance(admin_deps.get_solution_repository(), SolutionRepository)
        from operation_service import catalog_dependencies as cd
        assert isinstance(cd.get_catalog_repository(), CatalogRepository)

    def test_all_pg_when_db_set(self, monkeypatch):
        monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@localhost/oper")
        monkeypatch.setenv("APP_RW_PASSWORD", "secret")
        from operation_service.admin_repository import PgAdminRepository
        from operation_service.catalog_repository import PgCatalogRepository
        from operation_service.rollup_repository import PgRollupRepository
        from operation_service.solution_repository import PgSolutionRepository
        from operation_service.repository import PgEnterpriseRepository
        assert isinstance(deps.get_repository(), PgEnterpriseRepository)
        assert isinstance(deps.get_admin_repository(), PgAdminRepository)
        assert isinstance(deps.get_rollup_repository(), PgRollupRepository)
        assert isinstance(admin_deps.get_solution_repository(), PgSolutionRepository)
        from operation_service import catalog_dependencies as cd
        assert isinstance(cd.get_catalog_repository(), PgCatalogRepository)
