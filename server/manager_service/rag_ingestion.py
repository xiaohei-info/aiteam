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
_MAX_REQUEST_TIMEOUT_MS = 30_000
_MAX_PIPELINE_TIMEOUT_MS = 300_000
_MAX_POLL_INTERVAL_MS = 10_000


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
    """Stable Manager aliases returned after LightRAG has finished processing."""

    rag_document_id: str
    chunk_count: int | None = None


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

    def delete_document(
        self,
        *,
        workspace: str,
        doc_ids: list[str],
        delete_file: bool,
        delete_llm_cache: bool,
    ) -> RagDeletionResult: ...


def _response_json(response: httpx.Response) -> dict[str, Any]:
    if len(response.content) > _MAX_RESPONSE_BYTES:
        raise RagIngestionUnavailable("knowledge indexing unavailable")
    try:
        payload = response.json()
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise RagIngestionUnavailable("knowledge indexing unavailable") from exc
    if not isinstance(payload, dict):
        raise RagIngestionUnavailable("knowledge indexing unavailable")
    return payload


def _successful_response(payload: dict[str, Any]) -> bool:
    # LightRAG's insert endpoint must explicitly acknowledge success; an empty
    # or otherwise ambiguous response is never enough to publish Manager ready.
    return payload.get("status") == "success"


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
            pipeline_chunk_count = self._wait_until_ready(
                instance, settings, headers=headers, file_source=file_source, track_id=track_id,
                timeout=timeout,
            )
            chunk_count = payload.get("chunk_count")
            if not isinstance(chunk_count, int) or chunk_count < 0:
                chunk_count = pipeline_chunk_count
            # file_source is the deliberate stable citation alias.  We do not
            # trust an opaque or versioned ID returned by the upstream service.
            return RagIngestionResult(rag_document_id=file_source, chunk_count=chunk_count)
        except RagIngestionUnavailable:
            raise
        except (httpx.HTTPError, ValueError, TypeError, UnicodeError) as exc:
            logger.warning("LightRAG ingestion request failed: %s", type(exc).__name__)
            raise RagIngestionUnavailable("knowledge indexing unavailable") from exc

    def delete_document(
        self,
        *,
        workspace: str,
        doc_ids: list[str],
        delete_file: bool = False,
        delete_llm_cache: bool = True,
    ) -> RagDeletionResult:
        """Request LightRAG 1.5.6 document deletion through its exact endpoint."""
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
            started = payload.get("deletion_started", False)
            busy = payload.get("busy", False)
            if not isinstance(started, bool) or not isinstance(busy, bool):
                raise RagIngestionUnavailable("knowledge deletion unavailable")
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

    def _wait_until_ready(
        self,
        instance: RagInstance,
        settings: LightRagIngestionSettings,
        *,
        headers: dict[str, str],
        file_source: str,
        track_id: str,
        timeout: float,
    ) -> int | None:
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
            if len(documents) > 1 or payload.get("total_count") not in (0, 1):
                raise RagIngestionUnavailable("knowledge indexing unavailable")
            if not documents:
                self._sleep(min(settings.poll_interval_ms / 1000, remaining))
                continue
            document = documents[0]
            if not isinstance(document, dict) or document.get("file_path") != file_source:
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
                return count if isinstance(count, int) and count >= 0 else None
            self._sleep(min(settings.poll_interval_ms / 1000, remaining))


__all__ = [
    "LightRagIngestionClient",
    "LightRagIngestionSettings",
    "RagDeletionResult",
    "RagIngestionPort",
    "RagIngestionResult",
    "RagIngestionUnavailable",
]
