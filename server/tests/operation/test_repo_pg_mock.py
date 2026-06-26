"""PgEnterpriseRepository + apply_migrations 的 mock 单元测试。

用 mock 替代真实 PostgreSQL，覆盖 PG 实现 CRUD 三方法、UniqueViolation 冲突分支，
以及 apply_migrations 的迁移文件执行 + 角色口令下发 + 无口令分支。标 `not integration`。
"""

import pytest

from operation_service.repository import (
    EnterpriseAccount,
    PgEnterpriseRepository,
    _migrations_dir,
    apply_migrations,
)
from shared.errors import Conflict, NotFound


def _account(eid: str = "ent-1", code: str | None = "code1") -> EnterpriseAccount:
    return EnterpriseAccount(
        enterprise_id=eid,
        tenant_id="ten-1",
        enterprise_name="Test",
        enterprise_code=code,
        owner_phone="13800000000",
        owner_bootstrap_hash="hash1",
    )


class _FakeCursor:
    def __init__(self) -> None:
        self.executed: list[tuple] = []
        self.rowcount = 1
        self._row: tuple | None = None

    def execute(self, sql, params=None) -> None:
        self.executed.append((sql, params))
        if "current_database" in sql:
            self._row = ("testdb",)

    def fetchone(self):
        return self._row

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def cursor(self) -> _FakeCursor:
        return self._cursor

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _patch_psycopg_connect(monkeypatch, cursor=None):
    cur = cursor or _FakeCursor()
    conn = _FakeConn(cur)
    import sys

    import psycopg.errors as real_errors
    import psycopg.sql as real_sql

    fake = type("psycopg", (), {"connect": staticmethod(lambda dsn, **kw: conn)})()
    fake.errors = real_errors
    fake.sql = real_sql
    monkeypatch.setitem(sys.modules, "psycopg", fake)
    return conn, cur


# ---- create ----

def test_pg_create_success(monkeypatch):
    conn, cur = _patch_psycopg_connect(monkeypatch)
    repo = PgEnterpriseRepository("postgresql://test")
    acc = _account()
    result = repo.create(acc)
    assert result is acc
    assert any("INSERT" in s for s, _ in cur.executed)


def test_pg_create_conflict_pkey(monkeypatch):
    from psycopg.errors import UniqueViolation

    conn, cur = _patch_psycopg_connect(monkeypatch)

    def _execute(sql, params=None):
        if "INSERT" in sql:
            raise UniqueViolation("duplicate key value violates enterprise_account_pkey")
        cur.executed.append((sql, params))

    cur.execute = _execute
    repo = PgEnterpriseRepository("postgresql://test")
    with pytest.raises(Conflict, match="enterprise already exists"):
        repo.create(_account())


def test_pg_create_conflict_code(monkeypatch):
    from psycopg.errors import UniqueViolation

    conn, cur = _patch_psycopg_connect(monkeypatch)

    def _execute(sql, params=None):
        if "INSERT" in sql:
            raise UniqueViolation(
                "duplicate key value violates uq_enterprise_account_enterprise_code"
            )
        cur.executed.append((sql, params))

    cur.execute = _execute
    repo = PgEnterpriseRepository("postgresql://test")
    with pytest.raises(Conflict, match="enterprise_code already taken"):
        repo.create(_account(code="dupcode"))


def test_pg_create_conflict_other(monkeypatch):
    from psycopg.errors import UniqueViolation

    conn, cur = _patch_psycopg_connect(monkeypatch)

    def _execute(sql, params=None):
        if "INSERT" in sql:
            raise UniqueViolation("some other unknown violation")
        cur.executed.append((sql, params))

    cur.execute = _execute
    repo = PgEnterpriseRepository("postgresql://test")
    with pytest.raises(Conflict, match="enterprise constraint violation"):
        repo.create(_account())


# ---- get ----

def test_pg_get_success(monkeypatch):
    conn, cur = _patch_psycopg_connect(monkeypatch)
    cur._row = ("ent-1", "ten-1", "Test Corp", "code1", "13800000000", "hash1")
    repo = PgEnterpriseRepository("postgresql://test")
    result = repo.get("ent-1")
    assert result.enterprise_id == "ent-1"
    assert result.tenant_id == "ten-1"
    assert result.enterprise_name == "Test Corp"
    assert result.enterprise_code == "code1"
    assert result.owner_phone == "13800000000"
    assert result.owner_bootstrap_hash == "hash1"


def test_pg_get_not_found(monkeypatch):
    conn, cur = _patch_psycopg_connect(monkeypatch)
    cur._row = None
    repo = PgEnterpriseRepository("postgresql://test")
    with pytest.raises(NotFound, match="enterprise not found"):
        repo.get("nope")


# ---- update_bootstrap_hash ----

def test_pg_update_bootstrap_hash_success(monkeypatch):
    conn, cur = _patch_psycopg_connect(monkeypatch)
    cur.rowcount = 1
    cur._row = ("ent-1", "ten-1", "Test", "code1", "138", "new_hash")
    repo = PgEnterpriseRepository("postgresql://test")
    result = repo.update_bootstrap_hash("ent-1", "new_hash")
    assert result.owner_bootstrap_hash == "new_hash"


def test_pg_update_bootstrap_hash_not_found(monkeypatch):
    conn, cur = _patch_psycopg_connect(monkeypatch)
    cur.rowcount = 0
    repo = PgEnterpriseRepository("postgresql://test")
    with pytest.raises(NotFound, match="enterprise not found"):
        repo.update_bootstrap_hash("nope", "new_hash")


# ---- _migrations_dir ----

def test_migrations_dir_returns_existing_path():
    p = _migrations_dir()
    assert p.name == "migrations"
    assert p.is_dir()


# ---- apply_migrations ----

def test_apply_migrations_no_db_url_noop():
    assert apply_migrations(None) is None
    assert apply_migrations("") is None


def test_apply_migrations_no_migrations_dir(monkeypatch, tmp_path):
    import operation_service.repository as repo_mod

    monkeypatch.setattr(repo_mod, "_migrations_dir", lambda: tmp_path / "nonexistent")
    assert apply_migrations("postgresql://admin") is None


def _patch_apply_migrations_psycopg(monkeypatch):
    """Patch sys.modules['psycopg'] for apply_migrations's local `import psycopg`."""
    captured: list = []

    def _connect(dsn, **kw):
        c = _FakeConn(_FakeCursor())
        captured.append(c)
        return c

    import sys
    import psycopg.errors as real_errors
    import psycopg.sql as real_sql

    fake_psycopg = type("psycopg", (), {"connect": staticmethod(_connect)})()
    fake_psycopg.errors = real_errors
    fake_psycopg.sql = real_sql
    monkeypatch.setitem(sys.modules, "psycopg", fake_psycopg)
    monkeypatch.setitem(sys.modules, "psycopg.errors", real_errors)
    monkeypatch.setitem(sys.modules, "psycopg.sql", real_sql)
    return captured


def test_apply_migrations_executes_files_with_password(monkeypatch):
    captured = _patch_apply_migrations_psycopg(monkeypatch)
    apply_migrations("postgresql://admin", "secret_pw")
    assert len(captured) == 1
    cursor = captured[0]._cursor
    sqls = [str(s) for s, _ in cursor.executed]
    assert any("'secret_pw'" in s for s in sqls)


def test_apply_migrations_without_password(monkeypatch):
    captured = _patch_apply_migrations_psycopg(monkeypatch)
    apply_migrations("postgresql://admin", None)
    assert len(captured) == 1
    cursor = captured[0]._cursor
    sqls = [str(s) for s, _ in cursor.executed]
    assert not any("'secret_pw'" in s for s in sqls)
    assert any("GRANT CONNECT" in s for s in sqls)
