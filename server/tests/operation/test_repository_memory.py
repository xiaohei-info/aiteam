"""EnterpriseRepository 内存实现单元测试（#160）。

测试 InMemoryEnterpriseRepository 的接口契约，不需要真实数据库。
"""

import pytest

from operation_service.repository import EnterpriseAccount, InMemoryEnterpriseRepository
from shared.errors import Conflict, NotFound


@pytest.fixture
def repo():
    return InMemoryEnterpriseRepository()


def test_create_and_get(repo):
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


def test_get_not_found(repo):
    with pytest.raises(NotFound, match="enterprise not found"):
        repo.get("does-not-exist")


def test_create_duplicate_id_conflict(repo):
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


def test_create_duplicate_code_conflict(repo):
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


def test_update_bootstrap_hash(repo):
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

    # 验证持久化（内存）。
    retrieved = repo.get("ent-update")
    assert retrieved.owner_bootstrap_hash == "new_hash"


def test_update_bootstrap_hash_not_found(repo):
    with pytest.raises(NotFound, match="enterprise not found"):
        repo.update_bootstrap_hash("does-not-exist", "new_hash")


def test_create_without_code(repo):
    """enterprise_code 是可选字段（None）。"""
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


def test_multiple_null_codes_allowed(repo):
    """多个企业的 enterprise_code 都可以是 None。"""
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
