"""租户底座骨架验收（04 §6.1，D20/D22）：跨 tenant 隔离 + RAG workspace 派生。

注：此处验的是**抽象层隔离语义**；真实 PostgreSQL RLS 强制隔离由 M0 落地并由
integration 验证矩阵的 RLS 用例守（见 server/tests/integration/test_verification_matrix.py）。
"""

from shared.contracts.enums import IsolationLevel
from shared.contracts.tenancy import TenantContext
from shared.db import InMemoryTenantRouter, ManagerRagService, apply_migrations


def _ctx(tid: str) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id="u", roles=["member"])


def test_session_scoped_by_tenant_no_cross_leak():
    router = InMemoryTenantRouter()
    sa = router.session(_ctx("tenant-a"))
    sb = router.session(_ctx("tenant-b"))
    sa.put("employee:1", {"name": "A"})
    assert sa.get("employee:1") == {"name": "A"}
    assert sb.get("employee:1") is None  # tenant B 看不到 tenant A 的数据


def test_default_isolation_is_l1():
    router = InMemoryTenantRouter()
    assert router.isolation_level("any") is IsolationLevel.L1_SHARED_RLS


def test_rag_workspace_derivation():
    ws = ManagerRagService.derive_workspace("018f-3f8a", "ks_default")
    assert ws == "t018f3f8a__ks_default"  # 去连字符 + 知识空间后缀（04 §6.1.2）


def test_apply_migrations_noop_ok():
    assert apply_migrations(None) is None
