"""Manager-owned read-only RAG MCP facade.

The facade is the only northbound RAG surface.  It derives the LightRAG
workspace after checking the current employee snapshot and bindings; callers
never provide a workspace or LightRAG credential.
"""
import asyncio
import contextlib
import contextvars
import hashlib
import json
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import httpx
from fastapi import FastAPI
from mcp.server.fastmcp import FastMCP
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from shared.auth import TokenVerifier, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Problem
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Forbidden, Unauthorized

from .document_parser import extract_text
from .employee_config_service import employee_runnable
from .knowledge_artifact_service import _chunks as _manager_chunks
from .knowledge_intake_repository import KnowledgeDocumentRepository
from .knowledge_intake_service import _resolve_path
from .rag import RagHandle
from .rag_instances import RagInstance, RagInstanceConfigurationError, RagInstanceRegistry

MCP_MOUNT_PATH = "/api/manager/rag"
MCP_ENDPOINT_PATH = f"{MCP_MOUNT_PATH}/mcp"
_MAX_QUERY_CHARS = 8_000
_MAX_LIMIT = 20
_MAX_CHUNK_CHARS = 4_000
_MAX_RESPONSE_BYTES = 64 * 1024
_MAX_CITATION_TOKEN_CHARS = 256
_MAX_UPSTREAM_ALIAS_CHARS = 1_024
_MANAGER_CHUNK_CHARS = 1_200
_SAFE_CITATION_TOKEN = re.compile(r"^[A-Za-z0-9_-]{1,256}$")
_EXACT_CITATION_TOKEN = re.compile(
    r"^v([0-9a-f]{64})(?:-i([0-9]{1,9}))?(?:-o([0-9]{1,9})-l([0-9]{1,9}))?$"
)
_DOCUMENT_CITATION_TOKEN = re.compile(r"^v([0-9a-f]{64})-d$")
_AMBIGUOUS_UPSTREAM_VALUE = object()


class RagUnavailable(RuntimeError):
    """An upstream RAG failure with no upstream details exposed to clients."""


@dataclass(frozen=True)
class _ParsedCitation:
    knowledge_space_id: str
    document_id: str
    version_digest: str | None = None
    chunk_index: int | None = None
    chunk_offset: int | None = None
    chunk_length: int | None = None


def _parse_citation_id(citation_id: str) -> _ParsedCitation:
    if not isinstance(citation_id, str) or len(citation_id) > 1_024:
        raise RagUnavailable("knowledge service unavailable")
    parts = citation_id.split(":")
    if len(parts) not in (3, 4) or parts[0] != "citation":
        raise RagUnavailable("knowledge service unavailable")
    if any(
        not part
        or part.strip() != part
        or any(char in part for char in "\r\n\t")
        for part in parts[1:]
    ):
        raise RagUnavailable("knowledge service unavailable")
    if len(parts) == 3:
        return _ParsedCitation(parts[1], parts[2])
    token = parts[3]
    if len(token) > _MAX_CITATION_TOKEN_CHARS or not _SAFE_CITATION_TOKEN.fullmatch(token):
        raise RagUnavailable("knowledge service unavailable")
    match = _EXACT_CITATION_TOKEN.fullmatch(token)
    if match is not None:
        index = int(match.group(2)) if match.group(2) is not None else None
        offset = int(match.group(3)) if match.group(3) is not None else None
        length = int(match.group(4)) if match.group(4) is not None else None
        if (
            index is None
            and offset is None
            or index is not None and index > 999_999_999
            or offset is not None and (offset < 0 or offset > 999_999_999)
            or length is not None and (length < 1 or length > _MAX_CHUNK_CHARS)
        ):
            raise RagUnavailable("knowledge service unavailable")
        return _ParsedCitation(parts[1], parts[2], match.group(1), index, offset, length)
    match = _DOCUMENT_CITATION_TOKEN.fullmatch(token)
    if match is not None:
        return _ParsedCitation(parts[1], parts[2], match.group(1))
    raise RagUnavailable("knowledge service unavailable")


def _citation_version(digest: str) -> str:
    return f"sha256:{digest}"


def _version_digest(version: str) -> str:
    if not isinstance(version, str) or not version.startswith("sha256:"):
        raise RagUnavailable("knowledge service unavailable")
    digest = version[7:]
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise RagUnavailable("knowledge service unavailable")
    return digest


def _chunk_token(
    version: str, index: int | None = None, *, offset: int | None = None, length: int | None = None
) -> str:
    token = f"v{_version_digest(version)}"
    if index is not None:
        token += f"-i{index}"
    if offset is not None and length is not None:
        token += f"-o{offset}-l{length}"
    if index is None and (offset is None or length is None):
        raise RagUnavailable("knowledge service unavailable")
    return token


def _document_token(version: str) -> str:
    return f"v{_version_digest(version)}-d"


@dataclass(frozen=True)
class LightRagSettings:
    url: str
    api_key: str = field(repr=False)
    timeout_ms: int = 5_000
    query_mode: str = "naive"
    workspace: str | None = None
    instance_registry: RagInstanceRegistry | None = None

    @classmethod
    def from_env(cls) -> "LightRagSettings | None":
        registry = RagInstanceRegistry.from_env()
        if registry is None:
            return None
        first = registry.instances[0]
        try:
            timeout_ms = max(100, min(int(os.getenv("LIGHTRAG_TIMEOUT_MS", "5000")), 30_000))
        except ValueError:
            timeout_ms = 5_000
        query_mode = os.getenv("LIGHTRAG_QUERY_MODE", "naive").strip().lower()
        if query_mode not in {"local", "global", "hybrid", "naive", "mix"}:
            query_mode = "naive"
        return cls(first.url, first.api_key, timeout_ms, query_mode, first.workspace, registry)


class LightRagClient:
    """Small bounded client for LightRAG's structured, no-LLM query endpoint."""

    def __init__(self, settings: LightRagSettings | None = None, *, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings if settings is not None else LightRagSettings.from_env()
        self._http = httpx.AsyncClient(transport=transport) if transport else httpx.AsyncClient()

    @property
    def instance_registry(self) -> RagInstanceRegistry | None:
        return self.settings.instance_registry if self.settings is not None else None

    def instance_for_workspace(self, workspace: str) -> RagInstance:
        settings = self.settings
        if settings is None:
            raise RagUnavailable("knowledge service unavailable")
        try:
            if settings.instance_registry is not None:
                return settings.instance_registry.resolve(workspace)
            # Explicit constructor settings remain useful to tests and local
            # callers. Environment-created settings always have a fixed map.
            if settings.workspace is not None and workspace != settings.workspace:
                raise RagInstanceConfigurationError("LightRAG workspace is not configured")
            return RagInstance("legacy", settings.url, settings.api_key, workspace)
        except RagInstanceConfigurationError as exc:
            raise RagUnavailable("knowledge service unavailable") from exc

    async def aclose(self) -> None:
        await self._http.aclose()

    async def query(self, *, workspace: str, query: str, limit: int) -> dict[str, Any]:
        settings = self.settings
        if settings is None:
            raise RagUnavailable("knowledge service unavailable")
        try:
            instance = self.instance_for_workspace(workspace)
        except RagUnavailable:
            raise
        if len(query) > _MAX_QUERY_CHARS:
            raise RagUnavailable("knowledge service unavailable")
        body = {
            "query": query,
            "mode": settings.query_mode,
            "top_k": min(limit, _MAX_LIMIT),
            "chunk_top_k": min(limit, _MAX_LIMIT),
            "max_total_tokens": 2_000,
            "include_chunk_content": True,
            "include_references": True,
        }
        try:
            response = await self._http.post(
                f"{instance.url}/query/data",
                headers={"X-API-Key": instance.api_key, "LIGHTRAG-WORKSPACE": instance.workspace},
                json=body,
                timeout=settings.timeout_ms / 1000,
            )
            if response.status_code != 200 or len(response.content) > _MAX_RESPONSE_BYTES:
                raise RagUnavailable("knowledge service unavailable")
            payload = response.json()
            if not isinstance(payload, dict):
                raise RagUnavailable("knowledge service unavailable")
            # LightRAG 1.5.6 documents an empty query as a successful HTTP
            # response with this explicit no-context failure marker.
            if payload.get("status") == "failure" and payload.get("message") == "No context found for query":
                return {"status": "success", "data": {"references": [], "chunks": []}}
            if payload.get("status") not in (None, "success"):
                raise RagUnavailable("knowledge service unavailable")
            return payload
        except RagUnavailable:
            raise
        except (httpx.HTTPError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RagUnavailable("knowledge service unavailable") from exc


class SnapshotPort(Protocol):
    def generate(self, ctx: TenantContext, *, member_id: str, employee_id: str, employee_version: str | None = None): ...


class MemberPort(Protocol):
    def get_member(self, ctx: TenantContext, *, member_id: str): ...


class EmployeeConfigPort(Protocol):
    def get(self, ctx: TenantContext, *, employee_id: str): ...


class BindingPort(Protocol):
    def list_by_employee(self, ctx: TenantContext, *, employee_id: str, status: str | None = None): ...


class RagServicePort(Protocol):
    def get(self, ctx: TenantContext, knowledge_space_id: str) -> RagHandle | None: ...


class SpacePort(Protocol):
    def get(self, ctx: TenantContext, *, knowledge_space_id: str): ...


@dataclass(frozen=True)
class AuthorizedRagRequest:
    claims: TokenClaims
    ctx: TenantContext
    member_id: str
    employee_id: str
    snapshot: Any
    # ``handle`` remains the first handle for compatibility with existing
    # callers; ``handles`` is the complete authorized set.
    handle: RagHandle
    bindings: tuple[Any, ...]
    handles: tuple[RagHandle, ...] = ()


class RagAccessService:
    """Resolve all currently bound knowledge spaces, then query them."""

    def __init__(
        self,
        *,
        snapshot_service: SnapshotPort,
        member_repository: MemberPort,
        employee_config: EmployeeConfigPort,
        binding_repository: BindingPort,
        rag_service: RagServicePort,
        light_rag: LightRagClient,
        space_repository: SpacePort | None = None,
        document_repository: KnowledgeDocumentRepository | None = None,
        storage_root: os.PathLike[str] | str | None = None,
    ):
        self._snapshots = snapshot_service
        self._members = member_repository
        self._employees = employee_config
        self._bindings = binding_repository
        self._rag = rag_service
        self._light_rag = light_rag
        self._spaces = space_repository
        self._documents = document_repository
        self._storage_root = Path(storage_root).resolve() if storage_root is not None else None

    def authorize(self, claims: TokenClaims, employee_id: str) -> AuthorizedRagRequest:
        if not claims.tenant_id or not claims.user_id or not employee_id or len(employee_id) > 256:
            raise Unauthorized("invalid RAG identity")
        ctx = tenant_context_from(claims)
        member = self._members.get_member(ctx, member_id=claims.user_id)
        if (
            member is None
            or getattr(member, "status", None) != "active"
            or getattr(member, "tenant_id", ctx.tenant_id) != ctx.tenant_id
            or getattr(member, "id", claims.user_id) != claims.user_id
        ):
            raise Forbidden("member is not active")
        config = self._employees.get(ctx, employee_id=employee_id)
        if (
            config is None
            or getattr(config, "tenant_id", ctx.tenant_id) != ctx.tenant_id
            or not employee_runnable(config)
        ):
            raise Forbidden("employee is not runnable")
        snapshot = self._snapshots.generate(ctx, member_id=claims.user_id, employee_id=employee_id)
        if (
            getattr(snapshot, "tenant_id", ctx.tenant_id) != ctx.tenant_id
            or getattr(snapshot, "employee_id", None) != employee_id
        ):
            raise Forbidden("employee is not authorized")
        refs = list(dict.fromkeys(
            ref for ref in getattr(snapshot, "knowledge_refs", [])
            if isinstance(ref, str) and ref
        ))
        if not refs:
            raise Forbidden("employee knowledge binding is unavailable")
        all_bindings = tuple(self._bindings.list_by_employee(ctx, employee_id=employee_id))
        handles: list[RagHandle] = []
        valid_bindings: list[Any] = []
        for space_id in refs:
            space_bindings = tuple(
                row for row in all_bindings
                if self._valid_binding(row, ctx=ctx, employee_id=employee_id, space_id=space_id)
            )
            if not space_bindings:
                raise Forbidden("employee knowledge binding is unavailable")
            if self._spaces is not None:
                space = self._spaces.get(ctx, knowledge_space_id=space_id)
                if (
                    space is None
                    or getattr(space, "tenant_id", ctx.tenant_id) != ctx.tenant_id
                    or getattr(space, "knowledge_space_id", space_id) != space_id
                ):
                    raise Forbidden("employee knowledge binding is unavailable")
            handle = self._rag.get(ctx, space_id)
            if not handle or handle.tenant_id != ctx.tenant_id or handle.knowledge_space_id != space_id:
                raise Forbidden("employee knowledge binding is unavailable")
            if self._light_rag.settings is not None:
                try:
                    instance = self._light_rag.instance_for_workspace(handle.workspace)
                except RagUnavailable:
                    raise Forbidden("employee knowledge binding is unavailable")
                handle_instance_id = getattr(handle, "instance_id", "legacy")
                if self._light_rag.instance_registry is not None and handle_instance_id != instance.instance_id:
                    raise Forbidden("employee knowledge binding is unavailable")
            handles.append(handle)
            valid_bindings.extend(space_bindings)
        return AuthorizedRagRequest(
            claims, ctx, claims.user_id, employee_id, snapshot, handles[0], tuple(valid_bindings), tuple(handles)
        )

    async def search(self, auth: AuthorizedRagRequest, query: str, limit: int) -> dict[str, Any]:
        if not isinstance(query, str) or not query.strip() or len(query) > _MAX_QUERY_CHARS:
            raise RagUnavailable("knowledge service unavailable")
        try:
            limit = max(1, min(int(limit), _MAX_LIMIT))
        except (TypeError, ValueError):
            raise RagUnavailable("knowledge service unavailable")
        handles = auth.handles or (auth.handle,)

        async def query_space(handle: RagHandle):
            try:
                payload = await self._light_rag.query(workspace=handle.workspace, query=query, limit=limit)
                return handle, self._citations(auth, handle, payload), None
            except Exception:  # noqa: BLE001 - never expose upstream details
                return handle, [], RagUnavailable("knowledge service unavailable")

        results = await asyncio.gather(*(query_space(handle) for handle in handles))
        successful = [result for result in results if result[2] is None]
        if not successful:
            raise RagUnavailable("knowledge service unavailable")
        items = self._merge_citations(
            citation for _, citations, _ in successful for citation in citations
        )[:limit]
        result = {"query": query, "items": items}
        if len(successful) != len(results):
            result["degraded"] = True
        # Keep the MCP result bounded even if an upstream adds unexpectedly large metadata.
        while len(json.dumps(result, ensure_ascii=False).encode()) > _MAX_RESPONSE_BYTES and items:
            items.pop()
        return result

    def get(self, auth: AuthorizedRagRequest, citation_id: str) -> dict[str, Any]:
        """Read a current Manager-owned document or exact deterministic chunk."""
        parsed = _parse_citation_id(citation_id)

        # A search authorization is a snapshot-time object. Rebuild it here so
        # revoked bindings, reindexing, and employee changes take effect before
        # every read.
        current = self.authorize(auth.claims, auth.employee_id)
        handle = next(
            (candidate for candidate in (current.handles or (current.handle,))
             if candidate.knowledge_space_id == parsed.knowledge_space_id),
            None,
        )
        if handle is None or self._documents is None or self._storage_root is None:
            raise RagUnavailable("knowledge service unavailable")
        binding = next(
            (row for row in current.bindings
             if getattr(row, "document_id", None) == parsed.document_id
             and self._valid_binding(
                 row, ctx=current.ctx, employee_id=current.employee_id,
                 space_id=parsed.knowledge_space_id,
             )),
            None,
        )
        if binding is None:
            raise RagUnavailable("knowledge service unavailable")
        document = self._documents.get(current.ctx, document_id=parsed.document_id)
        if (
            document is None
            or getattr(document, "id", parsed.document_id) != parsed.document_id
            or getattr(document, "tenant_id", current.ctx.tenant_id) != current.ctx.tenant_id
            or getattr(document, "knowledge_space_id", None) != parsed.knowledge_space_id
            or getattr(document, "status", None) != "ready"
        ):
            raise RagUnavailable("knowledge service unavailable")
        try:
            path = self._document_path(current.ctx, parsed.knowledge_space_id, document)
            if path is None:
                raise ValueError("document storage is unavailable")
            text = extract_text(path)
            if not isinstance(text, str):
                raise ValueError("document parser returned invalid text")
        except Exception as exc:  # noqa: BLE001 - no storage/parser details at MCP boundary
            raise RagUnavailable("knowledge service unavailable") from exc

        version = self._document_version(current.ctx, parsed.knowledge_space_id, document)
        if parsed.version_digest is not None and parsed.version_digest != _version_digest(version):
            raise RagUnavailable("knowledge service unavailable")

        result_text = text[:_MAX_CHUNK_CHARS]
        result: dict[str, Any] = {
            "citation_id": citation_id,
            "document_id": parsed.document_id,
            "knowledge_space_id": parsed.knowledge_space_id,
            "title": str(getattr(document, "display_name", ""))[:512],
            "text": result_text,
            "citation_version": version,
            "source": self._public_source(document),
        }
        if parsed.chunk_offset is not None:
            assert parsed.chunk_length is not None
            end = parsed.chunk_offset + parsed.chunk_length
            if end > len(text):
                raise RagUnavailable("knowledge service unavailable")
            result["text"] = text[parsed.chunk_offset:end]
            result["locator"] = f"o{parsed.chunk_offset}l{parsed.chunk_length}"
            if parsed.chunk_index is not None:
                result["chunk_index"] = parsed.chunk_index
        elif parsed.chunk_index is not None:
            chunks = _manager_chunks(text, _MANAGER_CHUNK_CHARS)
            if parsed.chunk_index >= len(chunks):
                raise RagUnavailable("knowledge service unavailable")
            result["text"] = chunks[parsed.chunk_index][:_MAX_CHUNK_CHARS]
            result["locator"] = f"i{parsed.chunk_index}"
            result["chunk_index"] = parsed.chunk_index
        return result

    def _document_path(self, ctx: TenantContext, space_id: str, document: Any) -> Path | None:
        if self._storage_root is None:
            return None
        storage_key = getattr(document, "storage_key", None)
        if not isinstance(storage_key, str) or not storage_key:
            return None
        try:
            path = _resolve_path(self._storage_root, storage_key)
            relative = path.relative_to(self._storage_root)
        except (OSError, ValueError):
            return None
        expected = ("knowledge", ctx.tenant_id, space_id)
        if len(relative.parts) < 4 or relative.parts[:3] != expected or not path.is_file():
            return None
        return path

    def _document_version(self, ctx: TenantContext, space_id: str, document: Any) -> str:
        """Return a stable opaque version without exposing Manager storage data."""
        material = ["manager-rag-citation-v1", ctx.tenant_id, space_id, str(getattr(document, "id", ""))]
        for name in ("version_digest", "version"):
            value = getattr(document, name, None)
            if value is not None and str(value):
                material.append(f"{name}:{value}")
        updated_at = getattr(document, "updated_at", None)
        if updated_at is not None:
            material.append(f"updated_at:{updated_at.isoformat() if hasattr(updated_at, 'isoformat') else updated_at}")
        source_hash = getattr(document, "source_hash", None)
        if source_hash is not None and str(source_hash):
            material.append(f"source_hash:{source_hash}")
        path = self._document_path(ctx, space_id, document)
        if path is not None:
            try:
                material.append(f"storage_sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}")
            except (OSError, ValueError):
                pass
        if len(material) == 4:
            material.append(f"storage_key:{getattr(document, 'storage_key', '')}")
        return _citation_version(hashlib.sha256("|".join(material).encode("utf-8")).hexdigest())

    @staticmethod
    def _public_source(document: Any) -> dict[str, str]:
        source_type = str(getattr(document, "source_type", "file"))
        display_name = str(getattr(document, "display_name", ""))[:512]
        return {
            "type": source_type if source_type in {"file", "url"} else "file",
            "display_name": display_name,
        }

    @staticmethod
    def _valid_binding(row: Any, *, ctx: TenantContext, employee_id: str, space_id: str) -> bool:
        # The repository is tenant-scoped, but keep these checks here as a second
        # boundary before accepting an upstream citation identifier.
        return (
            getattr(row, "tenant_id", ctx.tenant_id) == ctx.tenant_id
            and getattr(row, "employee_id", employee_id) == employee_id
            and getattr(row, "knowledge_space_id", None) == space_id
            and getattr(row, "status", None) == "ready"
            and getattr(row, "enabled", True) is not False
            and bool(getattr(row, "document_id", None))
        )

    @staticmethod
    def _upstream_value(item: dict[str, Any], name: str) -> Any:
        value = item.get(name)
        metadata = item.get("metadata")
        metadata_value = metadata.get(name) if isinstance(metadata, dict) else None
        if value is not None and metadata_value is not None and value != metadata_value:
            return _AMBIGUOUS_UPSTREAM_VALUE
        return value if value is not None else metadata_value

    @staticmethod
    def _content_value(item: dict[str, Any]) -> str:
        value = item.get("content", item.get("text", ""))
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return "\n".join(part for part in value if isinstance(part, str))
        return ""

    @staticmethod
    def _score_value(item: dict[str, Any], fallback: dict[str, Any] | None = None) -> float:
        for source in (item, fallback or {}):
            value = source.get("score")
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            try:
                score = float(value)
            except (OverflowError, ValueError):
                continue
            if math.isfinite(score):
                return score
        return 0.0

    def _bound_documents(
        self, auth: AuthorizedRagRequest, handle: RagHandle
    ) -> tuple[dict[str, tuple[str, Any]], set[str]]:
        """Build a tenant/space-scoped alias map; collisions are unusable."""
        allowed: dict[str, tuple[str, Any]] = {}
        ambiguous: set[str] = set()
        if self._documents is None:
            return allowed, ambiguous
        for binding in auth.bindings:
            if not self._valid_binding(
                binding, ctx=auth.ctx, employee_id=auth.employee_id,
                space_id=handle.knowledge_space_id,
            ):
                continue
            document_id = str(getattr(binding, "document_id", ""))
            doc = self._documents.get(auth.ctx, document_id=document_id)
            if (
                not document_id
                or doc is None
                or getattr(doc, "id", document_id) != document_id
                or getattr(doc, "tenant_id", auth.ctx.tenant_id) != auth.ctx.tenant_id
                or getattr(doc, "knowledge_space_id", None) != handle.knowledge_space_id
                or getattr(doc, "status", None) != "ready"
            ):
                continue
            aliases = {
                document_id,
                str(getattr(binding, "rag_document_id", "") or ""),
                str(getattr(doc, "storage_key", "") or ""),
                str(getattr(doc, "file_name", "") or ""),
            }
            for alias in aliases - {""}:
                if alias in ambiguous:
                    continue
                previous = allowed.get(alias)
                if previous is not None and previous[0] != document_id:
                    ambiguous.add(alias)
                    allowed.pop(alias, None)
                else:
                    allowed[alias] = (document_id, doc)
        return allowed, ambiguous

    @staticmethod
    def _resolve_item(
        item: dict[str, Any],
        allowed: dict[str, tuple[str, Any]],
        ambiguous: set[str],
        reference_targets: dict[str, tuple[str, Any]],
        ambiguous_references: set[str],
    ) -> tuple[str, Any] | None:
        matches: dict[str, tuple[str, Any]] = {}
        # These fields identify a Manager document. If one is present but is
        # not a current alias, do not let another field silently override it.
        for name in ("file_path", "full_doc_id", "document_id", "rag_document_id"):
            value = RagAccessService._upstream_value(item, name)
            if value is _AMBIGUOUS_UPSTREAM_VALUE:
                return None
            if value is None or isinstance(value, bool):
                continue
            alias = str(value)
            if not alias:
                continue
            if alias in ambiguous:
                return None
            bound = allowed.get(alias)
            if bound is None:
                return None
            matches[bound[0]] = bound
        reference_id = RagAccessService._upstream_value(item, "reference_id")
        if reference_id is _AMBIGUOUS_UPSTREAM_VALUE:
            return None
        if reference_id is not None:
            reference_key = str(reference_id)
            if reference_key in ambiguous_references:
                return None
            bound = allowed.get(reference_key) or reference_targets.get(reference_key)
            if bound is not None:
                matches[bound[0]] = bound
        return next(iter(matches.values())) if len(matches) == 1 else None

    def _reference_targets(
        self,
        references: list[dict[str, Any]],
        allowed: dict[str, tuple[str, Any]],
        ambiguous: set[str],
    ) -> tuple[dict[str, tuple[str, Any]], set[str], dict[str, dict[str, Any]]]:
        targets: dict[str, tuple[str, Any]] = {}
        ambiguous_ids: set[str] = set()
        seen_ids: set[str] = set()
        metadata: dict[str, dict[str, Any]] = {}
        for reference in references:
            reference_id = self._upstream_value(reference, "reference_id")
            if reference_id is _AMBIGUOUS_UPSTREAM_VALUE or reference_id is None:
                continue
            key = str(reference_id)
            if key in seen_ids:
                ambiguous_ids.add(key)
                targets.pop(key, None)
                metadata.pop(key, None)
                continue
            seen_ids.add(key)
            bound = self._resolve_item(reference, allowed, ambiguous, {}, set())
            if bound is None:
                continue
            if key not in ambiguous_ids:
                targets[key] = bound
                metadata[key] = reference
        return targets, ambiguous_ids, metadata

    def _search_authoritative_text(
        self, auth: AuthorizedRagRequest, handle: RagHandle, document: Any
    ) -> str | None:
        path = self._document_path(auth.ctx, handle.knowledge_space_id, document)
        if path is None:
            return None
        try:
            text = extract_text(path)
            return text if isinstance(text, str) else None
        except Exception:  # noqa: BLE001 - search remains bounded and fail-closed
            return None

    @staticmethod
    def _unique_content_span(text: str | None, content: str) -> tuple[int, int] | None:
        if not text or not content or len(content) > _MAX_CHUNK_CHARS:
            return None
        start = text.find(content)
        if start < 0 or text.find(content, start + 1) >= 0:
            return None
        return start, len(content)

    def _citations(self, auth: AuthorizedRagRequest, handle: RagHandle, payload: dict[str, Any]) -> list[dict[str, Any]]:
        data = payload.get("data") if isinstance(payload.get("data"), (dict, list)) else payload
        if isinstance(data, dict):
            references = [item for item in data.get("references", []) if isinstance(item, dict)] if isinstance(data.get("references"), list) else []
            chunks = [item for item in data.get("chunks", []) if isinstance(item, dict)] if isinstance(data.get("chunks"), list) else []
            raw = chunks if chunks else references
        elif isinstance(data, list):
            references = []
            chunks = []
            raw = [item for item in data if isinstance(item, dict)]
        else:
            return []
        if not raw or self._documents is None:
            return []

        # LightRAG 1.5.6 /query/data currently emits references as
        # {reference_id,file_path} and chunks as {reference_id,file_path,
        # chunk_id,content}. Richer deployments may add full_doc_id and
        # chunk_order_index; no upstream storage is trusted here.
        allowed, ambiguous = self._bound_documents(auth, handle)
        reference_targets, ambiguous_references, reference_metadata = self._reference_targets(
            references, allowed, ambiguous
        )
        chunk_maps: dict[str, list[str] | None] = {}
        authoritative_texts: dict[str, str | None] = {}
        records: list[dict[str, Any]] = []
        for item in raw:
            bound = self._resolve_item(
                item, allowed, ambiguous, reference_targets, ambiguous_references
            )
            if bound is None:
                continue
            document_id, document = bound
            reference_id = self._upstream_value(item, "reference_id")
            reference = reference_metadata.get(str(reference_id)) if reference_id is not None else None
            chunk_id = self._upstream_value(item, "chunk_id")
            if not isinstance(chunk_id, str) or not chunk_id.strip() or len(chunk_id) > _MAX_UPSTREAM_ALIAS_CHARS:
                chunk_id = None
            elif any(char in chunk_id for char in "\r\n"):
                chunk_id = None
            order = self._upstream_value(item, "chunk_order_index")
            if order is None:
                order = self._upstream_value(item, "chunk_index")
            order_invalid = order is not None and (
                not isinstance(order, int)
                or isinstance(order, bool)
                or order < 0
                or order > 999_999_999
            )
            valid_order = not order_invalid and order is not None
            if not valid_order:
                order = None
            content = item.get("content", item.get("text"))
            content_text = content if isinstance(content, str) else ""
            if document_id not in chunk_maps:
                authoritative_text = self._search_authoritative_text(auth, handle, document)
                authoritative_texts[document_id] = authoritative_text
                chunk_maps[document_id] = (
                    _manager_chunks(authoritative_text, _MANAGER_CHUNK_CHARS)
                    if authoritative_text is not None else None
                )
            chunk_map = chunk_maps[document_id]
            content_span = self._unique_content_span(
                authoritative_texts.get(document_id), content_text
            )
            exact_index: int | None = None
            exact_range: tuple[int, int] | None = None
            if valid_order and chunk_map is not None:
                if order < len(chunk_map):
                    # An order/index without authoritative content is not
                    # enough to prove the upstream chunk identity; otherwise a
                    # malformed response could make us return a different
                    # chunk from the same document.
                    if content_text and chunk_map[order] == content_text:
                        exact_index = order
                    elif content_span is not None:
                        # LightRAG's token chunker need not match Manager's
                        # fixed local map. A unique exact source span is still
                        # safe; its offsets, not an inferred chunk number, are
                        # used by knowledge_get.
                        exact_index = order
                        exact_range = content_span
            elif not order_invalid and chunk_id is not None and content_span is not None:
                if chunk_map is not None:
                    matches = [index for index, value in enumerate(chunk_map) if value == content_text]
                else:
                    matches = []
                if len(matches) == 1:
                    exact_index = matches[0]
                else:
                    exact_range = content_span
            records.append({
                "document_id": document_id,
                "document": document,
                "chunk_id": chunk_id,
                "order": order,
                "order_invalid": order_invalid,
                "exact_index": exact_index,
                "exact_range": exact_range,
                "content": content_text or self._content_value(item),
                "score": self._score_value(item, reference),
                "chunk_map": chunk_map,
                "authoritative_text": authoritative_texts.get(document_id),
            })

        if not records:
            return []
        id_counts: dict[str, int] = {}
        index_counts: dict[tuple[str, int], int] = {}
        range_counts: dict[tuple[str, int, int], int] = {}
        for record in records:
            chunk_id = record["chunk_id"]
            if chunk_id is not None:
                id_counts[chunk_id] = id_counts.get(chunk_id, 0) + 1
            order = record["order"]
            if order is not None:
                key = (record["document_id"], order)
                index_counts[key] = index_counts.get(key, 0) + 1
            index = record["exact_index"]
            if index is not None and order is None:
                key = (record["document_id"], index)
                index_counts[key] = index_counts.get(key, 0) + 1
            span = record["exact_range"]
            if span is not None:
                key = (record["document_id"], span[0], span[1])
                range_counts[key] = range_counts.get(key, 0) + 1
        duplicate_ids = {chunk_id for chunk_id, count in id_counts.items() if count > 1}
        duplicate_indices = {
            key for key, count in index_counts.items() if count > 1
        }
        duplicate_ranges = {
            key for key, count in range_counts.items() if count > 1
        }

        exact_output: dict[str, dict[str, Any]] = {}
        document_output: dict[str, dict[str, Any]] = {}
        for record in records:
            document_id = record["document_id"]
            document = record["document"]
            version = self._document_version(auth.ctx, handle.knowledge_space_id, document)
            index = record["exact_index"]
            span = record["exact_range"]
            span_key = (document_id, span[0], span[1]) if span is not None else None
            if (
                (index is not None or span is not None)
                and record["chunk_id"] not in duplicate_ids
                and (index is None or (document_id, index) not in duplicate_indices)
                and (span_key is None or span_key not in duplicate_ranges)
            ):
                if span is not None:
                    offset, length = span
                    token = _chunk_token(version, index, offset=offset, length=length)
                    text = record["authoritative_text"][offset:offset + length]
                    locator = f"o{offset}l{length}"
                else:
                    assert index is not None
                    token = _chunk_token(version, index)
                    text = record["chunk_map"][index] if record["chunk_map"] is not None else record["content"]
                    locator = f"i{index}"
                citation = {
                    "citation_id": f"citation:{handle.knowledge_space_id}:{document_id}:{token}",
                    "document_id": document_id,
                    "knowledge_space_id": handle.knowledge_space_id,
                    "title": str(getattr(document, "display_name", ""))[:512],
                    "text": text[:_MAX_CHUNK_CHARS],
                    "score": record["score"],
                    "citation_version": version,
                    "locator": locator,
                    "source": self._public_source(document),
                }
                if index is not None:
                    citation["chunk_index"] = index
                previous = exact_output.get(citation["citation_id"])
                if previous is None or citation["score"] > previous["score"]:
                    exact_output[citation["citation_id"]] = citation
                continue

            # Ambiguous or incomplete upstream provenance gets a versioned
            # document citation. It is safe, bounded, and never pretends to be
            # an exact chunk.
            token = _document_token(version)
            citation = {
                "citation_id": f"citation:{handle.knowledge_space_id}:{document_id}:{token}",
                "document_id": document_id,
                "knowledge_space_id": handle.knowledge_space_id,
                "title": str(getattr(document, "display_name", ""))[:512],
                "text": record["content"][:_MAX_CHUNK_CHARS],
                "score": record["score"],
                "citation_version": version,
                "source": self._public_source(document),
            }
            previous = document_output.get(document_id)
            if previous is None or citation["score"] > previous["score"]:
                document_output[document_id] = citation
        return list(exact_output.values()) + list(document_output.values())

    @staticmethod
    def _merge_citations(items) -> list[dict[str, Any]]:
        # Exact citations are keyed by their opaque versioned id, not merely by
        # document, so two retrieved chunks from one document remain distinct.
        merged: dict[str, dict[str, Any]] = {}
        for item in items:
            key = str(item.get("citation_id", ""))
            if not key:
                continue
            current = merged.get(key)
            score = item.get("score", 0.0)
            current_score = current.get("score", 0.0) if current else 0.0
            if current is None or float(score) > float(current_score):
                merged[key] = item
        return sorted(
            merged.values(),
            key=lambda item: (
                -float(item.get("score", 0.0)),
                str(item.get("knowledge_space_id", "")),
                str(item.get("document_id", "")),
                str(item.get("chunk_index", "")),
                str(item.get("citation_id", "")),
            ),
        )


_current_rag_request: contextvars.ContextVar[AuthorizedRagRequest | None] = contextvars.ContextVar("aiteam_rag_request", default=None)


def _auth_problem(request: Request, *, status: int, code: str, title: str, detail: str) -> JSONResponse:
    problem = Problem(
        type=f"https://docs.aiteam.local/problems/{code}",
        title=title,
        status=status,
        code=code,
        detail=detail,
        instance=request.url.path,
        request_id=getattr(request.state, "request_id", None),
    )
    return JSONResponse(
        status_code=status,
        media_type="application/problem+json",
        content=problem.model_dump(mode="json", exclude_none=True),
    )


class RagAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, verifier: TokenVerifier, access: RagAccessService):
        super().__init__(app)
        self._verifier = verifier
        self._access = access

    async def dispatch(self, request: Request, call_next) -> Response:
        try:
            authorization = request.headers.get("authorization", "")
            if not authorization.startswith("Bearer "):
                raise Unauthorized("missing bearer token")
            claims = self._verifier.verify(authorization[7:].strip())
            employee_id = request.headers.get("x-aiteam-employee-id", "").strip()
            auth = self._access.authorize(claims, employee_id)
        except Unauthorized:
            return _auth_problem(request, status=401, code="unauthorized", title="Unauthorized", detail="Authentication required.")
        except (Forbidden, AppError, ValueError):
            return _auth_problem(request, status=403, code="forbidden", title="Forbidden", detail="RAG access denied.")
        except Exception:  # noqa: BLE001 - never expose verifier/repository failures at MCP boundary
            return _auth_problem(request, status=403, code="forbidden", title="Forbidden", detail="RAG access denied.")
        token = _current_rag_request.set(auth)
        try:
            return await call_next(request)
        finally:
            _current_rag_request.reset(token)


def build_rag_mcp(*, verifier: TokenVerifier, access: RagAccessService) -> tuple[FastMCP, Any]:
    mcp = FastMCP(
        "aiteam-manager-rag",
        instructions="Read-only authorized enterprise knowledge search. Results contain citations.",
        streamable_http_path="/mcp",
        stateless_http=False,
    )

    @mcp.tool(name="knowledge_search", description="Search the current employee's authorized knowledge space and return bounded citations.")
    async def knowledge_search(query: str, limit: int = 10) -> str:
        auth = _current_rag_request.get()
        if auth is None:
            raise RuntimeError("knowledge service unavailable")
        return json.dumps(await access.search(auth, query, limit), ensure_ascii=False)

    @mcp.tool(name="knowledge_get", description="Get bounded text for an authorized citation.")
    async def knowledge_get(citation_id: str) -> str:
        auth = _current_rag_request.get()
        if auth is None:
            raise RuntimeError("knowledge service unavailable")
        return json.dumps(
            await asyncio.to_thread(access.get, auth, citation_id),
            ensure_ascii=False,
        )

    mounted = mcp.streamable_http_app()
    mounted.add_middleware(RagAuthMiddleware, verifier=verifier, access=access)
    return mcp, mounted


@contextlib.asynccontextmanager
async def mcp_lifespan(mcp: FastMCP, close: Any = None):
    """Host FastAPI must own the SDK session-manager lifespan."""
    try:
        async with mcp.session_manager.run():
            yield
    finally:
        if close is not None:
            await close()


def install_rag_mcp_lifespan(app: FastAPI, mcp: FastMCP, *, close: Any = None) -> None:
    app.router.lifespan_context = lambda _: mcp_lifespan(mcp, close)
