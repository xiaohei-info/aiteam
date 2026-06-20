"""provider 凭据/AI Relay 管理面端到端 + 跨租户 RLS 隔离（integration，真 PG；M5，04 §6.7，D18/D22）。

验：
- owner HTTP 全链路 CRUD（201/200/200/204），统一 envelope（02 §10.3.4）。
- 明文加密存储：DB 列为 bytea 密文，HTTP 响应无明文/无密文（红线断言）。
- member 读可、写 403（03 §9.7）。
- 跨租户：t-a 的凭据在 t-b 视角 404（RLS 强制，D22）。
- version 自增：每次 PUT 配置变更 +1。
"""

import uuid

import pytest
from fastapi.testclient import TestClient

from shared.auth import DevTokenService
from shared.config import Settings
from shared.contracts.auth import TokenClaims

pytestmark = pytest.mark.integration


def _client(db_url: str) -> TestClient:
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router, _verifier
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_provider import build_provider_credential_router

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_employee_router(_verifier))
    app.include_router(build_provider_credential_router(_verifier))
    return TestClient(app)


def _token(tenant_id: str, roles: list[str], user_id: str | None = None) -> str:
    return DevTokenService().sign(
        TokenClaims(tenant_id=tenant_id, user_id=user_id or str(uuid.uuid4()), roles=roles, exp=9999999999)
    )


_PLAINTEXT_SECRET = "sk-relay-integration-超机密-9876543210"


def test_provider_credential_crud_e2e_and_cross_tenant_rls(
    migrated_db, admin_url, two_tenants
):
    tid_a, tid_b = two_tenants
    client = _client(migrated_db)
    owner_a = _token(tid_a, ["owner"], user_id="owner-a")

    config = {
        "provider_ref": "relay-default",
        "display_name": "默认 AI Relay",
        "mode": "relay",
        "endpoint": "https://relay.example.local/v1",
        "visibility": "tenant",
        "secret": _PLAINTEXT_SECRET,
    }

    # create
    r = client.post(
        "/api/manager/provider-credentials",
        json=config, headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201, r.text
    created = r.json()["data"]
    assert created["provider_ref"] == "relay-default"
    assert created["mode"] == "relay"
    assert created["version"] == 1
    # 红线：响应无明文/密文
    assert "secret" not in created
    assert "encrypted_secret" not in created
    assert _PLAINTEXT_SECRET not in r.text
    cid = created["credential_id"]

    # DB 列是密文（非明文）：直接查管理连接验
    import psycopg
    with psycopg.connect(admin_url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT encrypted_secret FROM provider_credential WHERE id = %s", (cid,)
            )
            db_secret = bytes(cur.fetchone()[0])
    assert db_secret != _PLAINTEXT_SECRET.encode()
    assert _PLAINTEXT_SECRET not in db_secret.decode("utf-8", errors="ignore")

    # get
    r = client.get(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert _PLAINTEXT_SECRET not in r.text

    # list
    r = client.get("/api/manager/provider-credentials", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert len(r.json()["data"]) == 1
    assert _PLAINTEXT_SECRET not in r.text

    # update -> version 自增
    config.update({
        "display_name": "改名",
        "mode": "direct",
        "endpoint": "https://api.openai.example/v1",
        "visibility": "tenant",
        "secret": "sk-new-plain-int-777",
    })
    r = client.put(
        f"/api/manager/provider-credentials/{cid}",
        json=config, headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 200
    assert r.json()["data"]["display_name"] == "改名"
    assert r.json()["data"]["version"] == 2
    assert "sk-new-plain-int-777" not in r.text

    # 跨租户：t-b owner 看不到 t-a 的凭据（RLS 强制）
    owner_b = _token(tid_b, ["owner"], user_id="owner-b")
    r = client.get(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404

    # member 读可、写 403
    member_a = _token(tid_a, ["member"], user_id="mem-a")
    r = client.get(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {member_a}"})
    assert r.status_code == 200
    r = client.put(
        f"/api/manager/provider-credentials/{cid}",
        json=config, headers={"Authorization": f"Bearer {member_a}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")

    # delete
    r = client.delete(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 204
    r = client.get(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 404


def test_provider_credential_endpoints_unauth_503_without_db():
    """无 DB → 503（不静默）；无 token → 401 problem+json。"""
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router, _verifier
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_provider import build_provider_credential_router

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=None)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_provider_credential_router(_verifier))
    client = TestClient(app)

    # 无 token
    r = client.get("/api/manager/provider-credentials")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")

    # 有 token 但无 DB
    tok = _token("t1", ["owner"])
    r = client.get("/api/manager/provider-credentials", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"
