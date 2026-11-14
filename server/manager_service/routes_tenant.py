"""F01 enterprise provisioning (POST /api/manager/tenants, Operator→Manager).

The control-plane registry is an internal compatibility record written with the
admin DSN; repeated provisioning is idempotent.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request, status

from shared.contracts.crosstier import TenantProvisionRequest, TenantPurgeRequest, TenantStatusSync
from shared.contracts.envelope import Envelope

from .exceptions import ManagerAdminDbNotConfigured
from .knowledge_space_service import ensure_enterprise_knowledge_space
from .multitenancy_phase import require_control_plane_writes_ready
from .onboarding_repository import OperatorTenantBindingRepository
from .openapi_schemas import TenantProvisionOut
from .service_ingress import (
    canonical_body_sha256,
    require_operator_service_principal,
    test_compatibility_principal,
    validate_onboarding_principal,
)

router = APIRouter(tags=["manager", "control-plane"])


def seed_enterprise_name(business_dsn: str, tenant_id: str, name: str) -> None:
    """把开通时的企业名写进 enterprise_settings，供企业端顶栏展示（幂等，不覆盖已有名称）。"""
    from shared.contracts.tenancy import TenantContext
    from shared.db import PgTenantRouter

    from .settings_repository import SettingsRepository

    ctx = TenantContext(tenant_id=tenant_id, user_id="system", roles=["owner"])
    SettingsRepository(PgTenantRouter(business_dsn)).ensure_enterprise_name(ctx, name)


@router.post(
    "/api/manager/tenants",
    summary="F01 企业开通——建 tenant_registry 行（Operator→Manager 云侧调用）",
    description="运营端Manager云侧调用：新建 tenant 注册行，返回 tenant_id。企业开通入口。",
    operation_id="manager_provision_tenant",
    status_code=status.HTTP_201_CREATED,
)
def provision_tenant(
    body: TenantProvisionRequest,
    request: Request,
    principal=Depends(require_operator_service_principal),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Envelope[TenantProvisionOut]:
    """同步路由（def）：psycopg 同步驱动，FastAPI 自动 run in threadpool，不阻塞事件循环。

    落地 initial_quota_policy（05 §5.1 D4）。
    """
    settings = request.app.state.settings
    dsn = settings.admin_db_url
    if not dsn:
        raise ManagerAdminDbNotConfigured("Manager 管理 DB 未配置（设置 ADMIN_DB_URL）")
    if not settings.db_url:
        raise ManagerAdminDbNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    require_control_plane_writes_ready(settings)

    # A signed F01 assertion is the only production authority allowed to submit
    # new IDs.  UUID validation is deliberately tied to that path so old local
    # phase-gate fixtures remain readable without becoming a production bypass.
    if principal is not None or settings.aiteam_env == "production":
        import uuid

        for field_name, value in (("enterprise_id", body.enterprise_id), ("tenant_id", body.tenant_id)):
            try:
                uuid.UUID(value)
            except (ValueError, TypeError) as exc:
                from shared.errors import ValidationProblem

                raise ValidationProblem(f"{field_name} must be a UUID") from exc

    from .idempotency_repository import normalize_idempotency_key

    idempotency_key = normalize_idempotency_key(idempotency_key)
    if principal is None:
        principal = test_compatibility_principal(
            request, body, operation="provision", idempotency_key=idempotency_key,
        )
        if principal is None:
            from shared.errors import Unauthorized

            raise Unauthorized("signed service principal is required for onboarding writes")
    validate_onboarding_principal(
        request,
        principal,
        operation="provision",
        enterprise_id=body.enterprise_id,
        tenant_id=body.tenant_id,
        body=body,
        idempotency_key=idempotency_key,
    )
    slug = body.enterprise_code or body.enterprise_name
    business_dsn = settings.db_url

    # Establish all business-side state before committing the durable F01
    # registry/receipt.  Both operations are idempotent, so a retry is safe if
    # the later control-plane transaction fails.
    try:
        ensure_enterprise_knowledge_space(
            business_dsn,
            body.tenant_id,
            instance_registry=getattr(request.app.state, "_rag_instance_registry", None),
        )

        seed_enterprise_name(business_dsn, body.tenant_id, body.enterprise_name)

        # 2. 处理 initial_quota_policy（租户作用域，需要 RLS + SET LOCAL）
        if body.initial_quota_policy:
            _provision_initial_quota_policy(business_dsn, body.tenant_id, body.initial_quota_policy)
    except Exception as exc:
        import psycopg

        if isinstance(exc, psycopg.Error):
            from .exceptions import ManagerControlPlaneUnavailable

            raise ManagerControlPlaneUnavailable("Manager tenant schema is unavailable") from exc
        raise

    try:
        OperatorTenantBindingRepository(dsn).ensure_registry_and_binding(
            tenant_id=body.tenant_id,
            enterprise_id=body.enterprise_id,
            enterprise_slug=slug,
            enterprise_code=body.enterprise_code,
            principal=principal,
            idempotency_key=idempotency_key,
            request_fingerprint=canonical_body_sha256(body),
        )
    except Exception as exc:
        import psycopg
        from shared.errors import Conflict

        if isinstance(exc, Conflict):
            raise
        if isinstance(exc, psycopg.errors.UniqueViolation):
            raise Conflict("企业信息重复，请检查企业名称和代码") from exc
        if isinstance(exc, psycopg.Error):
            from .exceptions import ManagerControlPlaneUnavailable

            raise ManagerControlPlaneUnavailable("Manager tenant registry is unavailable") from exc
        raise

    return Envelope[TenantProvisionOut](data=TenantProvisionOut(tenant_id=body.tenant_id))


def _provision_initial_quota_policy(dsn: str, tenant_id: str, policy: dict) -> None:
    """落地初始配额策略（D24：默认 soft，租户作用域 RLS）。

    policy 字典预期字段（来自 Operator，可选）：
    - policy_slug: str
    - display_name: str
    - scope: str (默认 "tenant")
    - window_days: int (默认 30)
    - dimensions: dict (cost_cap_usd / token_cap / run_cap)
    - enforcement: str (默认 "soft"，D24)
    """
    import json
    import psycopg

    policy_slug = policy.get("policy_slug", "default")
    display_name = policy.get("display_name", "Default Quota Policy")
    scope = policy.get("scope", "tenant")
    window_days = policy.get("window_days", 30)
    dimensions = policy.get("dimensions", {})
    enforcement = policy.get("enforcement", "soft")

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            # 设置租户上下文（RLS 策略要求）
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))

            # 幂等插入：ON CONFLICT DO NOTHING（重复调用不报错）
            cur.execute(
                """
                INSERT INTO quota_policy (
                    tenant_id, policy_slug, display_name, scope, target_ref,
                    window_start, window_end, dimensions, enforcement, status
                ) VALUES (
                    %s, %s, %s, %s, NULL,
                    now(), now() + (%s * interval '1 day'), %s, %s, 'active'
                )
                ON CONFLICT (tenant_id, policy_slug) DO NOTHING
                """,
                (
                    tenant_id, policy_slug, display_name, scope,
                    window_days, json.dumps(dimensions), enforcement
                ),
            )
        conn.commit()


def _lifecycle_store(request: Request):
    """租户状态存取（管理连接）；应用启动时挂在 app.state，测试可替换。"""
    store = getattr(request.app.state, "_tenant_status_store", None)
    if store is None:
        from .tenant_status import TenantStatusStore

        dsn = request.app.state.settings.admin_db_url
        if not dsn:
            raise ManagerAdminDbNotConfigured("Manager 管理 DB 未配置（设置 ADMIN_DB_URL）")
        store = TenantStatusStore(dsn)
        request.app.state._tenant_status_store = store
    return store


def _lifecycle_principal(request: Request, principal, body, tenant_id: str, idempotency_key: str | None):
    from shared.errors import Unauthorized

    from .idempotency_repository import normalize_idempotency_key

    key = normalize_idempotency_key(idempotency_key)
    if principal is None:
        principal = test_compatibility_principal(request, body, operation="lifecycle", idempotency_key=key)
        if principal is None:
            raise Unauthorized("signed service principal is required for tenant lifecycle writes")
    validate_onboarding_principal(
        request, principal, operation="lifecycle", tenant_id=tenant_id, body=body, idempotency_key=key,
    )
    return key


@router.post(
    "/api/manager/tenants/{tenant_id}/status",
    summary="R5 企业生命周期——Operator 下发租户状态（active/suspended/banned/closed/deleted）",
    description="运营端Manager云侧调用：写 tenant_registry.status。暂停=只读；封禁/注销/删除=拒绝登录与访问；幂等。",
    operation_id="manager_set_tenant_status",
)
def set_tenant_status(
    tenant_id: str,
    body: TenantStatusSync,
    request: Request,
    principal=Depends(require_operator_service_principal),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Envelope[dict]:
    from shared.errors import Conflict

    from .tenant_status import TenantNotFound

    _lifecycle_principal(request, principal, body, tenant_id, idempotency_key)
    store = _lifecycle_store(request)
    record = store.record(tenant_id)
    if record is None:
        raise TenantNotFound("tenant not found")
    if record[1] is not None:
        raise Conflict("tenant data has been purged; its status can no longer change")
    store.set_status(tenant_id, body.status, body.reason)
    return Envelope[dict](data={"tenant_id": tenant_id, "status": body.status})


@router.post(
    "/api/manager/tenants/{tenant_id}/purge",
    summary="R5 保留期后清理租户数据（仅对 deleted 的租户生效）",
    description="运营端Manager云侧调用：删除该 tenant 的业务数据与文件、签名私钥，并释放企业代码；可重入。",
    operation_id="manager_purge_tenant",
)
def purge_tenant(
    tenant_id: str,
    body: TenantPurgeRequest,
    request: Request,
    principal=Depends(require_operator_service_principal),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Envelope[dict]:
    from shared.errors import Conflict

    from .knowledge_intake_service import manager_storage_root
    from .tenant_status import TenantNotFound, purge_tenant_data

    _lifecycle_principal(request, principal, body, tenant_id, idempotency_key)
    store = _lifecycle_store(request)
    record = store.record(tenant_id)
    if record is None:
        raise TenantNotFound("tenant not found")
    if record[0] != "deleted":
        raise Conflict("only a deleted tenant can be purged")
    counts = purge_tenant_data(
        request.app.state.settings.admin_db_url, tenant_id, manager_storage_root(request.app.state.settings),
    )
    store.invalidate(tenant_id)
    return Envelope[dict](data={"tenant_id": tenant_id, "purged_rows": sum(counts.values())})
