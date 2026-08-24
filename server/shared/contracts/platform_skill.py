"""Operator platform skill catalog contracts shared with Manager."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from .skill import SkillPackage


class PlatformSkillRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skill_id: str = Field(min_length=1, description="Operator platform_skill UUID")
    version: str = Field(min_length=1, description="Immutable platform skill version")
    content_hash: str = Field(min_length=1, description="Pinned SkillPackage content hash")


class PlatformSkillSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skill_id: str
    owner: str
    slug: str
    display_name: str = ""
    summary: str = ""
    latest_external_version: str | None = None
    latest_internal_version: str | None = None
    published_version: str | None = None
    content_hash: str | None = None
    status: str


class PlatformSkillPackage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    owner: str
    slug: str
    source_url: str = ""
    package: SkillPackage
