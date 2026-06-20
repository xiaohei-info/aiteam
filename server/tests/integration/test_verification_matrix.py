"""验证矩阵骨架（占位）。

这些是 Wave 2 集成验收的关键闸门，但依赖尚未建成的服务/DB/runtime，故先以 skip 占位、
钉死"必须验什么、归哪个 Phase、对哪份文档"。对应模块就绪后，去掉 skip 并填实。

防跑偏意义：把"完成"的客观标准提前写死在仓库里，避免各模块各自宣称完成却没有统一验收靶子。
"""

import os
import uuid

import pytest


@pytest.mark.integration
def test_rls_cross_tenant_isolation():
    """RLS 跨租户串线回归：tenant A 上下文不得读到 tenant B 数据（DB + RAG workspace 双测）。

    M0 已落地（04 §6.1.1/§6.1.3，D20/D22）。无 DATABASE_URL 时 skip（默认门不依赖外部 PG）。
    详细分层用例见 tests/manager/test_rls_isolation.py 与 test_rag_workspace.py。
    """
    db_url = os.getenv("DATABASE_URL")
    admin_url = os.getenv("ADMIN_DATABASE_URL")
    app_rw_password = os.getenv("APP_RW_PASSWORD")
    if not db_url or not admin_url:
        pytest.skip("DATABASE_URL/ADMIN_DATABASE_URL 未设置；RLS 回归需真实 PG（M0/#60）")

    import psycopg

    from shared.contracts.tenancy import TenantContext
    from shared.db import ManagerRagService, PgTenantRouter, apply_migrations
    from manager_service.rag import PgManagerRagService

    # 迁移走管理连接（超管/DDL owner，#60）；业务连接（db_url）以 app_rw 身份跑 RLS SQL。
    apply_migrations(admin_url, app_rw_password=app_rw_password)
    with psycopg.connect(admin_url, autocommit=True) as conn:
        tid_a = str(conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
            (f"vm_a_{uuid.uuid4().hex[:8]}",),
        ).fetchone()[0])
        tid_b = str(conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
            (f"vm_b_{uuid.uuid4().hex[:8]}",),
        ).fetchone()[0])

    def ctx(t):
        return TenantContext(tenant_id=t, user_id=str(uuid.uuid4()), roles=["member"])

    # DB 维度：A 写 employee，B 看不到。
    router = PgTenantRouter(db_url)
    slug = f"vm_{uuid.uuid4().hex[:8]}"
    with router.session(ctx(tid_a)) as s:
        s.execute("INSERT INTO employee (tenant_id, employee_slug) VALUES (%s, %s)", (tid_a, slug))
    with router.session(ctx(tid_b)) as s:
        assert s.execute("SELECT 1 FROM employee WHERE employee_slug = %s", (slug,)).fetchall() == []

    # RAG workspace 维度：A 建映射，B 看不到。
    rag = PgManagerRagService(db_url)
    rag.get(ctx(tid_a), "ks_vm")
    b_ws = {r["workspace"] for r in rag.list_workspaces(ctx(tid_b))}
    assert ManagerRagService.derive_workspace(tid_a, "ks_vm") not in b_ws


@pytest.mark.integration
@pytest.mark.skip(reason="待用户端本地主链就绪（Phase 2）；口径见 10 §17 / 07 §8")
def test_timeline_parity_vs_frozen_baseline():
    """streaming/timeline parity：事件类型/顺序/cursor/payload 关键字段对齐冻结契约基线。"""
    raise AssertionError("placeholder")


@pytest.mark.integration
@pytest.mark.skip(reason="待跨端链路就绪（Phase 2/4）；口径见 04 §6.5 / CLAUDE-AGENTS §3.3，D13")
def test_privacy_no_session_content_leaves_device():
    """隐私 e2e：跨端流量只含认证/授权/脱敏摘要，绝无会话内容/raw event/工具明细外泄。"""
    raise AssertionError("placeholder")


@pytest.mark.integration
@pytest.mark.skip(reason="待分端构建产物就绪（Phase 1+）；口径见 09 §14.2，D15")
def test_user_client_build_excludes_control_plane():
    """分端产物隔离：用户端交付物不含 operation/manager 后端与前端代码。"""
    raise AssertionError("placeholder")


@pytest.mark.integration
@pytest.mark.skip(reason="待入户链就绪（Phase 1）；口径见 09 §14.3 / 05 F01-F02-F09")
def test_onboarding_chain_operator_to_manager_to_agent():
    """入户链 e2e：Operator 开通企业→Manager 建 tenant→负责人登录→Agent 绑定 tenant。"""
    raise AssertionError("placeholder")
