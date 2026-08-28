"""F02 负责人 bootstrap 收端（POST /api/manager/owner-bootstrap，Operator→Manager 云侧调用）。

收 OwnerBootstrapSync → 调 AuthService.provision_owner 落 bootstrap 凭据（scrypt hash，单一真相源）。
bootstrap_secret 是 TLS 服务间明文材料，provision_owner 内单次 scrypt 落库；
must_reset=true 强制首登重置后切换正常凭据。响应体不含明文/可逆凭据（03 §9.2，02 §11.2）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from shared.contracts.crosstier import OwnerBootstrapSync
from shared.contracts.envelope import Envelope
from shared.errors import NotFound
from shared.service_token import verify_service_token

from .auth_service import AuthService
from .exceptions import ManagerAdminDbNotConfigured

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
)
def owner_bootstrap(
    body: OwnerBootstrapSync,
    request: Request,
    _svc=Depends(verify_service_token),  # 服务间认证守卫（平面③ 代码层，03 §9.1）
) -> Envelope[dict]:
    settings = request.app.state.settings
    db_url = settings.db_url
    admin_db_url = settings.admin_db_url
    if not db_url or not admin_db_url:
        raise ManagerAdminDbNotConfigured("Manager DB 未配置（设置 DB_URL 与 ADMIN_DB_URL）")
    if not _tenant_exists(admin_db_url, body.tenant_id):
        raise NotFound("tenant not found")

    from manager_service.auth_service import build_auth_service

    cache = getattr(request.app.state, "_auth_service", None)
    if cache is None:
        cache = build_auth_service(db_url, admin_dsn=admin_db_url)
        request.app.state._auth_service = cache

    result_method = getattr(cache, "sync_owner_bootstrap_result", None) if isinstance(cache, AuthService) else None
    if result_method is not None:
        user_id, idempotent = result_method(
            body.tenant_id,
            phone=body.owner_phone,
            bootstrap_password=body.bootstrap_secret,  # 明文传入，Manager 内单次 scrypt
        )
    else:
        # Compatibility for injected test doubles and older embedding callers.
        user_id = cache.sync_owner_bootstrap(
            body.tenant_id,
            phone=body.owner_phone,
            bootstrap_password=body.bootstrap_secret,
        )
        idempotent = False

    data = {"tenant_id": body.tenant_id, "user_id": user_id}
    if idempotent:
        data["idempotent"] = True
    return Envelope[dict](data=data)
