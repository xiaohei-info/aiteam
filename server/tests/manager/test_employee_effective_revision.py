"""Status-only writes reach known_versions delta and snapshot contracts on real PG."""
import uuid

import pytest

from manager_service.auth_service import build_auth_service
from manager_service.authorized_config_service import AuthorizedConfigService
from manager_service.employee_config_service import build_employee_config_service
from manager_service.member_service import MemberDeptService, GrantService
from manager_service.repository_member import MemberDeptRepository, GrantRepository
from manager_service.schemas import EmployeeConfigIn
from manager_service.snapshot_service import SnapshotService
from shared.contracts.crosstier import AuthorizedConfigPullRequest
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter, apply_migrations

pytestmark = pytest.mark.integration


def test_lifecycle_delta_snapshot_noop_and_idempotent_migration(migrated_db, admin_url, two_tenants):
    import os
    router = PgTenantRouter(migrated_db)
    tenant = two_tenants[0]
    auth = build_auth_service(migrated_db, admin_url)
    member = auth.provision_owner(tenant, phone="lifecycle-"+uuid.uuid4().hex, bootstrap_password="Fixture-Pass-1")
    ctx = TenantContext(tenant_id=tenant, user_id=member, roles=["owner"])
    config = build_employee_config_service(router)
    member_repo = MemberDeptRepository(router)
    members = MemberDeptService(repo=member_repo)
    grants = GrantService(repo=GrantRepository(router), members=member_repo)
    pull = AuthorizedConfigService(config_service=config, grant_service=grants, member_service=members)
    snapshot = SnapshotService(config_service=config, grant_service=grants, member_service=members)
    employee = config.create(ctx, EmployeeConfigIn(display_name="Lifecycle"), employee_slug="lifecycle")
    req = AuthorizedConfigPullRequest(tenant_id=tenant, member_id=member)
    first = pull.pull(ctx, req).experts[0]
    frozen = snapshot.generate(ctx, member_id=member, employee_id=employee.employee_id)
    frozen_before = frozen.model_dump()
    version = first["version"]
    for transition, expected in [("activate", "active"), ("pause", "paused"), ("resume", "active"), ("archive", "archived")]:
        req.known_versions = {employee.employee_id: str(version)}
        employee = config.transition(ctx, employee_id=employee.employee_id, transition=transition, archive_reason="fixture" if transition == "archive" else None)
        result = pull.pull(ctx, req)
        assert len(result.experts) == 1
        delta = result.experts[0]
        assert delta["status"] == expected and delta["version"] == version+1
        version = delta["version"]
        # Agent sync requests snapshots for deltas, including nonactive employees.
        current = snapshot.generate(ctx, member_id=member, employee_id=employee.employee_id, employee_version=str(version))
        assert current.version == str(version)
        req.known_versions = {employee.employee_id: str(version)}
        assert pull.pull(ctx, req).experts == []
        assert frozen.model_dump() == frozen_before
    with router.session(ctx) as session:
        session.execute("UPDATE employee SET status = status WHERE id = %s", (employee.employee_id,))
    assert config.get(ctx, employee_id=employee.employee_id).version == version
    # Replaying all migrations preserves existing rows, status, revision, and the new final trigger.
    apply_migrations(admin_url, os.environ["APP_RW_PASSWORD"])
    assert config.get(ctx, employee_id=employee.employee_id).version == version
    with router.session(ctx) as session:
        assert session.execute("SELECT current_user").fetchone()[0] == "app_rw"
        for table in ("passkey_credential", "oauth_connection"):
            assert session.execute("SELECT has_table_privilege(current_user, %s, 'DELETE')", (table,)).fetchone()[0]
            assert session.execute("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = %s::regclass", (table,)).fetchone() == (True, True)
