"""闭环 B 负向矩阵测试：未授权/越权/跨租户拒绝 + 审计证据。

验证：
- **未授权成员不可见**：未 grant 的 member 拉 expert → 不可见（优先级高于已授权可见）。
- **越权拉快照 → 403 + 审计**：Snapshot 成员级授权 enforcement（F16）。
  非 owner/enterprise_admin 且无 member_grant 的成员拉 expert 快照 → 403 problem+json，
  且 Manager 侧审计 enterprise_audit（snapshot_pull_denied）已落库。
- **跨租户不可见**：tenant A 的 employee 快照/授权配置，tenant B HTTP 拿不到（RLS 拒绝 → 404）。
- **member_id != token 主体 → 403**：F10/F11 禁止代他人 pull（03 §9.7）。
- **body.tenant_id != token claims.tenant_id → 403**：跨端契约自洽。

标记: integration + 函数名含 negative。真 PG + RLS + RS256。"""

from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.service_client import ServiceClient
from tests.manager._auth_helper import sign_token, make_verifier


# ── helpers ──


def _register_tenant(pg_admin_url: str, prefix: str) -> str:
    import psycopg
    from shared.db import apply_migrations
    apply_migrations(pg_admin_url, app_rw_password="apprwpass")
    slug = f"{prefix}_{uuid.uuid4().hex[:6]}"
    with psycopg.connect(pg_admin_url, autocommit=True) as conn:
        return str(
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug,),
            ).fetchone()[0]
        )


def _build_manager_app(db_url: str, admin_url: str) -> TestClient:
    from manager_service.app import router as mgr_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_snapshot import build_snapshot_router
    from manager_service.routes_member import router as member_router
    from manager_service.routes_grants import router as grants_router
    from shared.app_factory import create_app

    verifier = make_verifier(admin_url)
    app = create_app(
        Settings(tier="manager", service_name="aiteam-manager-service",
                 db_url=db_url, admin_db_url=admin_url),
        mgr_router,
    )
    app.state._token_verifier = verifier
    app.include_router(auth_router)
    app.include_router(build_employee_router(verifier))
    app.include_router(member_router)
    app.include_router(grants_router)
    app.include_router(build_snapshot_router(verifier))
    return TestClient(app)


def _create_member(msvc, ctx, phone, display_name, roles, *, must_reset=False):
    from manager_service.schemas import MemberCreate
    return msvc.create_member(ctx, MemberCreate(
        account=phone, initial_password="pw123456", display_name=display_name,
        roles=roles, must_reset=must_reset,
    ))


def _create_employee(esvc, ctx, slug, display_name="专家"):
    from manager_service.schemas import EmployeeConfigIn
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    return esvc.create(ctx, EmployeeConfigIn(
        display_name=display_name, model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy(),
    ), employee_slug=slug)


# ── 未授权 member 不可见：未 grant 成员 pull → 空集 ──


@pytest.mark.integration
def test_negative_ungranted_member_sees_no_experts(
    migrated_pg, pg_admin_url,
):
    """negative：未 grant 的 member 拉 authorized-config → experts 应为空。

    验证：未授权成员不可见的优先级高于"已授权可见"（空集 ≠ 全量）。真 PG + RS256。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole

    tid = _register_tenant(pg_admin_url, "ent_neg1")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx_f(tid, ["owner"])
    from manager_service.employee_config_service import build_employee_config_service

    owner_mem = _create_member(msvc, ctx, f"138{uuid.uuid4().hex[:8]}", "owner", [EnterpriseRole.OWNER])
    ungranted = _create_member(msvc, ctx, f"139{uuid.uuid4().hex[:8]}", "ug", [EnterpriseRole.MEMBER])
    esvc = build_employee_config_service(router)
    e = _create_employee(esvc, ctx, "exp-neg1")
    # 不建 grant → ungranted 不应看到
    mgr = _build_manager_app(migrated_pg, pg_admin_url)

    # HTTP direct: ungranted member pull authorized-config → experts 应为空
    ug_tok = sign_token(pg_admin_url, tid, ["member"], user_id=ungranted.id)
    r = mgr.post(
        "/api/manager/grants/authorized-config",
        json={"tenant_id": tid, "member_id": ungranted.id},
        headers={"Authorization": f"Bearer {ug_tok}"},
    )
    assert r.status_code == 200, r.text
    experts = r.json()["data"]["experts"]
    assert experts == [], f"未 grant 成员不应看见任何 expert，实际: {[x['employee_id'] for x in experts]}"


# ── 越权拉快照 → 403 + audit（F16）──


@pytest.mark.integration
def test_negative_snapshot_unauthorized_member_403_and_audit_recorded(
    migrated_pg, pg_admin_url,
):
    """negative：未授权 member 拉 snapshot → 403 + enterprise_audit（snapshot_pull_denied）已落库。

    F16 越权审计红线（D13）：审计不含会话/配置内容字段。真 PG + RLS + RS256。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from shared.contracts.tenancy import TenantContext

    tid = _register_tenant(pg_admin_url, "ent_neg2")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx_f(tid, ["owner"])
    from manager_service.employee_config_service import build_employee_config_service

    esvc = build_employee_config_service(router)
    e = _create_employee(esvc, ctx, "exp-neg2")
    ungranted = _create_member(msvc, ctx, f"138{uuid.uuid4().hex[:8]}", "ug", [EnterpriseRole.MEMBER])
    # 不给 grant

    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    ug_tok = sign_token(pg_admin_url, tid, ["member"], user_id=ungranted.id)

    # 越权拉 snapshot → 403
    r = mgr.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid, "member_id": ungranted.id, "employee_id": e.employee_id},
        headers={"Authorization": f"Bearer {ug_tok}"},
    )
    assert r.status_code == 403, f"预期 403 越权，实际: {r.status_code} {r.text}"
    assert r.headers["content-type"].startswith("application/problem+json")

    # 越权审计已落 enterprise_audit
    from manager_service.enterprise_audit_repository import build_enterprise_audit_repository
    audit_repo = build_enterprise_audit_repository(router)
    audits = audit_repo.list_all(TenantContext(tenant_id=tid, user_id=ungranted.id, roles=["member"]))
    denied = [a for a in audits if a.action == "snapshot_pull_denied" and a.actor == ungranted.id]
    assert len(denied) == 1, f"越权应记一条审计，实际 {len(denied)}"
    assert denied[0].resource_type == "expert"
    assert denied[0].resource_id == e.employee_id
    # D13 红线：审计行不含配置内容
    detail = denied[0].detail or ""
    assert e.display_name not in detail
    assert "claude" not in detail


# ── 跨租户不可见：employee/snapshot/authorized-config 全维度 ──


@pytest.mark.integration
def test_negative_cross_tenant_employee_snapshot_not_visible(
    migrated_pg, pg_admin_url,
):
    """negative：tenant A 的 employee 快照在 tenant B HTTP 不可见（RLS → 404）。

    真 PG + RLS + 两个隔离 tenant (a,b)，RS256。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole

    tid_a = _register_tenant(pg_admin_url, "ent_nca")
    tid_b = _register_tenant(pg_admin_url, "ent_ncb")

    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx_a = _tenant_ctx_f(tid_a, ["owner"])
    from manager_service.employee_config_service import build_employee_config_service

    esvc = build_employee_config_service(router)
    e_a = _create_employee(esvc, ctx_a, "exp-nca")
    owner_a = _create_member(msvc, ctx_a, f"138{uuid.uuid4().hex[:8]}", "owner-a", [EnterpriseRole.OWNER])

    # tenant B 造 owner
    ctx_b = _tenant_ctx_f(tid_b, ["owner"])
    owner_b = _create_member(msvc, ctx_b, f"139{uuid.uuid4().hex[:8]}", "owner-b", [EnterpriseRole.OWNER])

    mgr = _build_manager_app(migrated_pg, pg_admin_url)

    # tenant B owner 拉 tenant A 的 employee 快照 → 404
    b_tok = sign_token(pg_admin_url, tid_b, ["owner"], user_id=owner_b.id)
    r = mgr.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid_b, "member_id": owner_b.id, "employee_id": e_a.employee_id},
        headers={"Authorization": f"Bearer {b_tok}"},
    )
    assert r.status_code == 404, f"跨租户快照应 404（RLS 不可见），实际: {r.status_code}"
    assert r.headers["content-type"].startswith("application/problem+json")

    # tenant B member 拉 tenant A 的 authorized-config → body.tenant_id 与 token 不匹配 → 403
    r = mgr.post(
        "/api/manager/grants/authorized-config",
        json={"tenant_id": tid_a, "member_id": owner_b.id},
        headers={"Authorization": f"Bearer {b_tok}"},
    )
    assert r.status_code == 403, f"跨租户 authorized-config 应 403（tenant_id mismatch），实际: {r.status_code}"


# ── member_id != token 主体 → 403（防代拉）──


@pytest.mark.integration
def test_negative_member_id_mismatch_token_subject_403(
    migrated_pg, pg_admin_url,
):
    """negative：body.member_id 与 token 主体不一致 → 403 Forbidden。

    F10 authorized-config 与 F11 snapshot 均有此守卫（03 §9.7：禁止代他人 pull）。
    无 DB 依赖（HTTP 层守卫，在打 DB 前就拦截）。
    """
    tid = _register_tenant(pg_admin_url, "ent_mis")
    mgr = _build_manager_app(migrated_pg, pg_admin_url)

    tok = sign_token(pg_admin_url, tid, ["owner"], user_id="real-user")

    # authorized-config
    r = mgr.post(
        "/api/manager/grants/authorized-config",
        json={"tenant_id": tid, "member_id": "someone-else"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 403, f"member_id 不匹配应 403，实际: {r.status_code}"
    assert r.headers["content-type"].startswith("application/problem+json")

    # snapshot
    r = mgr.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid, "member_id": "someone-else", "employee_id": str(uuid.uuid4())},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 403, f"snapshot member_id 不匹配应 403，实际: {r.status_code}"


# ── body.tenant_id != token claims.tenant_id → 403（跨端契约自洽）──


@pytest.mark.integration
def test_negative_tenant_id_mismatch_body_vs_token_403(
    migrated_pg, pg_admin_url,
):
    """negative：authorized-config body.tenant_id 与 token claims.tenant_id 不一致 → 403。

    契约自洽（03 §9.7）：严禁 body 声明一个 tenant、token 却属于另一个 tenant。
    """
    tid = _register_tenant(pg_admin_url, "ent_tmis")
    mgr = _build_manager_app(migrated_pg, pg_admin_url)

    tok = sign_token(pg_admin_url, tid, ["owner"], user_id="real-user")

    # body 声明 tid-other，token 属于 tid → 403
    r = mgr.post(
        "/api/manager/grants/authorized-config",
        json={"tenant_id": str(uuid.uuid4()), "member_id": "real-user"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")


# ── 受保护端点 401（无 token）──


@pytest.mark.integration
def test_negative_authorized_config_without_token_returns_401(
    migrated_pg, pg_admin_url,
):
    """negative：authorized-config endpoint 无 token → 401 problem+json。

    不依赖 DB（此时 DB 可能未配置，但路由守卫先检查 token 存在性，见 routes_grants _token_claims）。
    """
    from manager_service.app import router as mgr_router
    from manager_service.routes_grants import router as grants_router
    from manager_service.routes_member import router as member_router
    from shared.app_factory import create_app
    from tests.manager._auth_helper import make_inmem_verifier_and_signer

    _verifier, _ = make_inmem_verifier_and_signer()
    app = create_app(
        Settings(tier="manager", service_name="aiteam-manager-service", db_url=None),
        mgr_router,
    )
    app.state._token_verifier = _verifier
    app.include_router(member_router)
    app.include_router(grants_router)
    client = TestClient(app)

    r = client.post(
        "/api/manager/grants/authorized-config",
        json={"tenant_id": "t1", "member_id": "m1"},
    )
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "unauthorized"


# ── 越权拉 snapshot → 403 response 不含 token/配置内容（D13）──


@pytest.mark.integration
def test_negative_403_response_no_token_leakage(
    migrated_pg, pg_admin_url,
):
    """negative：越权 403 响应不泄露 token / secret / 配置内容（D13 红线）。

    验证 problem+json 的 detail/type/instance 等字段不含 token 原文。
    """
    tid = _register_tenant(pg_admin_url, "ent_noleak")
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole

    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx_f(tid, ["owner"])
    from manager_service.employee_config_service import build_employee_config_service

    esvc = build_employee_config_service(router)
    e = _create_employee(esvc, ctx, "exp-noleak")
    ungranted = _create_member(msvc, ctx, f"138{uuid.uuid4().hex[:8]}", "ug", [EnterpriseRole.MEMBER])

    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    ugly_tok = sign_token(pg_admin_url, tid, ["member"], user_id=ungranted.id)

    r = mgr.post(
        "/api/manager/snapshots",
        json={"tenant_id": tid, "member_id": ungranted.id, "employee_id": e.employee_id},
        headers={"Authorization": f"Bearer {ugly_tok}"},
    )
    assert r.status_code == 403

    body = r.json()
    assert "status" in body and body["status"] == 403
    assert "code" in body
    raw = r.text
    # 不得泄露 token 值
    token_segments = ugly_tok.split(".")
    for seg in token_segments:
        if len(seg) > 16:  # 只查明显长的子串
            assert seg not in raw, f"403 响应泄露了 token 段"


def _tenant_ctx_f(tid: str, roles: list[str], user_id: str | None = None):
    from shared.contracts.tenancy import TenantContext
    return TenantContext(tenant_id=tid, user_id=user_id or str(uuid.uuid4()), roles=roles)
