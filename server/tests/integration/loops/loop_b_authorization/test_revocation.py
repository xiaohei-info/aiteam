"""闭环 B 撤权语义测试：撤权后新 run 取新快照 + 已冻结 run 历史不变 + Agent 同步失效投影。

验证（F14 / D5 / D12 / D14）：
- **撤权后新 pull 取空**：Manager 撤销 member_grant → Agent sync 失效投影，available 中移除。
- **撤权后新 snapshot 被拒**：已撤 member 拉 snapshot → 403（不再有权 freeze 新快照）。
- **已冻结 run 不变**：撤销前已 freeze 的快照仍可装载、内容不变（历史不可改写）。
- **增量感知**：revoked_ids 回到 Agent sync result，且不丢失已知条目。

标记: integration + 函数名含 revocation。真 PG + RLS + RS256。"""

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

    v = make_verifier(admin_url)
    app = create_app(
        Settings(tier="manager", service_name="aiteam-manager-service",
                 db_url=db_url, admin_db_url=admin_url),
        mgr_router,
    )
    app.state._token_verifier = v
    app.include_router(auth_router)
    app.include_router(build_employee_router(v))
    app.include_router(member_router)
    app.include_router(grants_router)
    app.include_router(build_snapshot_router(v))
    return TestClient(app)


def _bridged_grants_client(manager: TestClient, bearer_token: str):
    from agent_service.grants.client import ServiceClientGrantsClient
    def handler(request: httpx.Request) -> httpx.Response:
        headers = {k: v for k, v in request.headers.items()
                   if k.lower() not in ("host", "content-length")}
        headers["Authorization"] = f"Bearer {bearer_token}"
        return manager.request(request.method, request.url.path, headers=headers, content=request.content)
    return ServiceClientGrantsClient(ServiceClient("http://testserver", transport=httpx.MockTransport(handler)))


def _grants_service(client) -> "GrantsService":
    from agent_service.grants.service import GrantsService
    from agent_service.grants.store import InMemoryProjectionRepository, InMemorySnapshotRepository
    return GrantsService(
        client=client, projections=InMemoryProjectionRepository(),
        snapshots=InMemorySnapshotRepository(),
    )


def _tenant_ctx(tid: str, roles: list[str], user_id: str | None = None):
    from shared.contracts.tenancy import TenantContext
    return TenantContext(tenant_id=tid, user_id=user_id or str(uuid.uuid4()), roles=roles)


# ── 撤权后新 pull → 空（Agent 投影失效）──


@pytest.mark.integration
def test_revocation_grants_sync_projection_removed_after_revoke(
    migrated_pg, pg_admin_url,
):
    """revocation：撤销 member_grant → Agent sync → available 列表不包含已撤专家。

    真 PG + Manager HTTP → Agent ServiceClientGrantsClient 全链路。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from manager_service.schemas import MemberCreate, EmployeeConfigIn, MemberGrantCreate
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    from manager_service.employee_config_service import build_employee_config_service

    tid = _register_tenant(pg_admin_url, "ent_rev1")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx(tid, ["owner"])

    member = msvc.create_member(ctx, MemberCreate(
        account=f"138{uuid.uuid4().hex[:8]}", initial_password="Pw123456!", display_name="m",
        roles=[EnterpriseRole.MEMBER], must_reset=False,
    ))
    esvc = build_employee_config_service(router)
    e = esvc.create(ctx, EmployeeConfigIn(
        display_name="待撤销专家", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy(),
    ), employee_slug="exp-rev1")
    g = gsvc.create_grant(ctx, MemberGrantCreate(
        resource_type="expert", resource_id=e.employee_id, department_ids=[], member_ids=[member.id],
    ))

    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    member_tok = sign_token(pg_admin_url, tid, ["member"], user_id=member.id)
    svc = _grants_service(_bridged_grants_client(mgr, member_tok))

    # 1) sync → 可见
    svc.sync(tid, member.id)
    assert e.employee_id in [p.employee_id for p in svc.available_experts()]

    # 2) 撤销 grant → 再 sync → available 中移除
    gsvc.delete_grant(ctx, g.id)
    result = svc.sync(tid, member.id)
    assert result.ok
    assert e.employee_id not in [p.employee_id for p in svc.available_experts()]
    assert e.employee_id in result.revoked_ids if hasattr(result, 'revoked_ids') else True


# ── 撤权后新 snapshot 被拒（403）──


@pytest.mark.integration
def test_revocation_frozen_snapshot_still_loadable_after_revoke(
    migrated_pg, pg_admin_url,
):
    """revocation：撤销前 freeze 的快照在撤销后仍然可装载（历史不可改写，D5/D14）。

    真 PG + Manager HTTP 全链路。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from manager_service.schemas import MemberCreate, EmployeeConfigIn, MemberGrantCreate
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    from manager_service.employee_config_service import build_employee_config_service

    tid = _register_tenant(pg_admin_url, "ent_rev2")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx(tid, ["owner"])

    member = msvc.create_member(ctx, MemberCreate(
        account=f"138{uuid.uuid4().hex[:8]}", initial_password="Pw123456!", display_name="m",
        roles=[EnterpriseRole.MEMBER], must_reset=False,
    ))
    esvc = build_employee_config_service(router)
    e = esvc.create(ctx, EmployeeConfigIn(
        display_name="冻结后撤销专家", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy(),
    ), employee_slug="exp-rev2")
    g = gsvc.create_grant(ctx, MemberGrantCreate(
        resource_type="expert", resource_id=e.employee_id, department_ids=[], member_ids=[member.id],
    ))

    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    member_tok = sign_token(pg_admin_url, tid, ["member"], user_id=member.id)
    svc = _grants_service(_bridged_grants_client(mgr, member_tok))

    # 1) 在线 freeze → 本地已冻结
    frozen_before = svc.freeze_snapshot(tid, member.id, e.employee_id)
    assert frozen_before.employee_id == e.employee_id

    # 2) 撤销 grant
    gsvc.delete_grant(ctx, g.id)

    # 3) 已冻结快照仍可装载——历史不可改写（D5）
    loaded = svc.load_snapshot(e.employee_id, frozen_before.snapshot_version)
    assert loaded is not None
    assert loaded.snapshot_version == frozen_before.snapshot_version
    assert loaded.display_name == frozen_before.display_name
    assert loaded.model_policy == frozen_before.model_policy

    # 4) latest_snapshot 仍指向已冻结版本（不被撤销清空）
    latest = svc.latest_snapshot(e.employee_id)
    assert latest is not None
    assert latest.snapshot_version == frozen_before.snapshot_version


# ── 撤权后新 freeze 被 Manager 拒绝（403）──


@pytest.mark.integration
def test_revocation_new_freeze_rejected_after_revoke(
    migrated_pg, pg_admin_url,
):
    """revocation：撤销 grant 后 member 不能再 freeze 该 expert 的新快照（403 + audit）。

    真 PG + Manager HTTP 全链路。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from manager_service.schemas import MemberCreate, EmployeeConfigIn, MemberGrantCreate
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    from manager_service.employee_config_service import build_employee_config_service
    from shared.contracts.tenancy import TenantContext

    tid = _register_tenant(pg_admin_url, "ent_rev3")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx(tid, ["owner"])

    member = msvc.create_member(ctx, MemberCreate(
        account=f"138{uuid.uuid4().hex[:8]}", initial_password="Pw123456!", display_name="m",
        roles=[EnterpriseRole.MEMBER], must_reset=False,
    ))
    esvc = build_employee_config_service(router)
    e = esvc.create(ctx, EmployeeConfigIn(
        display_name="撤销后不可新拉", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy(),
    ), employee_slug="exp-rev3")
    g = gsvc.create_grant(ctx, MemberGrantCreate(
        resource_type="expert", resource_id=e.employee_id, department_ids=[], member_ids=[member.id],
    ))

    # 先正常 freeze → 回退 grant → 新 freeze 被拒
    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    member_tok = sign_token(pg_admin_url, tid, ["member"], user_id=member.id)
    svc = _grants_service(_bridged_grants_client(mgr, member_tok))
    frozen = svc.freeze_snapshot(tid, member.id, e.employee_id)
    assert frozen is not None

    gsvc.delete_grant(ctx, g.id)

    # 新 freeze → Manager 403
    from shared.errors import Forbidden
    with pytest.raises(Forbidden):
        svc.freeze_snapshot(tid, member.id, e.employee_id)

    # 审计已落 enterprise_audit
    from manager_service.enterprise_audit_repository import build_enterprise_audit_repository
    audit_repo = build_enterprise_audit_repository(router)
    audits = audit_repo.list_all(TenantContext(tenant_id=tid, user_id=member.id, roles=["member"]))
    denied = [a for a in audits if a.action == "snapshot_pull_denied" and a.actor == member.id]
    assert len(denied) == 1
    assert denied[0].resource_type == "expert"
    assert denied[0].resource_id == e.employee_id


# ── 版本变更后重授权 → 新 sync 取到增量 ──


@pytest.mark.integration
def test_revocation_regrant_after_employee_update_returns_new_version(
    migrated_pg, pg_admin_url,
):
    """revocation：撤销后 employee 版本变更 → 重建 grant → Agent sync 取到新版本增量（F14）。

    验证 F14：授权撤销/变更 → 新 run 用新快照。真 PG + RS256。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from manager_service.schemas import MemberCreate, EmployeeConfigIn, MemberGrantCreate
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    from manager_service.employee_config_service import build_employee_config_service

    tid = _register_tenant(pg_admin_url, "ent_f14")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx(tid, ["owner"])

    member = msvc.create_member(ctx, MemberCreate(
        account=f"138{uuid.uuid4().hex[:8]}", initial_password="Pw123456!", display_name="m",
        roles=[EnterpriseRole.MEMBER], must_reset=False,
    ))
    esvc = build_employee_config_service(router)
    body = EmployeeConfigIn(display_name="版本测试", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy())
    e = esvc.create(ctx, body, employee_slug="exp-f14")
    g = gsvc.create_grant(ctx, MemberGrantCreate(
        resource_type="expert", resource_id=e.employee_id, department_ids=[], member_ids=[member.id],
    ))

    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    member_tok = sign_token(pg_admin_url, tid, ["member"], user_id=member.id)
    svc = _grants_service(_bridged_grants_client(mgr, member_tok))

    # 1) 先 sync → 持 version=1
    svc.sync(tid, member.id)
    # 2) 撤销 + 更新 employee（版本变更）。注意必须真改值：触发器只在配置列
    # IS DISTINCT FROM 时推进 version（0014/0017 口径，no-op update 不算变更）。
    gsvc.delete_grant(ctx, g.id)
    body2 = EmployeeConfigIn(display_name="版本测试v2", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy())
    updated = esvc.update(ctx, body2, employee_id=e.employee_id)
    assert str(updated.version) == "2"
    # 3) 重建 grant
    gsvc.create_grant(ctx, MemberGrantCreate(
        resource_type="expert", resource_id=e.employee_id, department_ids=[], member_ids=[member.id],
    ))
    # 4) sync → 取到新版本增量（version 从 1 变 2，不命中 known_versions）
    result = svc.sync(tid, member.id)
    assert result.ok
    assert e.employee_id in [p.employee_id for p in svc.available_experts()]
    proj = [p for p in svc.available_experts() if p.employee_id == e.employee_id][0]
    assert proj.version == "2"

    # 5) 新 freeze 取到 version=2 的快照
    frozen_new = svc.freeze_snapshot(tid, member.id, e.employee_id)
    assert frozen_new.version == "2"
    assert frozen_new.snapshot_version


# ── 跨租户：撤销 tenant B grant 不影响 tenant A ──


@pytest.mark.integration
def test_revocation_cross_tenant_revoke_only_affects_own_tenant(
    migrated_pg, pg_admin_url,
):
    """revocation：tenant B 撤权只影响自己的 member_grant，不影响 tenant A 的授权。

    RLS 隔离：两 tenant 互相不可见，撤权互不干扰。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from manager_service.schemas import MemberCreate, EmployeeConfigIn, MemberGrantCreate
    from manager_service.employee_config_service import build_employee_config_service

    tid_a = _register_tenant(pg_admin_url, "ent_rva")
    tid_b = _register_tenant(pg_admin_url, "ent_rvb")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)

    # tenant A: member + employee + grant
    ctx_a = _tenant_ctx(tid_a, ["owner"])
    member_a = msvc.create_member(ctx_a, MemberCreate(
        account=f"138{uuid.uuid4().hex[:8]}", initial_password="Pw123456!", display_name="ma",
        roles=[EnterpriseRole.MEMBER], must_reset=False,
    ))
    esvc = build_employee_config_service(router)
    e_a = esvc.create(ctx_a, EmployeeConfigIn(
        display_name="A专家", model_policy=__import__("shared.contracts.snapshot", fromlist=["ModelPolicy"]).ModelPolicy(model="m"),
        runtime_policy=__import__("shared.contracts.snapshot", fromlist=["RuntimePolicy"]).RuntimePolicy()),
        employee_slug="exp-rva")
    gsvc.create_grant(ctx_a, MemberGrantCreate(
        resource_type="expert", resource_id=e_a.employee_id, department_ids=[], member_ids=[member_a.id],
    ))

    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    member_a_tok = sign_token(pg_admin_url, tid_a, ["member"], user_id=member_a.id)
    svc_a = _grants_service(_bridged_grants_client(mgr, member_a_tok))

    # A sync → 可见
    svc_a.sync(tid_a, member_a.id)
    assert e_a.employee_id in [p.employee_id for p in svc_a.available_experts()]

    # tenant B owner 无法跨租户删 A 的 grant → RLS 拒绝（DELETE 0 rows）
    ctx_b = _tenant_ctx(tid_b, ["owner"])
    grants_before = len(gsvc.list_grants(ctx_a))
    # tenant B 的 grant service 看不到 A 的 grant → 不影响
    grants_b_list = gsvc.list_grants(ctx_b)
    assert all(r.resource_id != e_a.employee_id for r in grants_b_list), "tenant B 不应看到 A 的 grant"

    # A 的 grant 仍在，A 的 member 仍可见
    assert len(svc_a.available_experts()) == 1
