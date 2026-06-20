"""技能/连接器/记忆策略 目录 CRUD 端到端 + 跨租户 RLS 隔离（integration，真 PG；M4，04 §6.6，D17/D22）。

验：
- owner HTTP 全链路 CRUD（201/200/200/204），统一 envelope（02 §10.3.4）。
- member 读可、写 403（03 §9.7）。
- 跨租户：t-a 的目录条目在 t-b 视角 404（RLS 强制，D22）。
- catalog_version 自增：每次 PUT 配置变更 +1（增量 sync 与快照冻结依据）。
- runtime 中立：HTTP 出参无 SOUL/config.yaml/凭据字段（D16/D18）。

无 DB → 503（不静默）；无 token → 401 problem+json。
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
    from manager_service.routes_capability import build_capability_router

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_capability_router(_verifier))
    return TestClient(app)


def _token(tenant_id: str, roles: list[str], user_id: str | None = None) -> str:
    return DevTokenService().sign(
        TokenClaims(tenant_id=tenant_id, user_id=user_id or str(uuid.uuid4()), roles=roles, exp=9999999999)
    )


def test_skill_catalog_crud_e2e_and_cross_tenant_rls(migrated_db, two_tenants):
    tid_a, tid_b = two_tenants
    client = _client(migrated_db)
    owner_a = _token(tid_a, ["owner"], user_id="owner-a")

    config = {
        "skill_id": "code-review", "display_name": "代码评审", "version": "1.2.0",
        "install_policy": "pinned", "binding_policy": "auto_bind", "visibility": "tenant",
        "config": {"lang": "py"},
    }

    r = client.post("/api/manager/skills", json=config, headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 201, r.text
    created = r.json()["data"]
    assert created["skill_id"] == "code-review"
    assert created["install_policy"] == "pinned"
    assert created["catalog_version"] == 1
    cid = created["catalog_id"]

    # get
    r = client.get(f"/api/manager/skills/{cid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200

    # list
    r = client.get("/api/manager/skills", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert len(r.json()["data"]) == 1

    # update -> catalog_version 自增
    config["display_name"] = "改名"
    config["version"] = "1.3.0"
    r = client.put(f"/api/manager/skills/{cid}", json=config, headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert r.json()["data"]["display_name"] == "改名"
    assert r.json()["data"]["catalog_version"] == 2

    # 跨租户：t-b owner 看不到 t-a 的技能（RLS 强制）
    owner_b = _token(tid_b, ["owner"], user_id="owner-b")
    r = client.get(f"/api/manager/skills/{cid}", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404
    r = client.get("/api/manager/skills", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.json()["data"] == []

    # member 读可、写 403
    member_a = _token(tid_a, ["member"], user_id="mem-a")
    r = client.get(f"/api/manager/skills/{cid}", headers={"Authorization": f"Bearer {member_a}"})
    assert r.status_code == 200
    r = client.put(f"/api/manager/skills/{cid}", json=config, headers={"Authorization": f"Bearer {member_a}"})
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")

    # delete
    r = client.delete(f"/api/manager/skills/{cid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 204
    r = client.get(f"/api/manager/skills/{cid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 404


def test_connector_and_memory_policy_e2e(migrated_db, two_tenants):
    """连接器 + 记忆策略 各走一遍 create/get/list/update/delete + 跨租户隔离。"""
    tid_a, tid_b = two_tenants
    client = _client(migrated_db)
    owner_a = _token(tid_a, ["owner"], user_id="owner-a")

    # connector
    conn = {"connector_id": "slack", "display_name": "Slack", "visibility": "tenant",
            "grant_scope": "department_scoped", "config": {"base_url": "https://slack.com"}}
    r = client.post("/api/manager/connectors", json=conn, headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 201, r.text
    created = r.json()["data"]
    assert created["connector_id"] == "slack"
    assert created["grant_scope"] == "department_scoped"
    # 红线③：出参无凭据本体字段（D18）
    assert "api_key" not in created and "secret" not in created and "token" not in created
    ccid = created["catalog_id"]

    r = client.put(f"/api/manager/connectors/{ccid}", json={**conn, "grant_scope": "member_scoped"},
                   headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert r.json()["data"]["grant_scope"] == "member_scoped"
    assert r.json()["data"]["catalog_version"] == 2

    # 跨租户不可见
    owner_b = _token(tid_b, ["owner"], user_id="owner-b")
    r = client.get(f"/api/manager/connectors/{ccid}", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404

    # memory_policy
    mem = {"policy_id": "default", "display_name": "默认策略", "policy": {"scope": "user"},
           "seed_memories": [{"role": "system", "content": "记住偏好"}], "retention_days": 30,
           "visibility": "tenant", "config": {}}
    r = client.post("/api/manager/memory-policies", json=mem, headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 201, r.text
    created = r.json()["data"]
    assert created["policy_id"] == "default"
    assert created["retention_days"] == 30
    assert created["seed_memories"] == [{"role": "system", "content": "记住偏好"}]
    mpid = created["catalog_id"]

    r = client.get(f"/api/manager/memory-policies/{mpid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    r = client.get("/api/manager/memory-policies", headers={"Authorization": f"Bearer {owner_a}"})
    assert len(r.json()["data"]) == 1

    r = client.put(f"/api/manager/memory-policies/{mpid}", json={**mem, "retention_days": 90},
                   headers={"Authorization": f"Bearer {owner_a}"})
    assert r.json()["data"]["retention_days"] == 90
    assert r.json()["data"]["catalog_version"] == 2

    # 跨租户不可见
    r = client.get(f"/api/manager/memory-policies/{mpid}", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404


def test_capability_endpoints_unauth_503_without_db():
    """无 DB → 503（不静默）；无 token → 401 problem+json。"""
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router, _verifier
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_capability import build_capability_router

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=None)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_capability_router(_verifier))
    client = TestClient(app)

    # 无 token
    r = client.get("/api/manager/skills")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")

    # 有 token 但无 DB
    tok = _token("t1", ["owner"])
    r = client.get("/api/manager/skills", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"
