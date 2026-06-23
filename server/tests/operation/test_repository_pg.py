"""EnterpriseRepository PostgreSQL 实现集成测试（#160）。

标记 `@pytest.mark.integration`（需真实 PostgreSQL）；`-m 'not integration'` 跳过。
"""

import os

import pytest

from operation_service.repository import (
    EnterpriseAccount,
    PgEnterpriseRepository,
    apply_migrations,
)
from shared.errors import Conflict, NotFound

# 测试需要真实 PostgreSQL，从环境变量读取连接配置。
# CI/本地运行前需配置：OPER_TEST_ADMIN_DB_URL（管理连接）、OPER_TEST_DB_URL（业务连接）。
ADMIN_DB_URL = os.getenv("OPER_TEST_ADMIN_DB_URL")
APP_DB_URL = os.getenv("OPER_TEST_DB_URL")
APP_RW_PASSWORD = os.getenv("OPER_TEST_APP_RW_PASSWORD", "test_password")

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def pg_repo():
    """模块级 PostgreSQL 仓储 fixture：应用迁移，返回仓储实例。"""
    if not ADMIN_DB_URL or not APP_DB_URL:
        pytest.skip(
            "PostgreSQL integration test requires OPER_TEST_ADMIN_DB_URL and OPER_TEST_DB_URL"
        )

    # 应用迁移（管理连接）。
    apply_migrations(ADMIN_DB_URL, APP_RW_PASSWORD)

    # 返回业务仓储（app_rw 连接）。
    return PgEnterpriseRepository(APP_DB_URL)


@pytest.fixture
def clean_db(pg_repo):
    """每测试前清空企业账号表（测试隔离）。"""
    import psycopg

    with psycopg.connect(APP_DB_URL, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM enterprise_account")
    yield pg_repo


def test_create_and_get(clean_db):
    repo = clean_db
    account = EnterpriseAccount(
        enterprise_id="ent-123",
        tenant_id="ten-456",
        enterprise_name="Test Corp",
        enterprise_code="testcorp",
        owner_phone="13800000000",
        owner_bootstrap_hash="hash123",
    )

    created = repo.create(account)
    assert created == account

    retrieved = repo.get("ent-123")
    assert retrieved.enterprise_id == "ent-123"
    assert retrieved.tenant_id == "ten-456"
    assert retrieved.enterprise_name == "Test Corp"
    assert retrieved.enterprise_code == "testcorp"
    assert retrieved.owner_phone == "13800000000"
    assert retrieved.owner_bootstrap_hash == "hash123"


def test_get_not_found(clean_db):
    repo = clean_db
    with pytest.raises(NotFound, match="enterprise not found"):
        repo.get("does-not-exist")


def test_create_duplicate_id_conflict(clean_db):
    repo = clean_db
    account = EnterpriseAccount(
        enterprise_id="ent-dup",
        tenant_id="ten-1",
        enterprise_name="First",
        enterprise_code=None,
        owner_phone="13800000001",
        owner_bootstrap_hash="hash1",
    )
    repo.create(account)

    duplicate = EnterpriseAccount(
        enterprise_id="ent-dup",  # 冲突
        tenant_id="ten-2",
        enterprise_name="Second",
        enterprise_code=None,
        owner_phone="13800000002",
        owner_bootstrap_hash="hash2",
    )
    with pytest.raises(Conflict, match="enterprise already exists"):
        repo.create(duplicate)


def test_create_duplicate_code_conflict(clean_db):
    repo = clean_db
    account1 = EnterpriseAccount(
        enterprise_id="ent-1",
        tenant_id="ten-1",
        enterprise_name="First",
        enterprise_code="samecode",
        owner_phone="13800000001",
        owner_bootstrap_hash="hash1",
    )
    repo.create(account1)

    account2 = EnterpriseAccount(
        enterprise_id="ent-2",
        tenant_id="ten-2",
        enterprise_name="Second",
        enterprise_code="samecode",  # 冲突
        owner_phone="13800000002",
        owner_bootstrap_hash="hash2",
    )
    with pytest.raises(Conflict, match="enterprise_code already taken"):
        repo.create(account2)


def test_update_bootstrap_hash(clean_db):
    repo = clean_db
    account = EnterpriseAccount(
        enterprise_id="ent-update",
        tenant_id="ten-update",
        enterprise_name="Update Test",
        enterprise_code=None,
        owner_phone="13800000003",
        owner_bootstrap_hash="old_hash",
    )
    repo.create(account)

    updated = repo.update_bootstrap_hash("ent-update", "new_hash")
    assert updated.owner_bootstrap_hash == "new_hash"
    assert updated.enterprise_id == "ent-update"
    assert updated.enterprise_name == "Update Test"

    # 验证持久化。
    retrieved = repo.get("ent-update")
    assert retrieved.owner_bootstrap_hash == "new_hash"


def test_update_bootstrap_hash_not_found(clean_db):
    repo = clean_db
    with pytest.raises(NotFound, match="enterprise not found"):
        repo.update_bootstrap_hash("does-not-exist", "new_hash")


def test_create_without_code(clean_db):
    """enterprise_code 是可选字段（NULL）。"""
    repo = clean_db
    account = EnterpriseAccount(
        enterprise_id="ent-nocode",
        tenant_id="ten-nocode",
        enterprise_name="No Code Corp",
        enterprise_code=None,
        owner_phone="13800000004",
        owner_bootstrap_hash="hash4",
    )
    created = repo.create(account)
    assert created.enterprise_code is None

    retrieved = repo.get("ent-nocode")
    assert retrieved.enterprise_code is None


def test_multiple_null_codes_allowed(clean_db):
    """多个企业的 enterprise_code 都可以是 NULL（UNIQUE NULLS NOT DISTINCT 约束）。"""
    repo = clean_db
    account1 = EnterpriseAccount(
        enterprise_id="ent-null-1",
        tenant_id="ten-null-1",
        enterprise_name="Null Code 1",
        enterprise_code=None,
        owner_phone="13800000005",
        owner_bootstrap_hash="hash5",
    )
    account2 = EnterpriseAccount(
        enterprise_id="ent-null-2",
        tenant_id="ten-null-2",
        enterprise_name="Null Code 2",
        enterprise_code=None,
        owner_phone="13800000006",
        owner_bootstrap_hash="hash6",
    )
    repo.create(account1)
    repo.create(account2)  # 不应冲突

    # 验证两个都创建成功。
    assert repo.get("ent-null-1").enterprise_code is None
    assert repo.get("ent-null-2").enterprise_code is None
