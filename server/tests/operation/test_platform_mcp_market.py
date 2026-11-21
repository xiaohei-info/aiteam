"""Operator platform MCP catalog routes (design §11.3)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from shared.mcp_probe import (
    McpProbeRequest,
    McpProbeResult,
    ProbeBlocked,
    probe_mcp,
    public_addresses,
)
from run import get_app
from shared.contracts.platform_mcp import (
    PlatformMcpServer,
    PlatformMcpServerFields,
    PlatformMcpServerPull,
)
from shared.errors import Conflict, NotFound
from tests.operation.auth_helpers import operation_test_token


class FakeMcpRepo:
    """Mirrors PlatformMcpRepository's secret rules: None keeps, "" clears, other replaces; non-oauth clears."""

    def __init__(self):
        self.items: dict[str, PlatformMcpServer] = {}
        self.secrets: dict[str, str] = {}

    def _secret(self, server_id, body: PlatformMcpServerFields):
        if body.auth != "oauth" or not body.oauth_client_id or body.oauth_client_secret == "":
            self.secrets.pop(server_id, None)
        elif body.oauth_client_secret is not None:
            self.secrets[server_id] = body.oauth_client_secret
        return server_id in self.secrets

    def list_for_pull(self):
        return [PlatformMcpServerPull(**item.model_dump(), oauth_client_secret=self.secrets.get(item.server_id, ""))
                for item in self.items.values() if item.status == "published"]

    def list(self, *, status=None):
        return [item for item in self.items.values() if status is None or item.status == status]

    def create(self, body: PlatformMcpServerFields):
        if any(item.ref == body.ref for item in self.items.values()):
            raise Conflict("dup")
        server_id = f"s{len(self.items) + 1}"
        item = PlatformMcpServer(**body.model_dump(exclude={"oauth_client_secret"}), server_id=server_id, revision=1, status="draft",
                                 oauth_client_secret_set=self._secret(server_id, body))
        self.items[item.server_id] = item
        return item

    def update(self, server_id, body: PlatformMcpServerFields):
        current = self.items.get(server_id)
        if current is None:
            raise NotFound("missing")
        if current.ref != body.ref:
            raise Conflict("ref immutable")
        item = current.model_copy(update={**body.model_dump(exclude={"oauth_client_secret"}), "revision": current.revision + 1,
                                          "oauth_client_secret_set": self._secret(server_id, body)})
        self.items[server_id] = item
        return item

    def set_status(self, server_id, status):
        current = self.items.get(server_id)
        if current is None:
            raise NotFound("missing")
        self.items[server_id] = current.model_copy(update={"status": status})
        return self.items[server_id]


BODY = {
    "ref": "mes-lookup", "display_name": "MES 批次查询", "summary": "查询生产批次",
    "url": "https://mcp.example.com/mes", "tools": ["batch_get", "batch_search"],
}


@pytest.fixture
def client():
    app = get_app("operation")
    app.state._platform_mcp_repository = FakeMcpRepo()
    yield TestClient(app)
    del app.state._platform_mcp_repository


def auth(role: str = "system_admin") -> dict[str, str]:
    from operation_service.app import _auth
    return {"Authorization": f"Bearer {operation_test_token(_auth, user_id='op1', role=role)}"}


def test_create_update_publish_and_pull(client):
    created = client.post("/api/operation/mcp-market/servers", json=BODY, headers=auth())
    assert created.status_code == 201, created.text
    server = created.json()["data"]
    assert (server["status"], server["revision"]) == ("draft", 1)

    pulled = client.get("/api/operation/mcp-market/pull/servers", headers={"X-Service-Token": "test-service-token"})
    assert pulled.status_code == 200 and pulled.json()["data"] == []

    updated = client.put(f"/api/operation/mcp-market/servers/{server['server_id']}", json={**BODY, "summary": "新用途"}, headers=auth())
    assert updated.status_code == 200 and updated.json()["data"]["revision"] == 2

    published = client.post(f"/api/operation/mcp-market/servers/{server['server_id']}/publish", headers=auth("system_operator"))
    assert published.json()["data"]["status"] == "published"
    pulled = client.get("/api/operation/mcp-market/pull/servers", headers={"X-Service-Token": "test-service-token"})
    assert [item["ref"] for item in pulled.json()["data"]] == ["mes-lookup"]

    client.post(f"/api/operation/mcp-market/servers/{server['server_id']}/unpublish", headers=auth())
    pulled = client.get("/api/operation/mcp-market/pull/servers", headers={"X-Service-Token": "test-service-token"})
    assert pulled.json()["data"] == []


def test_ref_is_immutable_and_unique(client):
    server = client.post("/api/operation/mcp-market/servers", json=BODY, headers=auth()).json()["data"]
    assert client.post("/api/operation/mcp-market/servers", json=BODY, headers=auth()).status_code == 409
    renamed = client.put(f"/api/operation/mcp-market/servers/{server['server_id']}", json={**BODY, "ref": "other"}, headers=auth())
    assert renamed.status_code == 409
    assert client.post("/api/operation/mcp-market/servers/nope/publish", headers=auth()).status_code == 404


@pytest.mark.parametrize("patch", [
    {"url": "http://mcp.example.com/mes"},
    {"url": "https://user:secret@mcp.example.com/mes"},
    {"url": "https://mcp.example.com/mes?token=1"},
    {"ref": "Bad Ref"},
    {"tools": []},
    {"tools": ["a", "a"]},
    {"tools": ["bad tool"]},
    {"display_name": ""},
])
def test_invalid_fields_rejected(client, patch):
    response = client.post("/api/operation/mcp-market/servers", json={**BODY, **patch}, headers=auth())
    assert response.status_code == 422, response.text


def test_management_requires_platform_role_and_pull_requires_service_identity(client):
    assert client.get("/api/operation/mcp-market/servers").status_code == 401
    assert client.get("/api/operation/mcp-market/pull/servers").status_code == 401


OAUTH = {
    "ref": "cr-test", "display_name": "Cycplus 活动数据", "url": "https://mcp-test.cycplus.com/mcp/cr-test",
    "tools": [], "auth": "oauth", "oauth_scopes": "openid  profile.read", "timeout_ms": 30000,
}
PULL = {"X-Service-Token": "test-service-token"}


def test_oauth_entry_may_leave_tools_empty_and_fields_of_other_modes_are_dropped(client):
    created = client.post("/api/operation/mcp-market/servers", json={**OAUTH, "auth_header": "X-API-Key"}, headers=auth())
    assert created.status_code == 201, created.text
    data = created.json()["data"]
    assert (data["auth"], data["tools"], data["oauth_scopes"], data["auth_header"]) == ("oauth", [], "openid profile.read", "")
    assert data["oauth_client_secret_set"] is False and "oauth_client_secret" not in data
    bearer = client.post("/api/operation/mcp-market/servers", json={**BODY, "ref": "crm", "auth": "bearer", "auth_header": "X-API-Key", "oauth_client_id": "x"}, headers=auth())
    assert bearer.status_code == 201, bearer.text
    assert (bearer.json()["data"]["auth_header"], bearer.json()["data"]["oauth_client_id"]) == ("X-API-Key", "")
    # «Authorization» is the default and stored as empty.
    default = client.post("/api/operation/mcp-market/servers", json={**BODY, "ref": "crm2", "auth": "bearer", "auth_header": "Authorization"}, headers=auth())
    assert default.json()["data"]["auth_header"] == ""


@pytest.mark.parametrize("patch", [
    {"auth": "none", "tools": []},
    {"auth": "bearer", "tools": []},
    {"auth": "basic"},
    {"auth": "bearer", "auth_header": "Host"},
    {"auth": "bearer", "auth_header": "X Key"},
    {"timeout_ms": 999},
    {"timeout_ms": 300001},
    {"auth": "oauth", "oauth_scopes": "bad\"scope"},
    {"auth": "oauth", "oauth_client_secret": "s"},  # secret without client id
    {"requires_credentials": True},  # old field is gone
])
def test_invalid_auth_fields_rejected(client, patch):
    response = client.post("/api/operation/mcp-market/servers", json={**BODY, **patch}, headers=auth())
    assert response.status_code == 422, response.text


def test_application_secret_is_write_only_and_only_the_service_pull_carries_it(client):
    body = {**OAUTH, "oauth_client_id": "app-1", "oauth_client_secret": "app-secret-xyz"}
    server = client.post("/api/operation/mcp-market/servers", json=body, headers=auth()).json()["data"]
    assert server["oauth_client_secret_set"] is True
    listed = client.get("/api/operation/mcp-market/servers", headers=auth())
    assert "app-secret-xyz" not in listed.text and listed.json()["data"][0]["oauth_client_secret_set"] is True
    client.post(f"/api/operation/mcp-market/servers/{server['server_id']}/publish", headers=auth())
    pulled = client.get("/api/operation/mcp-market/pull/servers", headers=PULL).json()["data"][0]
    assert (pulled["oauth_client_id"], pulled["oauth_client_secret"]) == ("app-1", "app-secret-xyz")

    # Omitted keeps it; empty clears it; switching away from oauth clears it too.
    kept = client.put(f"/api/operation/mcp-market/servers/{server['server_id']}", json={**OAUTH, "oauth_client_id": "app-1"}, headers=auth())
    assert kept.json()["data"]["oauth_client_secret_set"] is True
    cleared = client.put(f"/api/operation/mcp-market/servers/{server['server_id']}", json={**OAUTH, "oauth_client_id": "app-1", "oauth_client_secret": ""}, headers=auth())
    assert cleared.json()["data"]["oauth_client_secret_set"] is False
    client.put(f"/api/operation/mcp-market/servers/{server['server_id']}", json={**body}, headers=auth())
    switched = client.put(f"/api/operation/mcp-market/servers/{server['server_id']}", json={**BODY, "ref": "cr-test"}, headers=auth())
    assert switched.json()["data"]["oauth_client_secret_set"] is False
    assert client.get("/api/operation/mcp-market/pull/servers", headers=PULL).json()["data"][0]["oauth_client_secret"] == ""


def test_probe_route_requires_platform_role_and_never_echoes_the_test_token(client):
    seen: list[McpProbeRequest] = []

    def fake(body: McpProbeRequest) -> McpProbeResult:
        seen.append(body)
        return McpProbeResult(status="needs_token", auth="bearer", token_rejected=True, detail="服务方拒绝了测试令牌。")

    client.app.state._mcp_probe = fake
    try:
        assert client.post("/api/operation/mcp-market/probe", json={"url": "https://x.example.com/mcp"}).status_code == 401
        response = client.post("/api/operation/mcp-market/probe", json={"url": "https://x.example.com/mcp", "test_token": "tok-123456"}, headers=auth("system_operator"))
        assert response.status_code == 200, response.text
        assert "tok-123456" not in response.text
        assert response.json()["data"]["status"] == "needs_token"
        assert seen[0].test_token == "tok-123456"
    finally:
        del client.app.state._mcp_probe


# ---- probe logic with an injected transport (no network) ----

class FakeFetch:
    """Answers like an MCP server; `mode` picks open / oauth / bearer behaviour."""

    def __init__(self, mode: str, *, token: str = "", sse: bool = False, registration: bool = True):
        self.mode, self.token, self.sse, self.registration = mode, token, sse, registration
        self.calls: list[tuple[str, str, dict]] = []

    def __call__(self, method, url, headers, body, deadline):
        import json as _json
        headers = {k.lower(): v for k, v in headers.items()}  # HTTP header names are case-insensitive
        self.calls.append((method, url, headers))
        if method == "GET" and self.mode != "oauth":
            return 404, {}, b""
        if method == "GET" and url == "https://mcp.example.com/.well-known/oauth-protected-resource/mcp":
            return 200, {}, _json.dumps({"resource": "https://mcp.example.com/mcp", "authorization_servers": ["https://auth.example.com"], "scopes_supported": ["openid", "profile.read"]}).encode()
        if method == "GET" and url == "https://auth.example.com/.well-known/oauth-authorization-server":
            meta = {"issuer": "https://auth.example.com", "authorization_endpoint": "https://auth.example.com/authorize", "token_endpoint": "https://auth.example.com/token"}
            if self.registration:
                meta["registration_endpoint"] = "https://auth.example.com/register"
            return 200, {}, _json.dumps(meta).encode()
        if method == "GET":
            return 404, {}, b""
        message = _json.loads(body)
        if self.mode == "oauth":
            return 401, {"www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="openid"'}, b""
        if self.mode == "bearer" and headers.get("x-api-key") != self.token:
            return 401, {}, b""
        if "id" not in message:
            return 202, {}, b""
        result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "MES"}} if message["method"] == "initialize" \
            else {"tools": [{"name": "batch_get"}, {"name": "bad tool"}, {"name": "batch_search"}]}
        payload = _json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result})
        if self.sse:
            return 200, {"content-type": "text/event-stream", "mcp-session-id": "sess-1"}, f"event: message\ndata: {payload}\n\n".encode()
        return 200, {"content-type": "application/json"}, payload.encode()


def test_probe_reads_tools_from_open_servers_over_json_and_sse():
    for sse in (False, True):
        fetch = FakeFetch("open", sse=sse)
        result = probe_mcp(McpProbeRequest(url="https://mcp.example.com/mcp"), fetch)
        assert (result.status, result.auth, result.tools, result.server_name) == ("ok", "none", ["batch_get", "batch_search"], "MES")
        if sse:
            assert fetch.calls[-1][2]["mcp-session-id"] == "sess-1"


def test_probe_detects_browser_sign_in_without_registering_anything():
    fetch = FakeFetch("oauth")
    result = probe_mcp(McpProbeRequest(url="https://mcp.example.com/mcp"), fetch)
    assert (result.status, result.auth, result.tools, result.auth_host, result.scope) == ("needs_oauth", "oauth", [], "auth.example.com", "openid")
    assert result.scopes_supported == ["openid", "profile.read"] and result.dynamic_registration is True
    assert all(method == "GET" or url.endswith("/mcp") for method, url, _ in fetch.calls)
    assert not any("register" in url for _, url, _ in fetch.calls)
    assert probe_mcp(McpProbeRequest(url="https://mcp.example.com/mcp"), FakeFetch("oauth", registration=False)).dynamic_registration is False


def test_probe_with_a_test_token_reads_tools_and_reports_a_rejected_token_without_echoing_it():
    request = McpProbeRequest(url="https://mcp.example.com/mcp", auth_header="X-API-Key", test_token="good-1")
    ok = probe_mcp(request, FakeFetch("bearer", token="good-1"))
    assert (ok.status, ok.auth, ok.tools) == ("ok", "bearer", ["batch_get", "batch_search"])
    rejected = probe_mcp(request.model_copy(update={"test_token": "bad-2"}), FakeFetch("bearer", token="good-1"))
    assert (rejected.status, rejected.auth, rejected.token_rejected) == ("needs_token", "bearer", True)
    assert "bad-2" not in rejected.model_dump_json()
    none = probe_mcp(McpProbeRequest(url="https://mcp.example.com/mcp"), FakeFetch("bearer", token="good-1"))
    assert (none.status, none.token_rejected) == ("needs_token", False)


def test_probe_refuses_non_https_redirects_and_blocked_addresses():
    assert probe_mcp(McpProbeRequest(url="http://mcp.example.com/mcp"), FakeFetch("open")).status == "unreachable"
    redirect = probe_mcp(McpProbeRequest(url="https://mcp.example.com/mcp"), lambda *a: (302, {"location": "https://10.0.0.1/"}, b""))
    assert (redirect.status, "重定向" in redirect.detail) == ("unreachable", True)
    for host in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "224.0.0.1", "0.0.0.0", "100.64.0.1", "192.0.2.1"):
        with pytest.raises(ProbeBlocked):
            public_addresses(host, 443)
    # The real transport refuses the loopback address before any connection.
    assert probe_mcp(McpProbeRequest(url="https://127.0.0.1/mcp")).status == "unreachable"
    assert probe_mcp(McpProbeRequest(url="https://localhost/mcp")).status == "unreachable"
