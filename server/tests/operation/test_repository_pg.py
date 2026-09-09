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
# CI/local runs use the independent Operation database. OPER_TEST_* aliases
# remain accepted for isolated operation runs; never fall back to Manager DB URLs.
ADMIN_DB_URL = os.getenv("OPERATION_ADMIN_DB_URL") or os.getenv("OPER_TEST_ADMIN_DB_URL")
APP_DB_URL = os.getenv("OPERATION_DB_URL") or os.getenv("OPER_TEST_DB_URL")
APP_RW_PASSWORD = os.getenv("OPER_TEST_APP_RW_PASSWORD") or os.getenv("APP_RW_PASSWORD", "test_password")

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def pg_repo():
    """模块级 PostgreSQL 仓储 fixture：应用迁移，返回仓储实例。"""
    if not ADMIN_DB_URL or not APP_DB_URL:
        pytest.skip(
            "PostgreSQL integration test requires OPERATION_ADMIN_DB_URL/OPERATION_DB_URL (or OPER_TEST_* aliases)"
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
            for table in ("operation_recharge_record", "operation_enterprise_quota", "operation_audit_event", "enterprise_account"):
                cur.execute(f"DELETE FROM {table}")
    yield pg_repo


def test_create_and_get(clean_db):
    repo = clean_db
    account = EnterpriseAccount(
        enterprise_id="10000000-0000-4000-8000-000000000123",
        tenant_id="20000000-0000-4000-8000-000000000456",
        enterprise_name="Test Corp",
        enterprise_code="testcorp",
        owner_phone="13800000000",
        owner_bootstrap_hash="hash123",
    )

    created = repo.create(account)
    assert created == account

    retrieved = repo.get("10000000-0000-4000-8000-000000000123")
    assert retrieved.enterprise_id == "10000000-0000-4000-8000-000000000123"
    assert retrieved.tenant_id == "20000000-0000-4000-8000-000000000456"
    assert retrieved.enterprise_name == "Test Corp"
    assert retrieved.enterprise_code == "testcorp"
    assert retrieved.owner_phone == "13800000000"
    assert retrieved.owner_bootstrap_hash == "hash123"


def test_get_not_found(clean_db):
    repo = clean_db
    with pytest.raises(NotFound, match="enterprise not found"):
        repo.get("10000000-0000-4000-8000-000000009999")


def test_create_duplicate_id_conflict(clean_db):
    repo = clean_db
    account = EnterpriseAccount(
        enterprise_id="10000000-0000-4000-8000-000000000124",
        tenant_id="20000000-0000-4000-8000-000000000001",
        enterprise_name="First",
        enterprise_code=None,
        owner_phone="13800000001",
        owner_bootstrap_hash="hash1",
    )
    repo.create(account)

    duplicate = EnterpriseAccount(
        enterprise_id="10000000-0000-4000-8000-000000000124",  # 冲突
        tenant_id="20000000-0000-4000-8000-000000000002",
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
        enterprise_id="10000000-0000-4000-8000-000000000125",
        tenant_id="20000000-0000-4000-8000-000000000003",
        enterprise_name="First",
        enterprise_code="samecode",
        owner_phone="13800000001",
        owner_bootstrap_hash="hash1",
    )
    repo.create(account1)

    account2 = EnterpriseAccount(
        enterprise_id="10000000-0000-4000-8000-000000000126",
        tenant_id="20000000-0000-4000-8000-000000000004",
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
        enterprise_id="10000000-0000-4000-8000-000000000127",
        tenant_id="20000000-0000-4000-8000-000000000005",
        enterprise_name="Update Test",
        enterprise_code=None,
        owner_phone="13800000003",
        owner_bootstrap_hash="old_hash",
    )
    repo.create(account)

    updated = repo.update_bootstrap_hash("10000000-0000-4000-8000-000000000127", "new_hash")
    assert updated.owner_bootstrap_hash == "new_hash"
    assert updated.enterprise_id == "10000000-0000-4000-8000-000000000127"
    assert updated.enterprise_name == "Update Test"

    # 验证持久化。
    retrieved = repo.get("10000000-0000-4000-8000-000000000127")
    assert retrieved.owner_bootstrap_hash == "new_hash"


def test_update_bootstrap_hash_not_found(clean_db):
    repo = clean_db
    with pytest.raises(NotFound, match="enterprise not found"):
        repo.update_bootstrap_hash("10000000-0000-4000-8000-000000009998", "new_hash")


def test_create_without_code(clean_db):
    """enterprise_code 是可选字段（NULL）。"""
    repo = clean_db
    account = EnterpriseAccount(
        enterprise_id="10000000-0000-4000-8000-000000000128",
        tenant_id="20000000-0000-4000-8000-000000000006",
        enterprise_name="No Code Corp",
        enterprise_code=None,
        owner_phone="13800000004",
        owner_bootstrap_hash="hash4",
    )
    created = repo.create(account)
    assert created.enterprise_code is None

    retrieved = repo.get("10000000-0000-4000-8000-000000000128")
    assert retrieved.enterprise_code is None


def test_multiple_null_codes_allowed(clean_db):
    """多个企业的 enterprise_code 都可以是 NULL（UNIQUE NULLS NOT DISTINCT 约束）。"""
    repo = clean_db
    account1 = EnterpriseAccount(
        enterprise_id="10000000-0000-4000-8000-000000000129",
        tenant_id="20000000-0000-4000-8000-000000000007",
        enterprise_name="Null Code 1",
        enterprise_code=None,
        owner_phone="13800000005",
        owner_bootstrap_hash="hash5",
    )
    account2 = EnterpriseAccount(
        enterprise_id="10000000-0000-4000-8000-000000000130",
        tenant_id="20000000-0000-4000-8000-000000000008",
        enterprise_name="Null Code 2",
        enterprise_code=None,
        owner_phone="13800000006",
        owner_bootstrap_hash="hash6",
    )
    repo.create(account1)
    repo.create(account2)  # 不应冲突

    # 验证两个都创建成功。
    assert repo.get("10000000-0000-4000-8000-000000000129").enterprise_code is None
    assert repo.get("10000000-0000-4000-8000-000000000130").enterprise_code is None
