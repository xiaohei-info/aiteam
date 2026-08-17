"""Authenticated Manager facade for external knowledge artifact retrieval."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .employee_bindings_repositories import EmployeeKnowledgeBindingRepository
from .employee_config_service import build_employee_config_service
from .enterprise_audit_repository import build_enterprise_audit_repository
from .knowledge_artifact_client import KnowledgeArtifactClient
from .knowledge_artifact_service import KnowledgeArtifactService
from .member_service import GrantService, MemberDeptService
from .repository_member import GrantRepository, MemberDeptRepository
from .snapshot_service import build_snapshot_service


class KnowledgeArtifactSearchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    employee_id: str = Field(min_length=1)
    knowledge_refs: list[str] = Field(min_length=0)
    query: str = Field(min_length=1, max_length=8_000)
    limit: int = Field(default=10, ge=1, le=100)


class KnowledgeArtifactGetIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    employee_id: str = Field(min_length=1)
    knowledge_refs: list[str] = Field(min_length=0)
    citation_id: str = Field(min_length=1, max_length=512)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> KnowledgeArtifactService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_knowledge_artifact_service", None)
    if cache is None:
        router = PgTenantRouter(dsn)
        member_repo = MemberDeptRepository(router)
        grant_repo = GrantRepository(router)
        snapshot = build_snapshot_service(
            config_service=build_employee_config_service(router),
            grant_service=GrantService(repo=grant_repo, members=member_repo),
            member_service=MemberDeptService(repo=member_repo),
            audit_recorder=build_enterprise_audit_repository(router),
            knowledge_binding=EmployeeKnowledgeBindingRepository(router),
        )
        index = getattr(request.app.state, "_knowledge_artifact_client", None)
        cache = build_knowledge_artifact_service(
            snapshot=snapshot,
            index=index or KnowledgeArtifactClient(),
        )
        request.app.state._knowledge_artifact_service = cache
    return cache


def build_knowledge_artifact_service(*, snapshot, index) -> KnowledgeArtifactService:
    return KnowledgeArtifactService(snapshot=snapshot, index=index)


def build_knowledge_artifact_router(verifier) -> APIRouter:
    router = APIRouter(
        prefix="/api/manager/knowledge/artifacts",
        tags=["manager", "knowledge-artifact"],
    )
    require = require_claims(verifier)

    @router.post(
        "/search",
        summary="搜索当前员工快照授权的知识产物",
        operation_id="manager_knowledge_artifact_search",
    )
    async def search_artifacts(
        body: KnowledgeArtifactSearchIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        data = _service(request).search(
            tenant_context_from(claims),
            employee_id=body.employee_id,
            knowledge_refs=body.knowledge_refs,
            query=body.query,
            limit=body.limit,
        )
        return Envelope[dict](data=data)

    @router.post(
        "/get",
        summary="读取当前员工快照授权的知识引用",
        operation_id="manager_knowledge_artifact_get",
    )
    async def get_artifact(
        body: KnowledgeArtifactGetIn,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        data = _service(request).get(
            tenant_context_from(claims),
            employee_id=body.employee_id,
            knowledge_refs=body.knowledge_refs,
            citation_id=body.citation_id,
        )
        return Envelope[dict](data=data)

    return router
