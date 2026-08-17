"""三端 FastAPI 壳验收（C0.1）：健康/就绪/OpenAPI/envelope/受保护端点 401（Phase 1 验收口径）。"""

import pytest
from fastapi.testclient import TestClient

from run import get_app
TIERS = ["operation", "manager"]


@pytest.fixture(params=TIERS)
def tier(request):
    return request.param


@pytest.fixture
def client(tier):
    return TestClient(get_app(tier))


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_readyz(client):
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"


def test_openapi_and_docs(client, tier):
    spec = client.get("/openapi.json")
    assert spec.status_code == 200
    assert f"/api/{tier}/ping" in spec.json()["paths"]
    assert client.get("/docs").status_code == 200
    assert client.get("/redoc").status_code == 200


def test_ping_envelope(client, tier):
    r = client.get(f"/api/{tier}/ping")
    assert r.status_code == 200
    assert r.json() == {"data": {"pong": True}, "meta": None}


def test_request_id_header_present(client):
    r = client.get("/healthz")
    assert r.headers.get("X-Request-ID")


def test_protected_endpoint_401_problem_json(client, tier):
    r = client.get(f"/api/{tier}/whoami")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["code"] == "unauthorized"
    assert body["status"] == 401


def test_operation_whoami_with_system_token():
    """operation whoami 200（缺口2）：用系统账号登录拿真实 RS256 token 打 whoami。"""
    client = TestClient(get_app("operation"))
    r = client.post(
        "/api/operation/auth/login",
        json={"username": "sysadmin", "password": "changeme-me"},
    )
    assert r.status_code == 200, r.text
    token = r.json()["data"]["token"]
    r = client.get("/api/operation/whoami", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["data"]["user_id"] == "sysadmin"
