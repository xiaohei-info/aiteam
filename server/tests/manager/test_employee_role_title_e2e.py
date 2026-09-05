"""0034 role_title: real PG migration, RLS, versions and authorized projection.

Collected by the unchanged ci.yml integration job (postgres:16 + app_rw).
"""
from __future__ import annotations

from pathlib import Path

import pytest
import psycopg

from manager_service.authorized_config_service import AuthorizedConfigService
from manager_service.employee_config_repository import EmployeeConfigRepository
from manager_service.employee_config_service import EmployeeConfigService
from manager_service.org_service import OrgService
from shared.contracts.crosstier import AuthorizedConfigPullRequest
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import NotFound

from .test_employee_config_e2e import _client, _token

pytestmark = pytest.mark.integration


def test_role_title_pg_versions_rls_org_and_authorized_delta(migrated_db, admin_url, two_tenants):
    tenant_a, tenant_b = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner = {"Authorization": f"Bearer {_token(tenant_a, ['owner'], user_id='owner-a', admin_url=admin_url)}"}
    other = {"Authorization": f"Bearer {_token(tenant_b, ['owner'], user_id='owner-b', admin_url=admin_url)}"}
    router = PgTenantRouter(migrated_db)
    ctx = TenantContext(tenant_id=tenant_a, user_id="owner-a", roles=["owner"])
    other_ctx = TenantContext(tenant_id=tenant_b, user_id="owner-b", roles=["owner"])
    repo = EmployeeConfigRepository(router)
    service = EmployeeConfigService(repo)
    authorized = AuthorizedConfigService(config_service=service, grant_service=None, member_service=None)
    body = {"display_name": "研究员"}
    created = client.post("/api/manager/employees?employee_slug=role-title", headers=owner, json=body)
    assert created.status_code == 201, created.text
    employee = created.json()["data"]
    eid = employee["employee_id"]
    assert employee["role_title"] is None  # no invented default on legacy-shaped inserts
    assert employee["version"] == 1
    with router.session(ctx) as session:
        assert session.execute("SELECT current_user").fetchone()[0] == "app_rw"
        depts = [str(session.execute(
            "INSERT INTO department (tenant_id, department_slug, display_name) VALUES (%s, %s, %s) RETURNING id",
            (tenant_a, slug, slug),
        ).fetchone()[0]) for slug in ["research", "sales"]]
    for role_title, expected in [("研究分析师", 2), ("研究分析师", 2), (None, 3)]:
        response = client.put(f"/api/manager/employees/{eid}", headers=owner, json={**body, "role_title": role_title})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["version"] == expected
        assert repo.get(ctx, employee_id=eid).role_title == role_title
    body.update(role_title="多部门分析师", department_ids=depts)
    response = client.put(f"/api/manager/employees/{eid}", headers=owner, json=body)
    assert response.json()["data"]["version"] == 4
    req = AuthorizedConfigPullRequest(tenant_id=tenant_a, member_id="owner-a", known_versions={eid: "3"})
    projected = authorized.pull(ctx, req).experts[0]
    assert (projected["role_title"], projected["department_ids"], projected["version"]) == ("多部门分析师", depts, 4)
    req.known_versions = {eid: "4"}
    assert authorized.pull(ctx, req).experts == []
    tree = OrgService(router).build_tree(ctx)
    appearances = [emp for dept in tree["children"] for emp in dept["children"] if emp["id"] == eid]
    assert len(appearances) == 2
    assert all(emp["role_title"] == "多部门分析师" for emp in appearances)
    assert OrgService(router).build_tree(other_ctx)["children"] == []
    assert client.get(f"/api/manager/employees/{eid}", headers=other).status_code == 404
    assert client.put(f"/api/manager/employees/{eid}", headers=other, json=body).status_code == 404
    assert client.get("/api/manager/employees", headers=other).json()["data"] == []
    with pytest.raises(NotFound):
        service.get(other_ctx, employee_id=eid)
    for role in ["member", "finance_admin"]:
        headers = {"Authorization": f"Bearer {_token(tenant_a, [role], admin_url=admin_url)}"}
        assert client.put(f"/api/manager/employees/{eid}", headers=headers, json=body).status_code == 403
    for title in ["", "岗" * 101]:
        assert client.put(f"/api/manager/employees/{eid}", headers=owner, json={**body, "role_title": title}).status_code == 422
        with pytest.raises((psycopg.errors.CheckViolation, psycopg.errors.StringDataRightTruncation)):
            with router.session(ctx) as session:
                session.execute("UPDATE employee SET role_title = %s WHERE id = %s", (title, eid))
    assert service.get(ctx, employee_id=eid).version == 4
    # Omitting the field in the existing full-replacement PUT clears it and all departments.
    response = client.put(f"/api/manager/employees/{eid}", headers=owner, json={"display_name": "研究员"})
    assert response.status_code == 200, response.text
    assert (response.json()["data"]["role_title"], response.json()["data"]["department_ids"], response.json()["data"]["version"]) == (None, [], 5)
    # Lifecycle-only changes do not bump the config version.
    with router.session(ctx) as session:
        session.execute("UPDATE employee SET status = 'provisioning' WHERE id = %s", (eid,))
    assert service.get(ctx, employee_id=eid).version == 5
    # apply_migrations replays SQL files rather than keeping a migration ledger.
    migration = Path(__file__).parents[2] / "manager_service/migrations/0034_employee_role_title.sql"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(migration.read_text())
        conn.execute(migration.read_text())
    assert service.get(ctx, employee_id=eid).version == 5
    assert service.get(ctx, employee_id=eid).role_title is None
