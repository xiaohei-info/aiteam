"""Authorized facade over the external knowledge artifact/index service."""

from __future__ import annotations

from typing import Protocol

from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden


class SnapshotAuthorizer(Protocol):
    def generate(
        self,
        ctx: TenantContext,
        *,
        member_id: str,
        employee_id: str,
        employee_version: str | None = None,
    ) -> EmployeeExecutionSnapshot: ...


class ArtifactIndex(Protocol):
    def search(self, ctx: TenantContext, *, employee_id: str, knowledge_refs: list[str], query: str, limit: int) -> dict: ...

    def get(self, ctx: TenantContext, *, employee_id: str, knowledge_refs: list[str], citation_id: str) -> dict: ...


class KnowledgeArtifactService:
    """Authorize against the current Manager snapshot before any external call."""

    def __init__(self, *, snapshot: SnapshotAuthorizer, index: ArtifactIndex):
        self._snapshot = snapshot
        self._index = index

    def search(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        knowledge_refs: list[str],
        query: str,
        limit: int,
    ) -> dict:
        authorized_refs = self._authorized_refs(
            ctx, employee_id=employee_id, knowledge_refs=knowledge_refs
        )
        return self._index.search(
            ctx,
            employee_id=employee_id,
            knowledge_refs=authorized_refs,
            query=query,
            limit=limit,
        )

    def get(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        knowledge_refs: list[str],
        citation_id: str,
    ) -> dict:
        authorized_refs = self._authorized_refs(
            ctx, employee_id=employee_id, knowledge_refs=knowledge_refs
        )
        return self._index.get(
            ctx,
            employee_id=employee_id,
            knowledge_refs=authorized_refs,
            citation_id=citation_id,
        )

    def _authorized_refs(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        knowledge_refs: list[str],
    ) -> list[str]:
        snapshot = self._snapshot.generate(
            ctx,
            member_id=ctx.user_id,
            employee_id=employee_id,
        )
        allowed = set(snapshot.knowledge_refs)
        requested = set(knowledge_refs)
        if not requested.issubset(allowed):
            raise Forbidden("knowledge reference is not authorized for this employee snapshot")
        # Preserve the caller's snapshot-bound order; duplicate refs are not useful downstream.
        return list(dict.fromkeys(knowledge_refs))
