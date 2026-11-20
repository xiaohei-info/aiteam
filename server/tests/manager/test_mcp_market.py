"""Enterprise MCP market + member installable list (design §11.3)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import APIRouter
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from manager_service import mcp_catalog
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

    def get(self, ctx, server_id):
        return self.rows.get(server_id)

    def _put(self, server_id, fields, revision, secret_enc):
        row = McpCatalogRow(server_id, fields.ref, fields.display_name, fields.summary, fields.url, fields.tools,
                            fields.auth, fields.auth_header, fields.oauth_scopes, fields.timeout_ms,
                            fields.oauth_client_id, secret_enc is not None, revision, "enterprise")
        self.rows[server_id] = row
        if secret_enc is None:
            self.secrets.pop(server_id, None)
        else:
            self.secrets[server_id] = secret_enc
        return row

    def create_custom(self, ctx, fields, *, server_id, created_by, secret_enc):
        if any(row.ref == fields.ref for row in self.rows.values()):
            raise Conflict("ref clash")
        return self._put(server_id, fields, 1, secret_enc)

    def update_custom(self, ctx, server_id, fields, *, updated_by, secret_enc=mcp_catalog._KEEP):
        row = self.rows.get(server_id)
        if row is None or row.origin != "enterprise":
            return None
        secret = self.secrets.get(server_id) if secret_enc is mcp_catalog._KEEP else secret_enc
        if fields.auth != "oauth" or not fields.oauth_client_id:
            secret = None
        return self._put(server_id, fields, row.source_revision + 1, secret)


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
        "origin": "platform",
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


class _FakeAudit:
    def __init__(self):
        self.events: list[tuple[str, str, str | None]] = []

    def record(self, ctx, *, actor, action, resource_type=None, resource_id=None):
        self.events.append((actor, action, resource_id))


def test_oauth_client_is_issued_on_demand_and_audited():
    """按需下发（设计 2026-11-19 §3.4）：企业已启用 + 成员在职即下发，每次下发记一条审计。"""
    from cryptography.fernet import Fernet

    from shared.crypto import CryptoService

    crypto = CryptoService(Fernet(Fernet.generate_key()))
    operator = FakeOperatorCatalogClient()
    operator.seed_platform_mcp([_oauth_server(oauth_client_id="app-1", oauth_client_secret="sec-1")])
    repo = FakeRepo()
    audit = _FakeAudit()
    service = McpMarketService(operator=operator, repo=repo, members=FakeMembers(), crypto=crypto, audit=audit)
    service.enable(ADMIN, "s9")
    assert service.oauth_client(MEMBER, "s9") == {"client_id": "app-1", "client_secret": "sec-1"}
    assert service.oauth_client(MEMBER, "s9") == {"client_id": "app-1", "client_secret": "sec-1"}
    assert audit.events == [("m-1", "mcp.oauth_client.issued", "s9")] * 2


def _api_routes(routes):
    """展开 FastAPI ≥0.130 惰性子路由（`_IncludedRouter` 占位），按真实注册顺序。"""
    for route in routes:
        if isinstance(route, APIRoute):
            yield route
        elif (included := getattr(route, "original_router", None)) is not None:
            yield from _api_routes(included.routes)


def _resolved_path(app, path: str, method: str = "GET") -> str | None:
    """按 Starlette 注册顺序解析 `path`，返回命中路由的 path；未命中返回 None。"""
    scope = {"type": "http", "method": method, "path": path, "root_path": "", "headers": []}
    for route in _api_routes(app.routes):
        match, _ = route.matches(scope)
        if match.name == "FULL":
            return route.path
    return None


@pytest.mark.parametrize("path", [
    "/api/manager/grants/mcp-servers",
    "/api/manager/grants/skills",
])
def test_fixed_grants_prefixes_win_over_grant_id(path):
    """固定前缀必须先于 `/grants/{grant_id}` 注册，否则会被当成 grant_id 查 uuid 列。

    用真实 manager app 验证，而不是只挂 MCP 路由的 `create_app`——后者抓不到注册顺序。
    """
    from manager_service.app import app

    resolved = _resolved_path(app, path)
    assert resolved == path, f"{path} 被解析成 {resolved!r}（注册顺序不对）"
    assert resolved != "/api/manager/grants/{grant_id}"


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


# ---- 企业自建 MCP（设计 2026-11-20 §4.4）----

def _fields(**extra):
    from shared.contracts.platform_mcp import PlatformMcpServerFields
    base = {"ref": "erp-orders", "display_name": "ERP 订单", "summary": "查订单", "url": "https://erp.example.com/mcp", "tools": ["find_order"]}
    return PlatformMcpServerFields.model_validate({**base, **extra})


def _crypto_service():
    from cryptography.fernet import Fernet

    from shared.crypto import CryptoService
    return CryptoService(Fernet(Fernet.generate_key()))


def test_enterprise_mcp_create_update_delete_and_member_listing():
    from shared.errors import NotFound, ValidationProblem
    operator = FakeOperatorCatalogClient()
    operator.seed_platform_mcp([_server()])
    audit = _FakeAudit()
    service = McpMarketService(operator=operator, repo=FakeRepo(), members=FakeMembers(), crypto=_crypto_service(), audit=audit)
    service.enable(ADMIN, "s1")

    created = service.create_custom(ADMIN, _fields())
    assert created.server_id.startswith("ent-") and created.source_revision == 1 and created.origin == "enterprise"
    market = service.list_market(ADMIN)
    # Enterprise entries are their own group, never shown as «platform unpublished».
    assert [item["ref"] for item in market["servers"]] == ["mes-lookup"]
    assert [(item["ref"], item["revision"]) for item in market["enterprise"]] == [("erp-orders", 1)]
    assert {(item.ref, item.origin) for item in service.installable(MEMBER)} == {("mes-lookup", "platform"), ("erp-orders", "enterprise")}

    updated = service.update_custom(ADMIN, created.server_id, _fields(display_name="ERP 订单 v2", tools=["find_order", "list_orders"]))
    assert (updated.display_name, updated.source_revision, updated.tools) == ("ERP 订单 v2", 2, ["find_order", "list_orders"])
    with pytest.raises(ValidationProblem):
        service.update_custom(ADMIN, created.server_id, _fields(ref="erp-renamed"))
    with pytest.raises(NotFound):  # a platform entry is not editable here
        service.update_custom(ADMIN, "s1", _fields(ref="mes-lookup"))

    service.disable(ADMIN, created.server_id)
    assert [item.ref for item in service.installable(MEMBER)] == ["mes-lookup"]
    assert [action for _actor, action, _id in audit.events] == [
        "mcp_catalog.custom_created", "mcp_catalog.custom_updated", "mcp_catalog.custom_deleted",
    ]
    assert all(resource == created.server_id for _actor, _action, resource in audit.events)


def test_enterprise_mcp_admin_only_and_ref_unique_across_both_kinds():
    from shared.errors import Forbidden
    service, _ = _service([_server()])
    service.enable(ADMIN, "s1")
    for call in (lambda: service.create_custom(MEMBER, _fields()), lambda: service.update_custom(MEMBER, "ent-x", _fields()),
                 lambda: service.probe(MEMBER, None)):
        with pytest.raises(Forbidden):
            call()
    with pytest.raises(Conflict):  # ref held by the enabled platform entry
        service.create_custom(ADMIN, _fields(ref="mes-lookup"))


def test_enterprise_mcp_application_secret_is_write_only_kept_replaced_or_cleared():
    crypto = _crypto_service()
    repo = FakeRepo()
    service = McpMarketService(operator=FakeOperatorCatalogClient(), repo=repo, members=FakeMembers(), crypto=crypto)
    oauth = {"auth": "oauth", "tools": [], "oauth_client_id": "app-9"}
    row = service.create_custom(ADMIN, _fields(**oauth, oauth_client_secret="s-1"))
    assert row.oauth_client_secret_set and crypto.decrypt(repo.secrets[row.server_id]) == "s-1"
    assert service.oauth_client(MEMBER, row.server_id) == {"client_id": "app-9", "client_secret": "s-1"}
    assert "s-1" not in str(mcp_catalog.enterprise_entry(row))

    service.update_custom(ADMIN, row.server_id, _fields(**oauth, summary="不传密钥"))  # not sent: kept
    assert crypto.decrypt(repo.secrets[row.server_id]) == "s-1"
    service.update_custom(ADMIN, row.server_id, _fields(**oauth, oauth_client_secret="s-2"))
    assert crypto.decrypt(repo.secrets[row.server_id]) == "s-2"
    service.update_custom(ADMIN, row.server_id, _fields(**oauth, oauth_client_secret=""))
    assert row.server_id not in repo.secrets
    service.update_custom(ADMIN, row.server_id, _fields(**oauth, oauth_client_secret="s-3"))
    cleared = service.update_custom(ADMIN, row.server_id, _fields(auth="bearer"))  # no longer a preregistered app
    assert not cleared.oauth_client_secret_set and row.server_id not in repo.secrets


def test_enterprise_mcp_routes_and_probe():
    from shared.mcp_probe import McpProbeResult
    probed: list[str] = []

    def fake_probe(request):
        probed.append(request.url)
        return McpProbeResult(status="ok", auth="none", tools=["find_order"], server_name="ERP")

    operator = FakeOperatorCatalogClient()
    service = McpMarketService(operator=operator, repo=FakeRepo(), members=FakeMembers(), probe=fake_probe)
    app = create_app(Settings(tier="manager", service_name="manager"), APIRouter())
    app.state._mcp_market_service = service
    app.include_router(build_mcp_market_router(_VERIFIER))
    client = TestClient(app)
    owner = {"Authorization": f"Bearer {sign_inmem_token(_SIGNER, TENANT, ['owner'], user_id='owner-1')}"}
    member = {"Authorization": f"Bearer {sign_inmem_token(_SIGNER, TENANT, ['member'], user_id='m-1')}"}
    body = {"ref": "erp-orders", "display_name": "ERP 订单", "url": "https://erp.example.com/mcp", "tools": ["find_order"]}

    assert client.post("/api/manager/mcp-market/probe", headers=member, json={"url": "https://erp.example.com/mcp"}).status_code == 403
    probe = client.post("/api/manager/mcp-market/probe", headers=owner, json={"url": "https://erp.example.com/mcp"})
    assert probe.status_code == 200 and probe.json()["data"]["tools"] == ["find_order"] and probed == ["https://erp.example.com/mcp"]
    assert client.post("/api/manager/mcp-market/custom", headers=member, json=body).status_code == 403
    assert client.post("/api/manager/mcp-market/custom", headers=owner, json={**body, "url": "http://erp.example.com/mcp"}).status_code == 422
    created = client.post("/api/manager/mcp-market/custom", headers=owner, json=body)
    assert created.status_code == 201, created.text
    entry = created.json()["data"]
    assert entry["server_id"].startswith("ent-") and entry["revision"] == 1 and "oauth_client_secret" not in entry
    assert client.post("/api/manager/mcp-market/custom", headers=owner, json=body).status_code == 409
    path = f"/api/manager/mcp-market/custom/{entry['server_id']}"
    updated = client.put(path, headers=owner, json={**body, "summary": "查订单"})
    assert updated.status_code == 200 and updated.json()["data"]["revision"] == 2
    assert client.put(path, headers=owner, json={**body, "ref": "other"}).status_code == 422
    assert client.put("/api/manager/mcp-market/custom/ent-missing", headers=owner, json=body).status_code == 404
    listed = client.get("/api/manager/mcp-market", headers=owner).json()["data"]
    assert [item["ref"] for item in listed["enterprise"]] == ["erp-orders"] and listed["servers"] == []
    installable = client.get("/api/manager/grants/mcp-servers", headers=member).json()["data"]
    assert [(item["ref"], item["origin"], item["revision"]) for item in installable] == [("erp-orders", "enterprise", 2)]
    assert client.delete(f"/api/manager/mcp-market/{entry['server_id']}", headers=owner).status_code == 204
    assert client.get("/api/manager/grants/mcp-servers", headers=member).json()["data"] == []
