"""F02 负责人 bootstrap 收端（POST /api/manager/owner-bootstrap，Operator→Manager 云侧调用）。

收 OwnerBootstrapSync → 调 AuthService.provision_owner 落 bootstrap 凭据（scrypt hash，单一真相源）。
bootstrap_secret 是 TLS 服务间明文材料，provision_owner 内单次 scrypt 落库；
must_reset=true 强制首登重置后切换正常凭据。响应体不含明文/可逆凭据（03 §9.2，02 §11.2）。
"""

from __future__ import annotations

from fastapi import APIRouter, Request, status

from shared.contracts.crosstier import OwnerBootstrapSync
from shared.contracts.envelope import Envelope
from shared.errors import Conflict

from .exceptions import ManagerAdminDbNotConfigured

router = APIRouter(tags=["manager", "control-plane"])


@router.post(
    "/api/manager/owner-bootstrap",
    summary="F02 负责人 bootstrap——落凭据 hash（Operator→Manager 云侧调用）",
    operation_id="manager_owner_bootstrap",
    status_code=status.HTTP_201_CREATED,
)
def owner_bootstrap(body: OwnerBootstrapSync, request: Request) -> Envelope[dict]:
    settings = request.app.state.settings
    db_url = settings.db_url
    admin_db_url = settings.admin_db_url
    if not db_url or not admin_db_url:
        raise ManagerAdminDbNotConfigured("Manager DB 未配置（设置 DB_URL 与 ADMIN_DB_URL）")

    from manager_service.auth_service import build_auth_service

    cache = getattr(request.app.state, "_auth_service", None)
    if cache is None:
        cache = build_auth_service(db_url, admin_dsn=admin_db_url)
        request.app.state._auth_service = cache

    try:
        user_id = cache.provision_owner(
            body.tenant_id,
            phone=body.owner_phone,
            bootstrap_password=body.bootstrap_secret,  # 明文传入，provision_owner 内单次 scrypt
        )
    except Conflict:
        # 幂等：账号已存在（重放同 key），视为成功。
        return Envelope[dict](data={"tenant_id": body.tenant_id, "idempotent": True})

    return Envelope[dict](data={"tenant_id": body.tenant_id, "user_id": user_id})
