"""F01 enterprise provisioning (POST /api/manager/tenants, Operator→Manager).

The control-plane registry is an internal compatibility record written with the
admin DSN; repeated provisioning is idempotent.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request, status

from shared.contracts.crosstier import TenantProvisionRequest
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
