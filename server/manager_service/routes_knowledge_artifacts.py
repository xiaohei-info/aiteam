"""Authenticated Manager facade for external knowledge artifact retrieval."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .employee_config_service import build_employee_config_service
from .enterprise_audit_repository import build_enterprise_audit_repository
from .knowledge_artifact_service import KnowledgeArtifactBundleService
from .knowledge_intake_repository import KnowledgeDocumentBindingRepository, KnowledgeDocumentRepository
from .knowledge_intake_service import ensure_storage_root, manager_storage_root
from .employee_bindings_repositories import EmployeeKnowledgeBindingRepository
from .routes_grants import _authorized_config_service
from .member_service import GrantService, MemberDeptService
from .repository_member import GrantRepository, MemberDeptRepository
from .snapshot_service import build_snapshot_service


class KnowledgeArtifactBundleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    known_versions: dict[str, str] = Field(default_factory=dict)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _storage_root(request: Request) -> Path:
    # Intake and export share the canonical Settings path.
    return manager_storage_root(request.app.state.settings)


def _bundle_service(request: Request) -> KnowledgeArtifactBundleService:
    cache = getattr(request.app.state, "_knowledge_artifact_bundle_service", None)
    if cache is None:
        dsn = request.app.state.settings.db_url
        if not dsn:
            raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
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
        doc_repo = KnowledgeDocumentRepository(router)
        binding_repo = KnowledgeDocumentBindingRepository(router)
        storage_root = ensure_storage_root(_storage_root(request))
        cache = KnowledgeArtifactBundleService(
            config=_authorized_config_service(request), snapshot=snapshot,
            documents=doc_repo, bindings=binding_repo, storage_root=storage_root,
        )
        request.app.state._knowledge_artifact_bundle_service = cache
    return cache


def build_knowledge_artifact_router(verifier) -> APIRouter:
    router = APIRouter(
        prefix="/api/manager/knowledge/artifacts",
        tags=["manager", "knowledge-artifact"],
    )
    require = require_claims(verifier)

    @router.post(
        "/bundle",
        summary="Agent 拉取当前授权知识产物完整本地包",
        operation_id="manager_knowledge_artifact_bundle",
    )
    async def pull_bundle(
        request: Request,
        body: KnowledgeArtifactBundleIn = Body(default=KnowledgeArtifactBundleIn()),
        claims: TokenClaims = Depends(require),
    ) -> Envelope[dict]:
        # Identity is exclusively token-derived; body only carries known artifact versions.
        ctx = tenant_context_from(claims)
        return Envelope[dict](data=_bundle_service(request).pull(ctx, known_versions=body.known_versions))

    return router
