"""MCP 相关仓储与路由的 mock 单元测试（无需真实 PostgreSQL）。

覆盖 PG 实现分支：platform_mcp_market（Operator 平台目录）、mcp_catalog（企业目录）、
operator_catalog（服务间拉取端口）与 routes_mcp_market 的
「未注入服务 → 自建或 503」分支。不标 integration。
"""

from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from shared.contracts.platform_mcp import PlatformMcpServerFields
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, NotFound, ServiceUnavailable

CTX = TenantContext(tenant_id="00000000-0000-4000-8000-0000000000aa", user_id="u1", roles=["owner"])

_SERVER_ROW = ("s1", "cr-test", "CRM", "客户", "https://crm.example.com/mcp", ["a"], "oauth", "",
               "openid", 30000, "app-1", 1, "published", True)


class _FakeCursor:
    def __init__(self):
        self.calls: list[tuple[str, tuple]] = []
        self._queue: list = []
        self._fetchone = None
        self._fetchall: list = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.calls.append((sql, params or ()))
        if self._queue:
            self._queue.pop(0)(self)
        return self

    def fetchone(self):
        return self._fetchone

    def fetchall(self):
        return self._fetchall

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def execute(self, sql, params=None):
        return self._cursor.execute(sql, params)

    def commit(self):
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


def _body(**overrides) -> PlatformMcpServerFields:
    base = dict(ref="cr-test", display_name="CRM", summary="", url="https://crm.example.com/mcp",
                tools=["a"], auth="oauth", auth_header="", oauth_scopes="", timeout_ms=30000,
                oauth_client_id="app-1", oauth_client_secret=None)
    base.update(overrides)
    return PlatformMcpServerFields(**base)


# --------------------------------------------------------------------------
# Operator: platform_mcp_market.PlatformMcpRepository
# --------------------------------------------------------------------------

def test_platform_mcp_repository_crud_paths(monkeypatch):
    from operation_service.platform_mcp_market import PlatformMcpRepository

    cursor = _FakeCursor()
    _install_psycopg(monkeypatch, _FakeConn(cursor))
    repo = PlatformMcpRepository("postgresql://x")

    cursor._queue.append(lambda c: setattr(c, "_fetchall", [_SERVER_ROW]))
    assert repo.list()[0].server_id == "s1"

    cursor._queue.append(lambda c: setattr(c, "_fetchall", [_SERVER_ROW]))
    assert repo.list(status="published")[0].ref == "cr-test"

    cursor._queue.append(lambda c: setattr(c, "_fetchone", _SERVER_ROW))
    assert repo.get("s1").display_name == "CRM"

    cursor._queue.append(lambda c: setattr(c, "_fetchone", None))
    with pytest.raises(NotFound):
        repo.get("missing")

    cursor._queue.append(lambda c: setattr(c, "_fetchone", _SERVER_ROW))
    created = repo.create(_body())
    assert created.ref == "cr-test"

    cursor._queue.append(lambda c: setattr(c, "_fetchone", ("cr-test", None)))
    cursor._queue.append(lambda c: setattr(c, "_fetchone", _SERVER_ROW))
    assert repo.update("s1", _body()).revision == 1

    cursor._queue.append(lambda c: setattr(c, "_fetchone", None))
    with pytest.raises(NotFound):
        repo.update("missing", _body())

    cursor._queue.append(lambda c: setattr(c, "_fetchone", ("other", None)))
    with pytest.raises(Conflict):
        repo.update("s1", _body())

    cursor._queue.append(lambda c: setattr(c, "_fetchone", _SERVER_ROW))
    assert repo.set_status("s1", "published").status == "published"

    with pytest.raises(Exception):
        repo.set_status("s1", "bogus")
    cursor._queue.append(lambda c: setattr(c, "_fetchone", None))
    with pytest.raises(NotFound):
        repo.set_status("missing", "published")


def test_platform_mcp_repository_pull_decrypts_secret(monkeypatch):
    from operation_service.platform_mcp_market import PlatformMcpRepository
    from cryptography.fernet import Fernet

    from shared.crypto import CryptoService

    crypto = CryptoService(Fernet(Fernet.generate_key()))
    encrypted = crypto.encrypt("app-secret")
    cursor = _FakeConn(_FakeCursor())
    cursor._cursor._queue.append(lambda c: setattr(c, "_fetchall", [_SERVER_ROW[:13] + (encrypted,)]))
    _install_psycopg(monkeypatch, cursor)
    repo = PlatformMcpRepository("postgresql://x", crypto=crypto)
    pulled = repo.list_for_pull()
    assert pulled[0].server_id == "s1"
    assert pulled[0].oauth_client_secret_set is True
    assert pulled[0].oauth_client_secret == "app-secret"


def test_secret_cipher_requires_configuration(monkeypatch):
    from operation_service.platform_mcp_market import _SecretCipher

    monkeypatch.delenv("OPERATION_PROVIDER_CREDENTIAL_KEY", raising=False)
    cipher = _SecretCipher()
    with pytest.raises(ServiceUnavailable):
        cipher.encrypt("x")


def test_create_translates_unique_violation(monkeypatch):
    import psycopg.errors as real_errors

    from operation_service.platform_mcp_market import PlatformMcpRepository

    cursor = _FakeCursor()
    _install_psycopg(monkeypatch, _FakeConn(cursor))

    def boom(self):
        raise real_errors.UniqueViolation("dup")

    cursor._queue.append(boom)
    with pytest.raises(Conflict):
        PlatformMcpRepository("postgresql://x").create(_body())


# --------------------------------------------------------------------------
# Manager: mcp_catalog.McpCatalogRepository
# --------------------------------------------------------------------------

class _FakeRouter:
    def __init__(self, cursor):
        self._cursor = cursor

    def session(self, ctx):
        return self._cursor


def _catalog_row(secret_set=False):
    return ("s1", "cr-test", "CRM", "客户", "https://crm.example.com/mcp", ["a"], "oauth", "",
            "openid", 30000, "app-1", secret_set, 1)


def test_mcp_catalog_repository_paths():
    from manager_service.mcp_catalog import McpCatalogRepository

    cursor = _FakeCursor()
    repo = McpCatalogRepository(_FakeRouter(cursor))

    cursor._queue.append(lambda c: setattr(c, "_fetchall", [_catalog_row()]))
    assert [row.ref for row in repo.list(CTX)] == ["cr-test"]

    cursor._queue.append(lambda c: setattr(c, "_fetchone", ("oauth", "app-1", b"enc")))
    assert repo.oauth_client(CTX, "s1") == ("oauth", "app-1", b"enc")
    cursor._queue.append(lambda c: setattr(c, "_fetchone", ("oauth", "app-1", None)))
    assert repo.oauth_client(CTX, "s1") == ("oauth", "app-1", None)
    cursor._queue.append(lambda c: setattr(c, "_fetchone", None))
    assert repo.oauth_client(CTX, "missing") is None

    from shared.contracts.platform_mcp import PlatformMcpServerPull
    server = PlatformMcpServerPull(server_id="s1", ref="cr-test", display_name="CRM", summary="",
                                   url="https://crm.example.com/mcp", tools=["a"], auth="oauth", auth_header="",
                                   oauth_scopes="", timeout_ms=30000, oauth_client_id="app-1", revision=1,
                                   status="published", oauth_client_secret_set=False, oauth_client_secret="")
    cursor._queue.append(lambda c: setattr(c, "_fetchone", None))
    cursor._queue.append(lambda c: setattr(c, "_fetchone", _catalog_row()))
    assert repo.upsert(CTX, server, enabled_by="owner-1").ref == "cr-test"

    cursor._queue.append(lambda c: setattr(c, "_fetchone", ("other",)))
    with pytest.raises(Conflict):
        repo.upsert(CTX, server, enabled_by="owner-1")

    cursor._queue.append(lambda c: setattr(c, "_fetchone", ("s1",)))
    assert repo.delete(CTX, "s1") is True
    cursor._queue.append(lambda c: setattr(c, "_fetchone", None))
    assert repo.delete(CTX, "missing") is False


# --------------------------------------------------------------------------
# Manager: operator_catalog 端口
# --------------------------------------------------------------------------

def test_operator_catalog_unavailable_paths(monkeypatch):
    from manager_service import operator_catalog as module

    client = module.OperatorCatalogClient(base_url="http://127.0.0.1:9")

    def down(*args, **kwargs):
        raise module.OperatorCatalogUnavailable("down")

    monkeypatch.setattr(client, "_get", down)
    with pytest.raises(module.OperatorCatalogUnavailable):
        client.list_platform_mcp_servers()


# --------------------------------------------------------------------------
# 路由：未注入服务时的分支
# --------------------------------------------------------------------------

def test_manager_routes_build_service_when_db_configured():
    """routes_mcp_market._service 在未注入且 db 已配置时自建（覆盖 26-41 行）。"""
    from fastapi import FastAPI
    from manager_service.routes_mcp_market import _service

    app = FastAPI()
    app.state.settings = SimpleNamespace(db_url="postgresql://x")
    app.state._operator_catalog = SimpleNamespace(list_platform_mcp_servers=lambda: [])
    app.state._crypto_service = None
    request = SimpleNamespace(app=app)
    service = _service(request)
    assert service is not None
    assert app.state._mcp_market_service is service


def test_manager_routes_without_db_are_503():
    from fastapi import FastAPI
    from manager_service.routes_mcp_market import _ManagerNotConfigured, _service

    app = FastAPI()
    app.state.settings = SimpleNamespace(db_url=None)
    request = SimpleNamespace(app=app)
    with pytest.raises(_ManagerNotConfigured):
        _service(request)
