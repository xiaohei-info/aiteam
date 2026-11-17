"""行业文档生成：专家 skill 引用的宿主校验（生成后与手动保存共用同一口径）。

skill 引用只能指向平台目录里已发布的固定版本：skill_id 存在、version 与 content_hash 都和已发布版本一致。
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from shared.solution_authoring.prompts import SkillCatalogItem

# 读取平台已发布 skill 目录；未配置（None）视为空目录。
SkillCatalogLoader = Callable[[], Sequence[SkillCatalogItem]]

NOT_IN_CATALOG = "not_in_catalog"
VERSION_MISMATCH = "version_mismatch"


def has_skill_refs(package: dict[str, Any]) -> bool:
    return any(expert.get("skills") for expert in package.get("experts", []))


def _check(package: dict[str, Any], catalog: Sequence[SkillCatalogItem], *, drop: bool) -> list[tuple[str, str]]:
    published = {item.skill_id: item for item in catalog}
    bad: list[tuple[str, str]] = []
    for expert in package.get("experts", []):
        kept = []
        for ref in expert.get("skills", []):
            item = published.get(ref["skill_id"])
            if item and item.version == ref["version"] and item.content_hash == ref["content_hash"]:
                kept.append(ref)
                continue
            bad.append((
                f"专家「{expert.get('display_name', '')}」 · {ref['skill_id']}@{ref['version']}",
                VERSION_MISMATCH if item else NOT_IN_CATALOG,
            ))
        if drop:
            expert["skills"] = kept
    return bad


def unresolved_skills(package: dict[str, Any], catalog: Sequence[SkillCatalogItem]) -> list[tuple[str, str]]:
    """不在平台已发布目录里（或版本 / 内容不符）的 skill 引用。返回 (位置, 原因码)，不修改正文。"""
    return _check(package, catalog, drop=False)


def drop_unresolved_skills(package: dict[str, Any], catalog: Sequence[SkillCatalogItem]) -> list[tuple[str, str]]:
    """同上，并把这些引用从正文里剔除（生成结果用：模型编造的引用不落库）。"""
    return _check(package, catalog, drop=True)
