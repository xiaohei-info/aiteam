"""Operator platform MCP catalog routes (design §11.3)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from run import get_app
from shared.contracts.platform_mcp import PlatformMcpServer, PlatformMcpServerFields
from shared.errors import Conflict, NotFound
from tests.operation.auth_helpers import operation_test_token


class FakeMcpRepo:
    def __init__(self):
        self.items: dict[str, PlatformMcpServer] = {}

    def list(self, *, status=None):
        return [item for item in self.items.values() if status is None or item.status == status]

    def create(self, body: PlatformMcpServerFields):
        if any(item.ref == body.ref for item in self.items.values()):
            raise Conflict("dup")
        item = PlatformMcpServer(**body.model_dump(), server_id=f"s{len(self.items) + 1}", revision=1, status="draft")
        self.items[item.server_id] = item
        return item

    def update(self, server_id, body: PlatformMcpServerFields):
        current = self.items.get(server_id)
        if current is None:
            raise NotFound("missing")
        if current.ref != body.ref:
            raise Conflict("ref immutable")
        item = current.model_copy(update={**body.model_dump(), "revision": current.revision + 1})
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
    "url": "https://mcp.example.com/mes", "tools": ["batch_get", "batch_search"], "requires_credentials": False,
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
