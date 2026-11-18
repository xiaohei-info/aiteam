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
from shared.contracts.platform_mcp import PlatformMcpServerPull
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()
TENANT = "00000000-0000-4000-8000-0000000000aa"


def _server(server_id="s1", ref="mes-lookup", *, revision=1, auth="none", **extra):
    return {
        "server_id": server_id, "ref": ref, "display_name": f"MCP {ref}", "summary": "用途",
        "url": f"https://mcp.example.com/{ref}", "tools": ["a", "b"], "auth": auth,
        "revision": revision, "status": "published", **extra,
    }


class FakeRepo:
    def __init__(self):
        self.rows: dict[str, McpCatalogRow] = {}
        self.secrets: dict[str, bytes] = {}

    def list(self, ctx):
        return list(self.rows.values())

    def upsert(self, ctx, server: PlatformMcpServerPull, *, enabled_by, secret_enc=None):
        if any(row.ref == server.ref and row.server_id != server.server_id for row in self.rows.values()):
            raise Conflict("ref clash")
        row = McpCatalogRow(server.server_id, server.ref, server.display_name, server.summary, server.url,
                            server.tools, server.auth, server.auth_header, server.oauth_scopes, server.timeout_ms,
                            server.oauth_client_id, secret_enc is not None, server.revision)
        self.rows[server.server_id] = row
        if secret_enc is None:
            self.secrets.pop(server.server_id, None)
        else:
            self.secrets[server.server_id] = secret_enc
        return row

    def oauth_client(self, ctx, server_id):
        row = self.rows.get(server_id)
        return (row.auth, row.oauth_client_id, self.secrets.get(server_id)) if row else None

    def delete(self, ctx, server_id):
        self.secrets.pop(server_id, None)
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
    service, operator = _service([_server(), _server("s2", "doc-search", auth="bearer", auth_header="X-API-Key")])
    market = service.list_market(ADMIN)
    assert market["platform_available"] is True
    assert [(item["ref"], item["enabled"]) for item in market["servers"]] == [("mes-lookup", False), ("doc-search", False)]

    service.enable(ADMIN, "s1")
    service.enable(ADMIN, "s2")
    # Entries that need authentication are installable too: each member brings their own token.
    assert [(item.ref, item.auth, item.auth_header) for item in service.installable(MEMBER)] == [("mes-lookup", "none", ""), ("doc-search", "bearer", "X-API-Key")]

    operator.seed_platform_mcp([_server(revision=2), _server("s2", "doc-search", auth="bearer", auth_header="X-API-Key")])
    item = service.list_market(ADMIN)["servers"][0]
    assert (item["enabled_revision"], item["platform_revision"], item["update_available"]) == (1, 2, True)
    service.enable(ADMIN, "s1")
    assert service.list_market(ADMIN)["servers"][0]["update_available"] is False

    service.disable(ADMIN, "s1")
    service.disable(ADMIN, "s2")
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
        "auth": "none", "auth_header": "", "oauth_scopes": "", "timeout_ms": 30000, "oauth_client": "dynamic",
    }]
    assert client.delete("/api/manager/mcp-market/s1", headers=owner).status_code == 204


def _oauth_server(**extra):
    return _server("s9", "cr-test", auth="oauth", tools=[], oauth_scopes="openid profile.read", timeout_ms=45000, **extra)


def test_oauth_entries_reach_members_and_the_platform_application_secret_is_re_encrypted():
    from cryptography.fernet import Fernet

    from shared.crypto import CryptoService
    crypto = CryptoService(Fernet(Fernet.generate_key()))
    operator = FakeOperatorCatalogClient()
    operator.seed_platform_mcp([_oauth_server(oauth_client_id="app-1", oauth_client_secret="app-secret-xyz", oauth_client_secret_set=True)])
    repo = FakeRepo()
    service = McpMarketService(operator=operator, repo=repo, members=FakeMembers(), crypto=crypto)

    market = service.list_market(ADMIN)["servers"][0]
    assert (market["auth"], market["oauth_client"], market["tools"]) == ("oauth", "preregistered", [])
    assert "app-secret-xyz" not in str(market) and "oauth_client_id" not in market

    service.enable(ADMIN, "s9")
    stored = repo.secrets["s9"]
    assert b"app-secret-xyz" not in stored and crypto.decrypt(stored) == "app-secret-xyz"
    item = service.installable(MEMBER)[0]
    assert (item.auth, item.oauth_scopes, item.timeout_ms, item.oauth_client) == ("oauth", "openid profile.read", 45000, "preregistered")
    assert "app-secret-xyz" not in item.model_dump_json()
    assert service.oauth_client(MEMBER, "s9") == {"client_id": "app-1", "client_secret": "app-secret-xyz"}


def test_oauth_client_is_only_for_enabled_preregistered_oauth_entries_and_active_members():
    from manager_service.active_principal import PrincipalInactive
    from shared.errors import NotFound
    service, operator = _service([_oauth_server(), _server()])
    service.enable(ADMIN, "s9")
    service.enable(ADMIN, "s1")
    assert service.installable(MEMBER)[0].oauth_client == "dynamic"
    for server_id in ("s9", "s1", "missing"):  # dynamic registration / no auth / not enabled
        with pytest.raises(NotFound):
            service.oauth_client(MEMBER, server_id)
    operator.seed_platform_mcp([_oauth_server(oauth_client_id="app-2")])
    service.enable(ADMIN, "s9")
    assert service.oauth_client(MEMBER, "s9") == {"client_id": "app-2"}
    inactive = McpMarketService(operator=operator, repo=service._repo, members=FakeMembers("disabled"))
    with pytest.raises(PrincipalInactive):
        inactive.oauth_client(MEMBER, "s9")


def test_oauth_client_route_returns_the_application_to_members():
    service, operator = _service([_oauth_server(oauth_client_id="app-1", oauth_client_secret="sec-1")])
    service.enable(ADMIN, "s9")
    app = create_app(Settings(tier="manager", service_name="manager"), APIRouter())
    app.state._mcp_market_service = service
    app.include_router(build_mcp_market_router(_VERIFIER))
    client = TestClient(app)
    member = {"Authorization": f"Bearer {sign_inmem_token(_SIGNER, TENANT, ['member'], user_id='m-1')}"}
    assert client.get("/api/manager/grants/mcp-servers/s9/oauth-client").status_code == 401
    response = client.get("/api/manager/grants/mcp-servers/s9/oauth-client", headers=member)
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"client_id": "app-1", "client_secret": "sec-1"}
    assert client.get("/api/manager/grants/mcp-servers/nope/oauth-client", headers=member).status_code == 404
    listed = client.get("/api/manager/grants/mcp-servers", headers=member)
    assert "sec-1" not in listed.text and listed.json()["data"][0]["oauth_client"] == "preregistered"
