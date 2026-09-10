"""F02 负责人 bootstrap 收端（POST /api/manager/owner-bootstrap，Operator→Manager 云侧调用）。

收 OwnerBootstrapSync → 调 AuthService.provision_owner 落 bootstrap 凭据（scrypt hash，单一真相源）。
bootstrap_secret 是 TLS 服务间明文材料，provision_owner 内单次 scrypt 落库；
must_reset=true 强制首登重置后切换正常凭据。响应体不含明文/可逆凭据（03 §9.2，02 §11.2）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request, status

from shared.contracts.crosstier import OwnerBootstrapSync
from shared.contracts.envelope import Envelope
from shared.errors import NotFound

from .exceptions import ManagerAdminDbNotConfigured
from .idempotency_repository import normalize_idempotency_key, request_fingerprint
from .multitenancy_phase import require_control_plane_writes_ready
from .onboarding_repository import OperatorTenantBindingRepository
from .openapi_schemas import OwnerBootstrapOut
from .service_ingress import require_operator_service_principal, test_compatibility_principal, validate_onboarding_principal

router = APIRouter(tags=["manager", "control-plane"])


def _tenant_exists(admin_db_url: str, tenant_id: str) -> bool:
    """Return whether the control-plane tenant has been provisioned."""
    import psycopg

    with psycopg.connect(admin_db_url, autocommit=True) as conn:
        row = conn.execute(
            "SELECT 1 FROM tenant_registry WHERE tenant_id = %s",
            (tenant_id,),
        ).fetchone()
    return row is not None


@router.post(
    "/api/manager/owner-bootstrap",
    summary="F02 负责人 bootstrap——落凭据 hash（Operator→Manager 云侧调用）",
    description="运营端Manager云侧调用：负责人首次登录凭据 hash 落库。用户端凭此完成首登重置。",
    operation_id="manager_owner_bootstrap",
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def owner_bootstrap(
    body: OwnerBootstrapSync,
    request: Request,
    principal=Depends(require_operator_service_principal),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Envelope[OwnerBootstrapOut]:
    settings = request.app.state.settings
    db_url = settings.db_url
    admin_db_url = settings.admin_db_url
    if not db_url or not admin_db_url:
        raise ManagerAdminDbNotConfigured("Manager DB 未配置（设置 DB_URL 与 ADMIN_DB_URL）")
    require_control_plane_writes_ready(settings)
    idempotency_key = normalize_idempotency_key(idempotency_key)
    if principal is None:
        principal = test_compatibility_principal(
            request, body, operation="bootstrap", idempotency_key=idempotency_key,
        )
        if principal is None:
            from shared.errors import Unauthorized

            raise Unauthorized("signed service principal is required for onboarding writes")
    validate_onboarding_principal(
        request,
        principal,
        operation="bootstrap",
        tenant_id=body.tenant_id,
        body=body,
        idempotency_key=idempotency_key,
    )
    try:
        tenant_exists = _tenant_exists(admin_db_url, body.tenant_id)
    except Exception as exc:
        import psycopg

        if isinstance(exc, psycopg.Error):
            from .exceptions import ManagerControlPlaneUnavailable

            raise ManagerControlPlaneUnavailable("Manager tenant registry is unavailable") from exc
        raise
    if not tenant_exists:
        raise NotFound("tenant not found")
    try:
        OperatorTenantBindingRepository(admin_db_url).require_exact(
            principal,
            tenant_id=body.tenant_id,
            require_enterprise_claim=False,
        )
    except Exception as exc:
        import psycopg

        if isinstance(exc, psycopg.Error):
            from .exceptions import ManagerControlPlaneUnavailable

            raise ManagerControlPlaneUnavailable("Manager binding control table is unavailable") from exc
        raise

    from manager_service.auth_service import build_auth_service

    cache = getattr(request.app.state, "_auth_service", None)
    if cache is None:
        cache = build_auth_service(db_url, admin_dsn=admin_db_url)
        request.app.state._auth_service = cache

    idempotent_method = (
        getattr(cache, "sync_owner_bootstrap_idempotent", None)
        if getattr(type(cache), "sync_owner_bootstrap_idempotent", None) is not None
        else None
    )
    if idempotent_method is None:
        from .exceptions import ManagerControlPlaneUnavailable

        raise ManagerControlPlaneUnavailable("Manager bootstrap idempotency support is unavailable")
    from .idempotency_repository import ManagerIdempotencyRepository
    from shared.db import PgTenantRouter

    try:
        receipt = idempotent_method(
            body.tenant_id,
            phone=body.owner_phone,
            bootstrap_password=body.bootstrap_secret,  # 明文传入，Manager 内单次 scrypt
            must_reset=body.must_reset,
            idempotency_repository=ManagerIdempotencyRepository(PgTenantRouter(db_url)),
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint(
                "owner-bootstrap",
                body.model_dump(mode="json", exclude_none=True),
            ),
        )
    except Exception as exc:
        import psycopg

        if isinstance(exc, psycopg.Error):
            from .exceptions import ManagerControlPlaneUnavailable

            raise ManagerControlPlaneUnavailable("Manager bootstrap schema is unavailable") from exc
        raise
    return Envelope[OwnerBootstrapOut](data=OwnerBootstrapOut(**receipt.payload))
