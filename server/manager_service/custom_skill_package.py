"""Bounded custom text packages; reuse the signed distribution hash/path contract."""
from __future__ import annotations

from typing import Any, Literal

import yaml

from shared.contracts.skill import SkillPackage
from shared.errors import ValidationProblem
from shared.skill_package import catalog_package, validate_skill_frontmatter  # noqa: F401 (re-exported)


def validate_custom_package(**kwargs) -> SkillPackage:
    try:
        package = catalog_package(**kwargs)
        return package
    except (ValueError, TypeError, KeyError, UnicodeError, yaml.YAMLError) as exc:
        raise ValidationProblem(detail="Invalid skill package: use bounded canonical text files and SKILL.md with a description", errors=None) from exc


def package_status(row: Any) -> Literal["draft", "ready", "invalid"]:
    files = getattr(row, "files", None)
    # JSONB legacy rows may contain an object/scalar.  Preserve those values in
    # the repository projection, but never coerce them into executable files or
    # classify an empty malformed shape as a draft.
    if not isinstance(files, list):
        return "invalid"
    if not files and not getattr(row, "content_hash", ""):
        return "draft"
    try:
        if not row.content_hash:
            return "invalid"
        catalog_package(skill_id=row.skill_id, version=row.version, files=files, content_hash=row.content_hash)
        return "ready"
    except (ValueError, TypeError, KeyError, UnicodeError, yaml.YAMLError):
        return "invalid"
