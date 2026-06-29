"""P1-F1 PG/migration/RLS fixture（最终执行 DAG §5.1 P1-F1）。

提供后续三端 Service Integration 共享的真 PG 底座：
- 管理连接（ADMIN_DB_URL，超管/DDL owner）跑迁移/建角色/控制面写入。
- 业务连接（DB_URL，app_rw 身份）经 PgTenantRouter 跑租户 RLS SQL（#60 连接身份层收口）。
- 隔离 tenant scope：在 tenant_registry 注册独立租户，产 TenantScope，按需建 RLS 会话。

无 ADMIN_DB_URL/DB_URL 时整组 integration skip（默认门 `-m 'not integration'` 不依赖 PG）。

铁律：tenant_id 只从 TenantContext 走（D22）；隔离正确性由 PG RLS 物理强制，
本 fixture 不靠应用层 WHERE 兜底——cleanup 在 tenant 会话内删，RLS 决定它**够不到**别的租户。
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

import pytest

from shared.contracts.tenancy import TenantContext


@dataclass(frozen=True)
class TenantScope:
    """一个隔离租户作用域。后续业务 fixture/测试据此建 RLS 会话与签发身份。"""

    tenant_id: str
    enterprise_slug: str
    business_url: str
    admin_url: str

    def context(self, roles: list[str] | None = None, *, user_id: str | None = None) -> TenantContext:
        """构造本租户的 TenantContext（D22：tenant_id 只能来自此处，不接受手写）。"""
        return TenantContext(
            tenant_id=self.tenant_id,
            user_id=user_id or str(uuid.uuid4()),
            roles=list(roles or ["member"]),
        )

    def router(self):
        """本租户业务连接的 PgTenantRouter（app_rw 身份，受 RLS）。"""
        from shared.db import PgTenantRouter

        return PgTenantRouter(self.business_url)

    def session(self, roles: list[str] | None = None):
        """便捷：进入一个本租户 RLS 事务会话（with scope.session() as s: ...）。"""
        return self.router().session(self.context(roles))


def _register_tenant(admin_url: str, business_url: str, prefix: str) -> TenantScope:
    """控制面（管理连接）注册一个隔离租户，返回 TenantScope。"""
    import psycopg

    slug = f"{prefix}_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        tid = str(
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug,),
            ).fetchone()[0]
        )
    return TenantScope(
        tenant_id=tid, enterprise_slug=slug, business_url=business_url, admin_url=admin_url
    )


def _drop_tenant(scope: TenantScope) -> None:
    """teardown：清掉本租户 RLS 行（tenant 会话内删，RLS 物理限定范围）+ 控制面行。"""
    from tests.integration.fixtures.data_lifecycle import cleanup_test_scope

    cleanup_test_scope(scope)
    import psycopg

    with psycopg.connect(scope.admin_url, autocommit=True) as conn:
        conn.execute("DELETE FROM tenant_registry WHERE tenant_id = %s", (scope.tenant_id,))


# ---- pytest fixtures（经同目录 conftest.py 注册）----


@pytest.fixture(scope="session")
def pg_admin_url() -> str:
    """管理连接串（超管/DDL owner）。缺失 skip。"""
    url = os.getenv("ADMIN_DB_URL")
    if not url:
        pytest.skip("ADMIN_DB_URL 未设置；P1-F1 integration 需真实管理连接（#60）")
    return url


@pytest.fixture(scope="session")
def pg_business_url() -> str:
    """业务连接串（app_rw 身份）。缺失 skip。"""
    url = os.getenv("DB_URL")
    if not url:
        pytest.skip("DB_URL 未设置；P1-F1 integration 需真实业务连接（app_rw，#60）")
    return url


@pytest.fixture(scope="session")
def migrated_pg(pg_admin_url: str, pg_business_url: str) -> str:
    """用管理连接应用迁移 + 下发 app_rw LOGIN 口令；返回业务连接串。"""
    from shared.db import apply_migrations

    apply_migrations(pg_admin_url, app_rw_password=os.getenv("APP_RW_PASSWORD"))
    return pg_business_url


@pytest.fixture
def tenant_scope_factory(migrated_pg: str, pg_admin_url: str):
    """工厂：按需创建隔离租户 scope，测试结束统一回收（消除多份近似 fixture）。"""
    created: list[TenantScope] = []

    def _make(prefix: str = "p1f1") -> TenantScope:
        scope = _register_tenant(pg_admin_url, migrated_pg, prefix)
        created.append(scope)
        return scope

    yield _make

    for scope in created:
        _drop_tenant(scope)


@pytest.fixture
def tenant_scope(tenant_scope_factory) -> TenantScope:
    """单个隔离 tenant scope（最常用入口）。"""
    return tenant_scope_factory("p1f1")
