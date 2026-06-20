"""Manager integration 测试夹具：真实 PG，业务连接与管理连接分离（#60）。

两类连接（04 §6.1.1 第 5 条；#60 从连接身份层根除超管旁路）：
- 管理连接 `ADMIN_DATABASE_URL`（超管/DDL owner）：跑迁移/建角色/DDL、控制面表（tenant_registry、
  签名私钥）直读直写、以及"超管绕过 RLS"的反证。
- 业务连接 `DATABASE_URL`（app_rw 身份）：跑租户 RLS 业务 SQL。

无 ADMIN_DATABASE_URL/DATABASE_URL 时整组 integration 测试 skip——保证默认门
`-m 'not integration'` 不依赖外部 PG，而 integration 跑须显式提供两类库（04 §6.1.1 RLS 须真库验）。
"""

from __future__ import annotations

import os
import uuid

import pytest

ADMIN_DATABASE_URL = os.getenv("ADMIN_DATABASE_URL")
DATABASE_URL = os.getenv("DATABASE_URL")
APP_RW_PASSWORD = os.getenv("APP_RW_PASSWORD")


@pytest.fixture(scope="session")
def admin_url() -> str:
    """管理连接串（超管/DDL owner）。"""
    if not ADMIN_DATABASE_URL:
        pytest.skip("ADMIN_DATABASE_URL 未设置；integration 测试需真实管理连接（#60）")
    return ADMIN_DATABASE_URL


@pytest.fixture(scope="session")
def database_url() -> str:
    """业务连接串（app_rw 身份）。"""
    if not DATABASE_URL:
        pytest.skip("DATABASE_URL 未设置；integration 测试需真实业务连接（app_rw 身份，#60）")
    return DATABASE_URL


@pytest.fixture(scope="session")
def migrated_db(admin_url: str, database_url: str) -> str:
    """用管理连接自动应用迁移（04 §6.4）+ 下发 app_rw LOGIN 口令；返回业务连接串。

    返回业务 DSN（app_rw）——下游 PgTenantRouter/RAG 据此以受约束角色直接建连。
    """
    from shared.db import apply_migrations

    apply_migrations(admin_url, app_rw_password=APP_RW_PASSWORD)
    return database_url


@pytest.fixture()
def two_tenants(migrated_db: str, admin_url: str):
    """在控制面建两个隔离租户，返回 (tenant_a, tenant_b) 的 tenant_id。

    tenant_registry 为控制面表（无 RLS、app_rw 只读），写入须走管理连接。
    """
    import psycopg

    slug_a = f"ent_a_{uuid.uuid4().hex[:8]}"
    slug_b = f"ent_b_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug_a,),
            )
            tid_a = str(cur.fetchone()[0])
            cur.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug_b,),
            )
            tid_b = str(cur.fetchone()[0])
    return tid_a, tid_b
