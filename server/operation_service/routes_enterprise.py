"""企业开通 + 负责人 bootstrap 北向路由（/api/operation，05 F01/F02）。

鉴权：平台侧角色 system_admin | system_operator（03 §9.7）。受 require_claims 保护，
越权 → 403（authorize）。响应统一 Envelope；错误统一 problem+json（02 §11.2）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import PlatformRole
from shared.contracts.envelope import Envelope

from .dependencies import get_provisioning_service
from .schemas import (
    EnterpriseProvisioned,
    OwnerBootstrapResetResult,
    ProvisionEnterpriseRequest,
)
from .service import ProvisioningService

_PLATFORM_ROLES = [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]

router = APIRouter(prefix="/api/operation", tags=["operation-enterprise"])


def _require_platform_operator(request: Request) -> TokenClaims:
    # verifier 由 app 持有（系统级 RS256，app.py 构造挂 app.state._token_verifier），
    # 运行时读取——单例，避免各 routes 模块各自构造多套 key。
    verifier = request.app.state._token_verifier
    claims = require_claims(verifier)(request)
    authorize(claims, _PLATFORM_ROLES)
    return claims


@router.post(
    "/enterprises",
    description="开通企业（建 tenant + 签发负责人 bootstrap）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="开通企业（建 tenant + 签发负责人 bootstrap）",
    operation_id="operation_provision_enterprise",
    status_code=201,
)
async def provision_enterprise(
    body: ProvisionEnterpriseRequest,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: ProvisioningService = Depends(get_provisioning_service),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
) -> Envelope[EnterpriseProvisioned]:
    return Envelope[EnterpriseProvisioned](
        data=service.provision_enterprise(body, idempotency_key=idempotency_key)
    )


@router.post(
    "/enterprises/{enterprise_id}/owner-bootstrap/reset",
    description="重置负责人 bootstrap 凭据。成功响应遵循统一 envelope，失败返回 problem+json。", summary="重置负责人 bootstrap 凭据",
    operation_id="operation_reset_owner_bootstrap",
)
async def reset_owner_bootstrap(
    enterprise_id: str,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: ProvisioningService = Depends(get_provisioning_service),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
) -> Envelope[OwnerBootstrapResetResult]:
    return Envelope[OwnerBootstrapResetResult](
        data=service.reset_owner_bootstrap(enterprise_id, idempotency_key=idempotency_key)
    )
