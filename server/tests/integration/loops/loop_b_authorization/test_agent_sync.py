"""闭环 B agent_sync 测试：Agent 登录并同步授权对象和快照（F09+F10+F11/D5/D12/D14）。

验证：
- F09 入户：Agent 通过 RealManagerLoginClient → Manager RS256 登录 → 缓存 token + JWKS → whoami 本地验签。
- F10 授权同步：Agent GrantsService.sync() 经真实 Manager HTTP pull 授权配置增量；本地只见被授予对象。
- F11 快照冻结：Agent freeze_snapshot() pull Manager snapshot → 本地不可变冻结；已冻结快照离线仍可装载。
- 离线降级（D14）：Manager 不可达时已有投影 + 已冻结快照不受影响、仍可用。

跨端鉴权口径（03 §9.6/D23）：Manager 的 authorized-config / snapshot 路由要求 Bearer JWT
（body.member_id == claims.user_id）。Agent 持成员 access token，pull 时须以 Bearer 附带——
本测试用 bridging httpx transport 把 Agent 的 ServiceClient 请求桥接到真实 Manager TestClient
并注入成员 token，真实跑通 RLS + grant 裁剪 + envelope 解包（与单测里 MockTransport 同源，仅多注入 token）。

标记: integration + 函数名含 agent_sync。真 PG + 真 Manager HTTP (RS256 JWT)。"""

from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.service_client import ServiceClient
from tests.manager._auth_helper import sign_token, make_verifier


# ── helpers ──


def _tenant_ctx(tid: str, roles: list[str], user_id: str | None = None):
    from shared.contracts.tenancy import TenantContext
    return TenantContext(tenant_id=tid, user_id=user_id or str(uuid.uuid4()), roles=roles)


def _register_tenant(pg_admin_url: str, prefix: str) -> str:
    """建隔离 tenant，返回 tenant_id。"""
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
    """构造挂全业务路由的 Manager app（auth/employee/member/grants/snapshot），真实 RS256 验签。"""
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


def _bridged_grants_client(manager: TestClient, bearer_token: str) -> "ServiceClientGrantsClient":
    """构造 ServiceClientGrantsClient，其 ServiceClient 经 bridging transport 调真实 Manager。

    bridge 把 Agent 的请求（POST /api/manager/grants/authorized-config 等）重放到真实 Manager
    TestClient，并注入成员 Bearer token——模拟生产中 Agent 持成员 access token pull 的真实链路。
    真实跑通：FastAPI 路由 + RS256 验签 + RLS + grant 裁剪 + envelope 解包。
    """
    from agent_service.grants.client import ServiceClientGrantsClient

    def handler(request: httpx.Request) -> httpx.Response:
        headers = {k: v for k, v in request.headers.items()
                   if k.lower() not in ("host", "content-length")}
        headers["Authorization"] = f"Bearer {bearer_token}"
        return manager.request(
            request.method, request.url.path, headers=headers, content=request.content,
        )

    return ServiceClientGrantsClient(
        ServiceClient("http://testserver", transport=httpx.MockTransport(handler))
    )


def _grants_service(client) -> "GrantsService":
    from agent_service.grants.service import GrantsService
    from agent_service.grants.store import InMemoryProjectionRepository, InMemorySnapshotRepository
    return GrantsService(
        client=client,
        projections=InMemoryProjectionRepository(),
        snapshots=InMemorySnapshotRepository(),
    )


# ── F09 入户：Agent 登录 + whoami 本地 RS256 验签 ──


@pytest.mark.integration
def test_agent_sync_login_via_manager_rs256_then_whoami_local_verify(
    migrated_pg, pg_admin_url,
):
    """agent_sync (F09)：Agent RealManagerLoginClient → Manager HTTP login → 本地 RS256 验签 whoami。

    用真实 RS256 token（TenantKeyStore → DynamicRS256TokenVerifier 闭环），验证 Agent 端
    token cache + JWKS 本地验签链路。真 PG + RS256。
    """
    from manager_service.auth_service import build_auth_service

    tid = _register_tenant(pg_admin_url, "ent_asl")
    phone = f"138{uuid.uuid4().hex[:8]}"
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    auth.provision_owner(tid, phone=phone, bootstrap_password="boot-Pass-1")

    mgr = _build_manager_app(migrated_pg, pg_admin_url)

    # 首登重置
    r = mgr.post("/api/auth/owner-reset", json={
        "tenant_id": tid, "account": phone, "old_password": "boot-Pass-1", "new_password": "fresh-Pass-2",
    })
    assert r.status_code == 200, r.text
    fresh_token = r.json()["data"]["token"]
    claims_data = r.json()["data"]["claims"]
    assert claims_data["tenant_id"] == tid
    assert "owner" in claims_data["roles"]

    # JWKS 下发 + 本地 RS256 验签
    from shared.auth import RS256TokenVerifier
    jwks = mgr.get(f"/api/auth/{tid}/jwks.json").json()
    verifier = RS256TokenVerifier.from_jwks(jwks)
    claims = verifier.verify(fresh_token)
    assert claims.tenant_id == tid
    assert "owner" in claims.roles

    # Agent 端 login 装配：RealManagerLoginClient 经 TestClient transport → Manager
    from agent_service.auth.manager_client import RealManagerLoginClient
    from agent_service.auth.local_login import LocalLoginService, LoginRequest
    from agent_service.auth.token_cache import InMemoryTokenCache

    agent_login = LocalLoginService(
        manager=RealManagerLoginClient(
            ServiceClient("http://testserver", transport=mgr._transport)
        ),
        cache=InMemoryTokenCache(),
    )
    session = agent_login.login(LoginRequest(account=phone, password="fresh-Pass-2", tenant_hint=tid))
    assert session.claims.tenant_id == tid
    assert "owner" in session.claims.roles

    # whoami（本地验签）
    identity = agent_login.current_identity()
    assert identity is not None
    assert identity.tenant_id == tid
    assert "owner" in identity.roles


# ── F10 授权同步：Agent pull → 本地投影 ──


@pytest.mark.integration
def test_agent_sync_grants_pull_lands_local_projection(
    migrated_pg, pg_admin_url,
):
    """agent_sync (F10)：Agent GrantsService.sync() 经真实 Manager HTTP pull → 落本地投影。

    全链路：Manager employee + member_grant → Agent ServiceClientGrantsClient
    → sync → 本地 available_experts 只含已 grant 条目。真 PG + RS256。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from manager_service.schemas import MemberCreate, EmployeeConfigIn, MemberGrantCreate
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    from manager_service.employee_config_service import build_employee_config_service

    tid = _register_tenant(pg_admin_url, "ent_f10")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx(tid, ["owner"])

    member = msvc.create_member(ctx, MemberCreate(
        account=f"139{uuid.uuid4().hex[:8]}", initial_password="pw123456", display_name="alice",
        roles=[EnterpriseRole.MEMBER], must_reset=False,
    ))
    esvc = build_employee_config_service(router)
    e = esvc.create(ctx, EmployeeConfigIn(
        display_name="专家A", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy(),
    ), employee_slug="exp-f10")
    gsvc.create_grant(ctx, MemberGrantCreate(
        resource_type="expert", resource_id=e.employee_id, department_ids=[], member_ids=[member.id],
    ))

    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    member_tok = sign_token(pg_admin_url, tid, ["member"], user_id=member.id)

    svc = _grants_service(_bridged_grants_client(mgr, member_tok))

    # sync as member → 应只 pull 到已 grant 的 e
    result = svc.sync(tid, member.id)
    assert result.ok, f"sync 失败: {result.error}"
    available_ids = [p.employee_id for p in svc.available_experts()]
    assert e.employee_id in available_ids, f"agent_sync 应 pull 到已 grant 的 {e.employee_id}，实际可用: {available_ids}"

    # 第二次 sync：无增量、无撤销
    result2 = svc.sync(tid, member.id)
    assert result2.ok
    assert result2.upserted == 0
    assert result2.revoked == 0

    # 撤销 grant → sync → projection 从 available 移除
    grants = gsvc.list_grants_by_resource(ctx, resource_type="expert", resource_id=e.employee_id)
    for g in grants:
        gsvc.delete_grant(ctx, g.id)
    result3 = svc.sync(tid, member.id)
    assert result3.ok
    assert e.employee_id not in [p.employee_id for p in svc.available_experts()]


# ── F11 快照冻结：Manager → Agent freeze_snapshot ──


@pytest.mark.integration
@pytest.mark.pr_quick
def test_agent_sync_freeze_snapshot_via_manager_http_then_local_loadable(
    migrated_pg, pg_admin_url,
):
    """agent_sync (F11)：Agent freeze_snapshot() 经真实 Manager HTTP pull 快照 → 本地冻结不可变。

    已验证：已冻结快照幂等、不覆盖、离线仍可装载（D14）。真 PG + RS256。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from manager_service.schemas import MemberCreate, EmployeeConfigIn
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    from manager_service.employee_config_service import build_employee_config_service

    tid = _register_tenant(pg_admin_url, "ent_f11")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx(tid, ["owner"])

    owner_mem = msvc.create_member(ctx, MemberCreate(
        account=f"138{uuid.uuid4().hex[:8]}", initial_password="pw123456", display_name="owner",
        roles=[EnterpriseRole.OWNER], must_reset=False,
    ))
    esvc = build_employee_config_service(router)
    e = esvc.create(ctx, EmployeeConfigIn(
        display_name="专家S", model_policy=ModelPolicy(model="claude-opus-4-8",
                                                       provider_ref="relay-default",
                                                       thinking_level="high"),
        runtime_policy=RuntimePolicy(runtime_binding="hermes_acp", timeout_seconds=180),
        tools=["search"], skills=["code-review"], knowledge_refs=["ks_default"],
        connector_refs=["slack"], memory_policy={"seed": "记忆种子"},
    ), employee_slug="exp-f11")

    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    owner_tok = sign_token(pg_admin_url, tid, ["owner"], user_id=owner_mem.id)
    svc = _grants_service(_bridged_grants_client(mgr, owner_tok))

    frozen = svc.freeze_snapshot(tid, owner_mem.id, e.employee_id)
    assert frozen.employee_id == e.employee_id
    assert frozen.version == str(e.version)
    assert frozen.display_name == "专家S"
    assert frozen.model_policy.model == "claude-opus-4-8"
    assert frozen.runtime_policy.runtime_binding == "hermes_acp"
    assert frozen.snapshot_version

    # 幂等：同 key 再 freeze 返回既有（不覆盖）
    frozen2 = svc.freeze_snapshot(tid, owner_mem.id, e.employee_id)
    assert frozen2.snapshot_version == frozen.snapshot_version

    # 离线降级：已冻结快照仍可本地装载（不经 Manager）
    assert svc.load_snapshot(e.employee_id, frozen.snapshot_version) is not None
    assert svc.latest_snapshot(e.employee_id).snapshot_version == frozen.snapshot_version


# ── Agent 本地只见被授予对象（D12：授权裁剪）──


@pytest.mark.integration
def test_agent_sync_local_only_sees_granted_experts(
    migrated_pg, pg_admin_url,
):
    """agent_sync (D12)：Agent 本地投影仅见被授予对象，未授权成员不可见。

    使用真实 Manager HTTP 全链路验证。真 PG + RS256。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from manager_service.schemas import MemberCreate, EmployeeConfigIn, MemberGrantCreate
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    from manager_service.employee_config_service import build_employee_config_service

    tid = _register_tenant(pg_admin_url, "ent_vis")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx(tid, ["owner"])

    g_member = msvc.create_member(ctx, MemberCreate(
        account=f"138{uuid.uuid4().hex[:8]}", initial_password="pw123456", display_name="granted",
        roles=[EnterpriseRole.MEMBER], must_reset=False,
    ))
    ug_member = msvc.create_member(ctx, MemberCreate(
        account=f"139{uuid.uuid4().hex[:8]}", initial_password="pw123456", display_name="ungranted",
        roles=[EnterpriseRole.MEMBER], must_reset=False,
    ))
    esvc = build_employee_config_service(router)
    e = esvc.create(ctx, EmployeeConfigIn(
        display_name="可见专家", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy(),
    ), employee_slug="exp-vis")
    # 只授给 granted 成员
    gsvc.create_grant(ctx, MemberGrantCreate(
        resource_type="expert", resource_id=e.employee_id, department_ids=[], member_ids=[g_member.id],
    ))

    mgr = _build_manager_app(migrated_pg, pg_admin_url)

    # granted 成员 sync → 可见
    granted_svc = _grants_service(_bridged_grants_client(mgr, sign_token(pg_admin_url, tid, ["member"], user_id=g_member.id)))
    granted_svc.sync(tid, g_member.id)
    assert e.employee_id in [p.employee_id for p in granted_svc.available_experts()]

    # ungranted 成员 sync → 不可见
    ungranted_svc = _grants_service(_bridged_grants_client(mgr, sign_token(pg_admin_url, tid, ["member"], user_id=ug_member.id)))
    ungranted_svc.sync(tid, ug_member.id)
    assert e.employee_id not in [p.employee_id for p in ungranted_svc.available_experts()]


# ── Manager 离线降级（D14）──


@pytest.mark.integration
def test_agent_sync_offline_degradation_projection_intact(
    migrated_pg, pg_admin_url,
):
    """agent_sync (D14)：Manager 离线时已有投影保持不变、仍可用、不崩。

    先正常 sync 建立投影 → 断开 Manager（UnconfiguredGrantsClient）→ 再 sync 降级
    → 验证已有投影不丢失、available 仍可用。真 PG 用于建立数据。
    """
    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from shared.db import PgTenantRouter
    from shared.contracts.enums import EnterpriseRole
    from manager_service.schemas import MemberCreate, EmployeeConfigIn, MemberGrantCreate
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    from manager_service.employee_config_service import build_employee_config_service

    tid = _register_tenant(pg_admin_url, "ent_off")
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    router = PgTenantRouter(migrated_pg)
    ctx = _tenant_ctx(tid, ["owner"])

    member = msvc.create_member(ctx, MemberCreate(
        account=f"138{uuid.uuid4().hex[:8]}", initial_password="pw123456", display_name="m",
        roles=[EnterpriseRole.MEMBER], must_reset=False,
    ))
    esvc = build_employee_config_service(router)
    e = esvc.create(ctx, EmployeeConfigIn(
        display_name="离线专家", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy(),
    ), employee_slug="exp-off")
    gsvc.create_grant(ctx, MemberGrantCreate(
        resource_type="expert", resource_id=e.employee_id, department_ids=[], member_ids=[member.id],
    ))

    mgr = _build_manager_app(migrated_pg, pg_admin_url)
    member_tok = sign_token(pg_admin_url, tid, ["member"], user_id=member.id)
    svc = _grants_service(_bridged_grants_client(mgr, member_tok))

    # 在线 sync → 建立投影
    svc.sync(tid, member.id)
    assert len(svc.available_experts()) == 1

    # 模拟离线：换 UnconfiguredGrantsClient（直接抛异常→降级），复用既有投影仓储
    from agent_service.grants.client import UnconfiguredGrantsClient
    offline_svc = _grants_service(UnconfiguredGrantsClient())
    offline_svc._projections = svc._projections
    offline_svc._snapshots = svc._snapshots
    result = offline_svc.sync(tid, member.id)
    assert result.ok is False
    # 既有投影不丢失，仍可用
    assert len(offline_svc.available_experts()) == 1
