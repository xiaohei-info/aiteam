"""PG RLS 跨租户隔离验收（integration，真 PG；04 §6.1.1，D20/D22，#60）。

证明 RLS 真生效而非摆设，且业务连接已从**连接身份层**收口（#60）：
- 业务连接直接以受约束角色 app_rw 身份建连（current_user/session_user 均为 app_rw、
  is_superuser=off），不再运行时 SET LOCAL ROLE 降权；无路径 RESET ROLE 逃逸回超管。
- app_rw + SET LOCAL app.tenant_id 时，只能看到本 tenant 数据；错 tenant 看不到。
- superuser（管理连接，未 SET ROLE）会绕过 RLS（反证策略确实在拦截受约束角色）。
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


def test_business_connection_identity_is_app_rw_no_superuser_escape(two_tenants, migrated_db):
    """#60 连接身份层硬断言：业务连接本身即 app_rw，无任何路径回到超管。

    - current_user / session_user 均为 app_rw（连接身份即受约束角色，非运行时降权）。
    - is_superuser=off、rolsuper/rolbypassrls 均为 f。
    - RESET ROLE 不能逃逸回超管：连接身份就是 app_rw，RESET 后仍是 app_rw。
    """
    tid_a, _ = two_tenants
    router = PgTenantRouter(migrated_db)
    with router.session(_ctx(tid_a)) as s:
        cu = s.execute("SELECT current_user").fetchone()[0]
        su_user = s.execute("SELECT session_user").fetchone()[0]
        assert cu == "app_rw"
        assert su_user == "app_rw"  # 连接身份即 app_rw（不是降权来的）
        assert s.execute("SELECT current_setting('is_superuser')").fetchone()[0] == "off"

        flags = s.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
        ).fetchone()
        assert flags == (False, False)

        # RESET ROLE 逃逸验证：连接身份即 app_rw，RESET 后仍回不到超管。
        s.execute("RESET ROLE")
        assert s.execute("SELECT current_user").fetchone()[0] == "app_rw"
        assert s.execute("SELECT current_setting('is_superuser')").fetchone()[0] == "off"


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


def test_superuser_bypasses_rls_proving_policy_constrains_app_role(two_tenants, migrated_db, admin_url):
    """反证：用 superuser（管理连接 aiteam，不 SET tenant）能看到跨租户行，
    说明隔离是 RLS+受约束角色强制的，而非数据本就为空（避免'假绿'）。"""
    tid_a, _ = two_tenants
    router = PgTenantRouter(migrated_db)
    slug = f"emp_{uuid.uuid4().hex[:8]}"
    with router.session(_ctx(tid_a)) as s:
        s.execute(
            "INSERT INTO employee (tenant_id, employee_slug) VALUES (%s, %s)",
            (tid_a, slug),
        )

    # 直连管理连接 superuser（绕过 RLS，未设 tenant）：应看得到该行。
    with psycopg.connect(admin_url, autocommit=True) as conn:
        with conn.cursor() as cur:
            is_su = cur.execute("SELECT current_setting('is_superuser')").fetchone()[0]
            assert is_su == "on"
            cur.execute("SELECT count(*) FROM employee WHERE employee_slug = %s", (slug,))
            assert cur.fetchone()[0] == 1
