"""Manager RAG workspace 租户隔离验收（04 §6.1.2，D21）。

- workspace 只能由 ManagerRagService 从 TenantContext 推导，禁前端/Agent 直传。
- PG workspace/tenant 映射表加 RLS 作第二防线（§6.1.2 第 6 条）：跨租户不可见。
"""

import uuid

import pytest

from shared.contracts.tenancy import TenantContext
from shared.db import ManagerRagService, PgTenantRouter  # 派生规则（纯函数）

from manager_service.rag import PgManagerRagService
from manager_service.rag_instances import RagInstance, RagInstanceRegistry

pytestmark = pytest.mark.integration


def _ctx(tid: str) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id=str(uuid.uuid4()), roles=["member"])


def test_workspace_derived_from_tenant_context(two_tenants, migrated_db):
    tid_a, _ = two_tenants
    rag = PgManagerRagService(migrated_db)
    handle = rag.get(_ctx(tid_a), "enterprise_shared")
    # workspace 与派生规则一致（去连字符 tenant + 空间后缀）。
    assert handle.workspace == ManagerRagService.derive_workspace(tid_a, "enterprise_shared")
    assert tid_a.replace("-", "") in handle.workspace


def test_workspace_mapping_isolated_across_tenants(two_tenants, migrated_db):
    """tenant A 建的 workspace 映射行，tenant B 在 PG 第二防线看不到（RLS）。"""
    tid_a, tid_b = two_tenants
    rag = PgManagerRagService(migrated_db)
    rag.get(_ctx(tid_a), "enterprise_shared")  # 同名空间，不同 tenant

    a_rows = rag.list_workspaces(_ctx(tid_a))
    b_rows = rag.list_workspaces(_ctx(tid_b))
    a_ws = {r["workspace"] for r in a_rows}
    b_ws = {r["workspace"] for r in b_rows}
    assert ManagerRagService.derive_workspace(tid_a, "enterprise_shared") in a_ws
    # tenant B 看不到 tenant A 的 workspace 映射。
    assert ManagerRagService.derive_workspace(tid_a, "enterprise_shared") not in b_ws


def test_instance_mapping_bootstraps_legacy_row_and_replays_without_drift(two_tenants, migrated_db):
    tid_a, _ = two_tenants
    context = _ctx(tid_a)
    knowledge_space_id = f"ks_mapping_{uuid.uuid4().hex[:8]}"
    workspace = ManagerRagService.derive_workspace(tid_a, knowledge_space_id)
    registry = RagInstanceRegistry((RagInstance("rag-a", "http://rag", "secret"),))
    router = PgTenantRouter(migrated_db)
    with router.session(context) as session:
        session.execute(
            "INSERT INTO rag_workspace (tenant_id, knowledge_space_id, workspace) VALUES (%s, %s, %s)",
            (tid_a, knowledge_space_id, workspace),
        )

    first = PgManagerRagService(migrated_db, instance_registry=registry).get(context, knowledge_space_id)
    second = PgManagerRagService(migrated_db, instance_registry=registry).get(context, knowledge_space_id)
    assert first.instance_id == second.instance_id == "rag-a"
    with router.session(context) as session:
        row = session.execute(
            "SELECT tenant_id, knowledge_space_id, workspace, instance_id "
            "FROM rag_workspace WHERE knowledge_space_id = %s",
            (knowledge_space_id,),
        ).fetchone()
    assert row is not None
    assert str(row[0]) == tid_a
    assert tuple(row[1:]) == (knowledge_space_id, workspace, "rag-a")


def test_derive_workspace_is_pure_no_external_input():
    """派生是纯函数，不接受外部直传 workspace（D21）。"""
    ws1 = ManagerRagService.derive_workspace("018f-3f8a", "ks_x")
    ws2 = ManagerRagService.derive_workspace("018f-3f8a", "ks_x")
    assert ws1 == ws2 == "t018f3f8a__ks_x"
