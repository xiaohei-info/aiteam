"""Enterprise MCP market + member installable list (design §11.3)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.mcp_catalog import McpCatalogRow, McpMarketService
from manager_service.operator_catalog import (
    FakeOperatorCatalogClient,
    OperatorCatalogUnavailable,
)
from manager_service.routes_mcp_market import build_mcp_market_router
from shared.app_factory import create_app
from shared.config import Settings
from shared.contracts.platform_mcp import PlatformMcpServer
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()
TENANT = "00000000-0000-4000-8000-0000000000aa"


def _server(server_id="s1", ref="mes-lookup", *, revision=1, creds=False, **extra):
    return {
        "server_id": server_id, "ref": ref, "display_name": f"MCP {ref}", "summary": "用途",
        "url": f"https://mcp.example.com/{ref}", "tools": ["a", "b"], "requires_credentials": creds,
        "revision": revision, "status": "published", **extra,
    }


class FakeRepo:
    def __init__(self):
        self.rows: dict[str, McpCatalogRow] = {}

    def list(self, ctx):
        return list(self.rows.values())

    def upsert(self, ctx, server: PlatformMcpServer, *, enabled_by):
        if any(row.ref == server.ref and row.server_id != server.server_id for row in self.rows.values()):
            raise Conflict("ref clash")
        row = McpCatalogRow(server.server_id, server.ref, server.display_name, server.summary, server.url,
                            server.tools, server.requires_credentials, server.revision)
        self.rows[server.server_id] = row
        return row

    def delete(self, ctx, server_id):
        return self.rows.pop(server_id, None) is not None


class FakeMembers:
    def __init__(self, status="active"):
        self.status = status

    def get_member(self, ctx, member_id):
        return SimpleNamespace(status=self.status)


def _service(servers, *, members=None):
    operator = FakeOperatorCatalogClient()
    operator.seed_platform_mcp(servers)
    return McpMarketService(operator=operator, repo=FakeRepo(), members=members or FakeMembers()), operator


ADMIN = TenantContext(tenant_id=TENANT, user_id="owner-1", roles=["owner"])
MEMBER = TenantContext(tenant_id=TENANT, user_id="m-1", roles=["member"])


def test_enable_update_and_disable_flow():
    service, operator = _service([_server(), _server("s2", "doc-search", creds=True)])
    market = service.list_market(ADMIN)
    assert market["platform_available"] is True
    assert [(item["ref"], item["enabled"]) for item in market["servers"]] == [("mes-lookup", False), ("doc-search", False)]

    service.enable(ADMIN, "s1")
    service.enable(ADMIN, "s2")
    # Credential-requiring entries are enabled but never installable by members.
    assert [item.ref for item in service.installable(MEMBER)] == ["mes-lookup"]

    operator.seed_platform_mcp([_server(revision=2), _server("s2", "doc-search", creds=True)])
    item = service.list_market(ADMIN)["servers"][0]
    assert (item["enabled_revision"], item["platform_revision"], item["update_available"]) == (1, 2, True)
    service.enable(ADMIN, "s1")
    assert service.list_market(ADMIN)["servers"][0]["update_available"] is False

    service.disable(ADMIN, "s1")
    assert service.installable(MEMBER) == []


def test_unpublished_or_unreachable_platform_keeps_enabled_entries_listed():
    service, operator = _service([_server()])
    service.enable(ADMIN, "s1")
    operator.seed_platform_mcp([])
    item = service.list_market(ADMIN)["servers"][0]
    assert (item["enabled"], item["published"], item["platform_revision"]) == (True, False, None)
    # Members can still install what the enterprise enabled (§11.5: unpublishing limits only new enables).
    assert [entry.ref for entry in service.installable(MEMBER)] == ["mes-lookup"]

    def down():
        raise OperatorCatalogUnavailable("down")
    operator.list_platform_mcp_servers = down
    market = service.list_market(ADMIN)
    assert market["platform_available"] is False and [entry["ref"] for entry in market["servers"]] == ["mes-lookup"]


def test_only_admins_enable_and_unpublished_cannot_be_enabled():
    from shared.errors import Forbidden, NotFound
    service, _ = _service([_server()])
    with pytest.raises(Forbidden):
        service.enable(MEMBER, "s1")
    with pytest.raises(NotFound):
        service.enable(ADMIN, "nope")
    with pytest.raises(NotFound):
        service.disable(ADMIN, "s1")


def test_ref_clash_with_other_enabled_server_conflicts():
    service, _ = _service([_server(), _server("s2", "mes-lookup")])
    service.enable(ADMIN, "s1")
    with pytest.raises(Conflict):
        service.enable(ADMIN, "s2")


def test_inactive_member_cannot_list_installable():
    from manager_service.active_principal import PrincipalInactive
    service, _ = _service([_server()], members=FakeMembers("disabled"))
    with pytest.raises(PrincipalInactive):
        service.installable(MEMBER)


def test_routes_roundtrip():
    service, _ = _service([_server()])
    app = create_app(Settings(tier="manager", service_name="manager"), APIRouter())
    app.state._mcp_market_service = service
    app.include_router(build_mcp_market_router(_VERIFIER))
    client = TestClient(app)
    owner = {"Authorization": f"Bearer {sign_inmem_token(_SIGNER, TENANT, ['owner'], user_id='owner-1')}"}
    member = {"Authorization": f"Bearer {sign_inmem_token(_SIGNER, TENANT, ['member'], user_id='m-1')}"}

    assert client.get("/api/manager/mcp-market").status_code == 401
    assert client.post("/api/manager/mcp-market/s1/enable", headers=member).status_code == 403
    enabled = client.post("/api/manager/mcp-market/s1/enable", headers=owner)
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["data"]["source_revision"] == 1
    listed = client.get("/api/manager/mcp-market", headers=member).json()["data"]
    assert listed["servers"][0]["enabled"] is True
    installable = client.get("/api/manager/grants/mcp-servers", headers=member).json()["data"]
    assert installable == [{
        "server_id": "s1", "ref": "mes-lookup", "display_name": "MCP mes-lookup", "summary": "用途",
        "url": "https://mcp.example.com/mes-lookup", "tools": ["a", "b"], "revision": 1,
    }]
    assert client.delete("/api/manager/mcp-market/s1", headers=owner).status_code == 204
