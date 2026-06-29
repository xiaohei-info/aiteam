"""P1-F3 契约：seed/cleanup fixture（integration，真 PG）。

锁住 closeout DAG P1-F3 acceptance：seed/cleanup 可重复运行且不污染其它 tenant。
无 DB_URL/ADMIN_DB_URL 时整组 skip。
"""

from __future__ import annotations

import pytest

from tests.integration.fixtures.data_lifecycle import (
    TENANT_TABLES,
    cleanup_test_scope,
    seed_full_enterprise,
)

pytestmark = pytest.mark.integration


def _row_counts(scope) -> dict[str, int]:
    with scope.session(["owner"]) as s:
        return {t: s.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in TENANT_TABLES}


def test_seed_populates_then_cleanup_clears(tenant_scope):
    seeded = seed_full_enterprise(tenant_scope)
    counts = _row_counts(tenant_scope)
    assert counts["app_user"] == 2  # owner + member
    assert counts["auth_identity"] == 2
    assert counts["department"] == 1
    assert counts["member_grant"] == 1
    assert counts["knowledge_space_binding"] == 1
    assert counts["rag_workspace"] == 1
    assert seeded.owner_user_id and seeded.knowledge_space_id

    removed = cleanup_test_scope(tenant_scope)
    assert removed == 8  # 2+2+1+1+1+1
    assert all(v == 0 for v in _row_counts(tenant_scope).values())


def test_seed_is_repeatable(tenant_scope):
    """重复 seed 不撞唯一约束；累积可被一次 cleanup 全清。"""
    seed_full_enterprise(tenant_scope)
    seed_full_enterprise(tenant_scope)
    counts = _row_counts(tenant_scope)
    assert counts["app_user"] == 4
    assert counts["member_grant"] == 2
    cleanup_test_scope(tenant_scope)
    assert all(v == 0 for v in _row_counts(tenant_scope).values())


def test_cleanup_is_idempotent(tenant_scope):
    seed_full_enterprise(tenant_scope)
    assert cleanup_test_scope(tenant_scope) > 0
    assert cleanup_test_scope(tenant_scope) == 0  # 第二次无残留


def test_cleanup_does_not_pollute_other_tenant(tenant_scope_factory):
    """清 A 不影响 B——RLS 物理限定 cleanup 够不到别的租户。"""
    a = tenant_scope_factory("p1f3a")
    b = tenant_scope_factory("p1f3b")
    seed_full_enterprise(a)
    seed_full_enterprise(b)

    cleanup_test_scope(a)
    assert all(v == 0 for v in _row_counts(a).values())
    # B 完好无损。
    b_counts = _row_counts(b)
    assert b_counts["app_user"] == 2
    assert b_counts["member_grant"] == 1
    cleanup_test_scope(b)


def test_seeded_enterprise_fixture(seeded_enterprise, tenant_scope):
    assert seeded_enterprise.tenant_id == tenant_scope.tenant_id
    counts = _row_counts(tenant_scope)
    assert counts["app_user"] == 2
