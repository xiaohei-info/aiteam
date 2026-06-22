"""跨企业 rollup 上报 + 平台看板北向路由（/api/operation，04 §6.5，D13）。

- POST /rollups        : Manager → Operator 上报企业级脱敏聚合（窄通信写调用，幂等 by summary_id）。
- GET  /rollups/board  : 跨企业平台看板（全平台合计 + 各企业聚合行）。
- GET  /rollups/{eid}  : 单企业聚合视图。

鉴权：平台侧角色 system_admin | system_operator（03 §9.7）；越权 → 403。
响应统一 Envelope；错误统一 problem+json（02 §11.2）。
红线（D13）：只消费脱敏聚合、无会话内容、不下钻租户内部明细。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import PlatformRole
from shared.contracts.envelope import Envelope

from .dependencies import get_rollup_service
from .rollup_schemas import CrossEnterpriseBoard, EnterpriseRollupUpload, EnterpriseUsageRollup
from .rollup_service import RollupService

_PLATFORM_ROLES = [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]

router = APIRouter(prefix="/api/operation", tags=["operation-rollup"])


def _require_platform_operator(request: Request) -> TokenClaims:
    # verifier 由 app 持有（系统级 RS256，app.py 构造挂 app.state._token_verifier）。
    verifier = request.app.state._token_verifier
    claims = require_claims(verifier)(request)
    authorize(claims, _PLATFORM_ROLES)
    return claims


@router.post(
    "/rollups",
    summary="Manager 上报企业级脱敏聚合（跨企业 rollup 入口）",
    operation_id="operation_ingest_rollup",
    status_code=202,
)
async def ingest_rollup(
    body: EnterpriseRollupUpload,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: RollupService = Depends(get_rollup_service),
) -> Envelope[None]:
    service.ingest(body)
    return Envelope[None](data=None)


@router.get(
    "/rollups/board",
    summary="跨企业平台看板（全平台合计 + 各企业聚合）",
    operation_id="operation_cross_enterprise_board",
)
async def cross_enterprise_board(
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: RollupService = Depends(get_rollup_service),
) -> Envelope[CrossEnterpriseBoard]:
    return Envelope[CrossEnterpriseBoard](data=service.cross_enterprise_board())


@router.get(
    "/rollups/{enterprise_id}",
    summary="单企业聚合视图（脱敏，不下钻租户明细）",
    operation_id="operation_enterprise_rollup",
)
async def enterprise_rollup(
    enterprise_id: str,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: RollupService = Depends(get_rollup_service),
) -> Envelope[EnterpriseUsageRollup]:
    return Envelope[EnterpriseUsageRollup](data=service.enterprise_rollup(enterprise_id))
