"""执行快照生成端到端（HTTP）+ 成员级授权 + 跨租户 RLS 隔离（M7，05 F11/F16 / 04 §6.2/§6.3，D5/D22）。

非 integration（不依赖 PG）：无 token → 401；有 token 但无 DB → 503（problem+json）；
member_id 与 token 主体不一致 → 403。
integration（真 PG）：
- owner 建配置 → 自拉快照（200 + envelope + 字段映射 + 幂等，管理角色豁免 grant）。
- 已 grant 的 member 拉 → 200；未 grant 的 member 拉 → 403（problem+json）。
- 跨租户 RLS → 404；不存在 employee → 404。
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

# 无 DB 非集成测试用固定 RSA key 的 inmem verifier/signer（与 app 真实 DynamicRS256 同源逻辑）。
_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()


def _client(db_url: str | None, admin_url: str | None = None) -> TestClient:
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_snapshot import build_snapshot_router

    # 有 admin_url（integration）→ 真 RS256 DynamicRS256（TenantKeyStore 闭环）；
    # 无 admin_url（非 integration）→ inmem 固定 key verifier。
    verifier = make_verifier(admin_url) if admin_url else _INMEM_VERIFIER

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url=db_url)
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_employee_router(verifier))
    app.include_router(build_snapshot_router(verifier))
    return TestClient(app)


def _token(
    tenant_id: str,
    roles: list[str],
    user_id: str,
    *,
    admin_url: str | None = None,
) -> str:
    # integration（有 admin_url）→ TenantKeyStore 签真 RS256；否则 inmem 签。
    if admin_url:
        return sign_token(admin_url, tenant_id, roles, user_id=user_id)
    return sign_inmem_token(_INMEM_SIGNER, tenant_id, roles, user_id=user_id)


# ---- 非 integration：401 / 503 / member_id 不匹配 403 ----


def test_snapshot_endpoint_unauth_401_and_503_without_db():
    client = _client(db_url=None)

    # 无 token → 401
    r = client.post("/api/manager/snapshots", json={"tenant_id": "t1", "member_id": "m1", "employee_id": "e1"})
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")

    # 有 token 但 member_id != token 主体 → 403（在打 DB 前就拦）
    tok = _token("t1", ["owner"], user_id="real-user")
    r = client.post(
        "/api/manager/snapshots",
        json={"tenant_id": "t1", "member_id": "someone-else", "employee_id": "e1"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")

    # member_id 匹配但无 DB → 503
    r = client.post(
        "/api/manager/snapshots",
        json={"tenant_id": "t1", "member_id": "real-user", "employee_id": "e1"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


# ---- integration：真 PG 全链路 ----


def _create_employee(client: TestClient, token: str, slug: str) -> dict:
    config = {
        "display_name": "专家A",
        "persona": "你是一名资深测试专家",
        "model_policy": {"model": "claude-opus-4-8", "provider_ref": "relay-default", "thinking_level": "high"},
        "runtime_policy": {"runtime_binding": "hermes_acp", "timeout_seconds": 120},
        "tools": ["search"],
        "skills": ["code-review"],
        "knowledge_refs": ["ks_default"],
        "connector_refs": ["slack"],
        "memory_policy": {"seed": "记住用户偏好"},
    }
    r = client.post(
        f"/api/manager/employees?employee_slug={slug}",
        json=config, headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 201, r.text
    return r.json()["data"]


def _member_services(dsn: str, admin_dsn: str):
    """成员/部门/授权 service（用真 grant 建数据；签名私钥走 admin，业务走 app_rw）。"""
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service

    auth = build_auth_service(dsn, admin_dsn=admin_dsn)
    return build_member_dept_service(dsn, auth=auth)


@pytest.mark.integration
def test_snapshot_generate_e2e_grant_and_cross_tenant_rls(migrated_db, admin_url, two_tenants):
    from shared.contracts.enums import EnterpriseRole
    from shared.contracts.tenancy import TenantContext
    from shared.db import PgTenantRouter
    from manager_service.schemas import MemberCreate, MemberGrantCreate

    tid_a, tid_b = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    member_svc, grant_svc = _member_services(migrated_db, admin_url)

    # owner 建配置（owner 用真 app_user id：先建一个 owner 成员，token 主体须 == member_id）
    ctx_a = TenantContext(tenant_id=tid_a, user_id=str(uuid.uuid4()), roles=["owner"])
    owner = member_svc.create_member(ctx_a, MemberCreate(
        account=f"owner_{uuid.uuid4().hex[:8]}", initial_password="pw123456",
        display_name="owner", roles=[EnterpriseRole.OWNER],
    ))
    owner_tok = _token(tid_a, ["owner"], user_id=owner.id, admin_url=admin_url)
    created = _create_employee(client, owner_tok, "exp-a")
    eid = created["employee_id"]

    # owner 自拉快照（管理角色豁免 grant）→ 200 + 字段映射
    r = client.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid_a, "member_id": owner.id, "employee_id": eid},
        headers={"Authorization": f"Bearer {owner_tok}"},
    )
    assert r.status_code == 200, r.text
    snap = r.json()["data"]["snapshot"]
    assert snap["employee_id"] == eid
    assert snap["version"] == "1"
    assert snap["display_name"] == "专家A"
    assert snap["model_policy"]["model"] == "claude-opus-4-8"
    assert snap["runtime_policy"]["runtime_binding"] == "hermes_acp"
    assert snap["memory_policy"] == {"seed": "记住用户偏好"}
    assert snap["snapshot_version"]

    # 幂等：再拉一次得同 snapshot_version
    r2 = client.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid_a, "member_id": owner.id, "employee_id": eid},
        headers={"Authorization": f"Bearer {owner_tok}"},
    )
    assert r2.status_code == 200
    assert r2.json()["data"]["snapshot"]["snapshot_version"] == snap["snapshot_version"]

    # 建两个成员：granted（授权该专家）/ ungranted（未授权）
    granted = member_svc.create_member(ctx_a, MemberCreate(
        account=f"g_{uuid.uuid4().hex[:8]}", initial_password="pw123456",
        display_name="granted", roles=[EnterpriseRole.MEMBER],
    ))
    ungranted = member_svc.create_member(ctx_a, MemberCreate(
        account=f"u_{uuid.uuid4().hex[:8]}", initial_password="pw123456",
        display_name="ungranted", roles=[EnterpriseRole.MEMBER],
    ))
    grant_svc.create_grant(ctx_a, MemberGrantCreate(
        resource_type="expert", resource_id=eid, department_ids=[], member_ids=[granted.id],
    ))

    # 已 grant 的 member 拉 → 200
    granted_tok = _token(tid_a, ["member"], user_id=granted.id, admin_url=admin_url)
    r = client.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid_a, "member_id": granted.id, "employee_id": eid},
        headers={"Authorization": f"Bearer {granted_tok}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["snapshot"]["employee_id"] == eid

    # 未 grant 的 member 拉 → 403（problem+json）
    ungranted_tok = _token(tid_a, ["member"], user_id=ungranted.id, admin_url=admin_url)
    r = client.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid_a, "member_id": ungranted.id, "employee_id": eid},
        headers={"Authorization": f"Bearer {ungranted_tok}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")

    # 越权 403 → 落一条 enterprise_audit（05 F16）：actor=越权 member，resource=该专家，不含配置内容。
    from manager_service.enterprise_audit_repository import build_enterprise_audit_repository
    audit_repo = build_enterprise_audit_repository(PgTenantRouter(migrated_db))
    audits = audit_repo.list_all(TenantContext(tenant_id=tid_a, user_id=ungranted.id, roles=["member"]))
    denied = [a for a in audits if a.action == "snapshot_pull_denied" and a.actor == ungranted.id]
    assert len(denied) == 1, f"越权应记一条审计，实际 {len(denied)}"
    assert denied[0].resource_type == "expert"
    assert denied[0].resource_id == eid
    # 红线：审计行不含执行配置内容（D13）。
    assert "专家A" not in (denied[0].detail or "")
    assert "claude-opus" not in (denied[0].detail or "")

    # 跨租户：t-b owner 拉 t-a 的 employee 快照 → RLS 不可见 → 404
    ctx_b = TenantContext(tenant_id=tid_b, user_id=str(uuid.uuid4()), roles=["owner"])
    owner_b = member_svc.create_member(ctx_b, MemberCreate(
        account=f"ownerb_{uuid.uuid4().hex[:8]}", initial_password="pw123456",
        display_name="owner-b", roles=[EnterpriseRole.OWNER],
    ))
    owner_b_tok = _token(tid_b, ["owner"], user_id=owner_b.id, admin_url=admin_url)
    r = client.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid_b, "member_id": owner_b.id, "employee_id": eid},
        headers={"Authorization": f"Bearer {owner_b_tok}"},
    )
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")

    # 不存在的 employee → 404（管理角色豁免 grant，命中配置缺失）
    r = client.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid_a, "member_id": owner.id, "employee_id": str(uuid.uuid4())},
        headers={"Authorization": f"Bearer {owner_tok}"},
    )
    assert r.status_code == 404
