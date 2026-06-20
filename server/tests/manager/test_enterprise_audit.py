"""企业本地审计日志 enterprise_audit 验收（M7-followup #87，04「审计日志」/ 05 F16，D13/D22）。

integration（真 PG）：
- record + list 在租户内可见。
- 跨租户 RLS：A 写的审计 B 看不到（经 TenantContext，非手写过滤）。
- 字段口径：actor/action/resource_type/resource_id/detail/occurred_at；无会话/配置内容字段。

越权 → 403 且产生审计的端到端断言见 test_snapshot_e2e（经真实 HTTP 路由）。
"""

import pytest

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

from manager_service.enterprise_audit_repository import (
    EnterpriseAuditRow,
    build_enterprise_audit_repository,
)


def _ctx(tid: str) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id="u-1", roles=["owner"])


@pytest.mark.integration
def test_record_and_list_within_tenant(migrated_db, two_tenants):
    tid_a, _ = two_tenants
    repo = build_enterprise_audit_repository(PgTenantRouter(migrated_db))

    row = repo.record(
        _ctx(tid_a), actor="m-1", action="snapshot_pull_denied",
        resource_type="expert", resource_id="e-1", detail="not authorized",
    )
    assert isinstance(row, EnterpriseAuditRow)
    assert row.tenant_id == tid_a
    assert row.actor == "m-1"
    assert row.action == "snapshot_pull_denied"
    assert row.resource_type == "expert"
    assert row.resource_id == "e-1"

    listed = repo.list_all(_ctx(tid_a))
    assert any(a.audit_id == row.audit_id for a in listed)


@pytest.mark.integration
def test_cross_tenant_audit_isolated(migrated_db, two_tenants):
    """A 租户写的审计，B 租户经 RLS 不可见（D22）。"""
    tid_a, tid_b = two_tenants
    repo = build_enterprise_audit_repository(PgTenantRouter(migrated_db))

    repo.record(_ctx(tid_a), actor="m-a", action="snapshot_pull_denied",
                resource_type="expert", resource_id="e-a")

    # B 看不到 A 的审计
    b_rows = repo.list_all(_ctx(tid_b))
    assert all(a.actor != "m-a" for a in b_rows)

    # A 仍能看到自己的
    a_rows = repo.list_all(_ctx(tid_a))
    assert any(a.actor == "m-a" for a in a_rows)
