"""Manager-owned read-only RAG MCP facade.

The facade is the only northbound RAG surface.  It derives the LightRAG
workspace after checking the current employee snapshot and bindings; callers
never provide a workspace or LightRAG credential.
"""
import asyncio
import contextlib
import contextvars
import json
import os
from dataclasses import dataclass
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

from .employee_config_service import employee_runnable
from .knowledge_intake_repository import KnowledgeDocumentRepository
from .rag import RagHandle

MCP_MOUNT_PATH = "/api/manager/rag"
MCP_ENDPOINT_PATH = f"{MCP_MOUNT_PATH}/mcp"
_MAX_QUERY_CHARS = 8_000
_MAX_LIMIT = 20
_MAX_CHUNK_CHARS = 4_000
_MAX_RESPONSE_BYTES = 64 * 1024


class RagUnavailable(RuntimeError):
    """An upstream RAG failure with no upstream details exposed to clients."""


@dataclass(frozen=True)
class LightRagSettings:
    url: str
    api_key: str
    timeout_ms: int = 5_000
    query_mode: str = "naive"

    @classmethod
    def from_env(cls) -> "LightRagSettings | None":
        url = os.getenv("LIGHTRAG_URL", "").strip().rstrip("/")
        key = os.getenv("LIGHTRAG_API_KEY", "").strip()
        if not url or not key:
            return None
        try:
            timeout_ms = max(100, min(int(os.getenv("LIGHTRAG_TIMEOUT_MS", "5000")), 30_000))
        except ValueError:
            timeout_ms = 5_000
        query_mode = os.getenv("LIGHTRAG_QUERY_MODE", "naive").strip().lower()
        if query_mode not in {"local", "global", "hybrid", "naive", "mix"}:
            query_mode = "naive"
        return cls(url=url, api_key=key, timeout_ms=timeout_ms, query_mode=query_mode)


class LightRagClient:
    """Small bounded client for LightRAG's structured, no-LLM query endpoint."""

    def __init__(self, settings: LightRagSettings | None = None, *, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings or LightRagSettings.from_env()
        self._http = httpx.AsyncClient(transport=transport) if transport else httpx.AsyncClient()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def query(self, *, workspace: str, query: str, limit: int) -> dict[str, Any]:
        settings = self.settings
        if settings is None:
            raise RagUnavailable("knowledge service unavailable")
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
                f"{settings.url}/query/data",
                headers={"X-API-Key": settings.api_key, "LIGHTRAG-WORKSPACE": workspace},
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
    ):
        self._snapshots = snapshot_service
        self._members = member_repository
        self._employees = employee_config
        self._bindings = binding_repository
        self._rag = rag_service
        self._light_rag = light_rag
        self._spaces = space_repository
        self._documents = document_repository

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

    def _citations(self, auth: AuthorizedRagRequest, handle: RagHandle, payload: dict[str, Any]) -> list[dict[str, Any]]:
        data = payload.get("data") if isinstance(payload.get("data"), (dict, list)) else payload
        if isinstance(data, dict):
            references = data.get("references") if isinstance(data.get("references"), list) else []
            chunks = data.get("chunks") if isinstance(data.get("chunks"), list) else []
            raw = references or chunks
        else:
            references = []
            chunks = []
            raw = data
        if not isinstance(raw, list):
            return []

        # LightRAG returns reference metadata and chunk text in separate arrays.
        # Join them by reference_id/file_path before authorization so a reference
        # can carry the actual bounded text to Pi without trusting upstream paths.
        chunk_text: dict[str, str] = {}
        for chunk in chunks:
            if not isinstance(chunk, dict):
                continue
            content = chunk.get("content", chunk.get("text", ""))
            text = content if isinstance(content, str) else "\n".join(value for value in content if isinstance(value, str)) if isinstance(content, list) else ""
            for alias in (chunk.get("reference_id"), chunk.get("file_path"), chunk.get("full_doc_id"), chunk.get("document_id")):
                if alias is not None and text:
                    chunk_text[str(alias)] = text

        # Resolve every bound document first.  A LightRAG reference is never
        # trusted on its own: file_path/reference_id must alias a Manager row.
        allowed: dict[str, tuple[str, Any]] = {}
        ambiguous: set[str] = set()
        for binding in auth.bindings:
            if not self._valid_binding(binding, ctx=auth.ctx, employee_id=auth.employee_id, space_id=handle.knowledge_space_id):
                continue
            document_id = str(binding.document_id)
            doc = self._documents.get(auth.ctx, document_id=document_id) if self._documents else None
            if (
                doc is None
                or getattr(doc, "tenant_id", auth.ctx.tenant_id) != auth.ctx.tenant_id
                or getattr(doc, "knowledge_space_id", None) != handle.knowledge_space_id
                or getattr(doc, "status", None) != "ready"
            ):
                continue
            aliases = {
                str(document_id),
                str(getattr(binding, "rag_document_id", "") or ""),
                str(getattr(doc, "storage_key", "") or ""),
            }
            for alias in aliases - {""}:
                if alias in allowed and allowed[alias][0] != document_id:
                    ambiguous.add(alias)
                else:
                    allowed[alias] = (document_id, doc)

        output: dict[tuple[str, str], dict[str, Any]] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            candidates = (
                item.get("file_path"),
                item.get("document_id"),
                item.get("rag_document_id"),
                item.get("reference_id"),
                item.get("full_doc_id"),
                metadata.get("file_path"),
                metadata.get("document_id"),
                metadata.get("full_doc_id"),
            )
            bound = next(
                (allowed.get(str(value)) for value in candidates
                 if value is not None and str(value) not in ambiguous),
                None,
            )
            if bound is None:
                continue
            document_id, doc = bound
            citation_key = (handle.knowledge_space_id, document_id)
            content = item.get("content", item.get("text", ""))
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = "\n".join(value for value in content if isinstance(value, str))
            else:
                text = ""
            if not text:
                for alias in (item.get("reference_id"), item.get("file_path"), item.get("full_doc_id"), item.get("document_id")):
                    if alias is not None and str(alias) in chunk_text:
                        text = chunk_text[str(alias)]
                        break
            source_type = str(getattr(doc, "source_type", "file"))
            display_name = str(getattr(doc, "display_name", ""))[:512]
            citation = {
                "citation_id": f"citation:{handle.knowledge_space_id}:{document_id}",
                "document_id": document_id,
                "knowledge_space_id": handle.knowledge_space_id,
                "title": display_name,
                "text": text[:_MAX_CHUNK_CHARS],
                "score": float(item["score"]) if isinstance(item.get("score"), (int, float)) else 0.0,
                "source": {"type": source_type if source_type in {"file", "url"} else "file", "display_name": display_name},
            }
            previous = output.get(citation_key)
            if previous is None or citation["score"] > previous["score"]:
                output[citation_key] = citation
        return list(output.values())

    @staticmethod
    def _merge_citations(items) -> list[dict[str, Any]]:
        merged: dict[tuple[str, str], dict[str, Any]] = {}
        for item in items:
            key = (str(item.get("knowledge_space_id", "")), str(item.get("document_id", "")))
            current = merged.get(key)
            if current is None or float(item.get("score", 0.0)) > float(current.get("score", 0.0)):
                merged[key] = item
        return sorted(
            merged.values(),
            key=lambda item: (
                -float(item.get("score", 0.0)),
                str(item.get("knowledge_space_id", "")),
                str(item.get("document_id", "")),
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
