"""企业开通 + 负责人 bootstrap 北向路由（/api/operation，05 F01/F02）。

鉴权：平台侧角色 system_admin | system_operator（03 §9.7）。受 require_claims 保护，
越权 → 403（authorize）。响应统一 Envelope；错误统一 problem+json（02 §11.2）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from shared.auth import DevTokenService, authorize, require_claims
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

# ⚠️ 骨架期用 DevTokenService（仅 dev/测试）；生产替换为非对称验签（公钥/JWKS，03 §9.5/D23）。
_verifier = DevTokenService()

_PLATFORM_ROLES = [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]

router = APIRouter(prefix="/api/operation", tags=["operation-enterprise"])


def _require_platform_operator(
    claims: TokenClaims = Depends(require_claims(_verifier)),
) -> TokenClaims:
    authorize(claims, _PLATFORM_ROLES)
    return claims


@router.post(
    "/enterprises",
    summary="开通企业（建 tenant + 签发负责人 bootstrap）",
    operation_id="operation_provision_enterprise",
    status_code=201,
)
async def provision_enterprise(
    body: ProvisionEnterpriseRequest,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: ProvisioningService = Depends(get_provisioning_service),
) -> Envelope[EnterpriseProvisioned]:
    return Envelope[EnterpriseProvisioned](data=service.provision_enterprise(body))


@router.post(
    "/enterprises/{enterprise_id}/owner-bootstrap/reset",
    summary="重置负责人 bootstrap 凭据",
    operation_id="operation_reset_owner_bootstrap",
)
async def reset_owner_bootstrap(
    enterprise_id: str,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: ProvisioningService = Depends(get_provisioning_service),
) -> Envelope[OwnerBootstrapResetResult]:
    return Envelope[OwnerBootstrapResetResult](data=service.reset_owner_bootstrap(enterprise_id))
