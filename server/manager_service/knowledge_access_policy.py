"""One effective RAG policy for Manager projections and every MCP operation.

Index readiness is not administrator intent. Only explicit policy columns deny
an employee a document permanently; resource revocation lasts until publication.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, TYPE_CHECKING

from shared.contracts.snapshot import KnowledgePolicySnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden

if TYPE_CHECKING:
    from .employee_bindings_repositories import KnowledgeBindingRow
    from .knowledge_intake_repository import KnowledgeDocumentBindingRow


DEFAULT_EMPLOYEE_TOOLS = (
    "bash", "read", "write", "edit", "todo_update",
    "knowledge_search", "knowledge_get", "hindsight_recall", "hindsight_retain",
)
KNOWLEDGE_TOOLS = ("knowledge_search", "knowledge_get")


class WholeBindingReader(Protocol):
    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[KnowledgeBindingRow]: ...


class DocumentBindingReader(Protocol):
    def list_by_employee(self, ctx: TenantContext, *, employee_id: str) -> list[KnowledgeDocumentBindingRow]: ...


@dataclass(frozen=True)
class KnowledgeAccess:
    projection: KnowledgePolicySnapshot
    tools: tuple[str, ...]
    refs: tuple[str, ...]
    denied_documents: frozenset[str]
    fingerprint: tuple[object, ...]

    def require(self, operation: str | None = None) -> None:
        if self.projection.state == "deny" or not self.projection.allowed_operations:
            raise Forbidden("employee knowledge access denied")
        if operation is not None and operation not in self.projection.allowed_operations:
            raise Forbidden("employee knowledge operation denied")

    def permits_document(self, document_id: str) -> bool:
        return document_id not in self.denied_documents


def _owned(row, ctx: TenantContext, employee_id: str) -> bool:
    return (getattr(row, "tenant_id", ctx.tenant_id) == ctx.tenant_id
            and getattr(row, "employee_id", employee_id) == employee_id)


class KnowledgeAccessPolicy:
    def __init__(self, whole: WholeBindingReader | None = None,
                 documents: DocumentBindingReader | None = None):
        self._whole = whole
        self._documents = documents

    def resolve(self, ctx: TenantContext, *, employee_id: str, tools: list[str] | None,
                version: str) -> KnowledgeAccess:
        whole = list(self._whole.list_all(ctx, employee_id=employee_id)) if self._whole else []
        documents = list(self._documents.list_by_employee(ctx, employee_id=employee_id)) if self._documents else []
        if any(not _owned(row, ctx, employee_id) for row in [*whole, *documents]):
            raise Forbidden("employee knowledge policy scope mismatch")
        denied = any(row.enabled is False or getattr(row, "revoked_at", None) is not None for row in whole)
        state = "deny" if denied else "allow" if whole else "inherit"
        # Legacy config.tools=[] means platform defaults. A nonempty allowlist
        # never grants missing knowledge operations. Projection [] is explicit.
        effective_tools = tuple(tools or DEFAULT_EMPLOYEE_TOOLS)
        if denied:
            effective_tools = tuple(tool for tool in effective_tools if tool not in KNOWLEDGE_TOOLS)
        operations = [tool for tool in KNOWLEDGE_TOOLS if tool in effective_tools]
        refs = tuple(dict.fromkeys(row.knowledge_space_id for row in whole if row.enabled)) if not denied else ()
        denied_documents = frozenset(
            row.document_id for row in documents
            if getattr(row, "enabled", None) is False or getattr(row, "revoked_at", None) is not None
            or row.status == "revoked"
        )
        fingerprint = (
            str(version), state, effective_tools,
            tuple(sorted((str(row.binding_id), row.enabled, getattr(row, "policy_revision", 0),
                          str(getattr(row, "revoked_at", None))) for row in whole)),
            tuple(sorted((row.document_id, row.status, getattr(row, "enabled", None),
                          getattr(row, "policy_revision", 0), str(getattr(row, "revoked_at", None)))
                         for row in documents)),
        )
        return KnowledgeAccess(
            KnowledgePolicySnapshot(state=state, allowed_operations=operations, revision=str(version)),
            effective_tools, refs, denied_documents, fingerprint,
        )
