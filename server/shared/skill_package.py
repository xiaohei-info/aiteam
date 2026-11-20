"""Bounded skill packages with a SKILL.md: the one validator for every place that stores a skill.

Shared by the Manager tenant catalog and the Operator platform catalog; same hash/path rules as the signed
distribution contract (`shared.contracts.skill`). A skill is a folder with SKILL.md (frontmatter `name` +
`description`, then the instructions) plus optional scripts / references / assets.
"""
from __future__ import annotations

import re

import yaml

from .contracts.skill import (
    MAX_SKILL_FILES,
    MAX_SKILL_TOTAL_BYTES,
    SkillFile,
    SkillPackage,
    derive_file_hash,
)


def catalog_package(*, skill_id: str, version: str, files: list, content_hash: str = "",
                    display_name: str = "") -> SkillPackage:
    if not 1 <= len(files) <= MAX_SKILL_FILES:
        raise ValueError(f"a package requires 1–{MAX_SKILL_FILES} files")
    if sum(len(f["content"].encode("utf-8")) for f in files) > MAX_SKILL_TOTAL_BYTES:
        raise ValueError("skill package exceeds the size limit")
    package = SkillPackage(
        skill_id=skill_id, version=version, content_hash=content_hash, display_name=display_name,
        files=[SkillFile(path=f["path"], content=f["content"], content_hash=derive_file_hash(f["content"])) for f in files],
    ).with_computed_hash()
    try:
        validate_skill_frontmatter(next(f.content for f in package.files if f.path == "SKILL.md"))
    except yaml.YAMLError as exc:
        raise ValueError("invalid frontmatter") from exc
    return package


def validate_skill_frontmatter(text: str) -> None:
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.DOTALL)
    if not match or len(match.group(1).encode("utf-8")) > 8192:
        raise ValueError("invalid frontmatter")
    raw = match.group(1)
    depth = 0
    for index, token in enumerate(yaml.scan(raw)):
        if isinstance(token, (yaml.tokens.BlockMappingStartToken, yaml.tokens.BlockSequenceStartToken, yaml.tokens.FlowMappingStartToken, yaml.tokens.FlowSequenceStartToken)):
            depth += 1
        elif isinstance(token, (yaml.tokens.BlockEndToken, yaml.tokens.FlowMappingEndToken, yaml.tokens.FlowSequenceEndToken)):
            depth -= 1
        if depth > 6 or index > 512:
            raise ValueError("frontmatter is too complex")
        if isinstance(token, (yaml.tokens.AliasToken, yaml.tokens.AnchorToken)) or (
            isinstance(token, yaml.tokens.ScalarToken) and token.value == "<<"
        ):
            raise ValueError("aliases, anchors and merges are not supported")
    node = yaml.compose(raw, Loader=yaml.SafeLoader)
    pending = [(node, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if depth > 6 or count > 128:
            raise ValueError("frontmatter is too complex")
        if isinstance(item, yaml.nodes.MappingNode):
            keys = [key.value for key, _ in item.value]
            if len(set(keys)) != len(keys):
                raise ValueError("duplicate metadata key")
            pending.extend((child, depth + 1) for pair in item.value for child in pair)
        elif isinstance(item, yaml.nodes.SequenceNode):
            pending.extend((child, depth + 1) for child in item.value)
    metadata = yaml.safe_load(raw)
    description = metadata.get("description") if isinstance(metadata, dict) else None
    if not isinstance(description, str) or not description.strip() or len(description) > 1024:
        raise ValueError("description must be a nonempty string")
    if "name" in metadata and not isinstance(metadata["name"], str):
        raise ValueError("name must be a string")
