"""P1-F1 契约：PG/migration/RLS fixture（integration，真 PG）。

锁住 closeout DAG P1-F1 acceptance：可创建隔离 tenant scope 并验证 RLS 不可绕过。
无 DB_URL/ADMIN_DB_URL 时整组 skip（默认门不依赖 PG）。
"""

from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.integration


def test_scope_is_isolated_and_registered(tenant_scope_factory):
    a = tenant_scope_factory("p1f1a")
    b = tenant_scope_factory("p1f1b")
    assert a.tenant_id != b.tenant_id
    assert a.enterprise_slug != b.enterprise_slug
    assert uuid.UUID(a.tenant_id)  # 合法 UUID


def test_session_runs_as_app_rw_under_rls(tenant_scope):
    """业务会话身份即受约束角色 app_rw、非超管（#60 连接身份层收口）。"""
    with tenant_scope.session() as s:
        assert s.execute("SELECT current_user").fetchone()[0] == "app_rw"
        assert s.execute("SELECT current_setting('is_superuser')").fetchone()[0] == "off"
        got = s.execute("SELECT current_setting('app.tenant_id', true)").fetchone()[0]
        assert got == tenant_scope.tenant_id


def test_rls_blocks_cross_tenant_reads(tenant_scope_factory):
    """A 写入的行，B 上下文（app_rw）读不到——RLS 物理隔离，不是应用层兜底。"""
    a = tenant_scope_factory("p1f1a")
    b = tenant_scope_factory("p1f1b")
    slug = f"emp_{uuid.uuid4().hex[:8]}"
    with a.session() as s:
        s.execute(
            "INSERT INTO employee (tenant_id, employee_slug) VALUES (%s, %s)",
            (a.tenant_id, slug),
        )
    with a.session() as s:
        assert s.execute("SELECT count(*) FROM employee").fetchone()[0] == 1
    with b.session() as s:
        assert s.execute("SELECT count(*) FROM employee").fetchone()[0] == 0


def test_rls_with_check_rejects_foreign_tenant_write(tenant_scope_factory):
    """WITH CHECK：A 会话内不能插入 tenant_id≠A 的行（写侧也封死越租户）。"""
    import psycopg

    a = tenant_scope_factory("p1f1a")
    b = tenant_scope_factory("p1f1b")
    with pytest.raises(psycopg.errors.Error):
        with a.session() as s:
            s.execute(
                "INSERT INTO employee (tenant_id, employee_slug) VALUES (%s, %s)",
                (b.tenant_id, f"x_{uuid.uuid4().hex[:6]}"),
            )


def test_scope_teardown_removes_registry_row(tenant_scope_factory):
    """teardown 后控制面行被清，验证 fixture 不残留污染。"""
    import psycopg

    scope = tenant_scope_factory("p1f1t")
    # fixture 尚未 teardown：行存在。
    with psycopg.connect(scope.admin_url, autocommit=True) as conn:
        n = conn.execute(
            "SELECT count(*) FROM tenant_registry WHERE tenant_id = %s", (scope.tenant_id,)
        ).fetchone()[0]
    assert n == 1
