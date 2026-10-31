"""企业知识库部署位置 + NAS 只读网关路由（议题 6；02 §10.1/§10.3）。

- GET/PUT /api/manager/knowledge-spaces/{id}/deployment：仅 owner/enterprise_admin；
  出参含 endpoint 与 credential_ref（环境变量名），从不含凭据值。
- GET /api/manager/knowledge-spaces/{id}/nas/...：kind=nas 时的只读网关；本租户已认证成员可读，
  与托管模式成员读策略一致。客户端从不持有企业 NAS 令牌。

数据所有权：部署配置归 Manager tenant 数据空间（TenantContext + RLS，D22）；NAS 内容归企业 NAS，
Manager 只转发只读投影、不落库。会话内容不经过这些端点。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Query, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .knowledge_nas_gateway import (
    HttpNasKnowledgeAdapter,
    KnowledgeDeploymentService,
    NasKnowledgeGateway,
)
from .knowledge_space_repository import (
    KnowledgeSpaceDeploymentRepository,
    KnowledgeSpaceRepository,
)
from .schemas import (
    KnowledgeSpaceDeploymentOut,
    KnowledgeSpaceDeploymentUpdate,
    NasKnowledgeBaseOut,
    NasKnowledgeDocumentPreviewOut,
    NasKnowledgeSearchOut,
)

_SPACE_ID = Path(max_length=256, description="企业知识空间 ID。", examples=["enterprise_shared"])
_NAS_KB_ID = Path(max_length=256, description="NAS 上的知识库 ID（上游协议原样标识）。", examples=["kb-finance"])
_NAS_DOC_ID = Path(max_length=256, description="NAS 上的知识文档 ID（上游协议原样标识）。", examples=["doc-1"])


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _router(request: Request) -> PgTenantRouter:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    return PgTenantRouter(dsn)


def _deployment_service(request: Request) -> KnowledgeDeploymentService:
    cache = getattr(request.app.state, "_knowledge_deployment_service", None)
    if cache is None:
        router = _router(request)
        cache = KnowledgeDeploymentService(
            spaces=KnowledgeSpaceRepository(router), deployments=KnowledgeSpaceDeploymentRepository(router),
        )
        request.app.state._knowledge_deployment_service = cache
    return cache


def _gateway(request: Request) -> NasKnowledgeGateway:
    cache = getattr(request.app.state, "_nas_knowledge_gateway", None)
    if cache is None:
        router = _router(request)
        cache = NasKnowledgeGateway(
            spaces=KnowledgeSpaceRepository(router), deployments=KnowledgeSpaceDeploymentRepository(router),
            adapter=HttpNasKnowledgeAdapter(),
        )
        request.app.state._nas_knowledge_gateway = cache
    return cache


def build_knowledge_nas_router(verifier) -> APIRouter:
    """构造部署位置 + NAS 只读网关路由；verifier 由 app 持有并闭包注入。"""
    router = APIRouter(prefix="/api/manager/knowledge-spaces", tags=["manager", "knowledge-space"])
    require = require_claims(verifier)

    @router.get(
        "/{knowledge_space_id}/deployment", operation_id="manager_knowledge_space_deployment_get",
        summary="读企业知识库部署位置（管理员）",
        description="仅 owner/enterprise_admin。返回 kind、endpoint、credential_ref（Manager 环境变量名，不是凭据值）"
        "及该引用在本 Manager 是否可解析。数据归 Manager tenant 数据空间，tenant 由 JWT/TenantContext 决定。"
        "成功响应遵循统一 envelope，失败返回 problem+json。",
    )
    async def get_deployment(
        request: Request, knowledge_space_id: str = _SPACE_ID, claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeSpaceDeploymentOut]:
        out = _deployment_service(request).get(tenant_context_from(claims), knowledge_space_id=knowledge_space_id)
        return Envelope[KnowledgeSpaceDeploymentOut](data=out)

    @router.put(
        "/{knowledge_space_id}/deployment", operation_id="manager_knowledge_space_deployment_put",
        summary="设置企业知识库部署位置（管理员）",
        description="仅 owner/enterprise_admin。kind=managed 时不带 endpoint/credential_ref；kind=nas 时两者必填，"
        "credential_ref 须为 MANAGER_NAS_ 前缀的环境变量名，其值 JSON 中的 tenant_id/endpoint 必须与本租户和 endpoint 一致"
        "才可用。凭据值从不入库。数据归 Manager tenant 数据空间（Manager 单写）。"
        "成功响应遵循统一 envelope，失败返回 problem+json。",
    )
    async def put_deployment(
        body: KnowledgeSpaceDeploymentUpdate, request: Request,
        knowledge_space_id: str = _SPACE_ID, claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeSpaceDeploymentOut]:
        out = _deployment_service(request).update(
            tenant_context_from(claims), knowledge_space_id=knowledge_space_id, body=body,
        )
        return Envelope[KnowledgeSpaceDeploymentOut](data=out)

    @router.get(
        "/{knowledge_space_id}/nas/knowledge-bases", operation_id="manager_knowledge_nas_list",
        summary="浏览企业 NAS 知识库（只读网关）",
        description="知识空间部署在企业 NAS 时，由 Manager 持凭据代为列出 NAS 知识库；本租户已认证成员可读。"
        "未部署在 NAS 返回 409 knowledge_space_not_nas；凭据未配置或 NAS 不可达返回 503。"
        "内容归企业 NAS，Manager 不落库。成功响应遵循统一 envelope，失败返回 problem+json。",
    )
    async def list_nas_knowledge_bases(
        request: Request, knowledge_space_id: str = _SPACE_ID, claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[NasKnowledgeBaseOut]:
        items = _gateway(request).list_knowledge_bases(
            tenant_context_from(claims), knowledge_space_id=knowledge_space_id,
        )
        return ListEnvelope[NasKnowledgeBaseOut](data=items)

    @router.get(
        "/{knowledge_space_id}/nas/knowledge-bases/{nas_knowledge_base_id}/search",
        operation_id="manager_knowledge_nas_search", summary="检索企业 NAS 知识库（只读网关）",
        description="经 Manager 检索企业 NAS 上的知识库；本租户已认证成员可读。检索词只转发给企业 NAS，不落库。"
        "成功响应遵循统一 envelope，失败返回 problem+json。",
    )
    async def search_nas_knowledge_base(
        request: Request,
        knowledge_space_id: str = _SPACE_ID,
        nas_knowledge_base_id: str = _NAS_KB_ID,
        query: str = Query(min_length=1, max_length=512, description="检索关键词。", examples=["采购政策"]),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[NasKnowledgeSearchOut]:
        out = _gateway(request).search(
            tenant_context_from(claims), knowledge_space_id=knowledge_space_id,
            knowledge_base_id=nas_knowledge_base_id, query=query,
        )
        return Envelope[NasKnowledgeSearchOut](data=out)

    @router.get(
        "/{knowledge_space_id}/nas/documents/{nas_document_id}/preview",
        operation_id="manager_knowledge_nas_preview", summary="预览企业 NAS 文档（只读网关）",
        description="经 Manager 读取企业 NAS 文档预览；仅 text/markdown 返回正文，其余返回 mode=unsupported"
        "（不转发 NAS 内网地址）。本租户已认证成员可读。成功响应遵循统一 envelope，失败返回 problem+json。",
    )
    async def preview_nas_document(
        request: Request,
        knowledge_space_id: str = _SPACE_ID,
        nas_document_id: str = _NAS_DOC_ID,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[NasKnowledgeDocumentPreviewOut]:
        out = _gateway(request).preview_document(
            tenant_context_from(claims), knowledge_space_id=knowledge_space_id, document_id=nas_document_id,
        )
        return Envelope[NasKnowledgeDocumentPreviewOut](data=out)

    return router


__all__ = ["build_knowledge_nas_router"]
