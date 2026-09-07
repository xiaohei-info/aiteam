"""Manager-startup LightRAG instance registry.

The registry is deliberately static for endpoint credentials only. Workspace
selection is request/tenant scoped and supplied by the Manager RAG service;
multiple entries are an internal deterministic HA/sharding pool, never a
multi-enterprise identity map.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass, field
from types import MappingProxyType
from urllib.parse import urlsplit, urlunsplit
from typing import Any, Mapping

_MAX_CONFIG_BYTES = 64 * 1024
_MAX_INSTANCES = 32
_MAX_INSTANCE_ID = 128
_MAX_URL = 2_048
_MAX_API_KEY = 4_096
_MAX_WORKSPACE = 256

log = logging.getLogger(__name__)


class RagInstanceConfigurationError(ValueError):
    """Invalid or ambiguous Manager-owned instance configuration."""


@dataclass(frozen=True)
class RagInstance:
    """One immutable LightRAG endpoint; workspace is selected per request."""

    instance_id: str
    url: str
    api_key: str = field(repr=False)

    def __post_init__(self) -> None:
        _validate_instance(self)

    def __repr__(self) -> str:  # pragma: no cover - protects accidental debug output
        return f"RagInstance(instance_id={self.instance_id!r}, url={self.url!r})"


@dataclass(frozen=True)
class RagInstanceRegistry:
    """Static endpoint pool with deterministic workspace-to-instance routing."""

    instances: tuple[RagInstance, ...]
    _by_id: Mapping[str, RagInstance] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not self.instances or len(self.instances) > _MAX_INSTANCES:
            raise RagInstanceConfigurationError("invalid LightRAG instance count")
        by_id: dict[str, RagInstance] = {}
        for instance in self.instances:
            _validate_instance(instance)
            if instance.instance_id in by_id:
                raise RagInstanceConfigurationError("duplicate LightRAG instance_id")
            by_id[instance.instance_id] = instance
        object.__setattr__(self, "_by_id", MappingProxyType(by_id))

    def validate_workspace(self, workspace: str) -> None:
        """Validate a Manager-derived workspace before any endpoint selection."""
        if (
            not isinstance(workspace, str)
            or not workspace
            or workspace != workspace.strip()
            or len(workspace) > _MAX_WORKSPACE
            or any(char in workspace for char in "\r\n")
        ):
            raise RagInstanceConfigurationError("invalid LightRAG workspace")

    def resolve(self, workspace: str) -> RagInstance:
        """Resolve a workspace to one deterministic endpoint in the static pool."""
        self.validate_workspace(workspace)
        digest = hashlib.sha256(workspace.encode("utf-8")).digest()
        index = int.from_bytes(digest[:8], "big") % len(self.instances)
        return self.instances[index]

    def by_id(self, instance_id: str) -> RagInstance:
        try:
            return self._by_id[instance_id]
        except KeyError as exc:
            raise RagInstanceConfigurationError("LightRAG instance is not configured") from exc

    @classmethod
    def from_env(cls) -> "RagInstanceRegistry | None":
        raw = os.getenv("LIGHTRAG_INSTANCES")
        if raw is not None and raw.strip():
            if len(raw.encode("utf-8")) > _MAX_CONFIG_BYTES:
                raise RagInstanceConfigurationError("LightRAG instance configuration is too large")
            try:
                decoded = json.loads(raw)
            except (json.JSONDecodeError, UnicodeError) as exc:
                raise RagInstanceConfigurationError("invalid LightRAG instance configuration") from exc
            if not isinstance(decoded, list):
                raise RagInstanceConfigurationError("LightRAG instance configuration must be a JSON list")
            instances = tuple(_instance_from_mapping(item) for item in decoded)
            return cls(instances)

        url_raw = os.getenv("LIGHTRAG_URL")
        key_raw = os.getenv("LIGHTRAG_API_KEY")
        workspace_raw = os.getenv("LIGHTRAG_WORKSPACE")
        if not any(value is not None and value.strip() for value in (url_raw, key_raw, workspace_raw)):
            return None
        if not all(value is not None and value.strip() for value in (url_raw, key_raw)):
            raise RagInstanceConfigurationError("LIGHTRAG_URL and LIGHTRAG_API_KEY are required together")
        if workspace_raw and workspace_raw.strip():
            log.warning("LIGHTRAG_WORKSPACE is ignored; Manager derives workspace per tenant")
        return cls((RagInstance("legacy", _normalize_url(url_raw or ""), (key_raw or "").strip()),))


def _instance_from_mapping(item: Any) -> RagInstance:
    if not isinstance(item, dict):
        raise RagInstanceConfigurationError("LightRAG instance must be an object")
    required = {"instance_id", "url", "api_key"}
    allowed = required | {"workspace"}  # legacy field is accepted then discarded
    if set(item) - allowed or not required <= set(item):
        raise RagInstanceConfigurationError("LightRAG instance fields are invalid")
    values = {key: item[key] for key in required}
    if not all(isinstance(value, str) for value in values.values()):
        raise RagInstanceConfigurationError("LightRAG instance fields must be strings")
    if any(char in value for value in values.values() for char in "\r\n"):
        raise RagInstanceConfigurationError("LightRAG instance fields contain a control character")
    legacy_workspace = item.get("workspace")
    if legacy_workspace is not None and not isinstance(legacy_workspace, str):
        raise RagInstanceConfigurationError("legacy LightRAG workspace must be a string")
    if isinstance(legacy_workspace, str):
        if any(char in legacy_workspace for char in "\r\n"):
            raise RagInstanceConfigurationError("LightRAG instance fields contain a control character")
        if legacy_workspace.strip():
            log.warning("LIGHTRAG_INSTANCES workspace field is ignored; Manager derives workspace per tenant")
    return RagInstance(
        values["instance_id"].strip(),
        _normalize_url(values["url"]),
        values["api_key"].strip(),
    )


def _normalize_url(value: str) -> str:
    value = value.strip().rstrip("/")
    if len(value) > _MAX_URL:
        raise RagInstanceConfigurationError("LightRAG URL is too long")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise RagInstanceConfigurationError("invalid LightRAG URL") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise RagInstanceConfigurationError("LightRAG URL must use http(s) without credentials")
    if parsed.query or parsed.fragment:
        raise RagInstanceConfigurationError("LightRAG URL must not contain query or fragment")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _validate_instance(instance: RagInstance) -> None:
    if not instance.instance_id or len(instance.instance_id) > _MAX_INSTANCE_ID or any(char in instance.instance_id for char in "\r\n,/"):
        raise RagInstanceConfigurationError("invalid LightRAG instance_id")
    if not instance.api_key or len(instance.api_key) > _MAX_API_KEY or any(char in instance.api_key for char in "\r\n"):
        raise RagInstanceConfigurationError("invalid LightRAG API key")
    _normalize_url(instance.url)


__all__ = ["RagInstance", "RagInstanceConfigurationError", "RagInstanceRegistry"]
