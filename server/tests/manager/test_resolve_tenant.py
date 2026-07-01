"""企业标识 → tenant_id 解析测试（修登录体验：隐藏 UUID,用企业代码/名称）。"""

import uuid

import pytest

from shared.errors import NotFound

from manager_service.auth_service import AuthService
from manager_service.keys import TenantKeyStore


@pytest.fixture
def svc(migrated_db: str, admin_url: str):
    """构造 AuthService（依赖签名私钥表 + tenant_registry）。"""
    from manager_service.repository import TenantAuthRepository

    keys = TenantKeyStore(admin_url)
    repo = TenantAuthRepository()
    return AuthService(dsn=migrated_db, repo=repo, keys=keys)


@pytest.fixture
def tenant_with_code(admin_url: str):
    """建一个带 enterprise_code 的测试租户,返回 (tenant_id, code)。"""
    import psycopg

    tid = str(uuid.uuid4())
    code = f"test-ent-{uuid.uuid4().hex[:6]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (tenant_id, enterprise_slug, enterprise_code) "
            "VALUES (%s, %s, %s)",
            (tid, code, code),
        )
    return tid, code


def test_resolve_by_enterprise_code(svc, tenant_with_code):
    """企业代码精确匹配 → 返回对应 tenant_id。"""
    tid, code = tenant_with_code
    resolved = svc.resolve_tenant(code)
    assert resolved == tid


def test_resolve_by_enterprise_slug_when_no_code(svc, admin_url: str):
    """无 enterprise_code 时,按 enterprise_slug 匹配。"""
    import psycopg

    tid = str(uuid.uuid4())
    slug = f"slug-only-{uuid.uuid4().hex[:6]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (tenant_id, enterprise_slug, enterprise_code) "
            "VALUES (%s, %s, NULL)",
            (tid, slug),
        )
    resolved = svc.resolve_tenant(slug)
    assert resolved == tid


def test_resolve_not_found(svc):
    """不存在的企业标识 → 404。"""
    with pytest.raises(NotFound, match="enterprise not found"):
        svc.resolve_tenant("nonexistent-ent-99999")


def test_resolve_prefers_code_over_slug(svc, admin_url: str):
    """同时匹配 code 和 slug 时,优先返回 code 匹配者（SQL WHERE code= OR slug=, LIMIT 1）。"""
    import psycopg

    tid_code = str(uuid.uuid4())
    tid_slug = str(uuid.uuid4())
    common = f"common-{uuid.uuid4().hex[:6]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (tenant_id, enterprise_slug, enterprise_code) "
            "VALUES (%s, %s, %s), (%s, %s, NULL)",
            (tid_code, "other", common, tid_slug, common),
        )
    # 'common' 是 tid_code 的 code 和 tid_slug 的 slug,应返回 tid_code
    resolved = svc.resolve_tenant(common)
    assert resolved == tid_code
