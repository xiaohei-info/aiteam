"""群聊编排规则里的成员引用（`collaboration-markdown-v1` 的 `@{成员}`）。

同一份规则文本在三个阶段换三次标识：运营端草稿用专家 `key`，发布到目录时换成专家模板 ID，企业端应用时
换成员工 ID。换算是一次性的纯函数：不会把刚换出的值再当作 key 继续换，换不出来就明确失败，不留半成品。
引用语法与用户端 `server/agent_service/src/groups/orchestration.ts` 的 `validateMemberReferences` 保持一致。
"""

from __future__ import annotations

import re
from collections.abc import Mapping

_REF = re.compile(r"@\{([^{}\s]+)\}")


class OrchestrationRefError(ValueError):
    """规则里有无法解析的成员引用。"""


def referenced_members(rules: str) -> list[str]:
    """按首次出现的顺序列出被引用的成员（去重）。"""
    return list(dict.fromkeys(_REF.findall(rules)))


def _check_well_formed(rules: str) -> None:
    if "@{" in _REF.sub("", rules):
        raise OrchestrationRefError("Malformed member reference in orchestration rules")


def validate_member_refs(rules: str, members: set[str] | frozenset[str]) -> None:
    _check_well_formed(rules)
    outside = [member for member in referenced_members(rules) if member not in members]
    if outside:
        raise OrchestrationRefError(f"Orchestration rules reference a member outside this solution: {outside[0]}")


def rewrite_member_refs(rules: str, mapping: Mapping[str, str]) -> str:
    """把每个 `@{旧}` 换成 `@{新}`；有引用不在 `mapping` 里则抛错。"""
    _check_well_formed(rules)
    missing = [member for member in referenced_members(rules) if member not in mapping]
    if missing:
        raise OrchestrationRefError(f"Orchestration rules reference an unmapped member: {missing[0]}")
    return _REF.sub(lambda match: "@{" + mapping[match.group(1)] + "}", rules)
