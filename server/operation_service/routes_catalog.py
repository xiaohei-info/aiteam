"""目录发布/下架/可见范围北向路由（/api/operation/catalog，05 F03）。

鉴权：平台侧角色 system_admin | system_operator（03 §9.7）。受 require_claims 保护，
越权 → 403。响应统一 Envelope；错误统一 problem+json（02 §11.2）；非法 catalog_type → 422。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import CatalogStatus, CatalogType, PlatformRole
from shared.contracts.envelope import Envelope

from .catalog_dependencies import get_catalog_service
from .catalog_schemas import (
    CatalogEntryResponse,
    PublishTemplateRequest,
    RegisterExpertTemplateRequest,
    RegisterSolutionTemplateRequest,
    SetVisibilityRequest,
)
from .catalog_service import CatalogService

_PLATFORM_ROLES = [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]

router = APIRouter(prefix="/api/operation/catalog", tags=["operation-catalog"])


def _require_platform_operator(request: Request) -> TokenClaims:
    # verifier 由 app 持有（系统级 RS256，app.py 构造挂 app.state._token_verifier）。
    verifier = request.app.state._token_verifier
    claims = require_claims(verifier)(request)
    authorize(claims, _PLATFORM_ROLES)
    return claims


@router.post(
    "/expert-templates",
    summary="注册专家模板（草稿态）",
    operation_id="operation_register_expert_template",
    status_code=201,
)
async def register_expert_template(
    body: RegisterExpertTemplateRequest,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: CatalogService = Depends(get_catalog_service),
) -> Envelope[CatalogEntryResponse]:
    return Envelope[CatalogEntryResponse](data=service.register_expert_template(body))


@router.post(
    "/solution-templates",
    summary="注册行业方案模板（草稿态）",
    operation_id="operation_register_solution_template",
    status_code=201,
)
async def register_solution_template(
    body: RegisterSolutionTemplateRequest,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: CatalogService = Depends(get_catalog_service),
) -> Envelope[CatalogEntryResponse]:
    return Envelope[CatalogEntryResponse](data=service.register_solution_template(body))


@router.post(
    "/{catalog_type}/{template_id}/publish",
    summary="发布目录项（通知 Manager）",
    operation_id="operation_publish_catalog_entry",
)
async def publish_catalog_entry(
    catalog_type: CatalogType,
    template_id: str,
    body: PublishTemplateRequest,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: CatalogService = Depends(get_catalog_service),
) -> Envelope[CatalogEntryResponse]:
    return Envelope[CatalogEntryResponse](
        data=service.publish_template(catalog_type, template_id, body)
    )


@router.post(
    "/{catalog_type}/{template_id}/unpublish",
    summary="下架目录项（通知 Manager）",
    operation_id="operation_unpublish_catalog_entry",
)
async def unpublish_catalog_entry(
    catalog_type: CatalogType,
    template_id: str,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: CatalogService = Depends(get_catalog_service),
) -> Envelope[CatalogEntryResponse]:
    return Envelope[CatalogEntryResponse](
        data=service.unpublish_template(catalog_type, template_id)
    )


@router.put(
    "/{catalog_type}/{template_id}/visibility",
    summary="变更可见范围（通知 Manager）",
    operation_id="operation_set_catalog_visibility",
)
async def set_catalog_visibility(
    catalog_type: CatalogType,
    template_id: str,
    body: SetVisibilityRequest,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: CatalogService = Depends(get_catalog_service),
) -> Envelope[CatalogEntryResponse]:
    return Envelope[CatalogEntryResponse](
        data=service.set_visibility(catalog_type, template_id, body)
    )


@router.get(
    "",
    summary="列举目录项（可按类型/状态过滤）",
    operation_id="operation_list_catalog",
)
async def list_catalog(
    catalog_type: CatalogType | None = None,
    status: CatalogStatus | None = None,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: CatalogService = Depends(get_catalog_service),
) -> Envelope[list[CatalogEntryResponse]]:
    return Envelope[list[CatalogEntryResponse]](
        data=service.list_catalog(catalog_type=catalog_type, status=status)
    )


@router.get(
    "/{catalog_type}/{template_id}",
    summary="获取单个目录项",
    operation_id="operation_get_catalog_entry",
)
async def get_catalog_entry(
    catalog_type: CatalogType,
    template_id: str,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: CatalogService = Depends(get_catalog_service),
) -> Envelope[CatalogEntryResponse]:
    return Envelope[CatalogEntryResponse](data=service.get_entry(catalog_type, template_id))
