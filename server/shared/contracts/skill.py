"""Manager → Agent signed, text-only Skill package contract."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")


def _sha16(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def normalize_skill_file_path(path: str) -> str:
    """Validate the deliberately small, POSIX-only skill file namespace."""
    if not path or "\\" in path or path.startswith("/") or path.startswith("./") or "//" in path or not re.fullmatch(r"[A-Za-z0-9._/-]+", path):
        raise ValueError("skill file path must be canonical POSIX text")
    parts = path.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        raise ValueError("skill file path must not contain traversal or empty segments")
    if path != "SKILL.md" and (not path.startswith("references/") or not path.endswith(".md")):
        raise ValueError("only SKILL.md and references/*.md are accepted")
    return path


def _safe_segment(value: str, name: str) -> None:
    if not value or not _SAFE_SEGMENT.fullmatch(value) or value in {".", ".."}:
        raise ValueError(f"invalid {name}")


class SkillFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    content: str
    content_hash: str

    @model_validator(mode="after")
    def validate_file(self) -> "SkillFile":
        normalize_skill_file_path(self.path)
        if self.content_hash != _sha16(self.content):
            raise ValueError("skill file content_hash mismatch")
        return self


class SkillPackage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skill_id: str
    version: str
    content_hash: str
    display_name: str = ""
    description: str = ""
    files: list[SkillFile] = Field(default_factory=list)

    def compute_content_hash(self) -> str:
        normalized = sorted((normalize_skill_file_path(f.path), f.content) for f in self.files)
        if len({path for path, _ in normalized}) != len(normalized):
            raise ValueError("duplicate skill file path")
        return hashlib.sha256(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()[:16]

    @model_validator(mode="after")
    def validate_package(self) -> "SkillPackage":
        _safe_segment(self.skill_id, "skill_id")
        _safe_segment(self.version, "version")
        if not self.files or not any(file.path == "SKILL.md" for file in self.files):
            raise ValueError("skill package requires SKILL.md")
        if self.content_hash and self.content_hash != self.compute_content_hash():
            raise ValueError("skill package content_hash mismatch")
        return self

    def with_computed_hash(self) -> "SkillPackage":
        return self.model_copy(update={"content_hash": self.compute_content_hash()})


class SignedSkillPackage(BaseModel):
    """Dedicated Ed25519 envelope; the signature is scoped to tenant and member."""

    model_config = ConfigDict(extra="forbid")

    package: SkillPackage
    tenant_id: str = Field(min_length=1)
    member_id: str = Field(min_length=1)
    key_id: str = Field(min_length=1)
    algorithm: Literal["Ed25519"] = "Ed25519"
    signature: str = Field(min_length=1)

    @property
    def skill_package(self) -> SkillPackage:
        return self.package


def canonical_skill_package_bytes(package: SkillPackage, tenant_id: str, member_id: str) -> bytes:
    """Canonical UTF-8 JSON bytes shared byte-for-byte with the Node verifier."""
    return json.dumps(
        {"member_id": member_id, "package": package.model_dump(mode="json"), "tenant_id": tenant_id},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def derive_file_hash(content: str) -> str:
    return _sha16(content)
