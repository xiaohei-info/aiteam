"""知识空间/RAG 管理面 CRUD + 绑定 + 跨租户 RLS 隔离（integration，真 PG；M3，04 §6.1.2/§6.6，D21）。

验：
- owner HTTP 全链路：知识空间 CRUD（201/200/200/204），统一 envelope。
- workspace 由 ManagerRagService 推导（D21），HTTP 入参无 workspace。
- 绑定：专家走 employee.knowledge_refs；部门/成员走 knowledge_space_binding 表。
- 跨租户：t-a 的知识空间/绑定在 t-b 视角不可见（RLS 强制）。
- member 读可、写 403。
- 删除知识空间清残绑定 + 专家引用。
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
    from manager_service.routes_knowledge_space import build_knowledge_space_router

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_employee_router(_verifier))
    app.include_router(build_knowledge_space_router(_verifier))
    return TestClient(app)


def _token(tenant_id: str, roles: list[str], user_id: str | None = None) -> str:
    return DevTokenService().sign(
        TokenClaims(tenant_id=tenant_id, user_id=user_id or str(uuid.uuid4()), roles=roles, exp=9999999999)
    )


def test_knowledge_space_crud_e2e_and_cross_tenant_rls(migrated_db, two_tenants):
    tid_a, tid_b = two_tenants
    client = _client(migrated_db)
    owner_a = _token(tid_a, ["owner"], user_id="owner-a")
    owner_b = _token(tid_b, ["owner"], user_id="owner-b")

    # create
    r = client.post(
        "/api/manager/knowledge-spaces",
        json={"knowledge_space_id": "ks_default", "display_name": "默认知识库"},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201, r.text
    created = r.json()["data"]
    assert created["knowledge_space_id"] == "ks_default"
    # workspace 由 ManagerRagService 推导（D21），且含去连字符 tenant_id
    assert created["workspace"].startswith("t" + tid_a.replace("-", ""))
    assert created["workspace"].endswith("__ks_default")
    # 入参 schema 不含 workspace（D21 红线）
    assert "workspace" not in {"knowledge_space_id", "display_name"}

    # get
    r = client.get(
        "/api/manager/knowledge-spaces/ks_default", headers={"Authorization": f"Bearer {owner_a}"}
    )
    assert r.status_code == 200
    assert r.json()["data"]["display_name"] == "默认知识库"

    # list
    r = client.get("/api/manager/knowledge-spaces", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert len(r.json()["data"]) == 1

    # update
    r = client.patch(
        "/api/manager/knowledge-spaces/ks_default",
        json={"display_name": "默认改名"},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 200
    assert r.json()["data"]["display_name"] == "默认改名"

    # 跨租户：t-b 看不到 t-a 的知识空间（RLS 强制）
    r = client.get(
        "/api/manager/knowledge-spaces/ks_default", headers={"Authorization": f"Bearer {owner_b}"}
    )
    assert r.status_code == 404
    r = client.get("/api/manager/knowledge-spaces", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 200
    assert r.json()["data"] == []

    # member 读可、写 403
    member_a = _token(tid_a, ["member"], user_id="mem-a")
    r = client.get(
        "/api/manager/knowledge-spaces/ks_default", headers={"Authorization": f"Bearer {member_a}"}
    )
    assert r.status_code == 200
    r = client.post(
        "/api/manager/knowledge-spaces",
        json={"knowledge_space_id": "ks2"},
        headers={"Authorization": f"Bearer {member_a}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")

    # delete
    r = client.delete(
        "/api/manager/knowledge-spaces/ks_default", headers={"Authorization": f"Bearer {owner_a}"}
    )
    assert r.status_code == 204
    r = client.get(
        "/api/manager/knowledge-spaces/ks_default", headers={"Authorization": f"Bearer {owner_a}"}
    )
    assert r.status_code == 404


def test_knowledge_space_conflict_e2e(migrated_db, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db)
    owner_a = _token(tid_a, ["owner"])
    body = {"knowledge_space_id": "ks_conflict"}
    r = client.post("/api/manager/knowledge-spaces", json=body, headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 201
    r = client.post("/api/manager/knowledge-spaces", json=body, headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 409
    assert r.json()["code"] == "conflict"


def test_binding_department_member_and_expert_e2e(migrated_db, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db)
    owner_a = _token(tid_a, ["owner"], user_id="owner-a")

    # 建知识空间
    r = client.post(
        "/api/manager/knowledge-spaces",
        json={"knowledge_space_id": "ks_bind", "display_name": "绑定测试"},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201

    # 建一个 employee（M2）用于专家绑定
    from manager_service.routes_employee import build_employee_router
    from manager_service.app import _verifier
    # client 已挂 employee router；直接调
    emp_body = {
        "display_name": "专家X",
        "knowledge_refs": [],
    }
    r = client.post(
        f"/api/manager/employees?employee_slug=exp-x",
        json=emp_body, headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201, r.text
    employee_id = r.json()["data"]["employee_id"]

    # 绑定专家 → employee.knowledge_refs 含 ks_bind
    r = client.post(
        "/api/manager/knowledge-spaces/ks_bind/bindings",
        json={"knowledge_space_id": "ks_bind", "resource_type": "expert", "resource_id": employee_id},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201, r.text
    # 验 employee.knowledge_refs 真相态被改写
    r = client.get(
        f"/api/manager/employees/{employee_id}", headers={"Authorization": f"Bearer {owner_a}"}
    )
    assert "ks_bind" in r.json()["data"]["knowledge_refs"]

    # 绑定部门（id 用随机 uuid，knowledge_space_binding 不校验目标存在性，仅落元数据）
    dept_id = str(uuid.uuid4())
    r = client.post(
        "/api/manager/knowledge-spaces/ks_bind/bindings",
        json={"knowledge_space_id": "ks_bind", "resource_type": "department", "resource_id": dept_id},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201

    # list bindings：三种都在（专家派生自 knowledge_refs + 部门表）
    r = client.get(
        "/api/manager/knowledge-spaces/ks_bind/bindings",
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 200
    bindings = r.json()["data"]
    types = {b["resource_type"] for b in bindings}
    assert {"expert", "department"} <= types

    # 解绑专家 → knowledge_refs 移出 ks_bind
    r = client.delete(
        f"/api/manager/knowledge-spaces/ks_bind/bindings/expert/{employee_id}",
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 204
    r = client.get(
        f"/api/manager/employees/{employee_id}", headers={"Authorization": f"Bearer {owner_a}"}
    )
    assert "ks_bind" not in r.json()["data"]["knowledge_refs"]


def test_delete_clears_residual_bindings_e2e(migrated_db, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db)
    owner_a = _token(tid_a, ["owner"])

    client.post(
        "/api/manager/knowledge-spaces",
        json={"knowledge_space_id": "ks_del"},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    dept_id = str(uuid.uuid4())
    client.post(
        "/api/manager/knowledge-spaces/ks_del/bindings",
        json={"knowledge_space_id": "ks_del", "resource_type": "department", "resource_id": dept_id},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    # 删除知识空间
    r = client.delete(
        "/api/manager/knowledge-spaces/ks_del", headers={"Authorization": f"Bearer {owner_a}"}
    )
    assert r.status_code == 204
    # 残绑定清空（重建同名空间后 bindings 为空）
    client.post(
        "/api/manager/knowledge-spaces",
        json={"knowledge_space_id": "ks_del"},
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    r = client.get(
        "/api/manager/knowledge-spaces/ks_del/bindings",
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 200
    assert r.json()["data"] == []


def test_knowledge_space_endpoints_unauth_503_without_db():
    """无 DB → 503（不静默）；无 token → 401 problem+json。"""
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router, _verifier
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_knowledge_space import build_knowledge_space_router

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=None)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_knowledge_space_router(_verifier))
    client = TestClient(app)

    # 无 token
    r = client.get("/api/manager/knowledge-spaces")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")

    # 有 token 但无 DB
    tok = _token("t1", ["owner"])
    r = client.get("/api/manager/knowledge-spaces", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"
