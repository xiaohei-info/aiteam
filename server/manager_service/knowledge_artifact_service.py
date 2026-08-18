"""Authorized local bundle exporter for Manager's durable knowledge source.

Manager knowledge storage is clean-install only: this exporter reads documents
written by the current intake path and does not migrate legacy knowledge files.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Protocol

from .document_parser import extract_text
from .knowledge_intake_repository import KnowledgeDocumentRepository, KnowledgeDocumentBindingRepository

from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext


class SnapshotAuthorizer(Protocol):
    def generate(
        self,
        ctx: TenantContext,
        *,
        member_id: str,
        employee_id: str,
        employee_version: str | None = None,
    ) -> EmployeeExecutionSnapshot: ...


class AuthorizedConfigPuller(Protocol):
    def pull(self, ctx: TenantContext, req) -> object: ...


class KnowledgeArtifactBundleService:
    """Export the authorized, durable document source as a local-first bundle.

    This is intentionally an export seam, not a LightRAG query integration. A future
    LightRAG adapter may replace ``extract_text``/``_chunks`` without changing the
    Agent contract.
    """

    def __init__(self, *, config: AuthorizedConfigPuller, snapshot: SnapshotAuthorizer,
                 documents: KnowledgeDocumentRepository, bindings: KnowledgeDocumentBindingRepository,
                 storage_root: Path):
        self._config = config
        self._snapshot = snapshot
        self._documents = documents
        self._bindings = bindings
        self._root = storage_root.resolve()

    def pull(self, ctx: TenantContext, *, known_versions: dict[str, str] | None = None) -> dict:
        from shared.contracts.crosstier import AuthorizedConfigPullRequest
        # A bundle is a complete authoritative roster. known_versions is for other
        # projections only; using it here could turn an unchanged sync into an empty delete.
        config = self._config.pull(ctx, AuthorizedConfigPullRequest(
            tenant_id=ctx.tenant_id, member_id=ctx.user_id, known_versions={}
        ))
        experts = getattr(config, "experts", [])
        artifacts: list[dict] = []
        artifact_bytes = 0
        for expert in experts:
            employee_id = str(expert.get("employee_id") if isinstance(expert, dict) else expert.employee_id)
            snapshot = self._snapshot.generate(ctx, member_id=ctx.user_id, employee_id=employee_id)
            refs = set(snapshot.knowledge_refs)
            for binding in self._bindings.list_by_employee(ctx, employee_id=employee_id, status="ready"):
                doc = self._documents.get(ctx, document_id=binding.document_id)
                if doc is None or doc.status != "ready":
                    continue
                if binding.tenant_id != doc.tenant_id or doc.tenant_id != ctx.tenant_id:
                    raise ValueError("knowledge binding and document tenant mismatch")
                if binding.knowledge_space_id != doc.knowledge_space_id:
                    raise ValueError("knowledge binding and document space mismatch")
                if binding.knowledge_space_id not in refs:
                    continue
                path = self._safe_path(
                    doc.storage_key, tenant_id=ctx.tenant_id, knowledge_space_id=doc.knowledge_space_id
                )
                if not path.is_file():
                    raise ValueError("knowledge document storage file is missing")
                if path.stat().st_size > MAX_BUNDLE_ARTIFACT_BYTES:
                    raise ValueError("knowledge bundle artifact byte limit exceeded")
                raw = path.read_bytes()
                source_hash = hashlib.sha256(raw).hexdigest()
                version = f"exporter:{EXPORTER_SCHEMA_VERSION};chunker:{CHUNKER_SCHEMA_VERSION};sha256:{source_hash}"
                text = extract_text(path)
                for chunk_index, chunk in enumerate(_chunks(text)):
                    if len(artifacts) >= MAX_BUNDLE_ARTIFACTS:
                        raise ValueError("knowledge bundle artifact count limit exceeded")
                    chunk_bytes = len(chunk.encode("utf-8"))
                    if artifact_bytes + chunk_bytes > MAX_BUNDLE_ARTIFACT_BYTES:
                        raise ValueError("knowledge bundle artifact byte limit exceeded")
                    citation_id = hashlib.sha256(
                        f"{EXPORTER_SCHEMA_VERSION}|{CHUNKER_SCHEMA_VERSION}|{ctx.tenant_id}|{ctx.user_id}|{employee_id}|{doc.knowledge_space_id}|{doc.id}|{version}|{chunk_index}".encode()
                    ).hexdigest()
                    artifacts.append({
                        "tenant_id": ctx.tenant_id, "member_id": ctx.user_id,
                        "employee_id": employee_id, "knowledge_space_id": doc.knowledge_space_id,
                        "document_id": doc.id, "artifact_version": version,
                        "source_hash": source_hash, "citation_id": citation_id,
                        "chunk_index": chunk_index, "title": doc.display_name,
                        "source": {"type": doc.source_type, "name": doc.file_name, "mime_type": doc.file_type},
                        "content": chunk,
                    })
                    artifact_bytes += chunk_bytes
        artifacts.sort(key=lambda item: (item["employee_id"], item["knowledge_space_id"], item["document_id"], item["chunk_index"]))
        payload = {"artifacts": artifacts, "authoritative": True}
        if len(artifacts) > MAX_BUNDLE_ARTIFACTS:
            raise ValueError("knowledge bundle artifact count limit exceeded")
        if artifact_bytes > MAX_BUNDLE_ARTIFACT_BYTES:
            raise ValueError("knowledge bundle artifact byte limit exceeded")
        if len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_BUNDLE_RESPONSE_BYTES:
            raise ValueError("knowledge bundle response limit exceeded")
        return payload

    def _safe_path(self, storage_key: str, *, tenant_id: str, knowledge_space_id: str) -> Path:
        candidate = (self._root / storage_key).resolve()
        try:
            relative = candidate.relative_to(self._root)
        except ValueError as exc:
            raise ValueError("storage_key escapes configured knowledge root") from exc
        expected = Path("knowledge") / tenant_id / knowledge_space_id
        if len(relative.parts) < 4 or relative.parts[:3] != expected.parts:
            raise ValueError("storage_key is outside its tenant and knowledge-space namespace")
        return candidate


EXPORTER_SCHEMA_VERSION = "knowledge-export-v1"
CHUNKER_SCHEMA_VERSION = "fixed-chunker-1200-v1"
MAX_BUNDLE_ARTIFACTS = 4_096
MAX_BUNDLE_ARTIFACT_BYTES = 32 * 1024 * 1024
MAX_BUNDLE_RESPONSE_BYTES = 48 * 1024 * 1024


def _chunks(text: str, size: int = 1_200) -> list[str]:
    return [text[offset:offset + size] for offset in range(0, len(text), size)] if text else []
