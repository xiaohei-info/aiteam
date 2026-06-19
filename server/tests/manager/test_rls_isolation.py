"""PG RLS 跨租户隔离验收（integration，真 PG；04 §6.1.1，D20/D22）。

证明 RLS 真生效而非摆设：
- 受约束角色 app_rw + SET LOCAL app.tenant_id 时，只能看到本 tenant 数据；错 tenant 看不到。
- superuser（未 SET ROLE）会绕过 RLS（反证策略确实在拦截受约束角色）。
- 业务只经 TenantContext 读 tenant_id（D22）；session 不接受手写 tenant 过滤。
"""

import uuid

import psycopg
import pytest

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

pytestmark = pytest.mark.integration


def _ctx(tid: str) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id=str(uuid.uuid4()), roles=["member"])


def test_set_local_tenant_id_takes_effect(two_tenants, migrated_db):
    """SET LOCAL app.tenant_id 生效证据：session 内 current_setting 等于上下文 tenant。"""
    tid_a, _ = two_tenants
    router = PgTenantRouter(migrated_db)
    with router.session(_ctx(tid_a)) as s:
        got = s.execute("SELECT current_setting('app.tenant_id', true)").fetchone()[0]
        assert got == tid_a
        # 受约束角色：非 superuser、非 bypassrls。
        role = s.execute("SELECT current_user").fetchone()[0]
        assert role == "app_rw"
        su = s.execute("SELECT current_setting('is_superuser')").fetchone()[0]
        assert su == "off"


def test_cross_tenant_rows_not_visible_under_rls(two_tenants, migrated_db):
    """tenant A 写入的行，用 tenant B 上下文（app_rw）看不到。"""
    tid_a, tid_b = two_tenants
    router = PgTenantRouter(migrated_db)
    slug = f"emp_{uuid.uuid4().hex[:8]}"

    with router.session(_ctx(tid_a)) as s:
        s.execute(
            "INSERT INTO employee (tenant_id, employee_slug, display_name) VALUES (%s, %s, %s)",
            (tid_a, slug, "A-only"),
        )

    # tenant A 能看到自己的行
    with router.session(_ctx(tid_a)) as s:
        rows = s.execute("SELECT employee_slug FROM employee WHERE employee_slug = %s", (slug,)).fetchall()
        assert len(rows) == 1

    # tenant B 完全看不到 tenant A 的行（RLS 强制）
    with router.session(_ctx(tid_b)) as s:
        rows = s.execute("SELECT employee_slug FROM employee WHERE employee_slug = %s", (slug,)).fetchall()
        assert rows == []


def test_wrong_tenant_write_check_rejected(two_tenants, migrated_db):
    """WITH CHECK：tenant B 上下文不能写入 tenant A 的 tenant_id（防伪造写）。"""
    tid_a, tid_b = two_tenants
    router = PgTenantRouter(migrated_db)
    with pytest.raises(psycopg.errors.Error):
        with router.session(_ctx(tid_b)) as s:
            s.execute(
                "INSERT INTO employee (tenant_id, employee_slug) VALUES (%s, %s)",
                (tid_a, f"forge_{uuid.uuid4().hex[:8]}"),
            )


def test_superuser_bypasses_rls_proving_policy_constrains_app_role(two_tenants, migrated_db):
    """反证：用 superuser（aiteam，不 SET ROLE）不设 tenant 时能看到跨租户行，
    说明隔离是 RLS+受约束角色强制的，而非数据本就为空（避免'假绿'）。"""
    tid_a, _ = two_tenants
    router = PgTenantRouter(migrated_db)
    slug = f"emp_{uuid.uuid4().hex[:8]}"
    with router.session(_ctx(tid_a)) as s:
        s.execute(
            "INSERT INTO employee (tenant_id, employee_slug) VALUES (%s, %s)",
            (tid_a, slug),
        )

    # 直连 superuser（绕过 router 的 SET ROLE / SET LOCAL）：应看得到该行。
    with psycopg.connect(migrated_db, autocommit=True) as conn:
        with conn.cursor() as cur:
            is_su = cur.execute("SELECT current_setting('is_superuser')").fetchone()[0]
            assert is_su == "on"
            cur.execute("SELECT count(*) FROM employee WHERE employee_slug = %s", (slug,))
            assert cur.fetchone()[0] == 1
