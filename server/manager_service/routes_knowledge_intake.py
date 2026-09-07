"""Enterprise document intake compatibility routes (issue #416; 02 §10.1/§10.3 + 04 §6.1.2/6.6; D21/D22).

The existing `/knowledge-spaces/{knowledge_space_id}/documents/*` path remains
for internal/citation compatibility; the Manager UI supplies only its fixed
enterprise key and never exposes a workspace.
受保护端点（require_claims）；写操作需 owner/enterprise_admin（service 层强校验）。
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22）。

红线（D21）：
- LightRAG 写入只由 Manager-owned ingestion client 执行，HTTP 入参不接受凭据。
- workspace 只由 ManagerRagService 推导，HTTP 入参不接受 workspace。
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, File, Header, Request, UploadFile, status
from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .analytics_schemas import KnowledgeAnalyticsOut
from .knowledge_intake_service import (
    KnowledgeIntakeService,
    RagDeletionBusy,
    build_knowledge_intake_service,
    ensure_storage_root,
    manager_storage_root,
)
from .rag import PgManagerRagService
from .rag_instances import RagInstanceRegistry
from .rag_ingestion import LightRagIngestionClient, RagIngestionUnavailable
from .schemas import (
    KnowledgeDocumentBindingOut,
    KnowledgeDocumentImportUrl,
    KnowledgeDocumentOperationOut,
    KnowledgeDocumentOut,
    KnowledgeIngestionJobOut,
)

logger = logging.getLogger(__name__)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


class _KnowledgeUpstreamUnavailable(AppError):
    status, code, title = 503, "knowledge_upstream_unavailable", "Knowledge service unavailable"

    def __init__(self, _detail: str | None = None):
        super().__init__("Knowledge operation is temporarily unavailable; retry later.")


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
        registry = RagInstanceRegistry.from_env()
        enterprise_workspace = registry.instances[0].workspace if registry is not None else "enterprise_shared"
        cache = build_knowledge_intake_service(
            router,
            storage_root=root,
            rag_service=PgManagerRagService(
                dsn, instance_registry=registry, enterprise_workspace=enterprise_workspace,
            ),
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

    @router.get(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/analytics",
        summary="读取企业知识库 LightRAG 统计与文档活动",
        description="返回固定企业 workspace 的安全元数据投影；不接受 workspace 或凭据，也不返回文档正文。",
        operation_id="manager_knowledge_analytics",
    )
    async def knowledge_analytics(
        knowledge_space_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[KnowledgeAnalyticsOut]:
        svc = _service(request)
        data = await asyncio.to_thread(
            svc.analytics,
            tenant_context_from(claims),
            knowledge_space_id=knowledge_space_id,
        )
        return ListEnvelope[KnowledgeAnalyticsOut](data=[data])

    @router.post(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents",
        summary="上传知识文档（multipart，走完整 intake 状态机）",
        operation_id="manager_knowledge_intake_upload",
        status_code=status.HTTP_201_CREATED,
    )
    async def upload_document(
        knowledge_space_id: str,
        request: Request,
        background_tasks: BackgroundTasks,
        file: UploadFile = File(...),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeDocumentOut]:
        svc = _service(request)
        # Read only enough to enforce the existing 4 MiB intake limit.
        content = await file.read(4 * 1024 * 1024 + 1)
        if not content:
            from shared.errors import ValidationProblem
            raise ValidationProblem(detail="empty file", errors=None)
        ctx = tenant_context_from(claims)
        doc, job = await asyncio.to_thread(
            svc.prepare_upload,
            ctx,
            knowledge_space_id=knowledge_space_id,
            display_name=(file.filename or "untitled"),
            file_name=(file.filename or "untitled"),
            file_type=(file.content_type or "application/octet-stream"),
            content=content,
        )
        background_tasks.add_task(
            svc.process_ingestion,
            ctx,
            knowledge_space_id=knowledge_space_id,
            document_id=doc.id,
            job_id=job.id,
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

    @router.delete(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}",
        summary="请求删除知识文档索引（异步，撤销当前 citation）",
        operation_id="manager_knowledge_intake_delete",
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def delete_document(
        knowledge_space_id: str,
        document_id: str,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeDocumentOperationOut]:
        svc = _service(request)
        try:
            operation = await asyncio.to_thread(
                svc.delete,
                tenant_context_from(claims),
                knowledge_space_id=knowledge_space_id,
                document_id=document_id,
                idempotency_key=idempotency_key,
            )
        except RagDeletionBusy:
            # busy is a retryable upstream state, not a successful deletion.
            raise
        except RagIngestionUnavailable as exc:
            raise _KnowledgeUpstreamUnavailable() from exc
        return Envelope[KnowledgeDocumentOperationOut](data=operation)

    @router.post(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/reconcile-delete",
        summary="核对 LightRAG 删除完成并安全清理源文档（受控重试）",
        operation_id="manager_knowledge_intake_reconcile_delete",
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def reconcile_delete_document(
        knowledge_space_id: str,
        document_id: str,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeDocumentOperationOut]:
        svc = _service(request)
        try:
            operation = await asyncio.to_thread(
                svc.reconcile_delete,
                tenant_context_from(claims),
                knowledge_space_id=knowledge_space_id,
                document_id=document_id,
                idempotency_key=idempotency_key,
            )
        except RagIngestionUnavailable as exc:
            raise _KnowledgeUpstreamUnavailable() from exc
        return Envelope[KnowledgeDocumentOperationOut](data=operation)

    @router.post(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/reindex",
        summary="重建知识文档索引（异步 envelope，失败可重试）",
        operation_id="manager_knowledge_intake_reindex",
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def reindex_document(
        knowledge_space_id: str,
        document_id: str,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeDocumentOperationOut]:
        svc = _service(request)
        try:
            operation = await asyncio.to_thread(
                svc.reindex,
                tenant_context_from(claims),
                knowledge_space_id=knowledge_space_id,
                document_id=document_id,
                idempotency_key=idempotency_key,
            )
        except RagIngestionUnavailable as exc:
            raise _KnowledgeUpstreamUnavailable() from exc
        return Envelope[KnowledgeDocumentOperationOut](data=operation)

    @router.post(
        "/api/manager/knowledge-spaces/{knowledge_space_id}/documents/{document_id}/retry",
        summary="兼容重试失败/已完成的文档 intake",
        operation_id="manager_knowledge_intake_retry",
        status_code=status.HTTP_201_CREATED,
    )
    async def retry_document(
        knowledge_space_id: str,
        document_id: str,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeDocumentOut]:
        svc = _service(request)
        try:
            doc, _job = await asyncio.to_thread(
                svc.retry,
                tenant_context_from(claims),
                knowledge_space_id=knowledge_space_id,
                document_id=document_id,
                idempotency_key=idempotency_key,
            )
        except RagIngestionUnavailable as exc:
            raise _KnowledgeUpstreamUnavailable() from exc
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
