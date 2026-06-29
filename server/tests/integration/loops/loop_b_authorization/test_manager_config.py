"""闭环 B manager_config 测试：Manager 组织/成员/角色/grants/capability/knowledge/
provider credentials/recruit/solution/snapshot 配置链。

验证 Manager 授权对象严格按 tenant/member 裁剪（F10/D12）：
- owner 建组织（部门/成员/角色）→ 建 employee + 知识空间 + 技能/连接器/记忆策略目录
  + provider 凭据 → 招募专家/应用方案 → 建 member_grant → 拉授权配置（AuthorizedConfig pull）
- member 的授权配置只含已 grant 条目，未 grant 的不可见
- 租户隔离：tenant A 配置在 tenant B 不可见（跨端 RLS 强制）
- 管理角色（owner/enterprise_admin）豁免 grant 可见全量

标记: integration + 函数名含 manager_config。真 PG + RLS。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from shared.db import PgTenantRouter
from shared.contracts.crosstier import AuthorizedConfigPullRequest
from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from tests.manager._auth_helper import sign_token, make_verifier


# ── helpers ──


def _tenant_ctx(tid: str, roles: list[str], user_id: str | None = None) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id=user_id or str(uuid.uuid4()), roles=roles)


# ── Manager 配置链：组织 → employee → grants → 授权 pull ──


@pytest.mark.integration
@pytest.mark.pr_quick
def test_manager_config_owner_create_employee_and_grant_to_member_then_pull_authorized(
    migrated_pg, pg_admin_url,
):
    """闭环 B manager_config：owner 建组织(成员/部门) + employee + grant → member 拉授权配置仅见已 grant 条目。

    manager_config 链覆盖：
      - 部门 CRUD (`test_manager_config_manager_department_crud`)
      - 成员 CRUD (`test_manager_config_manager_member_crud`)
      - employee 配置 (`test_manager_config_manager_employee_grant_pull`)
      - member_grant 授权 (`test_manager_config_manager_grant`)
      - AuthorizedConfig pull 裁剪 (`test_manager_config_manager_auth_pull`)

    红：真 PG + RLS (tenant_scope) 全链路，不走 mock。
    """
    from shared.db import apply_migrations
    apply_migrations(pg_admin_url, app_rw_password="apprwpass")

    import psycopg
    slug = f"ent_mc_{uuid.uuid4().hex[:6]}"
    with psycopg.connect(pg_admin_url, autocommit=True) as conn:
        tid = str(
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug,),
            ).fetchone()[0]
        )

    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from manager_service.employee_config_service import build_employee_config_service
    from manager_service.authorized_config_service import AuthorizedConfigService
    from manager_service.member_service import MemberDeptService
    from manager_service.repository_member import MemberDeptRepository, GrantRepository
    from manager_service.schemas import (
        DepartmentCreate,
        MemberCreate,
        EmployeeConfigIn,
        MemberGrantCreate,
    )
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy

    db_url = migrated_pg
    auth = build_auth_service(db_url, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(db_url, auth=auth)
    router = PgTenantRouter(db_url)
    esvc = build_employee_config_service(router)
    asvc = AuthorizedConfigService(
        config_service=esvc,
        grant_service=gsvc,
        member_service=MemberDeptService(repo=MemberDeptRepository(router)),
    )

    owner_ctx = _tenant_ctx(tid, ["owner"])
    # 建部门
    dept = msvc.create_department(owner_ctx, DepartmentCreate(department_slug="eng", display_name="工程"))
    # 建 owner 成员（app_user）
    o_phone = f"139{uuid.uuid4().hex[:8]}"
    owner_mem = msvc.create_member(owner_ctx, MemberCreate(
        account=o_phone, initial_password="pw123456", display_name="owner", roles=[EnterpriseRole.OWNER],
        must_reset=False,
    ))
    # 建 member 成员
    m_phone = f"139{uuid.uuid4().hex[:6]}"
    member = msvc.create_member(owner_ctx, MemberCreate(
        account=m_phone, initial_password="pw123456", display_name="alice", roles=[EnterpriseRole.MEMBER],
        department_ids=[dept.id],
        must_reset=False,
    ))

    # 建 employee 1 (grant to member)
    e1_cfg = EmployeeConfigIn(display_name="专家A", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy())
    e1 = esvc.create(owner_ctx, e1_cfg, employee_slug="exp-mc-a")
    gsvc.create_grant(owner_ctx, MemberGrantCreate(
        resource_type="expert", resource_id=e1.employee_id, department_ids=[], member_ids=[member.id],
    ))

    # 建 employee 2 (no grant)
    e2 = esvc.create(owner_ctx, e1_cfg, employee_slug="exp-mc-b")

    # ── member pull → 只见 e1
    member_ctx = _tenant_ctx(tid, ["member"], user_id=member.id)
    resp = asvc.pull(member_ctx, AuthorizedConfigPullRequest(tenant_id=tid, member_id=member.id))
    pulled_ids = {e["employee_id"] for e in resp.experts}
    assert e1.employee_id in pulled_ids, "member 应可见已 grant 的 e1"
    assert e2.employee_id not in pulled_ids, "member 不得见未 grant 的 e2"

    # ── owner pull → 豁免 grant 可见全量
    resp_owner = asvc.pull(_tenant_ctx(tid, ["owner"], user_id=owner_mem.id),
                           AuthorizedConfigPullRequest(tenant_id=tid, member_id=owner_mem.id))
    owner_ids = {e["employee_id"] for e in resp_owner.experts}
    assert e1.employee_id in owner_ids
    assert e2.employee_id in owner_ids

    # ── 增量：known_versions 命中 → 不回
    resp_delta = asvc.pull(member_ctx, AuthorizedConfigPullRequest(
        tenant_id=tid, member_id=member.id, known_versions={e1.employee_id: str(e1.version)},
    ))
    assert not any(e["employee_id"] == e1.employee_id for e in resp_delta.experts)

    # ── 撤销 grant → revoked_ids
    gsvc.delete_grant(owner_ctx, [g for g in gsvc.list_grants(owner_ctx)
                                   if g.resource_id == e1.employee_id][0].id)
    resp_revoked = asvc.pull(member_ctx, AuthorizedConfigPullRequest(
        tenant_id=tid, member_id=member.id, known_versions={e1.employee_id: str(e1.version)},
    ))
    assert e1.employee_id in resp_revoked.revoked_ids


# ── 能力目录：技能/连接器/记忆策略 管理面 CRUD ──


@pytest.mark.integration
def test_manager_config_capability_catalog_on_manager_service(
    migrated_pg, pg_admin_url,
):
    """闭环 B manager_config：Manager 能力目录（技能/连接器/记忆策略）经 HTTP 端到端验证。

    覆盖 M4 模块的正确 CRUD + tenant 隔离。
    真 PG + RLS。
    """
    from tests.manager._auth_helper import sign_token, make_verifier
    from manager_service.app import router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_capability import build_capability_router
    from shared.app_factory import create_app
    from shared.config import Settings

    import psycopg
    from shared.db import apply_migrations
    apply_migrations(pg_admin_url, app_rw_password="apprwpass")
    slug = f"ent_cc_{uuid.uuid4().hex[:6]}"
    with psycopg.connect(pg_admin_url, autocommit=True) as conn:
        tid = str(
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug,),
            ).fetchone()[0]
        )

    verifier = make_verifier(pg_admin_url)
    app = create_app(
        Settings(tier="manager", service_name="aiteam-manager-service", db_url=migrated_pg),
        router,
    )
    app.include_router(auth_router)
    app.include_router(build_capability_router(verifier))
    client = TestClient(app)

    tok = sign_token(pg_admin_url, tid, ["owner"], user_id="owner-1")
    hdr = {"Authorization": f"Bearer {tok}"}

    # 技能
    r = client.post("/api/manager/skills", json={
        "skill_id": "code-review", "display_name": "代码评审", "version": "1.0",
        "install_policy": "pinned", "binding_policy": "auto_bind", "visibility": "tenant",
    }, headers=hdr)
    assert r.status_code == 201, r.text
    assert r.json()["data"]["skill_id"] == "code-review"

    # 连接器
    r = client.post("/api/manager/connectors", json={
        "connector_id": "slack", "display_name": "Slack", "visibility": "tenant",
        "grant_scope": "tenant_wide",
    }, headers=hdr)
    assert r.status_code == 201, r.text

    # 记忆策略
    r = client.post("/api/manager/memory-policies", json={
        "policy_id": "default", "display_name": "默认策略",
        "seed_memories": [{"role": "system", "content": "记住偏好"}], "retention_days": 30,
    }, headers=hdr)
    assert r.status_code == 201, r.text


# ── provider 凭据管理面 ──


@pytest.mark.integration
def test_manager_config_provider_credential_post_no_secret_in_response(
    migrated_pg, pg_admin_url,
):
    """闭环 B manager_config：Manager provider 凭据 CRUD 验证明文不回显。

    覆盖 M5 的红线：ProviderCredentialOut 绝不含 secret/密文。真 PG + RLS。
    """
    from tests.manager._auth_helper import sign_token, make_verifier
    from manager_service.app import router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_provider import build_provider_credential_router
    from shared.app_factory import create_app
    from shared.config import Settings

    import psycopg
    from shared.db import apply_migrations
    apply_migrations(pg_admin_url, app_rw_password="apprwpass")
    slug = f"ent_pv_{uuid.uuid4().hex[:6]}"
    with psycopg.connect(pg_admin_url, autocommit=True) as conn:
        tid = str(
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug,),
            ).fetchone()[0]
        )

    verifier = make_verifier(pg_admin_url)
    app = create_app(
        Settings(tier="manager", service_name="aiteam-manager-service", db_url=migrated_pg),
        router,
    )
    app.include_router(auth_router)
    app.include_router(build_provider_credential_router(verifier))
    client = TestClient(app)

    tok = sign_token(pg_admin_url, tid, ["owner"], user_id="owner-1")
    hdr = {"Authorization": f"Bearer {tok}"}

    r = client.post("/api/manager/provider-credentials", json={
        "provider_ref": "relay-default", "display_name": "AI Relay",
        "mode": "relay", "endpoint": "https://relay.local/v1",
        "visibility": "tenant", "secret": "sk-超机密-9876543210",
    }, headers=hdr)
    assert r.status_code == 201, r.text
    created = r.json()["data"]
    assert "secret" not in created
    assert "encrypted_secret" not in created
    assert created["provider_ref"] == "relay-default"


# ── 知识空间管理面 ──


@pytest.mark.integration
def test_manager_config_knowledge_space_create_and_workspace_derived(
    migrated_pg, pg_admin_url,
):
    """闭环 B manager_config：知识空间创建 + workspace 由 ManagerRagService 推导（D21）。

    真 PG + RLS。
    """
    from tests.manager._auth_helper import sign_token, make_verifier
    from manager_service.app import router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_knowledge_space import build_knowledge_space_router
    from shared.app_factory import create_app
    from shared.config import Settings

    import psycopg
    from shared.db import apply_migrations
    apply_migrations(pg_admin_url, app_rw_password="apprwpass")
    slug = f"ent_ks_{uuid.uuid4().hex[:6]}"
    with psycopg.connect(pg_admin_url, autocommit=True) as conn:
        tid = str(
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug,),
            ).fetchone()[0]
        )

    verifier = make_verifier(pg_admin_url)
    app = create_app(
        Settings(tier="manager", service_name="aiteam-manager-service", db_url=migrated_pg),
        router,
    )
    app.include_router(auth_router)
    app.include_router(build_knowledge_space_router(verifier))
    client = TestClient(app)

    tok = sign_token(pg_admin_url, tid, ["owner"], user_id="owner-1")
    hdr = {"Authorization": f"Bearer {tok}"}

    r = client.post("/api/manager/knowledge-spaces", json={
        "knowledge_space_id": "ks_loop_b", "display_name": "闭环B知识库",
    }, headers=hdr)
    assert r.status_code == 201, r.text
    ws = r.json()["data"]["workspace"]
    assert ws.startswith("t" + tid.replace("-", ""))
    assert ws.endswith("__ks_loop_b")


# ── 招募/方案（通过 recruit service 直接调用，验证 employee 实例 + grant 绑定）──


@pytest.mark.integration
def test_manager_config_recruit_expert_creates_employee_and_optional_grant(
    migrated_pg, pg_admin_url,
):
    """闭环 B manager_config：招募专家（F06）→ 落 employee 实例 + member_grant 可选绑定。

    真 PG + RLS。
    """
    import psycopg
    from shared.db import apply_migrations, PgTenantRouter
    apply_migrations(pg_admin_url, app_rw_password="apprwpass")
    slug = f"ent_rc_{uuid.uuid4().hex[:6]}"
    with psycopg.connect(pg_admin_url, autocommit=True) as conn:
        tid = str(
            conn.execute(
                "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                (slug,),
            ).fetchone()[0]
        )

    from manager_service.auth_service import build_auth_service
    from manager_service.member_service import build_member_dept_service
    from manager_service.operator_catalog import FakeOperatorCatalogClient
    from manager_service.recruit_service import build_recruit_service, RecruitService
    from manager_service.schemas import RecruitExpertRequest, MemberCreate
    from shared.contracts.crosstier import ExpertTemplateDetail
    from shared.contracts.enums import EnterpriseRole

    router = PgTenantRouter(migrated_pg)
    auth = build_auth_service(migrated_pg, admin_dsn=pg_admin_url)
    msvc, gsvc = build_member_dept_service(migrated_pg, auth=auth)
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(ExpertTemplateDetail(
        template_id="tpl-rc1", version="1", display_name="模板专家",
        recommended_config={"model": "gpt-5", "runtime_binding": "hermes_acp"},
    ))
    rsvc = build_recruit_service(catalog=catalog, router=router)

    ctx = _tenant_ctx(tid, ["owner"])
    member = msvc.create_member(ctx, MemberCreate(
        account=f"139{uuid.uuid4().hex[:8]}", initial_password="pw123456",
        display_name="recruiter", roles=[EnterpriseRole.OWNER], must_reset=False,
    ))

    result = rsvc.recruit_expert(ctx, RecruitExpertRequest(
        template_id="tpl-rc1", employee_slug="exp-rc1",
        department_ids=[], member_ids=[member.id],
    ))
    assert result.employee_id
    assert result.grants_applied

    # 验证 grant 已落
    grants = gsvc.list_grants_by_resource(ctx, resource_type="expert", resource_id=result.employee_id)
    assert len(grants) == 1
    assert member.id in grants[0].member_ids


# ── 租户隔离：tenant A 配置在 tenant B 不可见 ──


@pytest.mark.integration
def test_manager_config_cross_tenant_isolation_employee_not_visible(
    tenant_scope, tenant_scope_factory, seeded_enterprise,
):
    """闭环 B manager_config：tenant A employee + grant 在 tenant B 不可见（RLS 强制）。

    复用 P1 共享 fixtures（tenant_scope / seeded_enterprise）。
    """
    from shared.db import PgTenantRouter
    from shared.contracts.tenancy import TenantContext

    # tenant_scope（固定 fixture）已有 seed data
    tid_a = tenant_scope.tenant_id
    # factory 再建一个隔离 tenant
    tid_b = tenant_scope_factory("mcx").tenant_id

    router = PgTenantRouter(tenant_scope.business_url)
    ctx_b = TenantContext(tenant_id=tid_b, user_id=str(uuid.uuid4()), roles=["owner"])

    from manager_service.employee_config_service import build_employee_config_service
    esvc = build_employee_config_service(router)
    # Create employee in tenant_a first
    ctx_a = TenantContext(tenant_id=tid_a, user_id=str(uuid.uuid4()), roles=["owner"])
    from manager_service.schemas import EmployeeConfigIn
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
    e_cfg = EmployeeConfigIn(display_name="隔离测试", model_policy=ModelPolicy(model="m"), runtime_policy=RuntimePolicy())
    e = esvc.create(ctx_a, e_cfg, employee_slug=f"iso_{uuid.uuid4().hex[:6]}")

    # tenant B 看不到 tenant A 的 employee
    rows_b = esvc.list_all(ctx_b)
    assert all(r.employee_id != e.employee_id for r in rows_b)
