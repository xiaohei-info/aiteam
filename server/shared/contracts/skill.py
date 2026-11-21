"""Manager → Agent signed, text-only Skill package contract.

A package carries UTF-8 text files under safe relative POSIX paths (scripts, assets and references
included); binaries are never representable. The Node verifier (`server/agent_service/src/skills.ts`)
enforces the very same path rule and limits — change both together.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")
_PATH_CHARS = re.compile(r"[A-Za-z0-9._/-]+")

# Package limits, aligned with the desktop's local skill import (custom-skills.ts).
# 技能包格式：1 = 只有 SKILL.md 与 references/*.md；2 = 任意安全相对路径的文本（脚本、资料）。
# 新版 Agent 在请求头声明自己支持的格式；不声明的视为 1（老 Agent 验签会整包拒绝格式 2 的技能）。
SKILL_PACKAGE_FORMAT_HEADER = "X-AITeam-Skill-Package-Format"
SKILL_PACKAGE_FORMAT = 2


def required_package_format(paths: list[str]) -> int:
    legacy = all(path == "SKILL.md" or (path.startswith("references/") and path.endswith(".md")) for path in paths)
    return 1 if legacy else 2


MAX_SKILL_FILES = 256
MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024
MAX_SKILL_TOTAL_BYTES = 10 * 1024 * 1024
MAX_SKILL_PATH_LENGTH = 240
MAX_SKILL_PATH_DEPTH = 8


def _sha16(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def normalize_skill_file_path(path: str) -> str:
    """Validate a skill file path: relative POSIX, safe characters, no traversal, no dot segments.

    Dot-leading segments are reserved (`.aiteam-manifest.json` lives beside the files on the Agent) and also
    keep `.git` / `.env` style files out of distributed packages.
    """
    if not path or len(path) > MAX_SKILL_PATH_LENGTH or "\\" in path or path.startswith("/") or "//" in path or not _PATH_CHARS.fullmatch(path):
        raise ValueError("skill file path must be canonical POSIX text")
    parts = path.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        raise ValueError("skill file path must not contain traversal or empty segments")
    if any(part.startswith(".") for part in parts):
        raise ValueError("skill file path segments must not start with a dot")
    if len(parts) > MAX_SKILL_PATH_DEPTH:
        raise ValueError("skill file path is nested too deeply")
    return path


def _safe_segment(value: str, name: str) -> None:
    if not value or not _SAFE_SEGMENT.fullmatch(value) or value in {".", "..", ".aiteam-keyring"}:
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
        if len(self.files) > MAX_SKILL_FILES:
            raise ValueError("skill package has too many files")
        total = 0
        for file in self.files:
            size = len(file.content.encode("utf-8"))
            if size > MAX_SKILL_FILE_BYTES:
                raise ValueError("skill file is too large")
            total += size
        if total > MAX_SKILL_TOTAL_BYTES:
            raise ValueError("skill package is too large")
        if self.content_hash and self.content_hash != self.compute_content_hash():
            raise ValueError("skill package content_hash mismatch")
        return self

    def with_computed_hash(self) -> "SkillPackage":
        return self.model_copy(update={"content_hash": self.compute_content_hash()})


class SkillSigningKeyMetadata(BaseModel):
    """Public-only metadata used to rotate skill package verification keys.

    Private key material is intentionally not representable by this contract.  The
    Manager may publish ``current`` and ``next`` keys together during overlap;
    ``revoked`` metadata lets an Agent invalidate an already cached key without
    receiving any signing secret.
    """

    model_config = ConfigDict(extra="forbid")

    key_id: str = Field(min_length=1, max_length=200)
    public_key: str = Field(default="", description="base64 DER SubjectPublicKeyInfo")
    algorithm: Literal["Ed25519"] = "Ed25519"
    status: Literal["current", "next", "revoked", "expired"] = "current"
    not_before: str | None = None
    expires_at: str | None = None
    revoked_at: str | None = None

    @model_validator(mode="after")
    def validate_metadata(self) -> "SkillSigningKeyMetadata":
        if self.status != "revoked" and not self.public_key:
            raise ValueError("active skill signing key metadata requires a public key")
        for name in ("not_before", "expires_at", "revoked_at"):
            value = getattr(self, name)
            if value is None:
                continue
            try:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError(f"invalid skill signing key {name}") from exc
        return self


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
