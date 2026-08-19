"""知识文档 intake 北向路由（issue #416；02 §10.1/§10.3 + 04 §6.1.2/§6.6；D21/D22）。

路径：/api/manager/knowledge-spaces/{knowledge_space_id}/documents/* 与 /ingestions/*。
受保护端点（require_claims）；写操作需 owner/enterprise_admin（service 层强校验）。
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22）。

红线（D21）：
- LightRAG 写入只由 Manager-owned ingestion client 执行，HTTP 入参不接受凭据。
- workspace 只由 ManagerRagService 推导，HTTP 入参不接受 workspace。
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, File, Request, UploadFile, status
from fastapi.responses import Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .knowledge_intake_service import KnowledgeIntakeService, build_knowledge_intake_service, ensure_storage_root, manager_storage_root
from .rag import PgManagerRagService
from .rag_ingestion import LightRagIngestionClient
from .schemas import (
    KnowledgeDocumentBindingOut,
    KnowledgeDocumentImportUrl,
    KnowledgeDocumentOut,
    KnowledgeIngestionJobOut,
)

logger = logging.getLogger(__name__)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> KnowledgeIntakeService:
    """从端配置构造 KnowledgeIntakeService；存储根为持久化配置目录。"""
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_knowledge_intake_service", None)
    if cache is None:
        router = PgTenantRouter(dsn)
        root = ensure_storage_root(manager_storage_root(request.app.state.settings))
        ingestion_client = getattr(request.app.state, "_knowledge_intake_ingestion_client", None)
        if ingestion_client is None:
            ingestion_client = LightRagIngestionClient()
        cache = build_knowledge_intake_service(
            router,
            storage_root=root,
            rag_service=PgManagerRagService(dsn),
            ingestion_client=ingestion_client,
        )
        request.app.state._knowledge_intake_service = cache
    return cache


def build_knowledge_intake_router(verifier) -> APIRouter:
    """构造知识文档 intake 路由；verifier 由 app 持有并闭包注入受保护端点。"""
    require = require_claims(verifier)
    router = APIRouter(tags=["manager", "knowledge-intake"])

    @router.get(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents",
        summary="列知识空间全部文档（含 intake 状态）",
        operation_id="manager_knowledge_intake_list_documents",
    )
    async def list_documents(
        knowledge_space_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[KnowledgeDocumentOut]:
        svc = _service(request)
        items = await asyncio.to_thread(
            svc.list_documents, tenant_context_from(claims), knowledge_space_id=knowledge_space_id
        )
        return ListEnvelope[KnowledgeDocumentOut](data=items)

    @router.post(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents",
        summary="上传知识文档（multipart，走完整 intake 状态机）",
        operation_id="manager_knowledge_intake_upload",
        status_code=status.HTTP_201_CREATED,
    )
    async def upload_document(
        knowledge_space_id: str,
        request: Request,
        file: UploadFile = File(...),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeDocumentOut]:
        svc = _service(request)
        content = await file.read()
        if not content:
            from shared.errors import ValidationProblem
            raise ValidationProblem(detail="empty file", errors=None)
        doc, _job = await asyncio.to_thread(
            svc.ingest_upload,
            tenant_context_from(claims),
            knowledge_space_id=knowledge_space_id,
            display_name=(file.filename or "untitled"),
            file_name=(file.filename or "untitled"),
            file_type=(file.content_type or "application/octet-stream"),
            content=content,
        )
        return Envelope[KnowledgeDocumentOut](data=doc)

    @router.post(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/url",
        summary="从 URL 导入文档（抓取 → 解析 → intake）",
        operation_id="manager_knowledge_intake_import_url",
        status_code=status.HTTP_201_CREATED,
    )
    async def import_url(
        knowledge_space_id: str,
        body: KnowledgeDocumentImportUrl,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeDocumentOut]:
        svc = _service(request)
        try:
            doc, _job = await asyncio.to_thread(
                svc.ingest_url,
                tenant_context_from(claims),
                knowledge_space_id=knowledge_space_id,
                url=body.url,
                display_name=body.display_name,
            )
        except ValueError as exc:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail=str(exc)[:300])
        return Envelope[KnowledgeDocumentOut](data=doc)

    @router.post(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/retry",
        summary="重试失败/已完成的文档 intake",
        operation_id="manager_knowledge_intake_retry",
        status_code=status.HTTP_201_CREATED,
    )
    async def retry_document(
        knowledge_space_id: str,
        document_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeDocumentOut]:
        svc = _service(request)
        doc, _job = await asyncio.to_thread(
            svc.retry,
            tenant_context_from(claims),
            knowledge_space_id=knowledge_space_id,
            document_id=document_id,
        )
        return Envelope[KnowledgeDocumentOut](data=doc)

    @router.get(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/ingestion",
        summary="取文档最新 intake 任务状态",
        operation_id="manager_knowledge_intake_get",
    )
    async def get_ingestion(
        knowledge_space_id: str,
        document_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeIngestionJobOut]:
        svc = _service(request)
        job = await asyncio.to_thread(
            svc.get_ingestion,
            tenant_context_from(claims), knowledge_space_id=knowledge_space_id, document_id=document_id
        )
        return Envelope[KnowledgeIngestionJobOut](data=job)

    @router.get(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/ingestions",
        summary="列知识空间全部 intake 任务",
        operation_id="manager_knowledge_intake_list_ingestions",
    )
    async def list_ingestions(
        knowledge_space_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[KnowledgeIngestionJobOut]:
        svc = _service(request)
        items = await asyncio.to_thread(
            svc.list_ingestions, tenant_context_from(claims), knowledge_space_id=knowledge_space_id
        )
        return ListEnvelope[KnowledgeIngestionJobOut](data=items)

    @router.get(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/bindings",
        summary="列文档的索引绑定（已完成 intake 时已绑员工视图）",
        operation_id="manager_knowledge_intake_list_bindings",
    )
    async def list_bindings(
        knowledge_space_id: str,
        document_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[KnowledgeDocumentBindingOut]:
        svc = _service(request)
        items = await asyncio.to_thread(
            svc.list_bindings,
            tenant_context_from(claims), knowledge_space_id=knowledge_space_id, document_id=document_id
        )
        return ListEnvelope[KnowledgeDocumentBindingOut](data=items)

    return router
