"""敏感信息规则扫描（设计 §5）。

对草稿里的每个文本字段跑一组确定性规则，输出命中项。命中项带原文片段 `excerpt`（只在宿主
内部用于定位与替换，与草稿正文存在同一个库里）与 `masked`（脱敏展示，接口与日志只用它）。
规则宁可多报：每一项都要人工处理（替换 / 删除 / 确认不敏感），漏报才是事故。
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator
from typing import Any

from .schemas import FindingKind, SensitiveMatch

REDACTION_PLACEHOLDER = "[已脱敏]"

_COMPANY_SUFFIX = r"(?:股份有限公司|有限责任公司|有限公司|集团公司|集团|事务所|研究院)"

# 顺序即优先级：重叠时保留靠前规则的命中。
_RULES: tuple[tuple[FindingKind, re.Pattern[str]], ...] = (
    ("secret", re.compile(
        r"(?:sk-[A-Za-z0-9_\-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{6,}"
        r"|(?i:password|passwd|secret|token|api[_-]?key|密码|口令|密钥)\s*[:=：]\s*[^\s，。；,;]{6,})"
    )),
    ("id_card", re.compile(r"(?<![0-9])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9])")),
    ("bank_card", re.compile(r"(?<![0-9])[0-9]{16,19}(?![0-9])")),
    ("phone", re.compile(r"(?<![0-9])(?:\+?86[- ]?)?1[3-9][0-9]{9}(?![0-9])|(?<![0-9])0[0-9]{2,3}-[0-9]{7,8}(?![0-9])")),
    ("email", re.compile(r"[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]{1,63}(?:\.[A-Za-z0-9\-]{1,63}){1,4}")),
    ("amount", re.compile(
        r"[¥￥$]\s?[0-9][0-9,]*(?:\.[0-9]+)?(?:\s?(?:千万|百万|万|亿))?(?:\s?元)?"
        r"|[0-9][0-9,]*(?:\.[0-9]+)?\s?(?:万元|亿元|千万元|百万元|万美元|亿美元|美元|元)"
    )),
    ("company", re.compile(rf"[\u4e00-\u9fffA-Za-z0-9]{{2,20}}?{_COMPANY_SUFFIX}")),
)


def _luhn_ok(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = ord(char) - 48
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def fingerprint(kind: str, text: str) -> str:
    return hashlib.sha256(f"{kind}\x00{text}".encode()).hexdigest()[:16]


def mask(text: str) -> str:
    """脱敏展示：保留首尾各一个字符，中间用星号；短文本全打星。"""
    if len(text) <= 2:
        return "*" * len(text)
    return f"{text[0]}{'*' * min(len(text) - 2, 8)}{text[-1]}"


def scan_text(field_path: str, text: str) -> list[SensitiveMatch]:
    """扫描一段文本，返回不重叠的命中项（按位置排序）。"""
    taken: list[tuple[int, int]] = []
    matches: list[SensitiveMatch] = []
    for kind, pattern in _RULES:
        for found in pattern.finditer(text):
            start, end = found.span()
            value = found.group(0)
            if kind == "bank_card" and not _luhn_ok(value):
                continue
            if any(start < other_end and other_start < end for other_start, other_end in taken):
                continue
            taken.append((start, end))
            matches.append(SensitiveMatch(
                kind=kind, field_path=field_path, excerpt=value, fingerprint=fingerprint(kind, value),
                masked=mask(value), start=start, end=end,
            ))
    return sorted(matches, key=lambda item: item.start)


_SOLUTION_FIELDS = ("display_name", "description", "coordinator_instructions", "output_requirements")
_EXPERT_FIELDS = ("display_name", "category", "description", "system_prompt")


def _text_slots(solution: dict[str, Any]) -> Iterator[tuple[str, Any, Any]]:
    """草稿内容里所有会对外发布的文本字段：(字段路径, 容器, 键)。"""
    for name in _SOLUTION_FIELDS:
        if isinstance(solution.get(name), str):
            yield name, solution, name
    tags = solution.get("tags")
    if isinstance(tags, list):
        for index, tag in enumerate(tags):
            if isinstance(tag, str):
                yield f"tags[{index}]", tags, index
    experts = solution.get("experts")
    if isinstance(experts, list):
        for index, expert in enumerate(experts):
            if not isinstance(expert, dict):
                continue
            for name in _EXPERT_FIELDS:
                if isinstance(expert.get(name), str):
                    yield f"experts[{index}].{name}", expert, name


def solution_text_fields(solution: dict[str, Any]) -> Iterator[tuple[str, str]]:
    for path, container, key in _text_slots(solution):
        if container[key]:
            yield path, container[key]


def scan_solution(solution: dict[str, Any]) -> list[SensitiveMatch]:
    matches: list[SensitiveMatch] = []
    for path, text in solution_text_fields(solution):
        matches.extend(scan_text(path, text))
    return matches


def fields_containing(solution: dict[str, Any], excerpt: str) -> list[str]:
    """哪些字段里还原样出现这段内容。空片段不匹配任何字段。"""
    if not excerpt:
        return []
    return [path for path, text in solution_text_fields(solution) if excerpt in text]


def redact_solution(solution: dict[str, Any], excerpt: str, replacement: str = REDACTION_PLACEHOLDER) -> int:
    """把所有字段里原样出现的片段替换掉（原地修改）。返回替换次数。"""
    if not excerpt:
        return 0
    replaced = 0
    for _path, container, key in _text_slots(solution):
        count = container[key].count(excerpt)
        if count:
            container[key] = container[key].replace(excerpt, replacement)
            replaced += count
    return replaced
