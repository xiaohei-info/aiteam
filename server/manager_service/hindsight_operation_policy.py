"""Bounded runtime subset of Hindsight 0.9.0 (not a general bank HTTP proxy)."""
from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .hindsight_lease_repository import HindsightLeaseForbidden

Text = Annotated[str, Field(max_length=4096)]
Tag = Annotated[str, Field(max_length=256)]
Tags = Annotated[list[Tag], Field(max_length=32)]


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)


class IncludePart(StrictBody):
    max_tokens: int = Field(default=500, ge=1, le=8192)


class Include(StrictBody):
    entities: IncludePart | None = None
    chunks: IncludePart | None = None
    source_facts: IncludePart | None = None


class TagGroup(StrictBody):
    tags: Tags | None = None
    match: Literal["any", "all", "any_strict", "all_strict", "exact"] | None = None
    and_: Annotated[list["TagGroup"], Field(max_length=16)] | None = Field(default=None, alias="and")
    or_: Annotated[list["TagGroup"], Field(max_length=16)] | None = Field(default=None, alias="or")
    not_: "TagGroup | None" = Field(default=None, alias="not")


class RecallBody(StrictBody):
    query: str = Field(min_length=1, max_length=16384)
    types: Annotated[list[Literal["world", "experience", "observation"]], Field(max_length=3)] | None = None
    budget: Literal["low", "mid", "high"] = "low"
    max_tokens: int = Field(default=4096, ge=1, le=8192)
    trace: Literal[False] = False
    prefer_observations: bool = False
    query_timestamp: Annotated[str, Field(max_length=128)] | None = None
    include: Include = Field(default_factory=Include)
    tags: Tags | None = None
    tags_match: Literal["any", "all", "any_strict", "all_strict", "exact"] = "any"
    tag_groups: Annotated[list[TagGroup], Field(max_length=16)] | None = None


class Entity(StrictBody):
    text: Tag
    type: Tag | None = None


class RetainItem(StrictBody):
    content: str = Field(min_length=1, max_length=131072)
    context: Text | None = None
    timestamp: Annotated[str, Field(max_length=128)] | None = None
    metadata: dict[Tag, Text] | None = None
    document_id: Annotated[str, Field(max_length=512)] | None = None
    update_mode: Literal["replace", "append"] | None = None
    # The pinned automatic lifecycle uses this name. It is consumed, never
    # forwarded: a runtime caller cannot select a bank extraction strategy.
    strategy: Literal["conversation"] | None = None
    tags: Tags | None = None
    entities: Annotated[list[Entity], Field(max_length=32)] | None = None
    observation_scopes: Literal["per_tag", "combined", "all_combinations", "shared"] | Annotated[list[Tags], Field(max_length=16)] | None = None


class RetainBody(StrictBody):
    items: Annotated[list[RetainItem], Field(min_length=1, max_length=8)]
    async_: bool = Field(default=True, alias="async")
    operation_id: Annotated[str, Field(max_length=128)] | None = None
    document_tags: Tags | None = None


def _pairs(pairs):
    output = {}
    for key, value in pairs:
        if key in output:
            raise ValueError("duplicate JSON field")
        output[key] = value
    return output


def _bounded(value, depth=0):
    if depth > 10:
        raise ValueError("JSON nesting limit")
    if isinstance(value, dict):
        if len(value) > 64:
            raise ValueError("JSON field limit")
        for key, item in value.items():
            if key in {"bank", "bank_id"} or key.lower().startswith("aiteam"):
                raise ValueError("reserved scope field")
            _bounded(item, depth + 1)
    elif isinstance(value, list):
        if len(value) > 64:
            raise ValueError("JSON array limit")
        for item in value:
            _bounded(item, depth + 1)


def parse_operation_body(operation: str, body: bytes) -> dict:
    try:
        value = json.loads(body, object_pairs_hook=_pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        _bounded(value)
        model = RecallBody if operation == "recall" else RetainBody
        return model.model_validate(value).model_dump(by_alias=True, exclude_none=True, exclude_unset=True)
    except (ValueError, TypeError, ValidationError, RecursionError) as exc:
        raise HindsightLeaseForbidden("Unsupported Hindsight operation body") from exc


def scoped_retain_body(body: dict, *, tenant_id: str, member_id: str, employee_id: str) -> dict:
    """Retry-stable append-only document identities, never caller-selected overwrite targets.

    The digest includes the complete accepted request: changing content under a
    reused caller operation/document ID cannot rewrite the earlier document.
    No body or digest is persisted here. Finite retention is separately blocked.
    """
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(f"{tenant_id}:{member_id}:{employee_id}:{canonical}".encode()).hexdigest()
    operation = str(UUID(digest[:32]))
    items = []
    for index, source in enumerate(body["items"]):
        item = {k: v for k, v in source.items() if k not in {"document_id", "update_mode", "strategy", "metadata"}}
        metadata = {k: v for k, v in source.get("metadata", {}).items()
                    if k not in {"cwd", "pi_session_file"} and not any(s in k.lower() for s in ("token", "secret", "password", "credential", "authorization", "api_key", "cookie"))}
        item.update(document_id=f"aiteam-{digest}-{index}", metadata=metadata)
        items.append(item)
    return {"items": items, "async": True, "operation_id": operation}
