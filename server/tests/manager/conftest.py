"""Manager integration 测试夹具：真实 PG（DATABASE_URL）。

无 DATABASE_URL 时整组 integration 测试 skip——保证默认门 `-m 'not integration'`
不依赖外部 PG，而 integration 跑须显式提供库（04 §6.1.1 RLS 须真库验）。
"""

from __future__ import annotations

import os
import uuid

import pytest

DATABASE_URL = os.getenv("DATABASE_URL")


@pytest.fixture(scope="session")
def database_url() -> str:
    if not DATABASE_URL:
        pytest.skip("DATABASE_URL 未设置；integration 测试需真实 PG（见工单 M0）")
    return DATABASE_URL


@pytest.fixture(scope="session")
def migrated_db(database_url: str) -> str:
    """首次连接自动应用迁移（04 §6.4），返回 db_url。"""
    from shared.db import apply_migrations

    apply_migrations(database_url)
    return database_url


@pytest.fixture()
def two_tenants(migrated_db: str):
    """在控制面建两个隔离租户，返回 (tenant_a, tenant_b) 的 tenant_id。"""
    import psycopg

    slug_a = f"ent_a_{uuid.uuid4().hex[:8]}"
    slug_b = f"ent_b_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(migrated_db, autocommit=True) as conn:
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
