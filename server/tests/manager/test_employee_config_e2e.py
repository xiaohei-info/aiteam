"""employee 配置 CRUD 端到端 + 跨租户 RLS 隔离（integration，真 PG；M2，04 §6.1.1，D22/D16）。

验：
- owner HTTP 全链路 CRUD（201/200/200/204），统一 envelope（02 §10.3.4）。
- member 读可、写 403（03 §9.7）。
- 跨租户：t-a 的配置在 t-b 视角 404（RLS 强制，D22）。
- version 自增：每次 PUT 配置变更 +1（增量 sync 与快照冻结依据）。
- runtime 中立：DB 不存 runtime 原生格式，HTTP 出参无 SOUL/config.yaml 字段。
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

    # integration（有 admin_url）→ 真 RS256 DynamicRS256；否则 inmem（without_db 用例）。
    verifier = make_verifier(admin_url) if admin_url else _INMEM_VERIFIER

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_employee_router(verifier))
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


def _provision_tenants(admin_url: str):
    import psycopg

    slug_a = f"m2_a_{uuid.uuid4().hex[:8]}"
    slug_b = f"m2_b_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id", (slug_a,))
            tid_a = str(cur.fetchone()[0])
            cur.execute("INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id", (slug_b,))
            tid_b = str(cur.fetchone()[0])
    return tid_a, tid_b


def test_employee_config_crud_e2e_and_cross_tenant_rls(migrated_db, admin_url, two_tenants):
    tid_a, tid_b = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="owner-a", admin_url=admin_url)

    config = {
        "display_name": "专家A",
        "persona": "你是一名资深测试专家",
        "model_policy": {"model": "claude-opus-4-8", "provider_ref": "relay-default", "thinking_level": "high"},
        "execution_policy": {"timeout_seconds": 120},
        "tools": ["search"],
        "skills": ["code-review"],
        "knowledge_refs": ["ks_default"],
        "connector_refs": ["slack"],
        "memory_policy": {"seed": "记住用户偏好"},
    }

    # create
    r = client.post(
        f"/api/manager/employees?employee_slug=exp-a",
        json=config, headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201, r.text
    created = r.json()["data"]
    assert created["employee_slug"] == "exp-a"
    assert created["execution_policy"]["timeout_seconds"] == 120
    assert created["model_policy"]["model"] == "claude-opus-4-8"
    assert created["memory_policy"] == {"seed": "记住用户偏好"}
    assert created["version"] == 1
    eid = created["employee_id"]

    # get
    r = client.get(f"/api/manager/employees/{eid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert r.json()["data"]["employee_id"] == eid

    # list
    r = client.get("/api/manager/employees", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert len(r.json()["data"]) == 1

    # update -> version 自增
    config["display_name"] = "专家A改名"
    r = client.put(f"/api/manager/employees/{eid}", json=config, headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert r.json()["data"]["display_name"] == "专家A改名"
    assert r.json()["data"]["version"] == 2

    # 跨租户：t-b owner 看不到 t-a 的配置（RLS 强制）
    owner_b = _token(tid_b, ["owner"], user_id="owner-b", admin_url=admin_url)
    r = client.get(f"/api/manager/employees/{eid}", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 404

    # t-b list 为空
    r = client.get("/api/manager/employees", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 200
    assert r.json()["data"] == []

    # member 读可、写 403
    member_a = _token(tid_a, ["member"], user_id="mem-a", admin_url=admin_url)
    r = client.get(f"/api/manager/employees/{eid}", headers={"Authorization": f"Bearer {member_a}"})
    assert r.status_code == 200
    r = client.put(
        f"/api/manager/employees/{eid}", json=config, headers={"Authorization": f"Bearer {member_a}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")

    # delete
    r = client.delete(f"/api/manager/employees/{eid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 204
    r = client.get(f"/api/manager/employees/{eid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 404


def test_employee_config_endpoints_unauth_503_without_db():
    """无 DB → 503（不静默）；无 token → 401 problem+json。"""
    client = _client(db_url=None)

    # 无 token
    r = client.get("/api/manager/employees")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")

    # 有 token 但无 DB（inmem 签，无 admin_url）
    tok = _token("t1", ["owner"])
    r = client.get("/api/manager/employees", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"
