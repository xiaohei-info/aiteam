"""provider 凭据/AI Relay 管理面端到端 + 跨租户 RLS 隔离（integration，真 PG；M5，04 §6.7，D18/D22）。

验：
- owner HTTP 全链路 CRUD（201/200/200/204），统一 envelope（02 §10.3.4）。
- 明文加密存储：DB 列为 bytea 密文，HTTP 响应无明文/无密文（红线断言）。
- 能力目录：supported_models / model_catalog_source 全链路透传；更新 supported_models 后 version 递增。
- member 读可、写 403（03 §9.7）。
- 跨租户：t-a 的凭据在 t-b 视角 404（RLS 强制，D22）。
- version 自增：每次 PUT 配置变更 +1。
"""

import uuid

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import (
    make_inmem_verifier_and_signer,
    make_verifier,
    sign_inmem_token,
    sign_token,
)

pytestmark = pytest.mark.integration

# 无 admin_url（如 without_db 用例） fallback 用固定 RSA key 的 inmem verifier/signer。
_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()


def _client(db_url: str, admin_url: str | None = None) -> TestClient:
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_provider import build_provider_credential_router

    verifier = make_verifier(admin_url) if admin_url else _INMEM_VERIFIER

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_employee_router(verifier))
    app.include_router(build_provider_credential_router(verifier))
    return TestClient(app)


def _token(
    tenant_id: str,
    roles: list[str],
    user_id: str | None = None,
    *,
    admin_url: str | None = None,
) -> str:
    uid = user_id or str(uuid.uuid4())
    if admin_url:
        return sign_token(admin_url, tenant_id, roles, user_id=uid)
    return sign_inmem_token(_INMEM_SIGNER, tenant_id, roles, user_id=uid)


_PLAINTEXT_SECRET = "sk-relay-integration-超机密-9876543210"

_DEFAULT_MODELS = [
    {"model": "gpt-4o", "display_name": "GPT-4o", "enabled": True, "capabilities": {"context_window": 128000}},
    {"model": "claude-3-5-sonnet", "display_name": "", "enabled": True, "capabilities": {}},
]


def test_provider_credential_crud_e2e_and_cross_tenant_rls(
    migrated_db, admin_url, two_tenants
):
    tid_a, tid_b = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="owner-a", admin_url=admin_url)

    config = {
        "provider_ref": "relay-default",
        "display_name": "默认 AI Relay",
        "endpoint": "https://relay.example.local/v1",
        "visibility": "tenant",
        "secret": _PLAINTEXT_SECRET,
        "supported_models": _DEFAULT_MODELS,
        "model_catalog_source": "manual",
    }

    # create
    r = client.post(
        "/api/manager/provider-credentials",
        json=config, headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201, r.text
    created = r.json()["data"]
    assert created["provider_ref"] == "relay-default"
    assert created["version"] == 1
    # 能力目录透传
    assert len(created["supported_models"]) == 2
    assert created["supported_models"][0]["model"] == "gpt-4o"
    assert created["supported_models"][0]["capabilities"] == {"context_window": 128000}
    assert created["model_catalog_source"] == "manual"
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
                "SELECT encrypted_secret, supported_models FROM provider_credential WHERE id = %s", (cid,)
            )
            db_secret, db_models = cur.fetchone()
    db_secret = bytes(db_secret)
    assert db_secret != _PLAINTEXT_SECRET.encode()
    assert _PLAINTEXT_SECRET not in db_secret.decode("utf-8", errors="ignore")
    assert len(db_models) == 2
    assert db_models[0]["model"] == "gpt-4o"

    # get
    r = client.get(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    got = r.json()["data"]
    assert len(got["supported_models"]) == 2
    assert got["model_catalog_source"] == "manual"
    assert _PLAINTEXT_SECRET not in r.text

    # list
    r = client.get("/api/manager/provider-credentials", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    items = r.json()["data"]
    assert len(items) == 1
    assert len(items[0]["supported_models"]) == 2
    assert "encrypted_secret" not in items[0]
    assert _PLAINTEXT_SECRET not in r.text

    # update supported_models -> version 应自增（触发器 BEFORE UPDATE OF 含 supported_models）
    update_body = {
        "display_name": "改名",
        "endpoint": "https://api.openai.example/v1",
        "visibility": "tenant",
        "secret": "sk-new-plain-int-777",
        "supported_models": [
            {"model": "gpt-4o-mini", "display_name": "GPT-4o mini", "enabled": True, "capabilities": {}},
        ],
        "model_catalog_source": "manual",
    }
    r = client.put(
        f"/api/manager/provider-credentials/{cid}",
        json=update_body, headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 200
    updated = r.json()["data"]
    assert updated["display_name"] == "改名"
    assert updated["version"] == 2
    assert len(updated["supported_models"]) == 1
    assert updated["supported_models"][0]["model"] == "gpt-4o-mini"
    assert "sk-new-plain-int-777" not in r.text

    # 跨租户：t-b owner 看不到 t-a 的凭据（RLS 强制）
    owner_b = _token(tid_b, ["owner"], user_id="owner-b", admin_url=admin_url)
    r = client.get(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404

    # member 读可、写 403
    member_a = _token(tid_a, ["member"], user_id="mem-a", admin_url=admin_url)
    r = client.get(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {member_a}"})
    assert r.status_code == 200
    r = client.put(
        f"/api/manager/provider-credentials/{cid}",
        json=update_body, headers={"Authorization": f"Bearer {member_a}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")

    # delete
    r = client.delete(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 204
    r = client.get(f"/api/manager/provider-credentials/{cid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 404


def test_manager_provider_truth_routes_are_removed_but_runtime_route_stays_protected():
    client = _client(db_url=None)
    assert client.get("/api/manager/provider-credentials").status_code == 404

    path = "/api/manager/provider-credentials/runtime-config"
    r = client.post(path, json={"employee_id": "e1"})
    assert r.status_code == 401
    tok = _token("t1", ["owner"])
    r = client.post(path, json={"employee_id": "e1"}, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"
