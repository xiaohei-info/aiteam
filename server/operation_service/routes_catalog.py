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
    description="请查看接口名称了解用途", summary="注册专家模板（草稿态）",
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
    description="请查看接口名称了解用途", summary="注册行业方案模板（草稿态）",
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
    description="请查看接口名称了解用途", summary="发布目录项（通知 Manager）",
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
    description="请查看接口名称了解用途", summary="下架目录项（通知 Manager）",
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
    description="请查看接口名称了解用途", summary="变更可见范围（通知 Manager）",
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
    description="请查看接口名称了解用途", summary="列举目录项（可按类型/状态过滤）",
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
    description="请查看接口名称了解用途", summary="获取单个目录项",
    operation_id="operation_get_catalog_entry",
)
async def get_catalog_entry(
    catalog_type: CatalogType,
    template_id: str,
    _claims: TokenClaims = Depends(_require_platform_operator),
    service: CatalogService = Depends(get_catalog_service),
) -> Envelope[CatalogEntryResponse]:
    return Envelope[CatalogEntryResponse](data=service.get_entry(catalog_type, template_id))


# ---- Manager 拉取端点（服务间调用，05 F06/F07 §5.4）----

router_pull = APIRouter(prefix="/api/operation/catalog/pull", tags=["operation-catalog-pull"])


def _require_service_token(request: Request) -> None:
    """服务间调用守卫（平面③，03 §9.1）。Manager 拉取目录使用服务身份认证。"""
    from shared.service_token import verify_service_token
    verify_service_token(request)


@router_pull.get(
    "/expert-templates/{template_id}",
    description="请查看接口名称了解用途", summary="F06 Manager 拉取专家模板详情（服务间调用）",
    operation_id="operation_pull_expert_template",
)
async def pull_expert_template(
    template_id: str,
    request: Request,
    version: str | None = None,
    service: CatalogService = Depends(get_catalog_service),
):
    """F06：Manager 向 Operator 拉取专家模板详情（只读；Operator 持模板真相）。

    鉴权：服务间调用（X-Service-Token）。version 为 None 时返回最新已发布版本。
    """
    _require_service_token(request)
    from shared.contracts.crosstier import ExpertTemplateDetail
    from shared.contracts.envelope import Envelope

    return Envelope[ExpertTemplateDetail](
        data=service.pull_expert_template_detail(template_id=template_id, version=version)
    )


@router_pull.get(
    "/solution-templates/{solution_id}",
    description="请查看接口名称了解用途", summary="F07 Manager 拉取行业方案包（服务间调用）",
    operation_id="operation_pull_solution_package",
)
async def pull_solution_package(
    solution_id: str,
    request: Request,
    version: str | None = None,
    service: CatalogService = Depends(get_catalog_service),
):
    """F07：Manager 向 Operator 拉取行业方案包（只读；Operator 持模板真相）。

    鉴权：服务间调用（X-Service-Token）。version 为 None 时返回最新已发布版本。
    """
    _require_service_token(request)
    from shared.contracts.crosstier import SolutionPackage
    from shared.contracts.envelope import Envelope

    return Envelope[SolutionPackage](
        data=service.pull_solution_package(solution_id=solution_id, version=version)
    )


@router_pull.get(
    "/expert-templates",
    description="请查看接口名称了解用途", summary="F06 Manager 列举可招募专家模板（服务间调用）",
    operation_id="operation_list_expert_templates",
)
async def list_expert_templates(
    request: Request,
    service: CatalogService = Depends(get_catalog_service),
):
    """F06：Manager 浏览可招募专家模板（只读，只返回 PUBLISHED 状态）。

    鉴权：服务间调用（X-Service-Token）。
    """
    _require_service_token(request)
    from shared.contracts.crosstier import ExpertTemplateDetail
    from shared.contracts.envelope import ListEnvelope

    return ListEnvelope[ExpertTemplateDetail](data=service.list_published_expert_templates())


@router_pull.get(
    "/solution-templates",
    description="请查看接口名称了解用途", summary="F07 Manager 列举可应用行业方案包（服务间调用）",
    operation_id="operation_list_solution_packages",
)
async def list_solution_packages(
    request: Request,
    service: CatalogService = Depends(get_catalog_service),
):
    """F07：Manager 浏览可应用行业方案包（只读，只返回 PUBLISHED 状态）。

    鉴权：服务间调用（X-Service-Token）。
    """
    _require_service_token(request)
    from shared.contracts.crosstier import SolutionPackage
    from shared.contracts.envelope import ListEnvelope

    return ListEnvelope[SolutionPackage](data=service.list_published_solution_packages())
