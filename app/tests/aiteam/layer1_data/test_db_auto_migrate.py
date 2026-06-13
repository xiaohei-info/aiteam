"""Startup auto-migration hook in team_panel.transactions.db (no real DB)."""
from __future__ import annotations

import pytest

import team_panel.transactions.db as db
import team_panel.migrations.runner as runner


class _FakeConn:
    def __init__(self):
        self.autocommit = False


def _setup(monkeypatch, migrate_calls):
    monkeypatch.setattr(db.psycopg2, "connect", lambda url: _FakeConn())
    monkeypatch.setattr(runner, "apply_migrations", lambda conn, **kw: migrate_calls.append(1))
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pw@127.0.0.1:5432/db")
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("AITEAM_AUTO_MIGRATE", "1")
    db._migrations_done = False


def test_auto_migrate_runs_once_per_process(monkeypatch):
    calls = []
    _setup(monkeypatch, calls)
    db.create_connection()
    db.create_connection()
    db.create_connection()
    assert len(calls) == 1, "migrations should be applied once across many connections"


def test_auto_migrate_disabled_by_env(monkeypatch):
    calls = []
    _setup(monkeypatch, calls)
    monkeypatch.setenv("AITEAM_AUTO_MIGRATE", "0")
    db.create_connection()
    assert calls == []


def test_auto_migrate_skipped_under_pytest_env(monkeypatch):
    calls = []
    _setup(monkeypatch, calls)
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "some::test")
    db.create_connection()
    assert calls == []


def test_auto_migrate_retries_after_failure(monkeypatch):
    calls = []
    _setup(monkeypatch, calls)
    state = {"first": True}

    def flaky(conn, **kw):
        if state["first"]:
            state["first"] = False
            raise RuntimeError("migration boom")
        calls.append(1)

    monkeypatch.setattr(runner, "apply_migrations", flaky)
    with pytest.raises(RuntimeError):
        db.create_connection()
    assert db._migrations_done is False, "a failed migration must not be marked done"
    db.create_connection()  # next connection retries
    assert len(calls) == 1
