"""Manager-only LightRAG document ingestion client.

This client is deliberately separate from the read-only MCP query client.  Its
credential is loaded only by Manager and its workspace is supplied by the
Manager-owned RAG service, never by an Agent or northbound request.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

import httpx

from .rag_instances import RagInstance, RagInstanceConfigurationError, RagInstanceRegistry

logger = logging.getLogger(__name__)

_MAX_TEXT_BYTES = 4 * 1024 * 1024
_MAX_RESPONSE_BYTES = 64 * 1024
_MAX_PROBE_RESPONSE_BYTES = 512 * 1024
_MAX_REQUEST_TIMEOUT_MS = 30_000
_MAX_PIPELINE_TIMEOUT_MS = 300_000
_MAX_POLL_INTERVAL_MS = 10_000
_MAX_PAGINATED_PAGES = 32
_MAX_PAGINATED_PAGE_SIZE = 200
_MAX_PROBE_ID_CHARS = 1_024
_MAX_ALIAS_COUNT = 32


class RagIngestionUnavailable(RuntimeError):
    """An upstream indexing failure with no upstream details exposed to callers."""


@dataclass(frozen=True)
class LightRagIngestionSettings:
    url: str
    api_key: str = field(repr=False)
    request_timeout_ms: int
    pipeline_timeout_ms: int
    poll_interval_ms: int = 250
    workspace: str | None = None
    instance_registry: RagInstanceRegistry | None = None

    @classmethod
    def from_env(cls) -> "LightRagIngestionSettings | None":
        registry = RagInstanceRegistry.from_env()
        pipeline_raw = os.getenv("LIGHTRAG_PIPELINE_TIMEOUT_MS", "").strip()
        if registry is None or not pipeline_raw:
            return None
        try:
            pipeline_timeout_ms = int(pipeline_raw)
        except ValueError:
            return None
        if pipeline_timeout_ms < 1 or pipeline_timeout_ms > _MAX_PIPELINE_TIMEOUT_MS:
            return None
        try:
            request_timeout_ms = int(os.getenv("LIGHTRAG_TIMEOUT_MS", "5000"))
        except ValueError:
            request_timeout_ms = 5_000
        request_timeout_ms = max(100, min(request_timeout_ms, _MAX_REQUEST_TIMEOUT_MS))
        try:
            poll_interval_ms = int(os.getenv("LIGHTRAG_POLL_INTERVAL_MS", "250"))
        except ValueError:
            poll_interval_ms = 250
        poll_interval_ms = max(10, min(poll_interval_ms, _MAX_POLL_INTERVAL_MS))
        first = registry.instances[0]
        return cls(
            first.url, first.api_key, request_timeout_ms, pipeline_timeout_ms,
            poll_interval_ms, first.workspace, registry,
        )


@dataclass(frozen=True)
class RagIngestionResult:
    """Manager citation alias plus the private upstream identity, if known."""

    # Keep the public Manager/source alias stable for existing callers.  The
    # upstream id is an internal ingestion/deletion seam and is never mapped to
    # an Agent, SSE event, or HTTP response.
    rag_document_id: str
    chunk_count: int | None = None
    upstream_document_id: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class RagDocumentInfo:
    """Bounded, non-secret LightRAG document metadata for Manager analytics."""

    upstream_document_id: str
    file_path: str
    status: str
    chunks_count: int | None = None
    content_length: int | None = None
    created_at: str | None = None
    updated_at: str | None = None


@dataclass(frozen=True)
class RagDeletionResult:
    """LightRAG 1.5.6 deletion acknowledgement.

    The endpoint only acknowledges that deletion started or is busy; neither
    flag proves physical completion.  Manager therefore keeps the document in
    ``deleting`` until a separate reconciliation can verify completion.
    """

    deletion_started: bool
    busy: bool


class RagIngestionPort(Protocol):
    def ingest_text(self, *, workspace: str, file_source: str, text: str) -> RagIngestionResult: ...

    def list_documents(self, *, workspace: str) -> list[RagDocumentInfo]: ...

    def resolve_document_id(self, *, workspace: str, aliases: list[str]) -> str | None: ...

    def delete_document(
        self,
        *,
        workspace: str,
        doc_ids: list[str],
        delete_file: bool,
        delete_llm_cache: bool,
    ) -> RagDeletionResult: ...

    def document_ids_present(self, *, workspace: str, doc_ids: list[str]) -> set[str]: ...


def _response_json(
    response: httpx.Response,
    *,
    max_bytes: int = _MAX_RESPONSE_BYTES,
    unavailable_message: str = "knowledge indexing unavailable",
) -> dict[str, Any]:
    if len(response.content) > max_bytes:
        raise RagIngestionUnavailable(unavailable_message)
    try:
        payload = response.json()
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise RagIngestionUnavailable(unavailable_message) from exc
    if not isinstance(payload, dict):
        raise RagIngestionUnavailable(unavailable_message)
    return payload


def _successful_response(payload: dict[str, Any]) -> bool:
    # LightRAG's insert endpoint must explicitly acknowledge success; an empty
    # or otherwise ambiguous response is never enough to publish Manager ready.
    return payload.get("status") == "success"


def _valid_document_alias(value: Any) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and value == value.strip()
        and len(value) <= _MAX_PROBE_ID_CHARS
        and not any(char in value for char in "\x00\r\n")
    )


def _validated_aliases(values: Any) -> set[str]:
    if not isinstance(values, list) or not values or len(values) > _MAX_ALIAS_COUNT:
        raise RagIngestionUnavailable("knowledge deletion unavailable")
    if any(not _valid_document_alias(value) for value in values):
        raise RagIngestionUnavailable("knowledge deletion unavailable")
    return set(values)


def _document_identity(document: Any, *, workspace: str) -> tuple[str, str]:
    info = _document_info(document, workspace=workspace)
    return info.upstream_document_id, info.file_path


def _document_info(document: Any, *, workspace: str) -> RagDocumentInfo:
    if not isinstance(document, dict):
        raise RagIngestionUnavailable("knowledge analytics unavailable")
    document_id = document.get("id")
    file_path = document.get("file_path")
    if not _valid_document_alias(document_id) or not _valid_document_alias(file_path):
        raise RagIngestionUnavailable("knowledge analytics unavailable")
    metadata = document.get("metadata")
    for source in (document, metadata if isinstance(metadata, dict) else {}):
        for field_name in ("workspace", "workspace_id"):
            value = source.get(field_name)
            if value is not None and (not _valid_document_alias(value) or value != workspace):
                raise RagIngestionUnavailable("knowledge analytics unavailable")
    status = document.get("status")
    # Deletion reconciliation historically only required id/file_path. Keep
    # that contract while representing status-less upstream rows as unknown.
    if not isinstance(status, str) or not status.strip() or len(status) > 128 or any(char in status for char in "\x00\r\n"):
        status = "unknown"

    def nonnegative_int(value: Any) -> int | None:
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

    def safe_timestamp(value: Any) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or len(value) > 128 or any(char in value for char in "\x00\r\n"):
            return None
        return value

    return RagDocumentInfo(
        upstream_document_id=document_id,
        file_path=file_path,
        status=status.strip().casefold(),
        chunks_count=nonnegative_int(document.get("chunks_count")),
        content_length=nonnegative_int(document.get("content_length")),
        created_at=safe_timestamp(document.get("created_at")),
        updated_at=safe_timestamp(document.get("updated_at")),
    )

class LightRagIngestionClient:
    """Bounded synchronous client for LightRAG's text ingestion API."""

    def __init__(
        self,
        settings: LightRagIngestionSettings | None = None,
        *,
        instance_registry: RagInstanceRegistry | None = None,
        transport: httpx.BaseTransport | None = None,
        sleeper=time.sleep,
        clock=time.monotonic,
    ):
        resolved = settings if settings is not None else LightRagIngestionSettings.from_env()
        if instance_registry is not None and resolved is not None:
            resolved = replace(resolved, instance_registry=instance_registry)
        self.settings = resolved
        self._http = httpx.Client(transport=transport) if transport else httpx.Client()
        self._sleep = sleeper
        self._clock = clock

    @property
    def instance_registry(self) -> RagInstanceRegistry | None:
        return self.settings.instance_registry if self.settings is not None else None

    def instance_for_workspace(self, workspace: str) -> RagInstance:
        settings = self.settings
        if settings is None:
            raise RagIngestionUnavailable("knowledge indexing unavailable")
        try:
            if settings.instance_registry is not None:
                return settings.instance_registry.resolve(workspace)
            if settings.workspace is not None and workspace != settings.workspace:
                raise RagInstanceConfigurationError("LightRAG workspace is not configured")
            return RagInstance("legacy", settings.url, settings.api_key, workspace)
        except RagInstanceConfigurationError as exc:
            raise RagIngestionUnavailable("knowledge indexing unavailable") from exc

    def close(self) -> None:
        self._http.close()

    def ingest_text(self, *, workspace: str, file_source: str, text: str) -> RagIngestionResult:
        settings = self.settings
        if settings is None or not workspace.strip() or not file_source.strip():
            raise RagIngestionUnavailable("knowledge indexing unavailable")
        instance = self.instance_for_workspace(workspace)
        if not isinstance(text, str) or not text or len(text.encode("utf-8")) > _MAX_TEXT_BYTES:
            raise RagIngestionUnavailable("knowledge indexing unavailable")
        headers = {"X-API-Key": instance.api_key, "LIGHTRAG-WORKSPACE": instance.workspace}
        timeout = settings.request_timeout_ms / 1000
        try:
            response = self._http.post(
                f"{instance.url}/documents/text",
                headers=headers,
                json={"text": text, "file_source": file_source},
                timeout=timeout,
            )
            if response.status_code != 200:
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            payload = _response_json(response)
            if not _successful_response(payload):
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            track_id = payload.get("track_id")
            if not isinstance(track_id, str) or not track_id.strip():
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            pipeline_chunk_count, upstream_document_id = self._wait_until_ready(
                instance, settings, headers=headers, file_source=file_source, track_id=track_id,
                timeout=timeout,
            )
            chunk_count = payload.get("chunk_count")
            if not isinstance(chunk_count, int) or chunk_count < 0:
                chunk_count = pipeline_chunk_count
            # file_source remains the stable Manager/citation alias; the
            # opaque upstream id is retained only for Manager deletion.
            return RagIngestionResult(
                rag_document_id=file_source,
                chunk_count=chunk_count,
                upstream_document_id=upstream_document_id,
            )
        except RagIngestionUnavailable:
            raise
        except (httpx.HTTPError, ValueError, TypeError, UnicodeError) as exc:
            logger.warning("LightRAG ingestion request failed: %s", type(exc).__name__)
            raise RagIngestionUnavailable("knowledge indexing unavailable") from exc

    def list_documents(self, *, workspace: str) -> list[RagDocumentInfo]:
        """List only validated metadata from the Manager's fixed workspace."""
        settings = self.settings
        if not isinstance(workspace, str) or not workspace.strip():
            raise RagIngestionUnavailable("knowledge analytics unavailable")
        try:
            if settings is None:
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            instance = self.instance_for_workspace(workspace)
            timeout = settings.request_timeout_ms / 1000
            headers = {"X-API-Key": instance.api_key, "LIGHTRAG-WORKSPACE": instance.workspace}
            return list(self._paginated_documents(instance, headers=headers, timeout=timeout))
        except RagIngestionUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - upstream details never cross Manager boundary
            logger.warning("LightRAG document analytics failed: %s", type(exc).__name__)
            raise RagIngestionUnavailable("knowledge analytics unavailable") from exc

    def resolve_document_id(self, *, workspace: str, aliases: list[str]) -> str | None:
        """Resolve Manager/source aliases to one workspace-local LightRAG id."""
        settings = self.settings
        requested = _validated_aliases(aliases)
        if settings is None or not isinstance(workspace, str) or not workspace.strip():
            raise RagIngestionUnavailable("knowledge deletion unavailable")
        instance = self.instance_for_workspace(workspace)
        headers = {"X-API-Key": instance.api_key, "LIGHTRAG-WORKSPACE": instance.workspace}
        timeout = settings.request_timeout_ms / 1000
        matches: dict[str, set[str]] = {alias: set() for alias in requested}
        try:
            for document_id, file_path in self._paginated_document_identities(
                instance, headers=headers, timeout=timeout
            ):
                matched = requested.intersection({document_id, file_path})
                for alias in matched:
                    if matches[alias]:
                        raise RagIngestionUnavailable("knowledge deletion unavailable")
                    matches[alias].add(document_id)
            resolved = {document_id for values in matches.values() for document_id in values}
            if len(resolved) > 1:
                raise RagIngestionUnavailable("knowledge deletion unavailable")
            return next(iter(resolved), None)
        except RagIngestionUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - upstream details never cross Manager boundary
            logger.warning("LightRAG document alias resolution failed: %s", type(exc).__name__)
            raise RagIngestionUnavailable("knowledge deletion unavailable") from exc

    def delete_document(
        self,
        *,
        workspace: str,
        doc_ids: list[str],
        delete_file: bool = False,
        delete_llm_cache: bool = True,
    ) -> RagDeletionResult:
        """Delete already-resolved workspace-local LightRAG ids."""
        settings = self.settings
        if settings is None or not workspace.strip() or not doc_ids:
            raise RagIngestionUnavailable("knowledge deletion unavailable")
        if any(not isinstance(doc_id, str) or not doc_id.strip() for doc_id in doc_ids):
            raise RagIngestionUnavailable("knowledge deletion unavailable")
        instance = self.instance_for_workspace(workspace)
        headers = {"X-API-Key": instance.api_key, "LIGHTRAG-WORKSPACE": instance.workspace}
        timeout = settings.request_timeout_ms / 1000
        try:
            response = self._http.request(
                "DELETE",
                f"{instance.url}/documents/delete_document",
                headers=headers,
                json={
                    "doc_ids": doc_ids,
                    "delete_file": bool(delete_file),
                    "delete_llm_cache": bool(delete_llm_cache),
                },
                timeout=timeout,
            )
            if response.status_code != 200:
                raise RagIngestionUnavailable("knowledge deletion unavailable")
            payload = _response_json(response)
            started_value = payload.get("deletion_started")
            busy_value = payload.get("busy")
            # LightRAG 1.5.6 currently returns {status: "deletion_started"}
            # (or {status: "busy"}), while some patched deployments expose
            # boolean flags. Accept only these explicit acknowledgements; an
            # arbitrary 200 response must never be treated as success.
            if started_value is not None and not isinstance(started_value, bool):
                raise RagIngestionUnavailable("knowledge deletion unavailable")
            if busy_value is not None and not isinstance(busy_value, bool):
                raise RagIngestionUnavailable("knowledge deletion unavailable")
            response_status = payload.get("status")
            if response_status is not None and not isinstance(response_status, str):
                raise RagIngestionUnavailable("knowledge deletion unavailable")
            started = started_value is True or response_status == "deletion_started"
            busy = busy_value is True or response_status == "busy"
            if not started and not busy:
                # An ambiguous response cannot prove that the requested ids
                # were accepted; do not revoke them as if deletion completed.
                raise RagIngestionUnavailable("knowledge deletion unavailable")
            return RagDeletionResult(deletion_started=started, busy=busy)
        except RagIngestionUnavailable:
            raise
        except (httpx.HTTPError, ValueError, TypeError, UnicodeError) as exc:
            logger.warning("LightRAG deletion request failed: %s", type(exc).__name__)
            raise RagIngestionUnavailable("knowledge deletion unavailable") from exc

    def document_ids_present(self, *, workspace: str, doc_ids: list[str]) -> set[str]:
        """Return requested, already-resolved LightRAG ids still present."""
        settings = self.settings
        requested = _validated_aliases(doc_ids)
        if settings is None or not isinstance(workspace, str) or not workspace.strip():
            raise RagIngestionUnavailable("knowledge deletion unavailable")
        instance = self.instance_for_workspace(workspace)
        headers = {"X-API-Key": instance.api_key, "LIGHTRAG-WORKSPACE": instance.workspace}
        timeout = settings.request_timeout_ms / 1000
        present: set[str] = set()
        try:
            for document_id, _file_path in self._paginated_document_identities(
                instance, headers=headers, timeout=timeout
            ):
                if document_id in requested:
                    present.add(document_id)
            return present
        except RagIngestionUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - upstream details never cross Manager boundary
            logger.warning("LightRAG document probe failed: %s", type(exc).__name__)
            raise RagIngestionUnavailable("knowledge deletion unavailable") from exc

    def _paginated_document_identities(
        self,
        instance: RagInstance,
        *,
        headers: dict[str, str],
        timeout: float,
    ):
        """Yield only validated ids from the bounded Manager workspace listing."""
        try:
            for document in self._paginated_documents(instance, headers=headers, timeout=timeout):
                yield document.upstream_document_id, document.file_path
        except RagIngestionUnavailable as exc:
            raise RagIngestionUnavailable("knowledge deletion unavailable") from exc

    def _paginated_documents(
        self,
        instance: RagInstance,
        *,
        headers: dict[str, str],
        timeout: float,
    ):
        """Yield bounded LightRAG metadata after validating pagination and scope."""
        page = 1
        while True:
            if page > _MAX_PAGINATED_PAGES:
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            response = self._http.post(
                f"{instance.url}/documents/paginated",
                headers=headers,
                json={
                    "page": page,
                    "page_size": _MAX_PAGINATED_PAGE_SIZE,
                    "sort_field": "created_at",
                    "sort_direction": "desc",
                },
                timeout=timeout,
            )
            if response.status_code != 200:
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            payload = _response_json(
                response,
                max_bytes=_MAX_PROBE_RESPONSE_BYTES,
                unavailable_message="knowledge analytics unavailable",
            )
            documents = payload.get("documents")
            pagination = payload.get("pagination")
            if not isinstance(documents, list) or not isinstance(pagination, dict):
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            response_page = pagination.get("page")
            if response_page is not None and (
                not isinstance(response_page, int)
                or isinstance(response_page, bool)
                or response_page != page
            ):
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            response_page_size = pagination.get("page_size", _MAX_PAGINATED_PAGE_SIZE)
            if (
                not isinstance(response_page_size, int)
                or isinstance(response_page_size, bool)
                or response_page_size < 1
                or response_page_size > _MAX_PAGINATED_PAGE_SIZE
                or len(documents) > response_page_size
            ):
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            records = [
                _document_info(document, workspace=instance.workspace)
                for document in documents
            ]
            total_pages = pagination.get("total_pages")
            if total_pages is not None and (
                not isinstance(total_pages, int)
                or isinstance(total_pages, bool)
                or total_pages < 0
                or total_pages > _MAX_PAGINATED_PAGES
            ):
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            total_count = pagination.get("total_count")
            if total_count is not None and (
                not isinstance(total_count, int)
                or isinstance(total_count, bool)
                or total_count < 0
            ):
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            has_next = pagination.get("has_next")
            if has_next is not None and not isinstance(has_next, bool):
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            if total_pages is not None and total_count is not None:
                expected_pages = (
                    0 if total_count == 0
                    else (total_count + response_page_size - 1) // response_page_size
                )
                if total_pages != expected_pages:
                    raise RagIngestionUnavailable("knowledge analytics unavailable")
            if total_pages is not None:
                more = page < total_pages
                if has_next is not None and has_next != more:
                    raise RagIngestionUnavailable("knowledge analytics unavailable")
            elif total_count is not None:
                more = page * response_page_size < total_count
                if has_next is not None and has_next != more:
                    raise RagIngestionUnavailable("knowledge analytics unavailable")
            elif has_next is not None:
                more = has_next
            else:
                more = len(documents) == response_page_size
            if page == _MAX_PAGINATED_PAGES and more:
                raise RagIngestionUnavailable("knowledge analytics unavailable")
            yield from records
            if not more:
                return
            page += 1

    def _wait_until_ready(
        self,
        instance: RagInstance,
        settings: LightRagIngestionSettings,
        *,
        headers: dict[str, str],
        file_source: str,
        track_id: str,
        timeout: float,
    ) -> tuple[int | None, str]:
        """Wait for this insert, not the global LightRAG pipeline, to finish."""
        deadline = self._clock() + settings.pipeline_timeout_ms / 1000
        while True:
            remaining = deadline - self._clock()
            if remaining <= 0:
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            response = self._http.get(
                f"{instance.url}/documents/track_status/{track_id}",
                headers=headers,
                timeout=min(timeout, remaining),
            )
            if response.status_code != 200:
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            payload = _response_json(response)
            if payload.get("track_id") != track_id:
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            documents = payload.get("documents")
            if not isinstance(documents, list):
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            # One POST /documents/text creates one tracked document.  Refuse
            # ambiguous or cross-document responses rather than publishing a
            # ready Manager row for the wrong source.
            total_count = payload.get("total_count")
            if (
                not isinstance(total_count, int)
                or isinstance(total_count, bool)
                or total_count not in (0, 1)
                or len(documents) > 1
                or (not documents and total_count != 0)
                or (documents and total_count != 1)
            ):
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            if not documents:
                self._sleep(min(settings.poll_interval_ms / 1000, remaining))
                continue
            document = documents[0]
            if not isinstance(document, dict):
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            upstream_document_id = document.get("id")
            document_file_path = document.get("file_path")
            if (
                not _valid_document_alias(upstream_document_id)
                or not _valid_document_alias(document_file_path)
                or document_file_path != file_source
            ):
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            status = document.get("status")
            if not isinstance(status, str):
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            status = status.casefold()
            if status in {"failed", "failure", "error"}:
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            # LightRAG 1.5.6's per-document terminal state is PROCESSED.
            # Generic READY is not proof that this tracked insert completed.
            if status == "processed":
                count = document.get("chunks_count")
                return (
                    count if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else None,
                    upstream_document_id,
                )
            self._sleep(min(settings.poll_interval_ms / 1000, remaining))


__all__ = [
    "LightRagIngestionClient",
    "LightRagIngestionSettings",
    "RagDeletionResult",
    "RagDocumentInfo",
    "RagIngestionPort",
    "RagIngestionResult",
    "RagIngestionUnavailable",
]
