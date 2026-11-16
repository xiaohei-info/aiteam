"""R5：租户状态读写与数据清理的 SQL 路径（用假的 psycopg 连接，不依赖真实 PG）。

真实 PG 上的清理由集成测试把关；这里固定住每条语句的顺序与分支：
外键阻塞重试、残留行报错、签名私钥删除、企业代码释放、开通回执匿名化。
"""

from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch

import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg import errors

from manager_service import tenant_status
from manager_service.tenant_status import (
    TenantStatusStore, _decide, _remove_tenant_files, fetch_tenant_status,
    install_tenant_status_guard, purge_tenant_data,
)
from shared.config import Settings
from shared.errors import Conflict, ServiceUnavailable

T = "11111111-1111-4111-8111-111111111111"


class _Cur:
    def __init__(self, one=None, rows=(), rowcount=0):
        self._one, self._rows, self.rowcount = one, list(rows), rowcount

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._rows


class _Conn:
    """按语句文本分发结果；handler 返回 None 时给一个空游标。"""

    def __init__(self, handler=lambda text, params: None):
        self.handler, self.calls = handler, []

    def execute(self, query, params=()):
        text = query if isinstance(query, str) else query.as_string(None)
        self.calls.append((text, params))
        return self.handler(text, params) or _Cur()

    def transaction(self):
        return nullcontext()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _connect(conn):
    return patch("psycopg.connect", return_value=conn)


# ---- 状态读取 ----

def test_fetch_tenant_status_reads_registry_and_defaults_to_active():
    with _connect(_Conn(lambda text, params: _Cur(one=("suspended",)))):
        assert fetch_tenant_status("dsn", T) == "suspended"
    with _connect(_Conn()):  # 未登记的租户：按正常处理，存在性由其他校验负责
        assert fetch_tenant_status("dsn", T) == "active"


def test_fetch_tenant_status_maps_database_failure_to_503():
    with patch("psycopg.connect", side_effect=psycopg.OperationalError("down")):
        with pytest.raises(ServiceUnavailable):
            fetch_tenant_status("dsn", T)


def test_store_record_reads_status_and_purged_at_without_cache():
    conn = _Conn(lambda text, params: _Cur(one=("deleted", None)))
    with _connect(conn):
        assert TenantStatusStore("dsn").record(T) == ("deleted", None)
    assert "purged_at" in conn.calls[0][0] and conn.calls[0][1] == (T,)


def test_store_set_status_writes_and_drops_the_cached_value():
    store = TenantStatusStore("dsn", fetch=lambda dsn, tenant: "active")
    assert store.get(T) == "active"
    conn = _Conn(lambda text, params: _Cur(rowcount=1))
    with _connect(conn):
        assert store.set_status(T, "banned", "违规") is True
    assert conn.calls[0][1] == ("banned", "违规", T)
    assert T not in store._cache  # 下次读取直接看到新状态，不等 5 秒
    with _connect(_Conn(lambda text, params: _Cur(rowcount=0))):
        assert store.set_status(T, "banned", None) is False


# ---- 入口拦截的边界 ----

def test_decide_ignores_tokens_without_a_tenant():
    verifier = SimpleNamespace(verify=lambda token: SimpleNamespace(tenant_id=None))
    store = SimpleNamespace(get=lambda tenant: pytest.fail("status must not be read"))
    assert _decide(verifier, store, "tok", "POST", "/api/manager/employees") is None


def test_guard_cannot_be_installed_after_the_app_started():
    app = FastAPI()
    app.middleware_stack = app.build_middleware_stack()
    with pytest.raises(RuntimeError, match="before the application starts"):
        install_tenant_status_guard(app)


# ---- 清理 ----

def test_purge_rejects_a_malformed_tenant_id_before_touching_the_database():
    with patch("psycopg.connect", side_effect=AssertionError("must not connect")):
        with pytest.raises(Conflict, match="invalid tenant id"):
            purge_tenant_data("dsn", "1; DROP TABLE x", None)


def test_purge_deletes_tenant_tables_in_dependency_order_then_releases_identity(tmp_path):
    blocked_once = {"employee"}

    def handler(text, params):
        if "information_schema.columns" in text:
            # 控制面表（tenant_registry 等）即使带 tenant_id 也不在删除清单里
            return _Cur(rows=[("employee",), ("grant_record",), ("tenant_registry",), ("tenant_signing_key",)])
        if text.startswith("DELETE FROM \"employee\"") and blocked_once:
            blocked_once.clear()
            raise errors.ForeignKeyViolation("grant_record still references employee")
        if text.startswith("DELETE FROM \"employee\""):
            return _Cur(rowcount=3)
        if text.startswith("DELETE FROM \"grant_record\""):
            return _Cur(rowcount=2)
        if text.startswith("SELECT count(*)"):
            return _Cur(one=(0,))
        return None

    for namespace in ("knowledge", "avatars"):
        (tmp_path / namespace / T).mkdir(parents=True)
        (tmp_path / namespace / T / "f.bin").write_bytes(b"x")
    conn = _Conn(handler)
    with _connect(conn):
        counts = purge_tenant_data("dsn", T, tmp_path)

    assert counts == {"employee": 3, "grant_record": 2}
    statements = [text for text, _ in conn.calls]
    deletes = [text for text in statements if text.startswith("DELETE FROM \"")]
    # employee 第一轮被外键挡住，等 grant_record 删完后第二轮才删掉
    assert deletes == [
        'DELETE FROM "employee" WHERE tenant_id = %s::uuid',
        'DELETE FROM "grant_record" WHERE tenant_id = %s::uuid',
        'DELETE FROM "employee" WHERE tenant_id = %s::uuid',
    ]
    assert not any('"tenant_registry"' in text or '"tenant_signing_key"' in text for text in deletes)
    assert any("set_config('app.tenant_id'" in text for text in statements)
    tail = statements[-3:]
    assert tail[0].startswith("DELETE FROM tenant_signing_key")
    assert tail[1].startswith("UPDATE manager_onboarding_receipt SET enterprise_slug")
    assert tail[2].startswith("UPDATE tenant_registry SET enterprise_slug") and "purged_at = now()" in tail[2]
    released = f"deleted-{T}"
    assert conn.calls[-1][1] == (released, released, T) and conn.calls[-2][1] == (released, released, T)
    assert not (tmp_path / "knowledge" / T).exists() and not (tmp_path / "avatars" / T).exists()


def test_purge_fails_loudly_when_rows_are_left_behind():
    def handler(text, params):
        if "information_schema.columns" in text:
            return _Cur(rows=[("employee",)])
        if text.startswith("SELECT count(*)"):
            return _Cur(one=(2,))  # 例如 RLS 把删除静默过滤掉了
        return _Cur(rowcount=0)

    conn = _Conn(handler)
    with _connect(conn), pytest.raises(Conflict, match="left rows behind"):
        purge_tenant_data("dsn", T, None)
    # 没清干净就不能释放企业代码、标记已清理
    assert not any(text.startswith("UPDATE tenant_registry") for text, _ in conn.calls)


def test_remove_tenant_files_skips_missing_dirs_and_refuses_symlinks(tmp_path, caplog):
    assert _remove_tenant_files(None, T) == []
    assert _remove_tenant_files(tmp_path, T) == []  # 没有目录：无事可做

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    (tmp_path / "knowledge").mkdir()
    (tmp_path / "knowledge" / T).symlink_to(outside, target_is_directory=True)
    with caplog.at_level("WARNING", logger=tenant_status.logger.name):
        left = _remove_tenant_files(tmp_path, T)
    assert left == [f"knowledge/{T}"]
    assert (outside / "keep.txt").exists()  # 绝不顺着软链接删到存储根之外
    assert "symlinked tenant storage" in caplog.text


# ---- 路由侧的装配 ----

def test_seed_enterprise_name_writes_through_the_tenant_context(monkeypatch):
    from manager_service import routes_tenant, settings_repository

    seen = {}

    class Repo:
        def __init__(self, router):
            seen["router"] = router

        def ensure_enterprise_name(self, ctx, name):
            seen["ctx"], seen["name"] = ctx, name

    monkeypatch.setattr("shared.db.PgTenantRouter", lambda dsn: ("router", dsn))
    monkeypatch.setattr(settings_repository, "SettingsRepository", Repo)
    routes_tenant.seed_enterprise_name("postgresql://biz", T, "星河科技")
    assert seen["router"] == ("router", "postgresql://biz") and seen["name"] == "星河科技"
    assert seen["ctx"].tenant_id == T and seen["ctx"].roles == ["owner"]


def _lifecycle_app(admin_db_url):
    from manager_service.app import router as manager_router
    from manager_service.routes_tenant import router as tenant_router
    from manager_service.service_ingress import require_operator_service_principal
    from shared.app_factory import create_app

    app = create_app(Settings(tier="manager", service_name="m", admin_db_url=admin_db_url), manager_router)
    app.include_router(tenant_router)
    return app, require_operator_service_principal


def test_lifecycle_route_builds_the_store_on_first_use_and_needs_the_admin_db():
    from manager_service.service_ingress import canonical_body_sha256

    path = f"/api/manager/tenants/{T}/status"
    body = {"status": "closed"}

    def principal():
        return SimpleNamespace(
            purpose="service", scope=("tenant:lifecycle",), capability="tenant-lifecycle", kid="k1",
            enterprise_id=None, tenant_id=T, path=path, idempotency_key="idem-1",
            body_sha256=canonical_body_sha256(body),
        )

    app, dependency = _lifecycle_app("postgresql://admin/x")
    app.dependency_overrides[dependency] = principal
    conn = _Conn(lambda text, params: _Cur(one=("active", None), rowcount=1))
    with _connect(conn):
        r = TestClient(app).post(path, json=body, headers={"Idempotency-Key": "idem-1"})
    assert r.status_code == 200, r.text
    assert isinstance(app.state._tenant_status_store, TenantStatusStore)
    assert any(text.startswith("UPDATE tenant_registry SET status") for text, _ in conn.calls)

    app, dependency = _lifecycle_app(None)
    app.dependency_overrides[dependency] = principal
    r = TestClient(app).post(path, json=body, headers={"Idempotency-Key": "idem-1"})
    assert r.status_code == 503 and r.json()["code"] == "manager_admin_db_unconfigured"


def test_lifecycle_route_requires_a_signed_service_principal():
    path = f"/api/manager/tenants/{T}/status"
    app, dependency = _lifecycle_app("postgresql://admin/x")
    app.dependency_overrides[dependency] = lambda: None  # 没有签名身份，也不是 TEST 兼容模式
    r = TestClient(app).post(path, json={"status": "closed"}, headers={"Idempotency-Key": "idem-1"})
    assert r.status_code == 401
    assert getattr(app.state, "_tenant_status_store", None) is None


# ---- /me 的企业代码读取 ----

def test_me_registry_code_reader_tolerates_missing_dsn_rows_and_outages():
    from manager_service.routes_me import _registry_code_reader

    assert _registry_code_reader(None)(T) is None
    with _connect(_Conn(lambda text, params: _Cur(one=("acme",)))):
        assert _registry_code_reader("dsn")(T) == "acme"
    with _connect(_Conn()):
        assert _registry_code_reader("dsn")(T) is None
    with patch("psycopg.connect", side_effect=psycopg.OperationalError("down")):
        assert _registry_code_reader("dsn")(T) is None
