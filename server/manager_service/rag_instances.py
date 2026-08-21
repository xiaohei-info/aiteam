"""Manager-startup LightRAG instance registry.

The registry is deliberately static: Manager loads it once from a trusted
process environment and routes only to the configured fixed workspace of an
instance.  It is not a northbound/API configuration surface.
"""

from __future__ import annotations

import json
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


class RagInstanceConfigurationError(ValueError):
    """Invalid or ambiguous Manager-owned instance configuration."""


@dataclass(frozen=True)
class RagInstance:
    """One immutable LightRAG endpoint and its fixed PG workspace."""

    instance_id: str
    url: str
    api_key: str = field(repr=False)
    workspace: str

    def __post_init__(self) -> None:
        _validate_instance(self)

    def __repr__(self) -> str:  # pragma: no cover - protects accidental debug output
        return f"RagInstance(instance_id={self.instance_id!r}, url={self.url!r}, workspace={self.workspace!r})"


@dataclass(frozen=True)
class RagInstanceRegistry:
    """Unique workspace-to-instance map loaded at Manager startup."""

    instances: tuple[RagInstance, ...]
    _by_workspace: Mapping[str, RagInstance] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not self.instances or len(self.instances) > _MAX_INSTANCES:
            raise RagInstanceConfigurationError("invalid LightRAG instance count")
        by_workspace: dict[str, RagInstance] = {}
        ids: set[str] = set()
        for instance in self.instances:
            _validate_instance(instance)
            if instance.instance_id in ids:
                raise RagInstanceConfigurationError("duplicate LightRAG instance_id")
            if instance.workspace in by_workspace:
                raise RagInstanceConfigurationError("duplicate LightRAG workspace")
            ids.add(instance.instance_id)
            by_workspace[instance.workspace] = instance
        object.__setattr__(self, "_by_workspace", MappingProxyType(by_workspace))

    def resolve(self, workspace: str) -> RagInstance:
        """Resolve exactly one fixed workspace; unknown values fail closed."""
        instance = self._by_workspace.get(workspace)
        if instance is None:
            raise RagInstanceConfigurationError("LightRAG workspace is not configured")
        return instance

    @classmethod
    def from_env(cls) -> "RagInstanceRegistry | None":
        raw = os.getenv("LIGHTRAG_INSTANCES")
        if raw is not None:
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
        if not all(value is not None and value.strip() for value in (url_raw, key_raw, workspace_raw)):
            raise RagInstanceConfigurationError("LIGHTRAG_URL, LIGHTRAG_API_KEY and LIGHTRAG_WORKSPACE are required together")
        return cls((RagInstance("legacy", _normalize_url(url_raw or ""), (key_raw or "").strip(), (workspace_raw or "").strip()),))


def _instance_from_mapping(item: Any) -> RagInstance:
    if not isinstance(item, dict):
        raise RagInstanceConfigurationError("LightRAG instance must be an object")
    required = {"instance_id", "url", "api_key", "workspace"}
    if set(item) != required:
        raise RagInstanceConfigurationError("LightRAG instance fields are invalid")
    values = {key: item[key] for key in required}
    if not all(isinstance(value, str) for value in values.values()):
        raise RagInstanceConfigurationError("LightRAG instance fields must be strings")
    if any(char in value for value in values.values() for char in "\r\n"):
        raise RagInstanceConfigurationError("LightRAG instance fields contain a control character")
    return RagInstance(
        values["instance_id"].strip(),
        _normalize_url(values["url"]),
        values["api_key"].strip(),
        values["workspace"].strip(),
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
    if not instance.workspace or len(instance.workspace) > _MAX_WORKSPACE or any(char in instance.workspace for char in "\r\n"):
        raise RagInstanceConfigurationError("invalid LightRAG workspace")
    _normalize_url(instance.url)


__all__ = ["RagInstance", "RagInstanceConfigurationError", "RagInstanceRegistry"]
