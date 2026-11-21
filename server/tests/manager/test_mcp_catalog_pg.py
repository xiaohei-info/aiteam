"""Real PG/RLS for enterprise-built MCP entries (design 2026-11-20 §4.4); no network, no real servers."""

import psycopg
import pytest

from manager_service.mcp_catalog import ENTERPRISE_PREFIX, McpCatalogRepository
from shared.contracts.platform_mcp import PlatformMcpServerFields, PlatformMcpServerPull
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter, apply_migrations
from shared.errors import Conflict

pytestmark = pytest.mark.integration


def _fields(**extra) -> PlatformMcpServerFields:
    base = {"ref": "erp-orders", "display_name": "ERP 订单", "url": "https://erp.example.com/mcp", "tools": ["find_order"]}
    return PlatformMcpServerFields.model_validate({**base, **extra})


def _platform(ref: str) -> PlatformMcpServerPull:
    return PlatformMcpServerPull(server_id="7f1d1c5e-0000-4000-8000-000000000001", ref=ref, display_name="平台", url="https://p.example.com/mcp",
                                 tools=["a"], revision=3, status="published")


def test_enterprise_entries_share_the_catalog_with_platform_entries(migrated_db, admin_url, two_tenants):
    apply_migrations(admin_url)  # 0056 must be re-runnable
    repo = McpCatalogRepository(PgTenantRouter(migrated_db))
    ctx = TenantContext(tenant_id=two_tenants[0], user_id="owner-1", roles=["owner"])
    other = TenantContext(tenant_id=two_tenants[1], user_id="owner-2", roles=["owner"])

    platform = repo.upsert(ctx, _platform("mes-lookup"), enabled_by="owner-1")
    assert (platform.origin, platform.source_revision) == ("platform", 3)

    server_id = ENTERPRISE_PREFIX + "00000000-0000-4000-8000-0000000000e1"
    oauth = {"auth": "oauth", "tools": [], "oauth_client_id": "app-1"}
    created = repo.create_custom(ctx, _fields(**oauth), server_id=server_id, created_by="owner-1", secret_enc=b"enc-1")
    assert (created.origin, created.source_revision, created.oauth_client_secret_set) == ("enterprise", 1, True)
    with pytest.raises(Conflict):  # ref is unique across both kinds
        repo.create_custom(ctx, _fields(ref="mes-lookup"), server_id=ENTERPRISE_PREFIX + "x", created_by="owner-1", secret_enc=None)

    kept = repo.update_custom(ctx, server_id, _fields(**oauth, summary="v2"), updated_by="owner-1")
    assert (kept.source_revision, kept.summary, kept.oauth_client_secret_set) == (2, "v2", True)
    assert repo.oauth_client(ctx, server_id) == ("oauth", "app-1", b"enc-1")
    replaced = repo.update_custom(ctx, server_id, _fields(**oauth), updated_by="owner-1", secret_enc=b"enc-2")
    assert replaced.source_revision == 3 and repo.oauth_client(ctx, server_id)[2] == b"enc-2"
    cleared = repo.update_custom(ctx, server_id, _fields(auth="bearer"), updated_by="owner-1")
    assert (cleared.auth, cleared.oauth_client_id, cleared.oauth_client_secret_set) == ("bearer", "", False)
    # Only enterprise rows are editable this way.
    assert repo.update_custom(ctx, platform.server_id, _fields(ref="mes-lookup"), updated_by="owner-1") is None

    assert {(row.ref, row.origin) for row in repo.list(ctx)} == {("mes-lookup", "platform"), ("erp-orders", "enterprise")}
    assert repo.list(other) == [] and repo.get(other, server_id) is None  # RLS
    assert repo.update_custom(other, server_id, _fields(), updated_by="owner-2") is None

    # The origin / id pairing is enforced by the database, not only by the service.
    with psycopg.connect(admin_url, autocommit=True) as conn, pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO mcp_catalog (tenant_id, server_id, ref, display_name, url, source_revision, origin) "
            "VALUES (%s, 'ent-forged', 'forged', 'x', 'https://x.example.com', 1, 'platform')", (two_tenants[0],),
        )

    assert repo.delete(ctx, server_id) and repo.get(ctx, server_id) is None
