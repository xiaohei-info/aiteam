"""shared/db PgTenantSession + PgTenantRouter + apply_migrations mock 单元测试。

覆盖 PG 实现：tenant_id property, __enter__, execute, __exit__(commit+rollback),
PgTenantRouter.isolation_level/session, apply_migrations(with/without password)。
"""

import os

import pytest

from shared.contracts.enums import IsolationLevel
from shared.contracts.tenancy import TenantContext
from shared.db import (
    PgTenantRouter,
    PgTenantSession,
    apply_migrations,
)


# ---- helpers ----

class _FakeCursor:
    def __init__(self) -> None:
        self.executed: list = []
        self._row: tuple | None = None

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if "current_database" in str(sql):
            self._row = ("testdb",)

    def fetchone(self):
        return self._row

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, cur=None):
        self._cur = cur or _FakeCursor()
        self.committed = False
        self.rolled_back = False
        self.closed = False

    def cursor(self):
        return self._cur

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


# ---- PgTenantRouter ----

def test_pg_router_isolation_level_defaults_l1():
    router = PgTenantRouter("postgresql://test")
    assert router.isolation_level("any-tenant") is IsolationLevel.L1_SHARED_RLS


def test_pg_router_session_returns_pg_session():
    router = PgTenantRouter("postgresql://test")
    ctx = TenantContext(tenant_id="t-1", user_id="u-1")
    sess = router.session(ctx)
    assert isinstance(sess, PgTenantSession)
    assert sess.tenant_id == "t-1"


# ---- PgTenantSession ----

def _patch_pg_connect(monkeypatch, conn=None):
    conn = conn or _FakeConn()
    import sys

    fake_psycopg = type("psycopg", (), {"connect": staticmethod(lambda dsn, **kw: conn)})()
    monkeypatch.setitem(sys.modules, "psycopg", fake_psycopg)
    return conn


def test_pg_session_enter_and_tenant_id(monkeypatch):
    conn = _patch_pg_connect(monkeypatch)
    sess = PgTenantSession("postgresql://test", "ten-a")
    assert sess.tenant_id == "ten-a"
    with sess as s:
        assert s is sess
        # __enter__ should connect + set_config
        assert conn.cursor() is sess._cur
    # normal exit -> commit + close
    assert conn.committed is True
    assert conn.closed is True


def test_pg_session_execute_returns_cursor(monkeypatch):
    conn = _patch_pg_connect(monkeypatch)
    sess = PgTenantSession("postgresql://test", "ten-a")
    with sess as s:
        result = s.execute("SELECT 1")
        assert result is sess._cur
        assert any("SELECT 1" in str(sql) for sql, _ in conn._cur.executed)


def test_pg_session_exit_rollback_on_exception(monkeypatch):
    conn = _patch_pg_connect(monkeypatch)
    sess = PgTenantSession("postgresql://test", "ten-a")
    with pytest.raises(RuntimeError, match="boom"):
        with sess:
            raise RuntimeError("boom")
    assert conn.rolled_back is True
    assert conn.closed is True


# ---- apply_migrations ----

def test_apply_migrations_no_db_url_noop():
    assert apply_migrations(None) is None
    assert apply_migrations("") is None


def test_apply_migrations_no_migrations_dir(monkeypatch, tmp_path):
    import sys

    fake = type("psycopg", (), {"connect": staticmethod(lambda *a, **kw: _FakeConn())})()
    monkeypatch.setitem(sys.modules, "psycopg", fake)
    import shared.db as db_mod

    monkeypatch.setattr(db_mod, "_migrations_dir", lambda: str(tmp_path / "nope"))
    assert apply_migrations("postgresql://admin") is None


def _patch_apply_migrations_psycopg(monkeypatch):
    conn = _FakeConn()
    captured = [conn]

    def _connect(dsn, **kw):
        c = _FakeConn()
        captured[0] = c
        return c

    import sys
    import psycopg.errors as real_errors
    import psycopg.sql as real_sql

    fake = type("psycopg", (), {"connect": staticmethod(_connect)})()
    fake.errors = real_errors
    fake.sql = real_sql
    monkeypatch.setitem(sys.modules, "psycopg", fake)
    monkeypatch.setitem(sys.modules, "psycopg.errors", real_errors)
    monkeypatch.setitem(sys.modules, "psycopg.sql", real_sql)
    return captured


def test_apply_migrations_with_password(monkeypatch):
    captured = _patch_apply_migrations_psycopg(monkeypatch)
    apply_migrations("postgresql://admin", "secret")
    assert len(captured) == 1
    sqls = [str(sql) for sql, _ in captured[0]._cur.executed]
    # password branch produces _sql.Literal -> 'secret' (quoted); migration-file "secret" 是无引号列名。
    assert any("'secret'" in s for s in sqls)
    assert any("GRANT CONNECT" in s for s in sqls)


def test_apply_migrations_without_password(monkeypatch):
    captured = _patch_apply_migrations_psycopg(monkeypatch)
    apply_migrations("postgresql://admin", None)
    assert len(captured) == 1
    sqls = [str(sql) for sql, _ in captured[0]._cur.executed]
    assert not any("'secret'" in s for s in sqls)
    assert any("GRANT CONNECT" in s for s in sqls)


# ---- InMemoryTenantSession.tenant_id property (line 68) ----

def test_inmemory_session_tenant_id_property():
    """InMemoryTenantSession.tenant_id getter 必须被覆盖（line 68）。"""
    from shared.db import InMemoryTenantRouter

    router = InMemoryTenantRouter()
    ctx = TenantContext(tenant_id="ten-x", user_id="u-1")
    sess = router.session(ctx)
    assert sess.tenant_id == "ten-x"
    sess.put("k", "v")
    assert sess.get("k") == "v"
